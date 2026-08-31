import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { secureIds, systemClock } from '../../lib/clock.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
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

function fixture(options: { admin?: boolean } = {}): { app: DholeApp; context: ServerContext; database: DatabaseConnection; token: string; userId: string; teamId: string; projectId: string } {
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
  if (options.admin) {
    app.use('/api/admin/*', async (requestContext, next) => {
      requestContext.set('user', { id: userId, email: 'access@example.invalid', displayName: 'Access User', role: 'administrator', teamId });
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
