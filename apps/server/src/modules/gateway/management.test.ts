import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import type { AuthenticatedUser, DholeApp, ServerContext } from '../../lib/module.js';
import { GatewayService } from './index.js';
import { GatewayManagementService, registerGatewayManagementRoutes } from './management.js';

const databases: ServerContext['database'][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(fetchImpl: typeof fetch = async () => new Response('{}')) {
  const database = openDatabase(':memory:', systemClock);
  databases.push(database);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_MASTER_KEYS: JSON.stringify({ test: Buffer.alloc(32, 4).toString('base64') }), DHOLE_MASTER_KEY_ID: 'test', DHOLE_GATEWAY_ALLOWED_HOSTS: '127.0.0.1' });
  const context: ServerContext = { config, database, clock: systemClock, ids: secureIds, events: new EventStore(database, systemClock, secureIds) };
  const now = new Date().toISOString();
  database.prepare('INSERT INTO teams(id,name,created_at) VALUES (?,?,?)').run('team', 'Team', now);
  database.prepare('INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('admin', 'admin@example.invalid', 'Admin', 'fixture', now, now);
  const gateway = new GatewayService(context, { fetchImpl });
  const connection = gateway.createConnection('team', { name: 'CPA', baseUrl: 'http://127.0.0.1:8787', managementSecret: 'management-fixture-only', catalogSecret: 'catalog-fixture-only', enabled: true, retentionDays: 30 }, 'admin');
  return { context, gateway, management: new GatewayManagementService(context, gateway), id: connection.id };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

function appFor(context: ServerContext, gateway: GatewayService, role: AuthenticatedUser['role'] = 'administrator', teamId = 'team'): DholeApp {
  const app: DholeApp = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: 'admin', teamId, role, email: 'admin@example.invalid', displayName: 'Admin' }); await next(); });
  registerGatewayManagementRoutes(app, context, gateway);
  return app;
}

describe('gateway connection management', () => {
  it('revisions connection metadata, rejects stale edits, rotates credentials, and preserves history on delete', async () => {
    const calls: RequestInit[] = [];
    const { context, gateway, id } = setup(async (_url, init) => { calls.push(init ?? {}); return json({ reflected: 'management-fixture-only', config: { key: 'upstream-private' } }); });
    gateway.ingest(id, { request_id: 'retained', provider: 'codex', model: 'm' });
    expect(gateway.updateConnection(id, 'team', { expectedRevision: 1, name: 'Changed' }, 'admin')).toMatchObject({ revision: 2, name: 'Changed' });
    expect(() => gateway.updateConnection(id, 'team', { expectedRevision: 1, name: 'Stale' }, 'admin')).toThrow('Connection changed');
    gateway.updateConnection(id, 'team', { expectedRevision: 2, managementSecret: 'replacement-fixture-only' }, 'admin', 'rotate');
    expect(gateway.updateConnection(id, 'team', { expectedRevision: 3 }, 'admin', 'rollback', 1)).toMatchObject({ name: 'CPA', revision: 4 });
    expect(await gateway.health(id, 'team', 'admin')).toEqual({ ok: true, status: 200, body: null });
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer replacement-fixture-only' });
    const history = gateway.connectionRevisions(id, 'team');
    expect(history.map((entry) => entry.revision)).toEqual([4, 3, 2, 1]);
    expect(JSON.stringify(history)).not.toContain('fixture-only');
    expect(() => context.database.prepare('DELETE FROM gateway_connection_revisions WHERE connection_id = ?').run(id)).toThrow('immutable');
    expect(gateway.updateConnection(id, 'team', { expectedRevision: 4 }, 'admin', 'delete')).toMatchObject({ revision: 5, enabled: false, managementConfigured: false, catalogConfigured: false });
    expect(gateway.listRequests({ connectionId: id }, 'team').total).toBe(1);
    expect(context.database.prepare('SELECT count(*) AS count FROM provider_secrets').get()).toEqual({ count: 0 });
    await expect(gateway.fetchCatalog(id, 'team')).rejects.toMatchObject({ code: 'gateway_connection_disabled' });
    expect(() => gateway.updateConnection(id, 'team', { expectedRevision: 5 }, 'admin', 'rollback', 1)).toThrow('Deleted connections');
  });

  it('checks candidate credentials before activation and detects edits made during the check', async () => {
    let finish: ((response: Response) => void) | undefined;
    const { context, gateway, id } = setup(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    const checking = gateway.checkConnectionChange(id, 'team', { expectedRevision: 1, managementSecret: 'candidate-fixture' });
    expect(gateway.listConnections('team')[0]).toMatchObject({ revision: 1 });
    gateway.updateConnection(id, 'team', { expectedRevision: 1, retentionDays: 40 }, 'admin');
    finish!(json({}));
    await expect(checking).rejects.toMatchObject({ code: 'gateway_revision_conflict' });
    const rejected = new GatewayService(context, { fetchImpl: async () => json({}, 401) });
    const response = await appFor(context, rejected).request(`/api/gateway/connections/${id}/secrets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2, managementSecret: 'rejected-fixture' }) });
    expect(response.status).toBe(503);
    expect(gateway.listConnections('team')[0]).toMatchObject({ revision: 2 });
    expect(context.database.prepare('SELECT count(*) AS count FROM provider_secrets').get()).toEqual({ count: 2 });
  });

  it('rolls back metadata and credential changes when the audit cannot be recorded', () => {
    const { context, gateway, id } = setup();
    context.database.exec("CREATE TRIGGER fail_gateway_edit BEFORE INSERT ON audit_records WHEN NEW.action = 'gateway.connection.rotate' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    expect(() => gateway.updateConnection(id, 'team', { expectedRevision: 1, managementSecret: 'never-retained' }, 'admin', 'rotate')).toThrow('audit failed');
    expect(gateway.listConnections('team')[0]).toMatchObject({ revision: 1 });
    expect(context.database.prepare('SELECT count(*) AS count FROM provider_secrets').get()).toEqual({ count: 2 });
    expect(gateway.connectionRevisions(id, 'team')).toHaveLength(1);
  });

  it('requires administrator writes, exact change fields, and team ownership', async () => {
    const { context, gateway, id } = setup();
    const options = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, enabled: false }) };
    expect((await appFor(context, gateway, 'member').request(`/api/gateway/connections/${id}`, options)).status).toBe(403);
    expect((await appFor(context, gateway, 'administrator', 'other').request(`/api/gateway/connections/${id}`, options)).status).toBe(404);
    expect((await appFor(context, gateway).request(`/api/gateway/connections/${id}`, { ...options, body: JSON.stringify({ expectedRevision: 1, managementSecret: 'wrong-route' }) })).status).toBe(422);
  });

  it('denies redirects, bounds the complete response deadline, and separates catalog credentials', async () => {
    const observed: Array<{ url: string; headers: unknown }> = [];
    const { context, gateway, id } = setup(async (url, init) => { observed.push({ url: String(url), headers: init?.headers }); return json({ data: [{ id: 'a', display_name: 'management-fixture-only catalog-fixture-only' }] }); });
    expect((await gateway.fetchCatalog(id, 'team', '1.2')).body).toEqual({ data: [{ id: 'a', display_name: '[REDACTED] [REDACTED]' }] });
    expect(observed[0]).toMatchObject({ url: 'http://127.0.0.1:8787/v1/models?client_version=1.2', headers: { authorization: 'Bearer catalog-fixture-only' } });
    const redirected = new GatewayService(context, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://elsewhere.invalid' } }) });
    await expect(redirected.health(id)).rejects.toMatchObject({ code: 'gateway_redirect_denied' });
    const stalled = new GatewayService(context, { timeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    await expect(stalled.fetchCatalog(id, 'team')).rejects.toMatchObject({ code: 'gateway_unavailable' });
  });
});

describe('bounded CPA config and account actions', () => {
  it('compares config revisions before one exact setting write, retaining sanitized history', async () => {
    const values: Record<string, number | string> = { 'request-retry': 2, 'max-retry-credentials': 0, 'max-retry-interval': 30, 'routing/strategy': 'round-robin' };
    const writes: string[] = [];
    const { management, id } = setup(async (url, init) => {
      const setting = String(url).split('/v0/management/')[1]!;
      if (init?.method === 'PUT') { writes.push(setting); values[setting] = (JSON.parse(String(init.body)) as { value: number | string }).value; return json({ status: 'ok', secret: 'upstream-private' }); }
      return json({ [setting === 'routing/strategy' ? 'strategy' : setting]: values[setting], account: 'upstream-private' });
    });
    const before = await management.config(id, 'team');
    const change = { expectedRevision: 1, expectedConfigRevision: before.revision, setting: 'request-retry' as const, value: 3 };
    expect(await management.previewConfig(id, 'team', change)).toMatchObject({ changes: [{ setting: 'request-retry', before: 2, after: 3 }], concurrency: 'best-effort' });
    await management.applyConfig(id, 'team', change, 'admin');
    expect(writes).toEqual(['request-retry']);
    await expect(management.applyConfig(id, 'team', change, 'admin')).rejects.toMatchObject({ code: 'gateway_config_conflict' });
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(management.historyList(id, 'team'))).not.toContain('upstream-private');
  });

  it('projects credential-bearing account data and resolves source names only for supported explicit actions', async () => {
    const account = { auth_index: 'abc123', name: 'private-user@example.invalid.json', provider: 'codex', status: 'active', disabled: false, unavailable: false, runtime_only: false, source: 'file', account: 'upstream-private-api-key', path: '/secrets/path', label: 'private-user', id_token: { email: 'private-user@example.invalid' }, status_message: 'private diagnostic' };
    const writes: unknown[] = [];
    const { context, management, gateway, id } = setup(async (_url, init) => {
      if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)) as { disabled: boolean }; writes.push(body); account.disabled = body.disabled; return json({ status: 'ok', disabled: body.disabled }); }
      return json({ files: [account] });
    });
    const observed = await management.refreshAccounts(id, 'team', 'admin');
    expect(observed.accounts[0]).toMatchObject({ provider: 'codex', status: 'active', managementSupported: true, disabled: false });
    const accountId = String(observed.accounts[0]!.id);
    expect(JSON.stringify(observed)).not.toMatch(/upstream-private|private-user|secrets\/path/);
    const stored = context.database.prepare('SELECT * FROM gateway_accounts').get();
    expect(JSON.stringify(stored)).not.toMatch(/upstream-private|private-user|secrets\/path/);
    gateway.ingest(id, { request_id: 'plain', provider: 'codex', model: 'm', auth_index: 'abc123' });
    expect(gateway.listAccounts(id, 'team')[0]).toMatchObject({ status: 'active', observedAt: observed.observedAt });
    await management.setAccountStatus(id, 'team', accountId, { expectedRevision: 1, expectedDisabled: false, disabled: true }, 'admin');
    expect(writes).toEqual([{ name: account.name, auth_index: 'abc123', disabled: true }]);
    expect(JSON.stringify(management.historyList(id, 'team'))).not.toContain('private-user');
    await expect(management.setAccountStatus(id, 'team', accountId, { expectedRevision: 1, expectedDisabled: false, disabled: true }, 'admin')).rejects.toMatchObject({ code: 'gateway_account_conflict' });
  });
});

describe('CPA OAuth without a callback listener', () => {
  const state = 'a'.repeat(32);
  function oauthFixture() {
    let complete = false;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fixture = setup(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).endsWith('/codex-auth-url')) return json({ status: 'ok', state, url: `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}` });
      if (String(url).includes('get-auth-status')) return json({ status: complete ? 'ok' : 'wait', error: 'private-upstream-diagnostic' });
      if (String(url).endsWith('/oauth-callback')) return json({ status: 'ok' });
      return json({ status: 'ok', cancelled: true });
    });
    return { ...fixture, calls, complete() { complete = true; } };
  }

  it('encrypts actor-bound state, validates pasted callbacks, and persists completion without codes or tokens', async () => {
    const fixture = oauthFixture();
    const { management, context, id, calls } = fixture;
    const flow = await management.startOAuth(id, 'team', { expectedRevision: 1, provider: 'codex' }, 'admin');
    expect(flow).toMatchObject({ status: 'pending', callbackMode: 'paste-redirect-url' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/v0/management/codex-auth-url');
    expect(JSON.stringify(context.database.prepare('SELECT * FROM gateway_oauth_flows').get())).not.toContain(state);
    await expect(management.pollOAuth(id, 'team', flow.id, 'another-admin')).rejects.toMatchObject({ code: 'gateway_oauth_not_found' });
    await expect(management.submitOAuth(id, 'team', flow.id, `http://localhost:1455/auth/callback?state=${'b'.repeat(32)}&code=transient-code`, 'admin')).rejects.toMatchObject({ code: 'gateway_oauth_callback_invalid' });
    const accepted = await management.submitOAuth(id, 'team', flow.id, `http://localhost:1455/auth/callback?state=${state}&code=transient-code`, 'admin');
    expect(accepted.status).toBe('submitted');
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ provider: 'codex', state, code: 'transient-code' });
    await expect(management.submitOAuth(id, 'team', flow.id, `http://localhost:1455/auth/callback?state=${state}&code=transient-code`, 'admin')).rejects.toMatchObject({ code: 'gateway_oauth_callback_already_submitted' });
    fixture.complete();
    expect((await management.pollOAuth(id, 'team', flow.id, 'admin')).status).toBe('complete');
    const count = calls.length;
    expect((await management.pollOAuth(id, 'team', flow.id, 'admin')).status).toBe('complete');
    expect(calls).toHaveLength(count);
    const persisted = JSON.stringify({ flow: context.database.prepare('SELECT * FROM gateway_oauth_flows').get(), audit: context.database.prepare('SELECT * FROM audit_records').all() });
    expect(persisted).not.toMatch(/transient-code|private-upstream|management-fixture-only|catalog-fixture-only/);
    expect(context.database.prepare('SELECT encrypted_state_json FROM gateway_oauth_flows').get()).toEqual({ encrypted_state_json: null });
  });

  it('does not claim cancellation after upstream already completed the authorization', async () => {
    const { management, context, gateway, id } = setup(async (url) => {
      if (String(url).endsWith('/codex-auth-url')) return json({ status: 'ok', state, url: `https://auth.openai.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}` });
      if (String(url).includes('oauth-session')) return json({ status: 'ok', cancelled: false });
      return json({ status: 'ok' });
    });
    const flow = await management.startOAuth(id, 'team', { expectedRevision: 1, provider: 'codex' }, 'admin');
    expect((await management.cancelOAuth(id, 'team', flow.id, 'admin')).status).toBe('complete');
    const response = await appFor(context, gateway).request(`/api/gateway/connections/${id}/oauth/${flow.id}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('expires callbacks and invalidates pending flows on connection rotation', async () => {
    const { management, context, gateway, id, calls } = oauthFixture();
    const first = await management.startOAuth(id, 'team', { expectedRevision: 1, provider: 'codex' }, 'admin');
    context.database.prepare('UPDATE gateway_oauth_flows SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', first.id);
    expect((await management.pollOAuth(id, 'team', first.id, 'admin')).status).toBe('expired');
    const second = await management.startOAuth(id, 'team', { expectedRevision: 1, provider: 'codex' }, 'admin');
    gateway.updateConnection(id, 'team', { expectedRevision: 1, managementSecret: 'rotation-fixture-only' }, 'admin', 'rotate');
    expect((await management.pollOAuth(id, 'team', second.id, 'admin')).status).toBe('expired');
    expect(calls).toHaveLength(2);
  });

  it('rejects an upstream authorization redirect to an untrusted site', async () => {
    const { management, id } = setup(async () => json({ status: 'ok', state, url: `https://attacker.invalid/oauth/authorize?state=${state}` }));
    await expect(management.startOAuth(id, 'team', { expectedRevision: 1, provider: 'codex' }, 'admin')).rejects.toMatchObject({ code: 'gateway_oauth_url_invalid' });
  });
});
