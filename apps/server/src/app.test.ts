import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from './lib/config.js';
import { createApplication, type DholeApplication } from './app.js';

const applications: DholeApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

function config(): AppConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 4173,
    databasePath: ':memory:',
    publicOrigin: new URL('http://127.0.0.1:4173'),
    sourceUrl: new URL('https://github.com/example/dhole/tree/v0.1.0'),
    allowedHosts: new Set(['127.0.0.1']),
    demo: true,
    masterKeys: new Map(),
    gatewayAllowedHosts: new Set(['127.0.0.1', 'localhost']),
  };
}

async function authenticated(application: DholeApplication): Promise<{ cookie: string; csrf: string }> {
  const response = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
    method: 'POST',
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.dhole.local', password: 'DholeDemoAdmin!2026' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  return {
    csrf: body.csrfToken,
    cookie: values.flatMap((value) => value.split(/,(?=\s*dhole_)/u)).map((value) => value.split(';')[0]).join('; '),
  };
}

describe('integrated application', () => {
  it('hydrates cookie auth for modules and applies browser security headers', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const response = await application.app.request('http://127.0.0.1:4173/api/fleet/machines', { headers: { host: '127.0.0.1', cookie: auth.cookie } });
    expect(response.status).toBe(200);
    expect((await response.json() as unknown[]).length).toBeGreaterThan(0);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('keeps browser sessions and Mediation registration on the shared route', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const headers = { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };

    const browser = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', {
      method: 'POST', headers, body: JSON.stringify({ title: 'Browser session' }),
    });
    expect(browser.status).toBe(200);
    expect((await browser.json() as { title: string }).title).toBe('Browser session');

    const tokenResponse = await application.app.request('http://127.0.0.1:4173/api/admin/tokens', {
      method: 'POST', headers, body: JSON.stringify({ projectId: 'demo-project', permissions: ['project:read', 'coordination:write'] }),
    });
    expect(tokenResponse.status).toBe(201);
    const { token } = await tokenResponse.json() as { token: string };
    const mediation = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/sessions', {
      method: 'POST',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', worktree: 'demo-worktree' }),
    });
    expect(mediation.status).toBe(200);
    const registration = await mediation.json() as { capability?: string; session?: { capability?: string } };
    expect(registration.capability ?? registration.session?.capability).toBeTruthy();

    const mcp = await application.app.request('http://127.0.0.1:4173/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1:4173',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }),
    });
    expect(mcp.status).toBe(200);
    expect((await mcp.json() as { result?: { protocolVersion?: string } }).result?.protocolVersion).toBe('2026-07-28');
  });

  it('denies unauthenticated project coordination state', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const response = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/state', { headers: { host: '127.0.0.1' } });
    expect(response.status).toBe(401);
  });

  it('serves the license notices and redirects to the source code', async () => {
    const application = createApplication({ config: config(), seed: false });
    applications.push(application);
    const headers = { host: '127.0.0.1' };

    const source = await application.app.request('http://127.0.0.1:4173/source', { headers });
    expect(source.status).toBe(302);
    expect(source.headers.get('location')).toBe('https://github.com/example/dhole/tree/v0.1.0');

    const license = await application.app.request('http://127.0.0.1:4173/LICENSE', { headers });
    expect(license.status).toBe(200);
    expect(await license.text()).toContain('MIT License');

    const notices = await application.app.request('http://127.0.0.1:4173/THIRD_PARTY_NOTICES.md', { headers });
    expect(notices.status).toBe(200);
    expect(await notices.text()).toContain('# Dhole third-party notices');
  });
});
