import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../../lib/config.js';
import { secureIds } from '../../lib/clock.js';
import { EventStore } from '../../lib/events.js';
import { openDatabase } from '../../lib/database.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { coreModule } from './core.js';
import { getGithubIdentity, GithubOAuth } from './github.js';

const PASSWORD = 'A local account password 2026';
const databases: ServerContext['database'][] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

function setup(github = true, production = false) {
  let now = new Date('2026-09-05T12:00:00Z');
  let identity: unknown = { id: 42, login: 'owner' };
  const clock = { now: () => now };
  const database = openDatabase(':memory:', clock);
  databases.push(database);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'ephemeral-oauth-value', token_type: 'bearer' });
    if (String(url) === 'https://api.github.com/user') return Response.json(identity);
    throw new Error('Unexpected outbound request');
  });
  vi.stubGlobal('fetch', fetcher);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:' });
  const context: ServerContext = {
    config: {
      ...config,
      environment: production ? 'production' : 'test',
      publicOrigin: new URL(production ? 'https://dhole.example' : 'http://127.0.0.1:4173'),
      ...(production ? { passwordBootstrapToken: 'operator-bootstrap-secret-fixture-with-at-least-43-characters' } : {}),
      ...(github ? { githubAuth: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' } } : {}),
    },
    database, clock, ids: secureIds, events: new EventStore(database, clock, secureIds),
  };
  const app = new Hono<AppEnvironment>();
  coreModule.register(app, context);
  app.onError((error) => error instanceof HttpError ? Response.json({ error: { code: error.code, message: error.message } }, { status: error.status }) : Response.json({ error: 'internal' }, { status: 500 }));
  return { app, context, fetcher, setIdentity: (value: unknown) => { identity = value; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

function cookie(response: Response, name: string): string {
  return response.headers.get('set-cookie')?.match(new RegExp(`(?:^|, )(${name}=[^;]*)`))?.[1] ?? '';
}
function sessionCookies(response: Response): string {
  return [cookie(response, 'dhole_session'), cookie(response, 'dhole_csrf')].filter(Boolean).join('; ');
}
interface Account { cookie: string; csrfToken: string; userId: string; email: string }
async function bootstrap(f: ReturnType<typeof setup>): Promise<Account> {
  const email = 'owner@example.test';
  const response = await f.app.request('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', ...(f.context.config.passwordBootstrapToken ? { 'x-dhole-bootstrap-token': f.context.config.passwordBootstrapToken } : {}) }, body: JSON.stringify({ email, displayName: 'Owner', password: PASSWORD }) });
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string }; csrfToken: string };
  return { cookie: sessionCookies(response), csrfToken: body.csrfToken, userId: body.user.id, email };
}
function headers(account: Account) { return { cookie: account.cookie, 'x-csrf-token': account.csrfToken, 'content-type': 'application/json' }; }
async function start(f: ReturnType<typeof setup>, account: Account) {
  const response = await f.app.request('/api/auth/github/link', { method: 'POST', headers: headers(account), body: JSON.stringify({ currentPassword: PASSWORD }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { authorizeUrl: string };
  const url = new URL(body.authorizeUrl);
  return { response, url, cookie: `${account.cookie}; ${cookie(response, 'dhole_github_state')}`, state: url.searchParams.get('state')! };
}
async function link(f: ReturnType<typeof setup>, account: Account) {
  const pending = await start(f, account);
  return await f.app.request(`/api/auth/github/callback?state=${pending.state}&code=fixture-code`, { headers: { cookie: pending.cookie } });
}
async function member(f: ReturnType<typeof setup>, owner: Account): Promise<Account> {
  const email = 'member@example.test';
  const created = await f.app.request('/api/users', { method: 'POST', headers: headers(owner), body: JSON.stringify({ email, displayName: 'Member', password: PASSWORD }) });
  expect(created.status).toBe(201);
  const response = await f.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string }; csrfToken: string };
  return { cookie: sessionCookies(response), csrfToken: body.csrfToken, userId: body.user.id, email };
}

describe('native accounts and optional GitHub linking', () => {
  it('keeps native login primary and protects production bootstrap with an operator token', async () => {
    const f = setup(false, true);
    expect(await (await f.app.request('/api/auth/methods')).json()).toEqual({ mode: 'password', password: true, bootstrap: true, bootstrapTokenRequired: true, github: false, githubLink: false });
    const body = JSON.stringify({ email: 'attacker@example.test', displayName: 'Attacker', password: PASSWORD });
    for (const supplied of ['', 'wrong-token']) {
      const response = await f.app.request('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhole-bootstrap-token': supplied }, body });
      expect(response.status).toBe(403);
    }
    const owner = await bootstrap(f);
    expect(await (await f.app.request('/api/auth/methods')).json()).toMatchObject({ bootstrap: false, githubLink: false });
    expect((await f.app.request('/api/auth/me', { headers: headers(owner) })).status).toBe(200);
    expect((await f.app.request('/api/auth/github/login')).status).toBe(404);
    expect((await f.app.request('/api/auth/github/link', { method: 'POST', headers: headers(owner), body: JSON.stringify({ currentPassword: PASSWORD }) })).status).toBe(404);
    expect((await f.app.request('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dhole-bootstrap-token': f.context.config.passwordBootstrapToken! }, body })).status).toBe(409);
    const closed = setup(false, true);
    closed.context.config.passwordBootstrapToken = undefined;
    expect((await closed.app.request('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(404);
  });

  it('requires a native session, CSRF and fresh password before starting a link', async () => {
    const f = setup();
    expect((await f.app.request('/api/auth/github/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: PASSWORD }) })).status).toBe(401);
    const owner = await bootstrap(f);
    expect((await f.app.request('/api/auth/github/link', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: PASSWORD }) })).status).toBe(403);
    expect((await f.app.request('/api/auth/github/link', { method: 'POST', headers: headers(owner), body: JSON.stringify({ currentPassword: 'wrong-password' }) })).status).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('uses PKCE, same-browser Lax cookies and a fixed callback without storing OAuth tokens', async () => {
    const f = setup(true, true);
    const owner = await bootstrap(f);
    const pending = await start(f, owner);
    expect(pending.url.origin + pending.url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(pending.url.searchParams.get('redirect_uri')).toBe('https://dhole.example/api/auth/github/callback');
    expect(pending.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(pending.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    const response = await f.app.request(`/api/auth/github/callback?state=${pending.state}&code=fixture-code`, { headers: { cookie: pending.cookie } });
    expect(response.headers.get('location')).toBe('/?github=linked');
    expect(cookie(response, 'dhole_session')).toBe('');
    expect(getGithubIdentity(f.context, owner.userId)).toEqual({ githubUserId: 42, login: 'owner' });
    const exchange = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body)) as { code_verifier: string; redirect_uri: string };
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(pending.url.searchParams.get('code_challenge'));
    for (const [, init] of f.fetcher.mock.calls) { expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal); }
    expect(f.context.database.serialize().includes(Buffer.from('ephemeral-oauth-value'))).toBe(false);
    expect(f.context.database.serialize().includes(Buffer.from('fixture-client-secret'))).toBe(false);
    const me = await (await f.app.request('/api/auth/me', { headers: headers(owner) })).json();
    expect(me).toMatchObject({ user: { id: owner.userId, email: owner.email, displayName: 'Owner', status: 'active', role: 'administrator', github: { userId: 42, login: 'owner' } } });
  });

  it('rejects a missing browser binding, another native session, expired state and replay', async () => {
    // Seven real password KDF operations share CPU with the parallel server suite.
    const f = setup();
    const owner = await bootstrap(f);
    const other = await member(f, owner);
    for (const wrongCookie of [owner.cookie, other.cookie]) {
      const pending = await start(f, owner);
      const callback = `/api/auth/github/callback?state=${pending.state}&code=fixture-code`;
      expect((await f.app.request(callback, { headers: { cookie: wrongCookie } })).headers.get('location')).toBe('/?github=error');
      expect((await f.app.request(callback, { headers: { cookie: pending.cookie } })).headers.get('location')).toBe('/?github=error');
    }
    const expired = await start(f, owner);
    f.advance(10 * 60_000);
    expect((await f.app.request(`/api/auth/github/callback?state=${expired.state}&code=fixture-code`, { headers: { cookie: expired.cookie } })).headers.get('location')).toBe('/?github=error');
    expect(f.fetcher).not.toHaveBeenCalled();
    const pending = await start(f, owner);
    const callback = `/api/auth/github/callback?state=${pending.state}&code=fixture-code`;
    expect((await f.app.request(callback, { headers: { cookie: pending.cookie } })).headers.get('location')).toBe('/?github=linked');
    expect((await f.app.request(callback, { headers: { cookie: pending.cookie } })).headers.get('location')).toBe('/?github=error');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('does not create accounts or grant access through GitHub and preserves immutable link ownership', async () => {
    const f = setup();
    const owner = await bootstrap(f);
    const other = await member(f, owner);
    expect((await link(f, other)).headers.get('location')).toBe('/?github=linked');
    expect((await f.app.request('/api/users', { headers: headers(other) })).status).toBe(403);
    expect((await link(f, owner)).headers.get('location')).toBe('/?github=error');
    expect(getGithubIdentity(f.context, owner.userId)).toBeUndefined();
    f.setIdentity({ id: 43, login: 'owner' });
    expect((await link(f, other)).headers.get('location')).toBe('/?github=error');
    f.setIdentity({ id: 42, login: 'renamed-owner' });
    expect((await link(f, other)).headers.get('location')).toBe('/?github=linked');
    expect(getGithubIdentity(f.context, other.userId)).toEqual({ githubUserId: 42, login: 'renamed-owner' });
    expect(f.context.database.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 2 });
  });

  it('rechecks the native session after the GitHub request before attaching the identity', async () => {
    const f = setup();
    const owner = await bootstrap(f);
    const pending = await start(f, owner);
    f.fetcher.mockImplementation(async (url) => {
      if (String(url).includes('access_token')) return Response.json({ access_token: 'transient', token_type: 'bearer' });
      f.context.database.prepare('UPDATE web_sessions SET revoked_at = ?').run(f.context.clock.now().toISOString());
      return Response.json({ id: 42, login: 'owner' });
    });
    expect((await f.app.request(`/api/auth/github/callback?state=${pending.state}&code=fixture-code`, { headers: { cookie: pending.cookie } })).headers.get('location')).toBe('/?github=error');
    expect(getGithubIdentity(f.context, owner.userId)).toBeUndefined();
  });

  it('keeps the existing native account if linking audit persistence fails', async () => {
    const f = setup();
    const owner = await bootstrap(f);
    f.context.database.exec("CREATE TRIGGER reject_link_audit BEFORE INSERT ON audit_records WHEN NEW.action='auth.github.link' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await link(f, owner)).headers.get('location')).toBe('/?github=error');
    expect(getGithubIdentity(f.context, owner.userId)).toBeUndefined();
    expect((await f.app.request('/api/auth/me', { headers: headers(owner) })).status).toBe(200);
  });

  it('changes native passwords with session rotation and rejects old login credentials', async () => {
    const f = setup(false);
    const owner = await bootstrap(f);
    const nextPassword = 'Another native account password';
    expect((await f.app.request('/api/auth/password', { method: 'POST', headers: headers(owner), body: JSON.stringify({ currentPassword: 'wrong', newPassword: nextPassword }) })).status).toBe(401);
    const changed = await f.app.request('/api/auth/password', { method: 'POST', headers: headers(owner), body: JSON.stringify({ currentPassword: PASSWORD, newPassword: nextPassword }) });
    expect(changed.status).toBe(200);
    expect(sessionCookies(changed)).not.toBe(owner.cookie);
    expect((await f.app.request('/api/auth/me', { headers: headers(owner) })).status).toBe(401);
    expect((await f.app.request('/api/auth/me', { headers: { cookie: sessionCookies(changed) } })).status).toBe(200);
    for (const [password, status] of [[PASSWORD, 401], [nextPassword, 200]] as const) {
      expect((await f.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: owner.email, password }) })).status).toBe(status);
    }
  });

  it('disables native users and protects the last administrator independently of GitHub links', async () => {
    const f = setup(false);
    const owner = await bootstrap(f);
    const other = await member(f, owner);
    expect((await f.app.request(`/api/users/${other.userId}`, { method: 'PATCH', headers: headers(owner), body: JSON.stringify({ status: 'disabled' }) })).status).toBe(200);
    expect((await f.app.request('/api/auth/me', { headers: headers(other) })).status).toBe(401);
    for (const update of [{ status: 'disabled' }, { role: 'member' }]) expect((await f.app.request(`/api/users/${owner.userId}`, { method: 'PATCH', headers: headers(owner), body: JSON.stringify(update) })).status).toBe(409);
  });
});

describe('bounded GitHub OAuth boundary', () => {
  const binding = { userId: 'native-user', sessionHash: 'native-session-hash' };
  it.each([
    () => Response.json({ error: 'bad_verification_code', error_description: 'do-not-echo-provider-details' }),
    () => Response.json({ access_token: 'ephemeral-oauth-value', token_type: 'wrong' }),
    () => new Response('do-not-echo-provider-details', { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    () => new Response('x'.repeat(128 * 1024 + 1)),
    () => { throw new Error('do-not-echo-provider-details'); },
  ])('fails closed on token exchange errors without disclosing provider content', async (response) => {
    const f = setup();
    f.fetcher.mockImplementation(async () => response());
    const oauth = new GithubOAuth(f.context, f.fetcher);
    const pending = oauth.start(binding);
    await expect(oauth.complete(new URL(pending.authorizeUrl).searchParams.get('state')!, pending.browserToken, 'code', binding)).rejects.toThrow('GitHub sign-in failed');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ id: '42', login: 'owner' }, { id: Number.MAX_SAFE_INTEGER + 1, login: 'owner' }, { id: 42, login: '../owner' }])('rejects malformed provider identities', async (identity) => {
    const f = setup();
    f.setIdentity(identity);
    const oauth = new GithubOAuth(f.context, f.fetcher);
    const pending = oauth.start(binding);
    await expect(oauth.complete(new URL(pending.authorizeUrl).searchParams.get('state')!, pending.browserToken, 'code', binding)).rejects.toThrow('GitHub sign-in failed');
  });
  it('consumes denied authorization and aborts stalled exchanges after ten seconds', async () => {
    const f = setup();
    const oauth = new GithubOAuth(f.context, f.fetcher);
    const denied = oauth.start(binding);
    const deniedState = new URL(denied.authorizeUrl).searchParams.get('state')!;
    await expect(oauth.complete(deniedState, denied.browserToken, undefined, binding)).rejects.toThrow('not authorized');
    await expect(oauth.complete(deniedState, denied.browserToken, 'code', binding)).rejects.toThrow('expired');
    vi.useFakeTimers();
    f.fetcher.mockImplementation(async (_url, init) => await new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); }));
    const pending = oauth.start(binding);
    const completion = oauth.complete(new URL(pending.authorizeUrl).searchParams.get('state')!, pending.browserToken, 'code', binding);
    const assertion = expect(completion).rejects.toThrow('GitHub sign-in failed');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
