import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createApplication, type DholeApplication } from '../app.js';
import { MachineService } from '../modules/core/machines/index.js';
import { SessionsService, getSessionsService } from '../modules/core/sessions/index.js';
import type { AppConfig } from './config.js';
import { createModuleHost } from './module-host.js';
import { selectModules, type DholeModule } from './module.js';
import { getSessionAuthentication, notifySessionAuthorizationChanged } from './session-auth.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

function application(enabledModules: readonly string[] = []): DholeApplication {
  const config: AppConfig = {
    environment: 'test', host: '127.0.0.1', port: 4173, databasePath: ':memory:',
    publicOrigin: new URL('http://127.0.0.1:4173'), allowedHosts: new Set(['127.0.0.1']),
    demo: false, masterKeys: new Map(), gatewayAllowedHosts: new Set(['127.0.0.1']), enabledModules,
  };
  const app = createApplication({ config });
  cleanups.push(() => app.close());
  return app;
}

async function request(app: DholeApplication, path: string, options: RequestInit = {}): Promise<Response> {
  return app.app.request(`http://127.0.0.1:4173${path}`, {
    ...options,
    headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', ...options.headers },
  });
}

async function authenticate(app: DholeApplication): Promise<{ cookie: string; csrf: string; userId: string }> {
  const response = await request(app, '/api/auth/bootstrap', {
    method: 'POST', body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { csrfToken: string; user: { id: string } };
  return { cookie: response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; '), csrf: body.csrfToken, userId: body.user.id };
}

async function host(app: DholeApplication): Promise<{ server: Server; url: string; runtime: ReturnType<typeof createModuleHost> }> {
  const server = createServer((_request, response) => response.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local test port');
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const runtime = createModuleHost(app, server);
  cleanups.push(() => runtime.close());
  return { server, url: `ws://127.0.0.1:${address.port}`, runtime };
}

function socket(url: string, cookie: string): WebSocket {
  const client = new WebSocket(url, { origin: 'http://127.0.0.1:4173', headers: { cookie } });
  cleanups.push(() => { if (client.readyState !== WebSocket.CLOSED) client.terminate(); });
  return client;
}

describe('optional module host', () => {
  it('runs only enabled lifecycle hooks and isolates failed jobs and cleanup', async () => {
    const app = application();
    const closed: string[] = [];
    const first = { maintenance: vi.fn(() => { throw new Error('retry later'); }), close: vi.fn(() => { closed.push('first'); }) };
    const second = { maintenance: vi.fn(), close: vi.fn(() => { closed.push('second'); throw new Error('close failed'); }) };
    const disabled: DholeModule = { id: 'disabled', register: vi.fn(), start: vi.fn() };
    const modules = selectModules([
      ...app.modules, disabled,
      { id: 'first', register: vi.fn(), start: () => first },
      { id: 'second', dependencies: ['first'], register: vi.fn(), start: () => second },
    ], ['core', 'access', 'first', 'second']);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { runtime } = await host({ ...app, modules });
    runtime.maintenance();
    expect(first.maintenance).toHaveBeenCalledOnce();
    expect(second.maintenance).toHaveBeenCalledOnce();
    expect(disabled.start).not.toHaveBeenCalled();
    runtime.close();
    expect(closed).toEqual(['second', 'first']);
    expect(clear).toHaveBeenCalledWith(intervals.mock.results[0]?.value);
    runtime.maintenance();
    runtime.close();
    expect(second.maintenance).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('cleans up prior lifecycles when a module fails to start', () => {
    const app = application();
    const close = vi.fn();
    const server = createServer();
    const modules: DholeModule[] = [
      ...app.modules,
      { id: 'first', register: vi.fn(), start: () => ({ close }) },
      { id: 'broken', register: vi.fn(), start: () => { throw new Error('private startup details'); } },
    ];
    expect(() => createModuleHost({ ...app, modules }, server)).toThrow('Module broken failed to start');
    expect(close).toHaveBeenCalledOnce();
    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('boots, authenticates and manages projects with only Core and Access', async () => {
    const app = application();
    expect((await request(app, '/health')).status).toBe(200);
    expect((await request(app, '/api/modules')).status).toBe(401);
    const auth = await authenticate(app);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    const created = await request(app, '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Core project' }) });
    expect(created.status).toBe(201);
    const listed = await request(app, '/api/projects', { headers });
    expect(JSON.stringify(await listed.json())).toContain('Core project');
    const catalog = await request(app, '/api/modules', { headers });
    const body = await catalog.json() as { enabledModules: string[]; modules: unknown[] };
    expect(body.enabledModules).toEqual(['core', 'access']);
    expect(JSON.stringify(body)).toContain('event-outbox');
    expect(JSON.stringify(body)).toContain('machine-maintenance');
    expect(JSON.stringify(body)).toContain('/ws/app');
    for (const path of ['/api/machines', '/api/fleet/machines', '/api/runtime/providers', '/api/runtime/registrations']) {
      expect((await request(app, path, { headers })).status, path).toBe(200);
    }
    const { project } = await created.json() as { project: { id: string } };
    const session = await request(app, `/api/projects/${project.id}/sessions`, { method: 'POST', headers, body: JSON.stringify({ title: 'Core session' }) });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ title: 'Core session' });
    for (const path of ['/api/gateway/connections', '/api/lab/benchmarks', '/api/projects/missing/memory', '/api/orchestration/profiles', '/mcp']) {
      expect((await request(app, path, { headers })).status, path).toBe(404);
    }
    expect(getSessionsService(app.context)).toBeInstanceOf(SessionsService);
    const fleet = vi.spyOn(MachineService.prototype, 'markStale');
    const sessions = vi.spyOn(SessionsService.prototype, 'maintenance');
    const outbox = vi.spyOn(app.context.events, 'flushOutbox');
    const { runtime } = await host(app);
    runtime.maintenance();
    expect(outbox).toHaveBeenCalledOnce();
    expect(fleet).toHaveBeenCalledOnce();
    expect(sessions).toHaveBeenCalledOnce();
    runtime.close();
    runtime.maintenance();
    expect(outbox).toHaveBeenCalledOnce();
    const login = await request(app, '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }) });
    expect(login.status).toBe(200);
  });

  it('rejects retired module IDs and supports Gateway alongside Core execution', async () => {
    for (const id of ['sessions', 'runtime', 'fleet', 'memory', 'lab', 'orchestration', 'skills']) {
      expect(() => application([id])).toThrow(`Unknown module id ${id}`);
    }
    expect(() => application(['unknown'])).toThrow('Unknown module id unknown');
    const app = application(['gateway']);
    const auth = await authenticate(app);
    expect((await request(app, '/api/gateway/connections', { headers: { cookie: auth.cookie } })).status).toBe(200);
    expect(app.modules.map((item) => item.id)).toEqual(['core', 'access', 'gateway']);
  });

  it('requires node authorization and rejects unknown socket endpoints', async () => {
    const app = application();
    const auth = await authenticate(app);
    const { url } = await host(app);
    for (const path of ['/ws/unknown', '/ws/node']) {
      const client = socket(`${url}${path}`, auth.cookie);
      const status = await new Promise<number>((resolve, reject) => {
        client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); client.terminate(); });
        client.once('error', () => undefined);
        client.once('open', () => reject(new Error('Disabled socket endpoint accepted upgrade')));
      });
      expect(status).toBe(path === '/ws/node' ? 401 : 404);
    }
  });

  it('closes a revoked browser socket immediately on logout and keeps other sessions active', async () => {
    const app = application();
    const auth = await authenticate(app);
    const secondLogin = await request(app, '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }) });
    const secondCookie = secondLogin.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { url } = await host(app);
    const client = socket(`${url}/ws/app`, auth.cookie);
    const other = socket(`${url}/ws/app`, secondCookie);
    await Promise.all([once(client, 'open'), once(other, 'open')]);
    const closed = once(client, 'close');
    const response = await request(app, '/api/auth/logout', { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf }, body: '{}' });
    expect(response.status).toBe(200);
    expect((await closed)[0]).toBe(1008);
    expect(other.readyState).toBe(WebSocket.OPEN);
    expect(getSessionAuthentication(app.context, auth.cookie)).toBeUndefined();
  });

  it.each(['expiry', 'disabled', 'role'] as const)('revalidates active sockets after %s without another client frame', async (change) => {
    const app = application();
    const auth = await authenticate(app);
    const { url } = await host(app);
    const client = socket(`${url}/ws/app`, auth.cookie);
    await once(client, 'open');
    const closed = once(client, 'close');
    if (change === 'expiry') app.context.database.prepare('UPDATE web_sessions SET expires_at = ? WHERE user_id = ?').run('2000-01-01T00:00:00.000Z', auth.userId);
    else if (change === 'disabled') app.context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(app.context.clock.now().toISOString(), auth.userId);
    else {
      app.context.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(auth.userId);
      notifySessionAuthorizationChanged(app.context);
    }
    expect((await closed)[0]).toBe(1008);
  });
});
