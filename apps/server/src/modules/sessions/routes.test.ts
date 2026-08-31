import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../lib/config.js';
import { createApplication, type DholeApplication } from '../../app.js';

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

async function login(application: DholeApplication): Promise<{ headers: Record<string, string> }> {
  const response = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
    method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.dhole.local', password: 'DholeDemoAdmin!2026' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  const cookie = values.flatMap((value) => value.split(/,(?=\s*dhole_)/u)).map((value) => value.split(';')[0]).join('; ');
  return { headers: { host: '127.0.0.1', cookie, 'x-csrf-token': body.csrfToken, 'content-type': 'application/json' } };
}

describe('session routes', () => {
  it('does not let a coordination-only bearer create a human session, but keeps compatibility registration available', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await login(application);
    const tokenResponse = await application.app.request('http://127.0.0.1:4173/api/admin/tokens', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ projectId: 'demo-project', permissions: ['coordination:write'] }),
    });
    expect(tokenResponse.status).toBe(201);
    const { token } = await tokenResponse.json() as { token: string };
    const bearer = { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const before = application.context.database.prepare('SELECT count(*) AS count FROM sessions WHERE project_id = ?').get('demo-project') as { count: number };
    const human = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', {
      method: 'POST', headers: bearer, body: JSON.stringify({ title: 'must not be created' }),
    });
    expect(human.status).toBe(403);
    const after = application.context.database.prepare('SELECT count(*) AS count FROM sessions WHERE project_id = ?').get('demo-project') as { count: number };
    expect(after.count).toBe(before.count);

    const compatibility = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', {
      method: 'POST', headers: bearer, body: JSON.stringify({ agent: 'compatibility-agent' }),
    });
    expect(compatibility.status).toBe(200);
  });

  it('scopes run-token session listing and blocks persistent session creation', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await login(application);
    const firstResponse = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', { method: 'POST', headers: auth.headers, body: JSON.stringify({ title: 'run-scoped' }) });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { id: string };
    const spoof = await application.app.request(`http://127.0.0.1:4173/api/sessions/${first.id}/messages/agent`, { method: 'POST', headers: auth.headers, body: JSON.stringify({ body: 'forged agent output' }) });
    expect(spoof.status).toBe(404);
    const malformedExpiry = await application.app.request(`http://127.0.0.1:4173/api/sessions/${first.id}/approvals`, { method: 'POST', headers: auth.headers, body: JSON.stringify({ kind: 'command', summary: 'bad expiry', expiresAt: 'tomorrow' }) });
    expect(malformedExpiry.status).toBe(422);
    const runResponse = await application.app.request(`http://127.0.0.1:4173/api/sessions/${first.id}/runs`, { method: 'POST', headers: auth.headers, body: JSON.stringify({ rootObjective: 'scoped' }) });
    expect(runResponse.status).toBe(200);
    const run = await runResponse.json() as { id: string };
    const secondResponse = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', { method: 'POST', headers: auth.headers, body: JSON.stringify({ title: 'other' }) });
    expect(secondResponse.status).toBe(200);
    const tokenResponse = await application.app.request('http://127.0.0.1:4173/api/admin/tokens', { method: 'POST', headers: auth.headers, body: JSON.stringify({ projectId: 'demo-project', runId: run.id, permissions: ['project:read', 'coordination:write'] }) });
    expect(tokenResponse.status).toBe(201);
    const { token } = await tokenResponse.json() as { token: string };
    const bearer = { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listed = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', { headers: bearer });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual([first.id]);
    const blocked = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', { method: 'POST', headers: bearer, body: JSON.stringify({ title: 'must be blocked' }) });
    expect(blocked.status).toBe(403);
    const mediation = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', { method: 'POST', headers: bearer, body: JSON.stringify({ agent: 'codex' }) });
    expect(mediation.status).toBe(200);
  });
});
