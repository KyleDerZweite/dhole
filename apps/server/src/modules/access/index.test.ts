import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { secureIds, systemClock } from '../../lib/clock.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { coreModule } from '../core/index.js';
import { hashToken } from '../../lib/security.js';
import type { AppConfig } from '../../lib/config.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { accessModule } from './index.js';

const applications: Array<{ app: DholeApp; database: DatabaseConnection }> = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.database.close();
});

function config(): AppConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 4173,
    databasePath: ':memory:',
    publicOrigin: new URL('http://127.0.0.1:4173'),
    allowedHosts: new Set(['127.0.0.1']),
    demo: false,
    masterKeys: new Map(),
    gatewayAllowedHosts: new Set(['127.0.0.1']),
  };
}

function fixture(options: { admin?: boolean; cookie?: boolean; liveSession?: boolean; cookieAuthorizationCheck?: () => void } = {}): { app: DholeApp; context: ServerContext; database: DatabaseConnection; token: string; userId: string; teamId: string; projectId: string } {
  const database = openDatabase(':memory:', systemClock);
  const ids = secureIds;
  const teamId = ids.id();
  const userId = ids.id();
  const projectId = ids.id();
  const now = systemClock.now().toISOString();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, 'test team', now);
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, 'access@example.invalid', 'Access User', 'not-a-password', now, now);
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(teamId, userId, 'member', now);
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, teamId, 'test project', userId, now, now);

  const context: ServerContext = { config: config(), database, clock: systemClock, ids, events: new EventStore(database, systemClock, ids) };
  const token = ids.token(32);
  database.prepare('INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    ids.id(), userId, projectId, hashToken(token), JSON.stringify({ projectId, permissions: ['project:read'] }), now, new Date(systemClock.now().getTime() + 60_000).toISOString(),
  );

  const app = new Hono() as DholeApp;
  app.onError((error, requestContext) => error instanceof HttpError
    ? requestContext.json({ error: { code: error.code } }, error.status)
    : requestContext.json({ error: { code: 'internal_error' } }, 500));
  if (options.liveSession) coreModule.register(app, context);
  if (options.admin) {
    app.use('/api/admin/*', async (requestContext, next) => {
      requestContext.set('user', { id: userId, email: 'access@example.invalid', displayName: 'Access User', role: 'administrator', teamId });
      await next();
    });
  }
  if (options.cookie) {
    app.use('/api/*', async (requestContext, next) => {
      if (requestContext.req.header('cookie')) requestContext.set('user', { id: userId, email: 'access@example.invalid', displayName: 'Access User', role: 'administrator', teamId });
      if (options.cookieAuthorizationCheck) requestContext.set('assertAuthorizationCurrent', options.cookieAuthorizationCheck);
      await next();
    });
  }
  accessModule.register(app, context);
  app.get('/api/projects/:projectId/state', (requestContext) => requestContext.json({ ok: true }));
  applications.push({ app, database });
  return { app, context, database, token, userId, teamId, projectId };
}

function insertRun(fixtureValue: ReturnType<typeof fixture>): string {
  const { context, database, projectId, userId } = fixtureValue;
  const now = context.clock.now().toISOString();
  const sessionId = context.ids.id();
  const runId = context.ids.id();
  database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'idle\', ?, ?, ?)').run(sessionId, projectId, 'audit session', userId, now, now);
  database.prepare('INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'queued\', ?, ?, ?)').run(runId, sessionId, 'audit objective', userId, now, now);
  return runId;
}

interface AuditRow {
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: string;
  detail_json: string;
}

async function requestState(app: DholeApp, projectId: string, token: string): Promise<Response> {
  return await app.request(`/api/projects/${projectId}/state`, { headers: { authorization: `Bearer ${token}` } });
}

function delayedJson(input: unknown): { body: ReadableStream<Uint8Array>; reading: Promise<void>; release: () => void } {
  const reading = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reading.resolve();
      await released.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { body, reading: reading.promise, release: () => released.resolve() };
}

describe('compatibility bearer authentication', () => {
  it('accepts a token while its user is an active member of the project team', async () => {
    const { app, projectId, token } = fixture();
    expect((await requestState(app, projectId, token)).status).toBe(200);
  });

  it('rejects a token after its user is disabled', async () => {
    const { app, context, projectId, token, userId } = fixture();
    context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(context.clock.now().toISOString(), userId);
    const response = await requestState(app, projectId, token);
    expect(response.status).toBe(401);
  });

  it('does not let a session cookie elevate an invalid or insufficient bearer token', async () => {
    const { app, database, projectId, token } = fixture({ cookie: true });
    app.post('/api/projects/:projectId/claims', (c) => c.json({ ok: true }));
    const cookie = 'dhole_session=test-browser-session';
    expect((await app.request(`/api/projects/${projectId}/claims`, { method: 'POST', headers: { cookie } })).status).toBe(200);
    expect((await app.request(`/api/projects/${projectId}/claims`, { method: 'POST', headers: { cookie, authorization: `Bearer ${token}` } })).status).toBe(403);
    for (const authorization of ['Bearer invalid-token', 'Bearer', 'Basic invalid', '']) {
      expect((await app.request(`/api/projects/${projectId}/state`, { headers: { cookie, authorization } })).status).toBe(401);
    }
    database.prepare('UPDATE api_tokens SET revoked_at = created_at').run();
    expect((await app.request(`/api/projects/${projectId}/state`, { headers: { cookie, authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it.each(['token', 'device', 'permissions', 'project', 'role'] as const)('rejects a delayed mutation after %s authorization changes', async (change) => {
    const { app, context, database, projectId, token, userId, teamId } = fixture({ cookie: true, cookieAuthorizationCheck: () => { throw new Error('Bearer authentication must replace the cookie check'); } });
    const now = context.clock.now().toISOString();
    const parentId = context.ids.id();
    database.prepare(`INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(parentId, userId, teamId, 'test device', hashToken(context.ids.token(32)), '["coordination:write"]', now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    database.prepare('UPDATE api_tokens SET scopes_json = ?, device_token_id = ?').run(JSON.stringify({ projectId, permissions: ['coordination:write'] }), parentId);
    let mutated = false;
    app.post('/api/projects/:projectId/claims', async (c) => {
      await parseJson(c, z.object({ name: z.string() }));
      mutated = true;
      return c.json({ ok: true });
    });
    const delayed = delayedJson({ name: 'claim' });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: delayed.body, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, cookie: 'dhole_session=stale-cookie' } };
    const response = app.request(new Request(`http://localhost/api/projects/${projectId}/claims`, init));
    await delayed.reading;
    if (change === 'token') database.prepare('UPDATE api_tokens SET revoked_at = ?').run(now);
    if (change === 'device') database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(now, parentId);
    if (change === 'permissions') database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['project:read'] }));
    if (change === 'project') {
      const creatorId = context.ids.id();
      database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(creatorId, 'creator@example.invalid', 'New owner', 'not-a-password', now, now);
      database.prepare("UPDATE projects SET created_by = ?, visibility = 'private' WHERE id = ?").run(creatorId, projectId);
    }
    if (change === 'role') database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ? AND team_id = ?").run(userId, teamId);
    delayed.release();
    expect((await response).status).toBe(change === 'permissions' || change === 'project' ? 403 : 401);
    expect(mutated).toBe(false);
  });

  it('uses the bearer recheck when a request also has a stale cookie', async () => {
    const { app, database, projectId, token } = fixture({ cookie: true, cookieAuthorizationCheck: () => { throw new HttpError(401, 'session_invalid', 'Session revoked'); } });
    database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['coordination:write'] }));
    app.post('/api/projects/:projectId/claims', async (c) => c.json(await parseJson(c, z.object({ name: z.string() }))));
    const response = await app.request(`/api/projects/${projectId}/claims`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, cookie: 'dhole_session=stale-cookie' }, body: JSON.stringify({ name: 'claim' }) });
    expect(response.status).toBe(200);
  });

  it('does not issue an API token after the administrator session is revoked during the body upload', async () => {
    const { app, context, database, projectId, userId, teamId } = fixture({ liveSession: true });
    const now = context.clock.now().toISOString();
    database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ? AND team_id = ?").run(userId, teamId);
    const sessionToken = context.ids.token(32);
    const csrfToken = context.ids.token(32);
    database.prepare(`INSERT INTO web_sessions(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(context.ids.id(), userId, hashToken(sessionToken), hashToken(csrfToken), now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    const delayed = delayedJson({ projectId, permissions: ['project:read'] });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: delayed.body, headers: { 'content-type': 'application/json', cookie: `dhole_session=${sessionToken}`, 'x-csrf-token': csrfToken } };
    const response = app.request(new Request('http://localhost/api/admin/tokens', init));
    await delayed.reading;
    database.prepare('UPDATE web_sessions SET revoked_at = ?').run(now);
    delayed.release();
    expect((await response).status).toBe(401);
    expect(database.prepare('SELECT count(*) AS count FROM api_tokens').get()).toEqual({ count: 1 });
  });

  it('rejects cross-project tokens and unregistered compatibility operations', async () => {
    const { app, database, projectId, token } = fixture();
    app.post('/api/projects/:projectId/sessions/:id/arbitrary-command', (c) => c.json({ ok: true }));
    app.post('/api/projects/:projectId/claims/:id/revive', (c) => c.json({ ok: true }));
    expect((await requestState(app, 'other-project', token)).status).toBe(403);
    expect((await app.request(`/api/projects/${projectId}/sessions/example/arbitrary-command`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.request(`/api/projects/${projectId}/claims/example/revive`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['coordination:write'] }));
    expect((await app.request(`/api/projects/${projectId}/claims/example/revive`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('rechecks the parent device token and its user/team binding on every request', async () => {
    const { app, context, database, projectId, token, userId, teamId } = fixture();
    const id = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare(`INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, teamId, 'test device', hashToken(context.ids.token(32)), '["project:read"]', now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    database.prepare('UPDATE api_tokens SET device_token_id = ?').run(id);
    expect((await requestState(app, projectId, token)).status).toBe(200);
    database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(now, id);
    expect((await requestState(app, projectId, token)).status).toBe(401);
    database.prepare('UPDATE user_device_tokens SET revoked_at = NULL, expires_at = ? WHERE id = ?').run(now, id);
    expect((await requestState(app, projectId, token)).status).toBe(401);
    const otherTeamId = context.ids.id();
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(otherTeamId, 'unrelated team', now);
    database.prepare('UPDATE user_device_tokens SET team_id = ?, expires_at = ? WHERE id = ?').run(otherTeamId, new Date(context.clock.now().getTime() + 60_000).toISOString(), id);
    expect((await requestState(app, projectId, token)).status).toBe(401);
  });

  it('keeps native API authorization independent of an optional GitHub link', async () => {
    const { app, context, database, projectId, token, userId } = fixture();
    expect((await requestState(app, projectId, token)).status).toBe(200);
    const now = context.clock.now().toISOString();
    database.prepare(`INSERT INTO github_identities(user_id, github_user_id, login, status, created_at, updated_at)
      VALUES (?, 123, 'access-user', 'active', ?, ?)`).run(userId, now, now);
    expect((await requestState(app, projectId, token)).status).toBe(200);
    database.prepare("UPDATE github_identities SET status = 'disabled' WHERE user_id = ?").run(userId);
    expect((await requestState(app, projectId, token)).status).toBe(200);
    database.prepare('DELETE FROM github_identities WHERE user_id = ?').run(userId);
    expect((await requestState(app, projectId, token)).status).toBe(200);
  });

  it.each([false, true])('rechecks native project grants for API tokens with run scope %s', async (runScoped) => {
    const value = fixture();
    const { app, context, database, projectId, token, userId } = value;
    const now = context.clock.now().toISOString();
    const creatorId = context.ids.id();
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(creatorId, 'creator@example.invalid', 'Project creator', 'not-a-password', now, now);
    database.prepare("UPDATE projects SET created_by = ?, visibility = 'private' WHERE id = ?").run(creatorId, projectId);
    database.prepare("INSERT INTO project_members(project_id, user_id, role, created_by, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?, ?)").run(projectId, userId, creatorId, now, now);
    database.prepare('UPDATE api_tokens SET scopes_json = ?, run_id = ?').run(JSON.stringify({ projectId, permissions: ['project:read', 'coordination:write'] }), runScoped ? insertRun(value) : null);
    app.post('/api/projects/:projectId/claims', (c) => c.json({ ok: true }));
    const write = () => app.request(`/api/projects/${projectId}/claims`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect((await requestState(app, projectId, token)).status).toBe(200);
    expect((await write()).status).toBe(200);
    database.prepare("UPDATE project_members SET role = 'viewer' WHERE project_id = ? AND user_id = ?").run(projectId, userId);
    expect((await requestState(app, projectId, token)).status).toBe(200);
    expect((await write()).status).toBe(403);
    database.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    expect((await requestState(app, projectId, token)).status).toBe(403);
    expect((await write()).status).toBe(403);
  });

  it('rejects a token when its user is no longer a member of the project team', async () => {
    const { app, context, database, projectId, token, userId, teamId } = fixture();
    const otherTeamId = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(otherTeamId, 'other team', now);
    database.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
    database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(otherTeamId, userId, 'member', now);
    const response = await requestState(app, projectId, token);
    expect(response.status).toBe(401);
  });

  it('admits only scoped fleet-admin bearer tokens to credential rotation paths', async () => {
    const { app, context, database, teamId, token: readToken, userId } = fixture();
    const now = context.clock.now().toISOString();
    database.prepare('UPDATE team_members SET role = \'administrator\' WHERE team_id = ? AND user_id = ?').run(teamId, userId);
    const machineId = context.ids.id();
    database.prepare('INSERT INTO machines(id, team_id, name, status, created_at, updated_at) VALUES (?, ?, ?, \'enrolled\', ?, ?)').run(machineId, teamId, 'rotation-node', now, now);
    const fleetToken = context.ids.token(32);
    const projectId = (database.prepare('SELECT id FROM projects WHERE team_id = ? LIMIT 1').get(teamId) as { id: string }).id;
    database.prepare('INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      context.ids.id(), userId, projectId, hashToken(fleetToken), JSON.stringify({ projectId, permissions: ['fleet:admin'] }), now, new Date(context.clock.now().getTime() + 60_000).toISOString(),
    );
    app.post('/api/fleet/machines/:machineId/credential/replace', (requestContext) => requestContext.json({ ok: true }));
    const denied = await app.request(`/api/fleet/machines/${machineId}/credential/replace`, { method: 'POST', headers: { authorization: `Bearer ${readToken}` } });
    expect(denied.status).toBe(403);
    const admitted = await app.request(`/api/fleet/machines/${machineId}/credential/replace`, { method: 'POST', headers: { authorization: `Bearer ${fleetToken}` } });
    expect(admitted.status).toBe(200);
  });

  it('maps gateway reads, ingestion, and management to separate permissions', async () => {
    const { app, context, database, projectId, userId, teamId, token } = fixture({ cookie: true });
    const routes = [
      ['GET', '/api/gateway/connections', 'gateway:read'],
      ['GET', '/api/gateway/requests', 'gateway:read'],
      ['GET', '/api/gateway/requests/export', 'gateway:read'],
      ['GET', '/api/gateway/usage', 'gateway:read'],
      ['GET', '/api/gateway/connections/example/collection', 'gateway:read'],
      ['GET', '/api/gateway/connections/example/catalog', 'gateway:read'],
      ['GET', '/api/gateway/connections/example/config', 'gateway:read'],
      ['POST', '/api/gateway/connections/example/ingest', 'gateway:ingest'],
      ['POST', '/api/gateway/connections', 'gateway:manage'],
      ['PATCH', '/api/gateway/connections/example', 'gateway:manage'],
      ['DELETE', '/api/gateway/connections/example', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/config/apply', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/secrets', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/health', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/sync', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/prune', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/catalog/refresh', 'gateway:manage'],
      ['PATCH', '/api/gateway/connections/example/catalog/models/model', 'gateway:manage'],
      ['GET', '/api/gateway/connections/example/catalog/tokens', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/catalog/tokens', 'gateway:manage'],
      ['DELETE', '/api/gateway/connections/example/catalog/tokens/token', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/oauth', 'gateway:manage'],
      ['GET', '/api/gateway/connections/example/oauth/flow', 'gateway:manage'],
      ['POST', '/api/gateway/connections/example/oauth/flow/callback', 'gateway:manage'],
      ['DELETE', '/api/gateway/connections/example/oauth/flow', 'gateway:manage'],
    ] as const;
    database.prepare("UPDATE team_members SET role = 'administrator' WHERE team_id = ? AND user_id = ?").run(teamId, userId);
    for (const [method, path] of routes) app.on(method, path, (c) => c.json({ user: c.get('user'), credential: c.get('credential') }));
    for (const [method, path, permission] of routes) {
      const headers = { authorization: `Bearer ${token}`, cookie: 'dhole_session=test-browser-session' };
      database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['project:read'] }));
      expect((await app.request(path, { method, headers })).status, `${method} ${path} without ${permission}`).toBe(403);
      database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: [permission] }));
      const allowed = await app.request(path, { method, headers });
      expect(allowed.status, `${method} ${path} with ${permission}`).toBe(200);
      expect(await allowed.json()).toMatchObject({ user: { id: userId, teamId }, credential: { projectId, permissions: [permission] } });
    }
    database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['gateway:read', 'gateway:manage', 'gateway:ingest'] }));
    const runId = insertRun({ app, context, database, projectId, userId, teamId, token });
    database.prepare('UPDATE api_tokens SET run_id = ?').run(runId);
    for (const [method, path] of routes) {
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    }
    database.prepare('UPDATE api_tokens SET run_id = NULL').run();
    database.prepare("UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?").run(teamId, userId);
    for (const [method, path, permission] of routes) {
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${token}` } })).status).toBe(permission === 'gateway:read' ? 200 : 403);
    }
  });

  it('does not grant gateway permissions to arbitrary paths or methods', async () => {
    const { app, database, token, projectId, teamId, userId } = fixture({ cookie: true });
    database.prepare("UPDATE team_members SET role = 'administrator' WHERE team_id = ? AND user_id = ?").run(teamId, userId);
    database.prepare('UPDATE api_tokens SET scopes_json = ?').run(JSON.stringify({ projectId, permissions: ['gateway:read', 'gateway:manage', 'gateway:ingest'] }));
    app.all('/api/gateway/*', (c) => c.json({ ok: true }));
    for (const [method, path] of [
      ['POST', '/api/gateway/connections/example/api-call'],
      ['POST', '/api/gateway/connections/example/management/api-call'],
      ['PUT', '/api/gateway/connections/example/config'],
      ['GET', '/api/gateway/connections/example/secrets'],
      ['DELETE', '/api/gateway/connections/example/catalog'],
      ['POST', '/api/gateway/requests/export'],
      ['GET', '/api/gateway/fixture-arbitrary'],
    ] as const) {
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${token}`, cookie: 'dhole_session=test-browser-session' } })).status).toBe(401);
    }
  });

  it('delegates only exact catalog GET routes to the dedicated credential guard', async () => {
    const { app, token } = fixture({ cookie: true });
    const catalogToken = 'dedicated-catalog-token';
    app.all('/api/gateway/catalog/*', (c) => {
      if (hashToken(c.req.header('authorization') ?? '') !== hashToken(`Bearer ${catalogToken}`)) throw new HttpError(401, 'catalog_token_invalid', 'Catalog token required');
      return c.json({ dedicatedGuard: true, apiCredential: c.get('credential') ?? null });
    });
    for (const format of ['generic', 'opencode', 'codex']) {
      const path = `/api/gateway/catalog/v1/example/${format}`;
      const allowed = await app.request(path, { headers: { authorization: `Bearer ${catalogToken}` } });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ dedicatedGuard: true, apiCredential: null });
      expect((await app.request(path, { headers: { authorization: `Bearer ${token}`, cookie: 'dhole_session=test-browser-session' } })).status).toBe(401);
      expect((await app.request(path, { headers: { cookie: 'dhole_session=test-browser-session' } })).status).toBe(401);
      expect((await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${catalogToken}` } })).status).toBe(401);
    }
    for (const path of ['/api/gateway/catalog/v1/example/unknown', '/api/gateway/catalog/v1/example/generic/extra', '/api/gateway/catalog/v1/example/generic/']) {
      expect((await app.request(path, { headers: { authorization: `Bearer ${catalogToken}` } })).status).toBe(401);
    }
  });

  it('registers the self-authenticating device endpoints without opening other auth paths', async () => {
    const { app } = fixture();
    app.post('/api/auth/device/arbitrary', (c) => c.json({ ok: true }));
    const started = await app.request('/api/auth/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machineName: 'test machine' }) });
    expect(started.status).toBe(201);
    const denied = await app.request('/api/auth/device/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'manual', projectId: 'example' }) });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: 'device_token_invalid' } });
    expect((await app.request('/api/auth/device/arbitrary', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/auth/device/start')).status).toBe(401);
    expect((await app.request('/api/auth/devices')).status).toBe(403);
  });

  it('audits token creation and revocation without storing token secrets', async () => {
    const fixtureValue = fixture({ admin: true });
    const runId = insertRun(fixtureValue);
    const created = await fixtureValue.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: fixtureValue.projectId, runId, permissions: ['coordination:write'] }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; token: string };
    const createAudit = fixtureValue.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE action = 'api_token.create' AND target_id = ?").get(body.id) as AuditRow;
    expect(createAudit).toMatchObject({ actor_type: 'user', actor_id: fixtureValue.userId, action: 'api_token.create', target_type: 'api_token', target_id: body.id, outcome: 'allowed' });
    expect(JSON.parse(createAudit.detail_json)).toEqual({ projectId: fixtureValue.projectId, runId, permissions: ['coordination:write'] });
    const auditBeforeRevoke = JSON.stringify(fixtureValue.database.prepare('SELECT * FROM audit_records').all());
    expect(auditBeforeRevoke).not.toContain(body.token);
    expect(auditBeforeRevoke).not.toContain(hashToken(body.token));

    const legacySecret = 'Bearer legacy-audit-secret';
    fixtureValue.database.prepare('UPDATE api_tokens SET scopes_json = ? WHERE id = ?').run(JSON.stringify({ projectId: fixtureValue.projectId, runId, permissions: ['coordination:write', legacySecret] }), body.id);
    const revoked = await fixtureValue.app.request(`/api/admin/tokens/${body.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    const revokeAudit = fixtureValue.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE action = 'api_token.revoke' AND target_id = ?").get(body.id) as AuditRow;
    expect(revokeAudit).toMatchObject({ actor_type: 'user', actor_id: fixtureValue.userId, action: 'api_token.revoke', target_type: 'api_token', target_id: body.id, outcome: 'allowed' });
    expect(JSON.parse(revokeAudit.detail_json)).toEqual({ projectId: fixtureValue.projectId, runId, permissions: ['coordination:write'] });
    const auditAfterRevoke = JSON.stringify(fixtureValue.database.prepare('SELECT * FROM audit_records').all());
    expect(auditAfterRevoke).not.toContain(body.token);
    expect(auditAfterRevoke).not.toContain(hashToken(body.token));
    expect(auditAfterRevoke).not.toContain(legacySecret);
  });

  it('checks native project write access before issuing a token with mutation permissions', async () => {
    const { app, context, database, projectId, userId } = fixture({ admin: true });
    const now = context.clock.now().toISOString();
    const creatorId = context.ids.id();
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(creatorId, 'creator@example.invalid', 'Project creator', 'not-a-password', now, now);
    database.prepare("UPDATE projects SET created_by = ?, visibility = 'private' WHERE id = ?").run(creatorId, projectId);
    database.prepare("INSERT INTO project_members(project_id, user_id, role, created_by, created_at, updated_at) VALUES (?, ?, 'viewer', ?, ?, ?)").run(projectId, userId, creatorId, now, now);
    const create = (permissions: string[]) => app.request('/api/admin/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, permissions }) });
    expect((await create(['projects:create'])).status).toBe(422);
    expect((await create(['project:read'])).status).toBe(201);
    expect((await create(['project:read', 'coordination:write'])).status).toBe(404);
    database.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND user_id = ?").run(projectId, userId);
    expect((await create(['coordination:write'])).status).toBe(201);
    database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now, userId);
    expect((await create(['project:read'])).status).toBe(404);
  });

  it('rolls back token mutations when immutable audit persistence fails', async () => {
    const fixtureValue = fixture({ admin: true });
    fixtureValue.database.exec(`CREATE TRIGGER fail_api_token_create_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'api_token.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const failedCreate = await fixtureValue.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: fixtureValue.projectId, permissions: ['project:read'] }),
    });
    expect(failedCreate.status).toBe(500);
    expect(fixtureValue.database.prepare('SELECT count(*) AS count FROM api_tokens WHERE project_id = ?').get(fixtureValue.projectId)).toEqual({ count: 1 });
    fixtureValue.database.exec('DROP TRIGGER fail_api_token_create_audit');

    const created = await fixtureValue.app.request('/api/admin/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: fixtureValue.projectId, permissions: ['project:read'] }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string };
    fixtureValue.database.exec(`CREATE TRIGGER fail_api_token_revoke_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'api_token.revoke' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const failedRevoke = await fixtureValue.app.request(`/api/admin/tokens/${body.id}`, { method: 'DELETE' });
    expect(failedRevoke.status).toBe(500);
    expect(fixtureValue.database.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(body.id)).toEqual({ revoked_at: null });
  });
});
