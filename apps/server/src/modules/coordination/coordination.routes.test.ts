import { afterEach, describe, expect, it } from 'vitest';
import { createApplication, type DholeApplication } from '../../app.js';
import type { AppConfig } from '../../lib/config.js';
import { hashToken } from '../../lib/security.js';
import { DEMO_IDS, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } from '../../demo/index.js';

const applications: DholeApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

function config(): AppConfig {
  return {
    environment: 'test', host: '127.0.0.1', port: 4173, databasePath: ':memory:', publicOrigin: new URL('http://127.0.0.1:4173'),
    allowedHosts: new Set(['127.0.0.1']), demo: true, masterKeys: new Map(), gatewayAllowedHosts: new Set(['127.0.0.1', 'localhost']),
  };
}

async function cookieAuth(application: DholeApplication): Promise<{ cookie: string; csrf: string }> {
  const response = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
    method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  return {
    csrf: body.csrfToken,
    cookie: values.flatMap((value) => value.split(/,(?=\s*dhole_)/u)).map((value) => value.split(';')[0]).join('; '),
  };
}

function issueToken(application: DholeApplication, token: string, runId?: string): void {
  const now = application.context.clock.now().toISOString();
  application.context.database.prepare(`
    INSERT INTO api_tokens(id, user_id, project_id, run_id, token_hash, scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `token-${token}`, DEMO_IDS.admin, DEMO_IDS.project, runId ?? null, hashToken(token),
    JSON.stringify({ projectId: DEMO_IDS.project, ...(runId ? { runId } : {}), permissions: ['project:read', 'coordination:write'] }),
    now, new Date(application.context.clock.now().getTime() + 60_000).toISOString(),
  );
}

describe('coordination HTTP authorization', () => {
  it('enforces run-scoped compatibility tokens and filters state', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const token = 'run-scoped-token';
    const runId = DEMO_IDS.run;
    issueToken(application, token, runId);
    application.context.database.prepare(`
      INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, intent, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 'in-progress', ?, ?)
    `).run('unscoped-claim', DEMO_IDS.project, DEMO_IDS.coordinationSessionA, 'outside run', application.context.clock.now().toISOString(), application.context.clock.now().toISOString());

    const state = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/state`, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
    });
    expect(state.status).toBe(200);
    const stateBody = await state.json() as { claims: Array<{ id: string; runId?: string }> };
    expect(stateBody.claims.some((claim) => claim.id === 'unscoped-claim')).toBe(false);
    expect(stateBody.claims.every((claim) => claim.runId === runId)).toBe(true);

    const projectToken = 'project-filter-token';
    issueToken(application, projectToken);
    const filtered = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/state?runId=${encodeURIComponent(runId)}`, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${projectToken}` },
    });
    expect(filtered.status).toBe(200);
    expect((await filtered.json() as { claims: Array<{ id: string }> }).claims.some((claim) => claim.id === 'unscoped-claim')).toBe(false);
    const full = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/state`, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${projectToken}` },
    });
    expect((await full.json() as { claims: Array<{ id: string }> }).claims.some((claim) => claim.id === 'unscoped-claim')).toBe(true);

    const mismatch = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/agent-events`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'outside-event', runId: 'other-run', agentId: 'agent', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json() as { error: { code: string } }).error.code).toBe('run_scope_denied');

    const releaseMismatch = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/claims/unknown/release?runId=other-run`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
    });
    expect(releaseMismatch.status).toBe(403);

    const registration = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'scoped-agent' }),
    });
    expect(registration.status).toBe(200);
    const session = await registration.json() as { id: string; capability: string };
    const claim = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/claims`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'x-session-capability': session.capability, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, intent: 'scoped claim' }),
    });
    expect(claim.status).toBe(200);
    expect((await claim.json() as { claim: { runId?: string } }).claim.runId).toBe(runId);
  });

  it('requires the coordination capability for session-bound mutations', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const token = 'project-token';
    issueToken(application, token);
    const response = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions/${DEMO_IDS.coordinationSessionA}/heartbeat`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ activity: 'unauthorized refresh' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('capability_required');
  });

  it('keeps run-scoped tokens inside their run for session and claim mutations', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const token = 'run-session-scope-token';
    const runId = DEMO_IDS.run;
    issueToken(application, token, runId);
    const registration = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'run-scoped-session' }),
    });
    expect(registration.status).toBe(200);
    const session = await registration.json() as { id: string; capability: string };
    const now = application.context.clock.now().toISOString();
    application.context.database.prepare(`
      INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run('other-run', DEMO_IDS.session, 'Other run', DEMO_IDS.admin, now, now);
    application.context.database.prepare(`
      INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, intent, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'in-progress', ?, ?)
    `).run('cross-run-claim', DEMO_IDS.project, session.id, 'other-run', 'outside run', now, now);

    const headers = { host: '127.0.0.1', authorization: `Bearer ${token}`, 'x-session-capability': session.capability, 'content-type': 'application/json' };
    const heartbeat = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions/${session.id}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ activity: 'forbidden' }),
    });
    expect(heartbeat.status).toBe(403);
    expect((await heartbeat.json() as { error: { code: string } }).error.code).toBe('run_scope_denied');
    const repo = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions/${session.id}/repo`, {
      method: 'POST', headers, body: JSON.stringify({ dirtyFiles: [] }),
    });
    expect(repo.status).toBe(403);
    const ended = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/sessions/${session.id}`, {
      method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' },
    });
    expect(ended.status).toBe(403);

    const patch = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/claims/cross-run-claim`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'testing' }),
    });
    expect(patch.status).toBe(403);
    expect((await patch.json() as { error: { code: string } }).error.code).toBe('run_scope_denied');
    const complete = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/claims/cross-run-claim/complete`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'done' }),
    });
    expect(complete.status).toBe(403);
    const release = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/claims/cross-run-claim/release`, {
      method: 'POST', headers,
    });
    expect(release.status).toBe(403);
  });

  it('denies cookie-authenticated users from another team project', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const now = application.context.clock.now().toISOString();
    application.context.database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('foreign-team', 'Foreign team', now);
    application.context.database.prepare(`
      INSERT INTO projects(id, team_id, name, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?)
    `).run('foreign-project', 'foreign-team', 'Foreign project', DEMO_IDS.admin, now, now);
    const auth = await cookieAuth(application);
    const response = await application.app.request('http://127.0.0.1:4173/api/projects/foreign-project/state', {
      headers: { host: '127.0.0.1', cookie: auth.cookie },
    });
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('project_not_found');
  });

  it('rejects oversized JSON before parsing', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const token = 'size-token';
    issueToken(application, token);
    const response = await application.app.request(`http://127.0.0.1:4173/api/projects/${DEMO_IDS.project}/agent-events`, {
      method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(513 * 1024) },
      body: '{}',
    });
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
  });
});
