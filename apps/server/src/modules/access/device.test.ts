import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { secureIds, type Clock } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { hashToken } from '../../lib/security.js';
import { coreModule } from '../core/index.js';
import { createMachineService } from '../core/machines/index.js';
import { registerDeviceRoutes, revokeUserDeviceAuthorizations } from './device.js';

const databases: DatabaseConnection[] = [];
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
afterEach(() => { vi.unstubAllGlobals(); for (const database of databases.splice(0)) database.close(); });

function fixture(options: { github?: boolean; member?: boolean } = {}) {
  let time = Date.parse('2026-09-05T12:00:00.000Z');
  const clock: Clock = { now: () => new Date(time) };
  const database = openDatabase(':memory:', clock);
  databases.push(database);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:' });
  if (options.github) config.githubApp = { appId: '123', privateKey: key };
  const server: ServerContext = { config, database, clock, ids: secureIds, events: new EventStore(database, clock, secureIds) };
  const now = clock.now().toISOString();
  const teamId = secureIds.id();
  database.prepare('INSERT INTO teams(id,name,created_at) VALUES (?,?,?)').run(teamId, 'Device team', now);
  function user(email: string, role = 'administrator', team = teamId) {
    const id = secureIds.id();
    const token = secureIds.token();
    const csrf = secureIds.token();
    database.prepare('INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, email, email.split('@')[0], 'not-a-password', now, now);
    database.prepare('INSERT INTO team_members(team_id,user_id,role,created_at) VALUES (?,?,?,?)').run(team, id, role, now);
    database.prepare('INSERT INTO web_sessions(id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(secureIds.id(), id, hashToken(token), hashToken(csrf), now, now, new Date(time + 7 * 86400_000).toISOString());
    return { id, headers: { cookie: `dhole_session=${token}; dhole_csrf=${csrf}`, 'x-csrf-token': csrf } };
  }
  const owner = user('owner@example.invalid', options.member ? 'member' : 'administrator');
  const other = user('other@example.invalid');
  const projectId = secureIds.id();
  database.prepare('INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(projectId, teamId, 'Manual project', owner.id, now, now);
  if (options.github) database.prepare('INSERT INTO github_identities(user_id,github_user_id,login,status,created_at,updated_at) VALUES (?,?,?,\'active\',?,?)').run(owner.id, 42, 'octocat', now, now);
  const app = new Hono() as DholeApp;
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status)
    : error instanceof ZodError ? c.json({ error: { code: 'validation_failed' } }, 422)
      : c.json({ error: { code: 'internal_error', message: error.message } }, 500));
  coreModule.register(app, server);
  registerDeviceRoutes(app, server);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const start = async (permissions = ['project:read', 'coordination:write']) => {
    const response = await post('/api/auth/device/start', { machineName: 'test machine', permissions });
    expect(response.status).toBe(201);
    return await response.json() as { deviceCode: string; userCode: string; verificationUriComplete: string };
  };
  const authorize = async (permissions?: string[], approver = owner) => {
    const scopes = permissions ?? ['project:read', 'coordination:write', ...(options.github ? ['projects:create'] : [])];
    const request = await start(scopes);
    const approved = await post('/api/auth/device/approve', { userCode: request.userCode, permissions: scopes }, approver.headers);
    expect(approved.status).toBe(200);
    const polled = await post('/api/auth/device/poll', { deviceCode: request.deviceCode });
    expect(polled.status).toBe(200);
    const token = await polled.json() as { token: string; id: string; expiresAt: string };
    return { ...request, ...token, headers: { authorization: `Bearer ${token.token}` } };
  };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network disabled in fixture'); }));
  return { app, server, database, owner, other, teamId, projectId, user, post, start, authorize, advance: (ms: number) => { time += ms; } };
}

function githubFixture(options: { userId?: number; permission?: string; malformed?: boolean; status?: number } = {}) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (options.status) return Response.json({ message: 'fixture refusal' }, { status: options.status });
    if (path.endsWith('/installation')) return Response.json({ id: 7 });
    if (path === '/app/installations/7/access_tokens') {
      expect(JSON.parse(String(init?.body))).toEqual({ repositories: ['widget'], permissions: { metadata: 'read' } });
      return Response.json({ token: 'fixture-installation-secret', permissions: { metadata: 'read' } });
    }
    if (path.endsWith('/permission')) return Response.json({ permission: options.permission ?? 'write', user: { id: options.userId ?? 42 } });
    return Response.json(options.malformed ? { id: 'wrong' } : { id: 1001, full_name: 'acme/widget', default_branch: 'main' });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('machine authorization', () => {
  it('requires browser approval, hashes both codes, limits polls, redeems once, and never sends the machine token to the browser', async () => {
    const f = fixture();
    const request = await f.start();
    expect(request.userCode).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/u);
    expect(request.verificationUriComplete).toContain(`/connect?user_code=${request.userCode}`);
    const storage = JSON.stringify(f.database.prepare('SELECT * FROM device_authorization_requests').all());
    expect(storage).not.toContain(request.deviceCode);
    expect(storage).not.toContain(request.userCode.replace('-', ''));
    expect((await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode })).status).toBe(400);
    const rushed = await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode });
    expect(rushed.status).toBe(429);
    expect(await rushed.json()).toMatchObject({ error: { code: 'slow_down' } });
    expect((await f.post('/api/auth/device/approve', { userCode: request.userCode, permissions: ['project:read'] })).status).toBe(403);
    const review = await f.app.request(`/api/auth/device/requests/${request.userCode}`, { headers: f.owner.headers });
    expect(await review.json()).toMatchObject({ machineName: 'test machine', status: 'pending' });
    const approved = await f.post('/api/auth/device/approve', { userCode: request.userCode, permissions: ['project:read'] }, f.owner.headers);
    expect(await approved.json()).toEqual({ ok: true });
    expect((await f.post('/api/auth/device/approve', { userCode: request.userCode, permissions: ['project:read'] }, f.other.headers)).status).toBe(409);
    f.advance(5_000);
    expect((await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode }, f.owner.headers)).status).toBe(403);
    const polled = await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode });
    expect(polled.status).toBe(200);
    const token = await polled.json() as { token: string };
    expect((await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode })).status).toBe(400);
    const browser = await f.app.request('/api/auth/devices', { headers: f.owner.headers });
    const browserText = await browser.text();
    expect(browserText).toContain('test machine');
    expect(browserText).not.toContain(token.token);
    expect(browserText).not.toContain(hashToken(token.token));
    expect(JSON.stringify(f.database.prepare('SELECT * FROM audit_records').all())).not.toContain(token.token);
  });

  it('expires codes, bounds starts, enforces CSRF, and refuses unauthorized scopes', async () => {
    const f = fixture({ member: true });
    const request = await f.start(['project:read', 'fleet:admin']);
    const body = { userCode: request.userCode, permissions: ['fleet:admin'] };
    expect((await f.post('/api/auth/device/approve', body, f.owner.headers)).status).toBe(403);
    expect((await f.post('/api/auth/device/approve', { ...body, permissions: ['gateway:manage'] }, f.owner.headers)).status).toBe(403);
    expect((await f.post('/api/auth/device/approve', { ...body, permissions: ['project:read'] }, { cookie: f.owner.headers.cookie })).status).toBe(403);
    f.advance(600_000);
    const expired = await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode });
    expect(await expired.json()).toMatchObject({ error: { code: 'device_code_expired' } });
    for (let index = 0; index < 10; index++) await f.start();
    expect((await f.post('/api/auth/device/start', { machineName: 'one too many' })).status).toBe(429);
  });

  it('restricts project exchange to device permissions and current team membership, then revokes all derived tokens', async () => {
    const f = fixture();
    const device = await f.authorize();
    const body = { mode: 'manual', projectId: f.projectId };
    expect((await f.post('/api/auth/device/project', { ...body, projectId: 'made-up-project' }, device.headers)).status).toBe(403);
    expect((await f.post('/api/auth/device/project', { ...body, permissions: ['gateway:manage'] }, device.headers)).status).toBe(403);
    expect((await f.post('/api/auth/device/project', body, { ...device.headers, ...f.owner.headers })).status).toBe(403);
    const response = await f.post('/api/auth/device/project', body, device.headers);
    expect(response.status).toBe(201);
    const project = await response.json() as { id: string; token: string; projectId: string; expiresAt: string };
    expect(project.projectId).toBe(f.projectId);
    expect(Date.parse(project.expiresAt)).toBeLessThan(Date.parse(device.expiresAt));
    expect(f.database.prepare('SELECT token_hash,device_token_id FROM api_tokens WHERE id = ?').get(project.id)).toEqual({ token_hash: hashToken(project.token), device_token_id: device.id });
    expect((await f.app.request(`/api/auth/devices/${device.id}`, { method: 'DELETE', headers: f.other.headers })).status).toBe(404);
    expect((await f.app.request(`/api/auth/devices/${device.id}`, { method: 'DELETE', headers: f.owner.headers })).status).toBe(200);
    expect(f.database.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(project.id)).toEqual({ revoked_at: f.server.clock.now().toISOString() });
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(401);
  });

  it('rejects disabled users, removed membership and expired device tokens', async () => {
    const f = fixture();
    const device = await f.authorize();
    const body = { mode: 'manual', projectId: f.projectId };
    f.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(f.server.clock.now().toISOString(), f.owner.id);
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(401);
    f.database.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(f.owner.id);
    f.database.prepare('DELETE FROM team_members WHERE user_id = ?').run(f.owner.id);
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(401);
    f.database.prepare('INSERT INTO team_members(team_id,user_id,role,created_at) VALUES (?,?,\'administrator\',?)').run(f.teamId, f.owner.id, f.server.clock.now().toISOString());
    f.advance(91 * 86400_000);
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(401);
  });

  it('creates an owned private native project with unverified Codeberg metadata and idempotent retries', async () => {
    const f = fixture({ member: true });
    const device = await f.authorize(['projects:create', 'project:read', 'coordination:write']);
    const body = { name: 'Local research', repository: { label: 'Codeberg checkout', canonicalRemote: 'https://codeberg.org/example/research.git', defaultBranch: 'main' } };
    const headers = { ...device.headers, 'idempotency-key': 'project-creation-1' };
    const first = await f.post('/api/auth/device/projects', body, headers);
    expect(first.status).toBe(201);
    const created = await first.json() as { project: { id: string; createdBy: string }; repository: { id: string }; authorizationSource: string; repositoryVerification: string };
    expect(created).toMatchObject({ project: { createdBy: f.owner.id }, authorizationSource: 'native', repositoryVerification: 'unverified' });
    expect(f.database.prepare('SELECT visibility FROM projects WHERE id = ?').get(created.project.id)).toEqual({ visibility: 'private' });
    const repeated = await f.post('/api/auth/device/projects', body, headers);
    expect(await repeated.json()).toEqual(created);
    expect((await f.post('/api/auth/device/projects', { ...body, name: 'different' }, headers)).status).toBe(409);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM repositories WHERE project_id = ?').get(created.project.id)).toEqual({ count: 1 });
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: created.project.id }, device.headers)).status).toBe(201);
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: created.project.id, permissions: ['projects:create'] }, device.headers)).status).toBe(403);
    f.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(f.other.id);
    const other = await f.authorize(['project:read', 'coordination:write'], f.other);
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: created.project.id }, other.headers)).status).toBe(403);
    const now = f.server.clock.now().toISOString();
    f.database.prepare("INSERT INTO project_members(project_id,user_id,role,created_by,created_at,updated_at) VALUES (?,?,'viewer',?,?,?)").run(created.project.id, f.other.id, f.owner.id, now, now);
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: created.project.id, permissions: ['project:read'] }, other.headers)).status).toBe(201);
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: created.project.id }, other.headers)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires explicit native project creation scope and rolls back unsafe remote metadata', async () => {
    const f = fixture();
    const limited = await f.authorize();
    expect((await f.post('/api/auth/device/projects', { name: 'denied' }, limited.headers)).status).toBe(403);
    const device = await f.authorize(['projects:create']);
    const invalid = await f.post('/api/auth/device/projects', { name: 'unsafe remote', repository: { label: 'secret-bearing', canonicalRemote: 'https://token:private@codeberg.org/example/research' } }, device.headers);
    expect(invalid.status).toBe(422);
    expect(f.database.prepare("SELECT id FROM projects WHERE name = 'unsafe remote'").get()).toBeUndefined();
    expect((await f.post('/api/auth/device/projects', { name: 'private path', repository: { label: 'local', canonicalRemote: '/home/private/checkouts/research' } }, device.headers)).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies GitHub permission using a metadata-only App token and selects a stable project per repository', async () => {
    const f = fixture({ github: true });
    const device = await f.authorize();
    const fetcher = githubFixture();
    const first = await f.post('/api/auth/device/project', { mode: 'github', remote: 'git@github.com:acme/widget.git' }, device.headers);
    expect(first.status).toBe(201);
    const binding = await first.json() as { projectId: string; repositoryId: string; expiresAt: string };
    expect(Date.parse(binding.expiresAt) - f.server.clock.now().getTime()).toBe(300_000);
    const second = await f.post('/api/auth/device/project', { mode: 'github', remote: 'https://github.com/acme/widget.git' }, device.headers);
    expect(await second.json()).toMatchObject({ projectId: binding.projectId, repositoryId: binding.repositoryId, authorizationSource: 'github' });
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect((await f.post('/api/auth/device/project', { mode: 'manual', projectId: binding.projectId }, device.headers)).status).toBe(201);
    const allStorage = JSON.stringify(f.database.prepare('SELECT * FROM audit_records').all()) + JSON.stringify(f.database.prepare('SELECT * FROM api_tokens').all());
    expect(allStorage).not.toContain('fixture-installation-secret');
  });

  it('denies GitHub identity mismatch, read-only permission, unsupported remotes and unverifiable responses', async () => {
    const f = fixture({ github: true });
    const device = await f.authorize();
    const body = { mode: 'github', remote: 'acme/widget' };
    githubFixture({ userId: 999 });
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(403);
    githubFixture({ permission: 'read' });
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(403);
    const fetcher = githubFixture();
    expect((await f.post('/api/auth/device/project', { ...body, remote: 'https://evil.invalid/acme/widget' }, device.headers)).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
    githubFixture({ malformed: true });
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(503);
    githubFixture({ status: 500 });
    expect((await f.post('/api/auth/device/project', body, device.headers)).status).toBe(503);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM github_repository_bindings').get()).toEqual({ count: 0 });
  });

  it('does not turn verified GitHub push permission into membership of another native private project', async () => {
    const f = fixture({ github: true, member: true });
    const owner = await f.authorize();
    githubFixture();
    const first = await f.post('/api/auth/device/project', { mode: 'github', remote: 'acme/widget' }, owner.headers);
    expect(first.status).toBe(201);
    f.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(f.other.id);
    const now = f.server.clock.now().toISOString();
    f.database.prepare("INSERT INTO github_identities(user_id,github_user_id,login,status,created_at,updated_at) VALUES (?,99,'collaborator','active',?,?)").run(f.other.id, now, now);
    const other = await f.authorize(undefined, f.other);
    githubFixture({ userId: 99 });
    expect((await f.post('/api/auth/device/project', { mode: 'github', remote: 'acme/widget' }, other.headers)).status).toBe(403);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM github_repository_bindings').get()).toEqual({ count: 1 });
  });

  it('enrolls one machine, rotates its credential on repeated setup, and revokes its node access with authorization', async () => {
    const f = fixture();
    const device = await f.authorize(['project:read', 'coordination:write', 'fleet:admin']);
    const first = await f.post('/api/auth/device/enroll', {}, device.headers);
    expect(first.status).toBe(201);
    const enrolled = await first.json() as { machineId: string; credential: string };
    const fleet = createMachineService(f.server);
    expect(fleet.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(true);
    const second = await f.post('/api/auth/device/enroll', {}, device.headers);
    const rotated = await second.json() as { machineId: string; credential: string };
    expect(rotated.machineId).toBe(enrolled.machineId);
    expect(rotated.credential).not.toBe(enrolled.credential);
    expect(fleet.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(false);
    expect(fleet.authenticateNode(rotated.machineId, rotated.credential)).toBe(true);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM machines').get()).toEqual({ count: 1 });
    expect((await f.app.request(`/api/auth/devices/${device.id}`, { method: 'DELETE', headers: f.owner.headers })).status).toBe(200);
    expect(fleet.authenticateNode(rotated.machineId, rotated.credential)).toBe(false);
    const pairedAgain = await f.authorize(['fleet:admin']);
    const replacement = await f.post('/api/auth/device/enroll', {}, pairedAgain.headers);
    expect(replacement.status).toBe(201);
    const fresh = await replacement.json() as { machineId: string; machineName: string };
    expect(fresh.machineId).not.toBe(rotated.machineId);
    expect(fresh.machineName).toMatch(/^test machine-[a-f0-9]{8}$/u);
  });

  it('rechecks enrollment authority while Core keeps machine enrollment available', async () => {
    const f = fixture();
    const device = await f.authorize(['fleet:admin']);
    let bodyRead!: () => void;
    let finishBody!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead();
        return new Promise<void>((resolve) => {
          finishBody = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); resolve(); };
        });
      },
    }, { highWaterMark: 0 });
    const pending = f.app.request(new Request('http://127.0.0.1/api/auth/device/enroll', { method: 'POST', headers: { ...device.headers, 'content-type': 'application/json' }, body, ...{ duplex: 'half' } }));
    await reading;
    f.database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(f.server.clock.now().toISOString(), device.id);
    finishBody();
    expect((await pending).status).toBe(401);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM machines').get()).toEqual({ count: 0 });
    f.server.enabledModules = new Set(['core', 'access']);
    const authorized = await f.authorize(['fleet:admin']);
    expect((await f.post('/api/auth/device/enroll', {}, authorized.headers)).status).toBe(201);
  });

  it('does not approve a pending code after the browser session is revoked while its request body is still arriving', async () => {
    const f = fixture();
    const request = await f.start();
    let read!: () => void;
    let finish!: () => void;
    const reading = new Promise<void>((resolve) => { read = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      read();
      return new Promise<void>((resolve) => { finish = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ userCode: request.userCode, permissions: ['project:read'] })));
        controller.close(); resolve();
      }; });
    } }, { highWaterMark: 0 });
    const pending = f.app.request(new Request('http://127.0.0.1/api/auth/device/approve', { method: 'POST', headers: { ...f.owner.headers, 'content-type': 'application/json' }, body, ...{ duplex: 'half' } }));
    await reading;
    f.database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ?').run(f.server.clock.now().toISOString(), f.owner.id);
    revokeUserDeviceAuthorizations(f.server, f.owner.id, f.owner.id);
    finish();
    expect((await pending).status).toBe(401);
    expect(f.database.prepare('SELECT approved_at FROM device_authorization_requests').get()).toEqual({ approved_at: null });
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM user_device_tokens').get()).toEqual({ count: 0 });
  });

  it('requires native administrator authority for nodes independently of an optional GitHub link', async () => {
    const f = fixture({ github: true });
    const device = await f.authorize(['fleet:admin']);
    const response = await f.post('/api/auth/device/enroll', {}, device.headers);
    const node = await response.json() as { machineId: string; credential: string };
    const fleet = createMachineService(f.server);
    expect(fleet.authenticateNode(node.machineId, node.credential)).toBe(true);
    f.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(f.owner.id);
    expect(fleet.authenticateNode(node.machineId, node.credential)).toBe(false);
    f.database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ?").run(f.owner.id);
    f.database.prepare("UPDATE github_identities SET status = 'disabled' WHERE user_id = ?").run(f.owner.id);
    expect(fleet.authenticateNode(node.machineId, node.credential)).toBe(true);
    expect((await f.app.request('/api/auth/device/status', { headers: device.headers })).status).toBe(200);
  });

  it('keeps one machine binding when enrollment bodies complete concurrently', async () => {
    const f = fixture();
    const device = await f.authorize(['fleet:admin']);
    function pendingEnrollment(machineName: string) {
      let read!: () => void;
      let finish!: () => void;
      const reading = new Promise<void>((resolve) => { read = resolve; });
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        read();
        return new Promise<void>((resolve) => { finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ machineName }))); controller.close(); resolve(); }; });
      } }, { highWaterMark: 0 });
      const response = f.app.request(new Request('http://127.0.0.1/api/auth/device/enroll', { method: 'POST', headers: { ...device.headers, 'content-type': 'application/json' }, body, ...{ duplex: 'half' } }));
      return { reading, response, finish: () => finish() };
    }
    const first = pendingEnrollment('concurrent one');
    const second = pendingEnrollment('concurrent two');
    await Promise.all([first.reading, second.reading]);
    first.finish();
    second.finish();
    const responses = await Promise.all([first.response, second.response]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const nodes = await Promise.all(responses.map(async (response) => await response.json() as { machineId: string; credential: string }));
    expect(new Set(nodes.map((node) => node.machineId)).size).toBe(1);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM machines').get()).toEqual({ count: 1 });
    const fleet = createMachineService(f.server);
    expect(nodes.filter((node) => fleet.authenticateNode(node.machineId, node.credential))).toHaveLength(1);
    expect((await f.app.request(`/api/auth/devices/${device.id}`, { method: 'DELETE', headers: f.owner.headers })).status).toBe(200);
    expect(nodes.filter((node) => fleet.authenticateNode(node.machineId, node.credential))).toHaveLength(0);
  });

  it('reports saved device status and permanently revokes authorization on an account security change', async () => {
    const f = fixture();
    const device = await f.authorize();
    const status = await f.app.request('/api/auth/device/status', { headers: device.headers });
    expect(await status.json()).toMatchObject({ id: device.id, machineId: null, machineStatus: null });
    const project = await f.post('/api/auth/device/project', { mode: 'manual', projectId: f.projectId }, device.headers);
    const child = await project.json() as { id: string };
    const waiting = await f.start();
    expect((await f.post('/api/auth/device/approve', { userCode: waiting.userCode, permissions: ['project:read'] }, f.owner.headers)).status).toBe(200);
    const fleet = createMachineService(f.server);
    const enrollment = fleet.issueEnrollmentToken({ teamId: f.teamId, label: 'pending legacy node', createdBy: f.owner.id });
    revokeUserDeviceAuthorizations(f.server, f.owner.id, f.other.id);
    expect((await f.app.request('/api/auth/device/status', { headers: device.headers })).status).toBe(401);
    expect(f.database.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(child.id)).toEqual({ revoked_at: f.server.clock.now().toISOString() });
    const denied = await f.post('/api/auth/device/poll', { deviceCode: waiting.deviceCode });
    expect(await denied.json()).toMatchObject({ error: { code: 'device_code_revoked' } });
    expect(() => fleet.consumeEnrollmentToken(enrollment.token)).toThrow('Enrollment token is invalid');
  });

  it('does not issue a GitHub project token when device authority is revoked during verification', async () => {
    const f = fixture({ github: true });
    const device = await f.authorize();
    const fetcher = githubFixture();
    fetcher.mockImplementationOnce(async () => {
      f.database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(f.server.clock.now().toISOString(), device.id);
      return Response.json({ id: 7 });
    });
    expect((await f.post('/api/auth/device/project', { mode: 'github', remote: 'acme/widget' }, device.headers)).status).toBe(401);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM github_repository_bindings').get()).toEqual({ count: 0 });
  });

  it('rolls back one-time redemption when the immutable audit write fails', async () => {
    const f = fixture();
    const request = await f.start();
    expect((await f.post('/api/auth/device/approve', { userCode: request.userCode, permissions: ['project:read'] }, f.owner.headers)).status).toBe(200);
    f.database.exec("CREATE TRIGGER fail_device_audit BEFORE INSERT ON audit_records WHEN NEW.action = 'device.authorized' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await f.post('/api/auth/device/poll', { deviceCode: request.deviceCode })).status).toBe(500);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM user_device_tokens').get()).toEqual({ count: 0 });
    expect(f.database.prepare('SELECT consumed_at FROM device_authorization_requests').get()).toEqual({ consumed_at: null });
  });
});
