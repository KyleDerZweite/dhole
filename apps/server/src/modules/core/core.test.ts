import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../../lib/config.js';
import { systemClock, secureIds } from '../../lib/clock.js';
import { EventStore } from '../../lib/events.js';
import { openDatabase } from '../../lib/database.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { coreModule, requireSessionParticipant } from './core.js';

function setup() {
  const database = openDatabase(':memory:', systemClock);
  const context: ServerContext = {
    config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' }),
    database,
    clock: systemClock,
    ids: secureIds,
    events: new EventStore(database, systemClock, secureIds),
  };
  const app = new Hono<AppEnvironment>();
  coreModule.register(app, context);
  app.get('/api/test/sessions/:sessionId', requireSessionParticipant, () => Response.json({ ok: true }));
  app.onError((error) => error instanceof Error ? Response.json({ error: error.message }, { status: (error as { status?: number }).status ?? 500 }) : Response.json({ error: 'internal' }, { status: 500 }));
  return { app, context };
}

async function json(app: Hono<AppEnvironment>, path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await app.request(path, init);
  const body = await response.json();
  return { response, body };
}

function cookies(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const session = header.match(/dhole_session=[^;]+/)?.[0];
  const csrf = header.match(/dhole_csrf=[^;]+/)?.[0];
  return [session, csrf].filter(Boolean).join('; ');
}

describe('core authentication and project boundary', () => {
  it('bootstraps an administrator, creates a member, and enforces CSRF and role checks', async () => {
    const { app } = setup();
    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', displayName: 'Admin', password: 'correct horse battery staple', teamName: 'Test team' }),
    });
    expect(bootstrap.response.status).toBe(201);
    const adminCookies = cookies(bootstrap.response);
    const csrf = bootstrap.body.csrfToken as string;

    const denied = await json(app, '/api/users', {
      method: 'POST',
      headers: { cookie: adminCookies, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', displayName: 'Member', password: 'another correct horse' }),
    });
    expect(denied.response.status).toBe(403);

    const created = await json(app, '/api/users', {
      method: 'POST',
      headers: { cookie: adminCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', displayName: 'Member', password: 'another correct horse' }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.user.passwordHash).toBeUndefined();

    const login = await json(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', password: 'another correct horse' }),
    });
    expect(login.response.status).toBe(200);
    expect(login.body.user.role).toBe('member');
  });

  it('requires JSON auth requests and rejects cross-origin bootstrap and login', async () => {
    const { app } = setup();
    const body = JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' });
    const crossOriginBootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body,
    });
    expect(crossOriginBootstrap.response.status).toBe(403);
    expect(crossOriginBootstrap.body.error.code).toBe('origin_denied');

    const invalidTypeBootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(invalidTypeBootstrap.response.status).toBe(400);
    expect(invalidTypeBootstrap.body.error.code).toBe('invalid_content_type');

    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(bootstrap.response.status).toBe(201);

    const loginBody = JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const crossOriginLogin = await json(app, '/api/auth/login', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: loginBody,
    });
    expect(crossOriginLogin.response.status).toBe(403);
    expect(crossOriginLogin.body.error.code).toBe('origin_denied');

    const invalidTypeLogin = await json(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: loginBody,
    });
    expect(invalidTypeLogin.response.status).toBe(400);
    expect(invalidTypeLogin.body.error.code).toBe('invalid_content_type');
  });

  it('does not trust forwarding headers for authentication rate limits', async () => {
    const { app } = setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await json(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${attempt}` },
        body: JSON.stringify({ email: 'missing@example.test', password: 'wrong password' }),
      });
      expect(response.response.status).toBe(401);
    }
    const limited = await json(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.200' },
      body: JSON.stringify({ email: 'missing@example.test', password: 'wrong password' }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('permits only one concurrent administrator bootstrap', async () => {
    const { app, context } = setup();
    const request = (email: string) => app.request('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, displayName: 'Owner', password: 'correct horse battery staple' }),
    });
    const responses = await Promise.all([request('first@example.test'), request('second@example.test')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(context.database.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect(context.database.prepare('SELECT count(*) AS count FROM teams').get()).toEqual({ count: 1 });
  });

  it('rejects login for disabled users', async () => {
    const { app, context } = setup();
    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'disabled@example.test', displayName: 'Disabled', password: 'correct horse battery staple' }),
    });
    const userId = bootstrap.body.user.id as string;
    context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
    const login = await json(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'disabled@example.test', password: 'correct horse battery staple' }),
    });
    expect(login.response.status).toBe(401);
    expect(login.body.error.code).toBe('invalid_credentials');
  });

  it('prevents a session participant IDOR while allowing a linked repository', async () => {
    const { app, context } = setup();
    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' }),
    });
    const ownerCookies = cookies(bootstrap.response);
    const csrf = bootstrap.body.csrfToken as string;
    const project = await json(app, '/api/projects', {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'repo project' }),
    });
    expect(project.response.status).toBe(201);
    const projectId = project.body.project.id as string;
    const repository = await json(app, `/api/projects/${projectId}/repositories`, {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'local', localPathHint: '/tmp/repo', defaultBranch: 'main' }),
    });
    expect(repository.response.status).toBe(201);
    expect(repository.body.repository.label).toBe('local');

    const sessionId = secureIds.id();
    context.database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sessionId, projectId, 'private', 'idle', bootstrap.body.user.id, new Date().toISOString(), new Date().toISOString());
    const created = await json(app, '/api/users', { method: 'POST', headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@example.test', displayName: 'Other', password: 'correct horse battery staple' }) });
    expect(created.response.status).toBe(201);
    const other = await json(app, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@example.test', password: 'correct horse battery staple' }) });
    const otherCookies = cookies(other.response);
    const idor = await json(app, `/api/test/sessions/${sessionId}`, { headers: { cookie: otherCookies } });
    expect(idor.response.status).toBe(404);
    const listed = await json(app, `/api/projects/${projectId}/repositories`, { headers: { cookie: ownerCookies } });
    expect(listed.response.status).toBe(200);
  });

  it('rejects project deletion without erasing append-only history', async () => {
    const { app, context } = setup();
    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' }),
    });
    const ownerCookies = cookies(bootstrap.response);
    const csrf = bootstrap.body.csrfToken as string;
    const project = await json(app, '/api/projects', {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'history project' }),
    });
    const projectId = project.body.project.id as string;
    context.events.transaction(() => {
      context.events.append({
        projectId,
        eventKind: 'run.started',
        aggregateType: 'run',
        aggregateId: secureIds.id(),
        actor: { type: 'user', userId: bootstrap.body.user.id as string },
        source: { kind: 'platform', adapter: 'core.test' },
        payload: { objective: 'preserve history' },
      });
    });
    const before = context.database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get(projectId) as { count: number };

    const deleted = await json(app, `/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf },
    });

    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error.code).toBe('project_deletion_not_supported');
    expect(context.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toEqual({ id: projectId });
    expect(context.database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get(projectId)).toEqual(before);
  });

  it('records project and repository actors and rolls back when audit persistence fails', async () => {
    const { app, context } = setup();
    const bootstrap = await json(app, '/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' }),
    });
    const ownerCookies = cookies(bootstrap.response);
    const csrf = bootstrap.body.csrfToken as string;
    const project = await json(app, '/api/projects', {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'audited project' }),
    });
    expect(project.response.status).toBe(201);
    const projectId = project.body.project.id as string;
    expect(context.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id FROM audit_records WHERE action = 'project.create'").get()).toMatchObject({
      actor_type: 'user', actor_id: bootstrap.body.user.id, action: 'project.create', target_type: 'project', target_id: projectId,
    });

    const repository = await json(app, `/api/projects/${projectId}/repositories`, {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'audited repo', localPathHint: '/tmp/repo' }),
    });
    expect(repository.response.status).toBe(201);
    expect(context.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id FROM audit_records WHERE action = 'repository.register'").get()).toMatchObject({
      actor_type: 'user', actor_id: bootstrap.body.user.id, action: 'repository.register', target_type: 'repository', target_id: repository.body.repository.id,
    });

    context.database.exec(`CREATE TRIGGER fail_project_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'project.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const failed = await json(app, '/api/projects', {
      method: 'POST',
      headers: { cookie: ownerCookies, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'must rollback' }),
    });
    expect(failed.response.status).toBe(500);
    expect(context.database.prepare("SELECT count(*) AS count FROM projects WHERE name = 'must rollback'").get()).toEqual({ count: 0 });
  });
});
