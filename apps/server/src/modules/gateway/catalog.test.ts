import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { secureIds } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedCredential, AuthenticatedUser, ServerContext } from '../../lib/module.js';
import { hashToken } from '../../lib/security.js';
import { accessModule } from '../access/index.js';
import { GatewayService } from './index.js';
import { CATALOG_STALE_AFTER_MS, GatewayCatalogService, catalogContentHash, diffCatalogModels, parseCliProxyCatalog, registerGatewayCatalogRoutes } from './catalog.js';

const standard = { object: 'list', data: [{ id: 'model-b', owned_by: 'fixture-provider' }, { id: 'model-a', context_window: 128_000 }] };
const rich = { models: [{ slug: 'model-a', display_name: 'Model A', context_window: 200_000, max_output_tokens: 32_000, input_modalities: ['image', 'text'], supported_reasoning_levels: [{ effort: 'high', description: 'Untrusted instructions' }], default_reasoning_level: 'high', supports_parallel_tool_calls: true, capabilities: { tools: true } }] };
const administrator: AuthenticatedUser = { id: 'user-1', email: 'user@example.invalid', displayName: 'User', role: 'administrator', teamId: 'team-1' };

function setup(targetVersion?: number) {
  let instant = Date.parse('2026-09-05T12:00:00.000Z');
  const clock = { now: () => new Date(instant) };
  const database = openDatabase(':memory:', clock, targetVersion);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173', DHOLE_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 4).toString('base64') }), DHOLE_MASTER_KEY_ID: 'v1', DHOLE_GATEWAY_ALLOWED_HOSTS: '127.0.0.1' });
  const context: ServerContext = { config, database, clock, ids: secureIds, events: new EventStore(database, clock, secureIds) };
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', clock.now().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(administrator.id, administrator.email, administrator.displayName, 'test', clock.now().toISOString(), clock.now().toISOString());
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(administrator.teamId, administrator.id, administrator.role, clock.now().toISOString());
  let payload: unknown = standard;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
  const gateway = new GatewayService(context, { fetchImpl });
  const connectionId = gateway.createConnection('team-1', { name: 'fixture', baseUrl: 'http://127.0.0.1:8787', managementSecret: 'management-fixture', catalogSecret: 'catalog-fixture', enabled: true, retentionDays: 30 }, administrator.id).id;
  const catalog = new GatewayCatalogService(context, gateway);
  const app = new Hono<AppEnvironment>();
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code, message: error.message } }, error.status) : c.json({ error: 'internal' }, 500));
  app.use('*', async (c, next) => {
    if (c.req.header('x-fixture-user') === 'admin') c.set('user', administrator);
    if (c.req.header('x-fixture-user') === 'member') c.set('user', { ...administrator, role: 'member' });
    await next();
  });
  accessModule.register(app, context);
  registerGatewayCatalogRoutes(app, context, gateway);
  return { context, gateway, catalog, connectionId, fetchImpl, app, setPayload(value: unknown) { payload = value; }, advance(ms: number) { instant += ms; } };
}

function apiParent(context: ServerContext, withDevice: boolean) {
  const now = context.clock.now().toISOString();
  const id = context.ids.id();
  const token = context.ids.token(32);
  const projectId = context.ids.id();
  const deviceId = withDevice ? context.ids.id() : null;
  const expiresAt = new Date(context.clock.now().getTime() + 60 * 60_000).toISOString();
  context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, administrator.teamId, projectId, administrator.id, now, now);
  if (deviceId) context.database.prepare('INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(deviceId, administrator.id, administrator.teamId, 'fixture', hashToken(context.ids.token(32)), JSON.stringify(['gateway:manage']), now, new Date(context.clock.now().getTime() + 2 * 60 * 60_000).toISOString());
  context.database.prepare('INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at, device_token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, administrator.id, projectId, hashToken(token), JSON.stringify({ projectId, permissions: ['gateway:manage'] }), now, expiresAt, deviceId);
  const credential: AuthenticatedCredential = { tokenId: id, projectId, userId: administrator.id, permissions: ['gateway:manage'] };
  return { id, token, projectId, deviceId, credential, expiresAt };
}

describe('CLIProxy catalog fixtures', () => {
  it('parses both supported shapes and discards all other metadata', () => {
    expect(parseCliProxyCatalog(standard)).toMatchObject({ shape: 'openai', models: [{ modelKey: 'model-a', declared: { contextWindow: 128_000 }, compatibility: { codex: false } }, { modelKey: 'model-b' }] });
    expect(parseCliProxyCatalog(rich)).toMatchObject({ shape: 'codex', models: [{ modelKey: 'model-a', displayName: 'Model A', declared: { contextWindow: 200_000, maxOutputTokens: 32_000, inputModalities: ['image', 'text'], reasoningLevels: ['high'], capabilities: { tools: true } }, compatibility: { codex: true } }] });
    const output = JSON.stringify(parseCliProxyCatalog({ models: [{ ...rich.models[0], display_name: 'Bearer opaque-fixture secret=hidden-fixture https://user:pass@host.invalid/path?key=leak', description: 'private text', base_instructions: 'private prompt', metadata: { api_key: 'forbidden-fixture' }, credentials: 'forbidden-fixture', capabilities: { tools: true, api_key: 'forbidden-fixture' } }] }));
    for (const secret of ['opaque-fixture', 'hidden-fixture', 'user:pass', 'key=leak', 'private text', 'private prompt', 'forbidden-fixture', 'Untrusted instructions']) expect(output).not.toContain(secret);
  });

  it('rejects malformed, ambiguous, duplicate, oversized and secret-bearing identifiers', () => {
    for (const value of [null, [], {}, { data: [{}] }, { models: [{}] }, { data: 'not an array' }, { data: [], models: [] }, { models: [{ slug: 'a', id: 'b' }] }, { data: [{ id: 'a' }, { id: 'a' }] }, { data: [{ id: 'Bearer credential' }] }, { data: [{ id: 'sk-secretvalue123' }] }, { data: [{ id: 'a', context_window: -1 }] }, { data: [], metadata: 'x'.repeat(512 * 1024) }, { data: Array.from({ length: 2049 }, (_, i) => ({ id: `model-${i}` })) }]) {
      expect(() => parseCliProxyCatalog(value)).toThrow(HttpError);
    }
    expect(parseCliProxyCatalog({ data: [] }).models).toEqual([]);
    expect(parseCliProxyCatalog({ models: [{ slug: 'only-id' }] }).models[0]?.modelKey).toBe('only-id');
  });

  it('hashes sorted sanitized content and produces deterministic model diffs', () => {
    const before = parseCliProxyCatalog(standard).models;
    const reordered = parseCliProxyCatalog({ data: [...standard.data].reverse() }).models;
    expect(catalogContentHash(before)).toBe(catalogContentHash(reordered));
    const after = parseCliProxyCatalog({ data: [{ id: 'model-a', context_window: 200_000 }, { id: 'model-c' }] }).models;
    expect(diffCatalogModels(before, after)).toEqual({ added: ['model-c'], removed: ['model-b'], changed: ['model-a'] });
    expect(parseCliProxyCatalog({ models: [{ slug: 'ordered', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] }] }).models[0]?.declared.reasoningLevels).toEqual(['low', 'medium', 'high']);
  });
});

describe('Gateway catalog persistence and policy', () => {
  it('serves legacy capability values as unknown without rewriting stored evidence', async () => {
    const { catalog, context, app, connectionId } = setup();
    const view = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    const modelId = view.models[0]!.modelId;
    const legacy = JSON.stringify({ text: true, tools: true, vision: false, reasoning: 'unsupported', streaming: 'supported', json: { unverified: true } });
    context.database.prepare('UPDATE models SET measured_capabilities_json = ? WHERE id = ?').run(legacy, modelId);
    const response = await app.request(`/api/gateway/connections/${connectionId}/catalog`, { headers: { 'x-fixture-user': 'admin' } });
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<{ modelId: string; measuredCapabilities: Record<string, string> }> };
    expect(body.models.find((model) => model.modelId === modelId)?.measuredCapabilities).toEqual({ tools: 'unknown', vision: 'unknown', reasoning: 'unsupported', streaming: 'supported', json: 'unknown' });
    expect(context.database.prepare('SELECT measured_capabilities_json FROM models WHERE id = ?').get(modelId)).toEqual({ measured_capabilities_json: legacy });
    for (const encoded of ['null', '[]', 'invalid-json']) {
      context.database.prepare('UPDATE models SET measured_capabilities_json = ? WHERE id = ?').run(encoded, modelId);
      expect(catalog.view(connectionId, 'team-1').models.find((model) => model.modelId === modelId)?.measuredCapabilities).toEqual({});
    }
  });

  it('appends immutable snapshots and preserves enablement and measured capability authority across removal', async () => {
    const { catalog, context, connectionId, setPayload } = setup();
    expect(catalog.view(connectionId, 'team-1')).toMatchObject({ status: 'unobserved', stale: true, snapshot: null });
    const first = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(first.models.every((model) => !model.enabled)).toBe(true);
    expect(first.snapshot?.diff).toEqual({ added: ['model-a', 'model-b'], removed: [], changed: [] });
    const modelId = first.models[0]!.modelId;
    catalog.setPolicy(connectionId, 'team-1', modelId, true, administrator.id);
    context.database.prepare('UPDATE models SET measured_capabilities_json = ? WHERE id = ?').run(JSON.stringify({ tools: 'unsupported' }), modelId);
    setPayload(rich);
    const second = await catalog.refresh(connectionId, 'team-1', { clientVersion: '0.100.0' }, administrator.id);
    expect(second.models.find((model) => model.modelId === modelId)).toMatchObject({ enabled: true, available: true, declared: { capabilities: { tools: true } }, measuredCapabilities: { tools: 'unsupported' } });
    expect(second.models.find((model) => model.modelKey === 'model-b')).toMatchObject({ available: false, enabled: false });
    expect(second.snapshot?.diff).toEqual({ added: [], removed: ['model-b'], changed: ['model-a'] });
    expect(second.snapshot?.source).toMatchObject({ connectionId, providerId: first.providerId, endpoint: '/v1/models?client_version=0.100.0', shape: 'codex' });
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_catalog_snapshots').get()).toEqual({ count: 2 });
    expect(() => context.database.prepare("UPDATE gateway_catalog_snapshots SET models_json = '[]' WHERE id = ?").run(first.snapshot!.id)).toThrow('immutable');
    expect(() => context.database.prepare('DELETE FROM gateway_catalog_snapshots WHERE id = ?').run(first.snapshot!.id)).toThrow('immutable');
    setPayload({ data: [] });
    await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(catalog.projection(connectionId, 'team-1', 'generic').data).toEqual([]);
    setPayload(standard);
    const restored = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(restored.models[0]).toMatchObject({ modelId, enabled: true, measuredCapabilities: { tools: 'unsupported' } });
  });

  it('preserves last good state on invalid and upstream failures, and ages a successful snapshot', async () => {
    const { catalog, connectionId, setPayload, advance, fetchImpl } = setup();
    const good = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    advance(CATALOG_STALE_AFTER_MS);
    expect(catalog.view(connectionId, 'team-1')).toMatchObject({ stale: true, status: 'stale' });
    setPayload({ data: [{ id: 'duplicate' }, { id: 'duplicate' }] });
    const failed = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(failed).toMatchObject({ stale: true, status: 'error', lastSuccessAt: good.lastSuccessAt, snapshot: { id: good.snapshot?.id }, error: { code: 'catalog_duplicate_model' } });
    fetchImpl.mockRejectedValueOnce(new Error('Bearer must-never-leak'));
    const unavailable = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(unavailable.snapshot?.id).toBe(good.snapshot?.id);
    expect(JSON.stringify(unavailable)).not.toContain('must-never-leak');
    setPayload(standard);
    expect(await catalog.refresh(connectionId, 'team-1', {}, administrator.id)).toMatchObject({ stale: false, status: 'current', error: null });
  });

  it('uses only the distinct catalog credential and rejects oversized, redirect and slow-body reads', async () => {
    const { context, connectionId, catalog, fetchImpl } = setup();
    await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe('http://127.0.0.1:8787/v1/models');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { authorization: 'Bearer catalog-fixture' } });
    for (const response of [new Response('x'.repeat(512 * 1024 + 1)), new Response(null, { status: 302, headers: { location: 'http://untrusted.invalid' } })]) {
      fetchImpl.mockResolvedValueOnce(response);
      expect(await catalog.refresh(connectionId, 'team-1', {}, administrator.id)).toMatchObject({ stale: true, status: 'error' });
    }
    const hanging = new GatewayService(context, { timeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    const slow = new GatewayCatalogService(context, hanging);
    expect(await slow.refresh(connectionId, 'team-1', {}, administrator.id)).toMatchObject({ stale: true, status: 'error' });
    context.database.prepare('UPDATE gateway_connections SET catalog_secret_id = NULL WHERE id = ?').run(connectionId);
    fetchImpl.mockClear();
    expect(await catalog.refresh(connectionId, 'team-1', {}, administrator.id)).toMatchObject({ status: 'current', snapshot: { source: { credentialScope: 'anonymous' } } });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
  });

  it('rolls back snapshots and model imports if audit append fails', async () => {
    const { context, catalog, connectionId } = setup();
    context.database.exec(`CREATE TRIGGER catalog_audit_failure BEFORE INSERT ON audit_records WHEN NEW.action = 'gateway.catalog.refresh' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await expect(catalog.refresh(connectionId, 'team-1', {}, administrator.id)).rejects.toThrow('audit unavailable');
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_catalog_snapshots').get()).toEqual({ count: 0 });
    expect(context.database.prepare('SELECT count(*) AS count FROM models').get()).toEqual({ count: 0 });
  });

  it('marks changed connection provenance stale and excludes it until refreshed', async () => {
    const { context, catalog, connectionId, fetchImpl } = setup();
    const first = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    catalog.setPolicy(connectionId, 'team-1', first.models[0]!.modelId, true, administrator.id);
    expect(catalog.projection(connectionId, 'team-1', 'generic').data).toHaveLength(1);
    context.database.prepare('UPDATE gateway_connections SET revision = revision + 1 WHERE id = ?').run(connectionId);
    expect(catalog.view(connectionId, 'team-1')).toMatchObject({ status: 'stale', stale: true, sourceMatchesConnection: false, snapshot: { id: first.snapshot!.id } });
    expect(catalog.projection(connectionId, 'team-1', 'generic').data).toEqual([]);
    fetchImpl.mockImplementationOnce(async () => {
      context.database.prepare('UPDATE gateway_connections SET revision = revision + 1 WHERE id = ?').run(connectionId);
      return new Response(JSON.stringify(standard));
    });
    await expect(catalog.refresh(connectionId, 'team-1', {}, administrator.id)).rejects.toThrow('changed during refresh');
    expect(catalog.view(connectionId, 'team-1').snapshot?.id).toBe(first.snapshot?.id);
    const current = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    expect(current).toMatchObject({ status: 'current', sourceMatchesConnection: true, snapshot: { source: { connectionRevision: 3 } } });
    expect(catalog.projection(connectionId, 'team-1', 'generic').data).toHaveLength(1);
  });
});

describe('scoped catalog projections', () => {
  it('requires a connection/client-scoped token, respects policy, and handles conditional/stale requests', async () => {
    const { catalog, app, context, connectionId, advance, setPayload } = setup();
    setPayload(rich);
    const view = await catalog.refresh(connectionId, 'team-1', { clientVersion: '0.100.0' }, administrator.id);
    const issued = catalog.createToken(connectionId, administrator, { name: 'OpenCode fixture', client: 'opencode', expiresInDays: 1 });
    expect(context.database.prepare('SELECT token_hash FROM gateway_catalog_tokens WHERE id = ?').get(issued.id)).toEqual({ token_hash: hashToken(issued.token) });
    expect(JSON.stringify(catalog.listTokens(connectionId, 'team-1'))).not.toContain(issued.token);
    const headers = { authorization: `Bearer ${issued.token}` };
    expect((await app.request(issued.endpoint)).status).toBe(401);
    expect((await app.request(issued.endpoint, { headers: { 'x-fixture-user': 'admin' } })).status).toBe(401);
    expect((await app.request(issued.endpoint.replace('/opencode', '/generic'), { headers })).status).toBe(401);
    expect((await app.request(issued.endpoint.replace(connectionId, 'other-connection'), { headers })).status).toBe(401);
    const disabled = await app.request(issued.endpoint, { headers });
    expect(await disabled.json()).toMatchObject({ schemaVersion: 1, client: 'opencode', models: {}, stale: false });
    catalog.setPolicy(connectionId, 'team-1', view.models[0]!.modelId, true, administrator.id);
    const enabled = await app.request(issued.endpoint, { headers });
    const body = await enabled.json();
    expect(body).toMatchObject({ models: { 'model-a': { id: 'model-a', name: 'Model A', limit: { context: 200_000, output: 32_000 } } } });
    for (const secret of ['management-fixture', 'catalog-fixture', issued.token, 'token_hash', 'nonce', 'ciphertext']) expect(JSON.stringify(body)).not.toContain(secret);
    const etag = enabled.headers.get('etag')!;
    const unchanged = await app.request(issued.endpoint, { headers: { ...headers, 'if-none-match': `W/${etag}` } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    advance(CATALOG_STALE_AFTER_MS);
    const stale = await app.request(issued.endpoint, { headers: { ...headers, 'if-none-match': etag } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-dhole-catalog-stale')).toBe('true');
    expect(await stale.json()).toMatchObject({ stale: true, status: 'stale' });
    catalog.revokeToken(connectionId, issued.id, administrator);
    expect((await app.request(issued.endpoint, { headers })).status).toBe(401);
  });

  it('expires credentials and revokes access when issuing membership or provider state changes', async () => {
    const { catalog, context, connectionId, app, advance } = setup();
    const view = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    catalog.setPolicy(connectionId, 'team-1', view.models[0]!.modelId, true, administrator.id);
    const issued = catalog.createToken(connectionId, administrator, { name: 'Generic', client: 'generic', expiresInDays: 1 });
    const headers = { authorization: `Bearer ${issued.token}` };
    context.database.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(view.providerId);
    expect(await (await app.request(issued.endpoint, { headers })).json()).toMatchObject({ data: [] });
    context.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(administrator.id);
    expect((await app.request(issued.endpoint, { headers })).status).toBe(401);
    context.database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ?").run(administrator.id);
    advance(86_400_000);
    expect((await app.request(issued.endpoint, { headers })).status).toBe(401);
  });

  it('denies team access and member policy/token mutations', async () => {
    const { catalog, app, connectionId } = setup();
    expect(() => catalog.view(connectionId, 'other-team')).toThrow('not found');
    const view = await catalog.refresh(connectionId, 'team-1', {}, administrator.id);
    const headers = { 'x-fixture-user': 'member', 'content-type': 'application/json' };
    expect((await app.request(`/api/gateway/connections/${connectionId}/catalog/models/${view.models[0]!.modelId}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) })).status).toBe(403);
    expect((await app.request(`/api/gateway/connections/${connectionId}/catalog/tokens`, { method: 'POST', headers, body: JSON.stringify({ name: 'No', client: 'generic' }) })).status).toBe(403);
  });

  it('authorizes active native users independently of an optional GitHub link', () => {
    const { catalog, context, connectionId } = setup();
    const issued = catalog.createToken(connectionId, administrator, { name: 'Identity check', client: 'generic', expiresInDays: 1 });
    expect(catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toBe(administrator.teamId);
    const now = context.clock.now().toISOString();
    context.database.prepare('INSERT INTO github_identities(user_id, github_user_id, login, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(administrator.id, 123, 'fixture-user', 'active', now, now);
    expect(catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toBe(administrator.teamId);
    context.database.prepare("UPDATE github_identities SET status = 'disabled' WHERE user_id = ?").run(administrator.id);
    expect(catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toBe(administrator.teamId);
    context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now, administrator.id);
    expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
  });
});

describe('catalog token authority inheritance', () => {
  it('binds agent issuance to API and device authority and permanently revokes descendants', async () => {
    const { context, catalog, app, connectionId } = setup();
    const parent = apiParent(context, true);
    const browser = catalog.createToken(connectionId, administrator, { name: 'Browser', client: 'generic', expiresInDays: 30 });
    const response = await app.request(`/api/gateway/connections/${connectionId}/catalog/tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${parent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent', client: 'generic', expiresInDays: 30 }),
    });
    expect(response.status).toBe(201);
    const issued = await response.json() as { id: string; token: string; endpoint: string; expiresAt: string };
    expect(issued.expiresAt).toBe(parent.expiresAt);
    expect(context.database.prepare('SELECT authority_kind, parent_api_token_id, parent_device_token_id FROM gateway_catalog_tokens WHERE id = ?').get(issued.id)).toEqual({ authority_kind: 'api', parent_api_token_id: parent.id, parent_device_token_id: parent.deviceId });
    expect((await app.request(issued.endpoint, { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(200);
    context.database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(context.clock.now().toISOString(), parent.deviceId);
    expect((await app.request(issued.endpoint, { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(401);
    context.database.prepare('UPDATE user_device_tokens SET revoked_at = NULL WHERE id = ?').run(parent.deviceId);
    expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
    expect(catalog.authenticate(connectionId, 'generic', `Bearer ${browser.token}`)).toBe(administrator.teamId);
    expect(() => context.database.prepare('UPDATE gateway_catalog_tokens SET revoked_at = NULL WHERE id = ?').run(issued.id)).toThrow('permanent');
    expect(() => context.database.prepare('UPDATE gateway_catalog_tokens SET parent_device_token_id = NULL WHERE id = ?').run(issued.id)).toThrow('immutable');
  });

  it('honors non-device API expiry, scope changes, and permanent explicit revocation', () => {
    for (const change of ['scope', 'revoke', 'expire'] as const) {
      const { catalog, context, connectionId } = setup();
      const parent = apiParent(context, false);
      const issued = catalog.createToken(connectionId, administrator, { name: 'API', client: 'generic', expiresInDays: 30 }, parent.credential);
      expect(issued.expiresAt).toBe(parent.expiresAt);
      expect(catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toBe(administrator.teamId);
      if (change === 'scope') context.database.prepare('UPDATE api_tokens SET scopes_json = ? WHERE id = ?').run(JSON.stringify({ permissions: ['gateway:read'] }), parent.id);
      if (change === 'revoke') context.database.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(context.clock.now().toISOString(), parent.id);
      if (change === 'expire') context.database.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(context.clock.now().toISOString(), parent.id);
      expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow();
      if (change === 'revoke') {
        context.database.prepare('UPDATE api_tokens SET revoked_at = NULL WHERE id = ?').run(parent.id);
        expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
      }
    }
  });

  it('caps device expiry and rejects current device scope loss at issuance and use', () => {
    const { catalog, context, connectionId } = setup();
    const parent = apiParent(context, true);
    const deviceExpiry = new Date(context.clock.now().getTime() + 30 * 60_000).toISOString();
    context.database.prepare('UPDATE user_device_tokens SET expires_at = ? WHERE id = ?').run(deviceExpiry, parent.deviceId);
    const issued = catalog.createToken(connectionId, administrator, { name: 'Device', client: 'generic', expiresInDays: 30 }, parent.credential);
    expect(issued.expiresAt).toBe(deviceExpiry);
    context.database.prepare('UPDATE user_device_tokens SET permissions_json = ? WHERE id = ?').run(JSON.stringify(['gateway:read']), parent.deviceId);
    expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
    expect(() => catalog.createToken(connectionId, administrator, { name: 'Forbidden', client: 'generic', expiresInDays: 1 }, parent.credential)).toThrow('parent authorization');
    context.database.prepare('UPDATE user_device_tokens SET permissions_json = ? WHERE id = ?').run(JSON.stringify(['gateway:manage']), parent.deviceId);
    expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
  });

  it('permanently revokes browser tokens on password reset, disablement, and demotion', () => {
    for (const change of ['password', 'disable', 'demote'] as const) {
      const { catalog, context, connectionId } = setup();
      const issued = catalog.createToken(connectionId, administrator, { name: 'Browser', client: 'generic', expiresInDays: 30 });
      if (change === 'password') context.database.prepare("UPDATE users SET password_hash = 'new-fixture-hash' WHERE id = ?").run(administrator.id);
      if (change === 'disable') {
        context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(context.clock.now().toISOString(), administrator.id);
        context.database.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(administrator.id);
      }
      if (change === 'demote') {
        context.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(administrator.id);
        context.database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ?").run(administrator.id);
      }
      expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${issued.token}`)).toThrow('invalid or expired');
    }
  });

  it('revokes legacy catalog tokens whose issuing authority was not recorded', () => {
    const { context, connectionId, catalog } = setup(14);
    const token = context.ids.token(32);
    const id = context.ids.id();
    context.database.prepare('INSERT INTO gateway_catalog_tokens(id, connection_id, created_by, name, client, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, connectionId, administrator.id, 'Legacy', 'generic', hashToken(token), context.clock.now().toISOString(), '2099-01-01T00:00:00.000Z');
    migrateDatabase(context.database, context.clock);
    expect(context.database.prepare('SELECT authority_kind, revoked_at FROM gateway_catalog_tokens WHERE id = ?').get(id)).toMatchObject({ authority_kind: 'legacy', revoked_at: expect.any(String) });
    expect(() => catalog.authenticate(connectionId, 'generic', `Bearer ${token}`)).toThrow('invalid or expired');
  });
});
