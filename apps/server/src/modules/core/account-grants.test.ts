import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { secureIds } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { hashPassword, hashToken, verifyPassword } from '../../lib/security.js';
import { subscribeSessionAuthorizationChanges } from '../../lib/session-auth.js';
import { coreModule } from './core.js';

const password = 'correct horse battery staple';
let passwordHash: string;
const databases: ServerContext['database'][] = [];
beforeAll(async () => { passwordHash = await hashPassword(password); });
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function setup() {
  let at = new Date('2026-09-05T10:00:00.000Z');
  const clock = { now: () => at };
  const database = openDatabase(':memory:', clock);
  databases.push(database);
  const server: ServerContext = {
    config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' }),
    database, clock, ids: secureIds, events: new EventStore(database, clock, secureIds), enabledModules: new Set(['core', 'access']),
  };
  const app = new Hono<AppEnvironment>();
  coreModule.register(app, server);
  app.onError((error, c) => c.json({ error: { code: error instanceof HttpError ? error.code : 'internal_error' } }, error instanceof HttpError ? error.status : 500));
  const teamId = secureIds.id();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, 'Test team', at.toISOString());
  const addUser = (email: string, role: 'administrator' | 'member' = 'member', team = teamId) => {
    const id = secureIds.id();
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, email.split('@')[0], passwordHash, at.toISOString(), at.toISOString());
    database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(team, id, role, at.toISOString());
    const token = secureIds.token(32);
    const csrf = secureIds.token(24);
    database.prepare('INSERT INTO web_sessions(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(secureIds.id(), id, hashToken(token), hashToken(csrf), at.toISOString(), at.toISOString(), '2026-09-20T10:00:00.000Z');
    return { id, headers: { cookie: `dhole_session=${token}`, 'x-csrf-token': csrf } };
  };
  const admin = addUser('admin@example.test', 'administrator');
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  });
  const invite = async (email = 'member@example.test', extra = {}) => {
    const response = await request('/api/admin/invitations', { email, ...extra }, admin.headers);
    expect(response.status).toBe(201);
    const { invitation } = await response.json() as { invitation: { id: string; setupUrl: string; email: string; expiresAt: string } };
    return { ...invitation, token: new URLSearchParams(new URL(invitation.setupUrl).hash.slice(1)).get('invitation')! };
  };
  const reset = async (userId: string) => {
    const response = await request(`/api/admin/users/${userId}/reset-password`, {}, admin.headers);
    expect(response.status).toBe(201);
    const { reset: result } = await response.json() as { reset: { id: string; setupUrl: string; expiresAt: string } };
    return { ...result, token: new URLSearchParams(new URL(result.setupUrl).hash.slice(1)).get('password-reset')! };
  };
  return { app, server, database, request, admin, teamId, addUser, invite, reset, advance: (milliseconds: number) => { at = new Date(at.getTime() + milliseconds); } };
}

describe('native account invitation and recovery grants', () => {
  it('lets an invited recipient choose a password once and keeps tokens out of storage and audit', async () => {
    const { request, invite, database } = setup();
    const invitation = await invite('MEMBER@EXAMPLE.TEST');
    const review = await request(`/api/auth/invitation?token=${invitation.token}`);
    expect(review.status).toBe(200);
    expect(review.headers.get('cache-control')).toBe('no-store');
    expect(await review.json()).toEqual({ invitation: { emailHint: 'm***@example.test', teamName: 'Test team', role: 'member', expiresAt: invitation.expiresAt } });
    const weak = await request('/api/auth/invitation/accept', { token: invitation.token, displayName: 'Member', password: 'only12letters' });
    expect(weak.status).toBe(422);
    const accepted = await request('/api/auth/invitation/accept', { token: invitation.token, displayName: 'Member', password });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get('set-cookie')).toBeNull();
    const user = database.prepare('SELECT id, password_hash FROM users WHERE email = ?').get('member@example.test') as { id: string; password_hash: string };
    expect(await verifyPassword(password, user.password_hash)).toBe(true);
    expect(database.prepare('SELECT role FROM team_members WHERE user_id = ?').get(user.id)).toEqual({ role: 'member' });
    expect(database.prepare('SELECT count(*) AS count FROM github_identities WHERE user_id = ?').get(user.id)).toEqual({ count: 0 });
    expect((await request('/api/auth/invitation/accept', { token: invitation.token, displayName: 'Again', password })).status).toBe(400);
    expect((await request(`/api/auth/invitation?token=${invitation.token}`)).status).toBe(400);
    expect(JSON.stringify(database.prepare('SELECT * FROM account_grants').all())).not.toContain(invitation.token);
    const audit = JSON.stringify(database.prepare('SELECT * FROM audit_records').all());
    expect(audit).toContain('auth.invitation.accept');
    expect(audit).not.toContain(invitation.token);
    expect(audit).not.toContain(password);
  });

  it('replaces outstanding invitations and atomically accepts only one concurrent request', async () => {
    const { request, invite, database } = setup();
    const first = await invite();
    const second = await invite();
    expect((await request(`/api/auth/invitation?token=${first.token}`)).status).toBe(400);
    expect(database.prepare('SELECT revoked_at FROM account_grants WHERE id = ?').get(first.id)).toEqual({ revoked_at: expect.any(String) });
    const responses = await Promise.all([1, 2].map(() => request('/api/auth/invitation/accept', { token: second.token, displayName: 'Member', password })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(database.prepare('SELECT count(*) AS count FROM users WHERE email = ?').get('member@example.test')).toEqual({ count: 1 });
  });

  it('rejects expired grants and grants issued by an administrator who lost authority', async () => {
    const { app, request, invite, reset, advance, database, admin, addUser } = setup();
    const expired = await invite('expired@example.test', { expiresInHours: 1 });
    const expiredReset = await reset(addUser('reset@example.test').id);
    advance(3_600_000);
    const invalid = await request(`/api/auth/invitation?token=${expired.token}`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(await (await request(`/api/auth/invitation?token=${secureIds.token(32)}`)).json());
    expect((await request(`/api/auth/password/reset?token=${expiredReset.token}`)).status).toBe(400);
    const revoked = await invite('revoked@example.test');
    addUser('peer-admin@example.test', 'administrator');
    expect((await app.request(`/api/admin/users/${admin.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...admin.headers }, body: JSON.stringify({ status: 'disabled' }),
    })).status).toBe(200);
    database.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(admin.id);
    expect((await request('/api/auth/invitation/accept', { token: revoked.token, displayName: 'Member', password })).status).toBe(400);
    expect(database.prepare('SELECT id FROM users WHERE email = ?').get('revoked@example.test')).toBeUndefined();
  });

  it('invalidates outstanding recovery links when the owner changes their password', async () => {
    const { request, reset, addUser } = setup();
    const member = addUser('member@example.test');
    const pending = await reset(member.id);
    expect((await request('/api/auth/password', { currentPassword: password, newPassword: 'the owner chose another password' }, member.headers)).status).toBe(200);
    expect((await request('/api/auth/password/reset', { token: pending.token, newPassword: 'this stale reset must not work' })).status).toBe(400);
  });

  it('revokes all unused grants issued by an administrator when that administrator recovers their account', async () => {
    const { request, reset, invite, admin } = setup();
    const invitation = await invite('future-admin@example.test', { role: 'administrator' });
    const recovery = await reset(admin.id);
    expect((await request('/api/auth/password/reset', { token: recovery.token, newPassword: 'the administrator recovered this account' })).status).toBe(200);
    expect((await request(`/api/auth/invitation?token=${invitation.token}`)).status).toBe(400);
  });

  it('rechecks the issuer session after reading a slow request body', async () => {
    for (const kind of ['invitation', 'password_reset']) {
      const { app, database, admin, addUser } = setup();
      const member = addUser('member@example.test');
      let markReading!: () => void;
      const reading = new Promise<void>((resolve) => { markReading = resolve; });
      let finishBody!: () => void;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          markReading();
          return new Promise<void>((resolve) => {
            finishBody = () => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(kind === 'invitation' ? { email: 'new@example.test' } : {})));
              controller.close();
              resolve();
            };
          });
        },
      }, { highWaterMark: 0 });
      const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { 'content-type': 'application/json', ...admin.headers }, body, duplex: 'half' };
      const response = app.request(kind === 'invitation' ? '/api/admin/invitations' : `/api/admin/users/${member.id}/reset-password`, init);
      await reading;
      database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ?').run('2026-09-05T10:00:00.000Z', admin.id);
      finishBody();
      expect((await response).status).toBe(401);
      expect(database.prepare('SELECT count(*) AS count FROM account_grants').get()).toEqual({ count: 0 });
    }
  });

  it('requires human admin authorization and CSRF and never joins an existing email to a new identity', async () => {
    const { request, addUser, admin, invite, database, teamId } = setup();
    const member = addUser('existing@example.test');
    expect((await request('/api/admin/invitations', { email: 'new@example.test' })).status).toBe(401);
    expect((await request('/api/admin/invitations', { email: 'new@example.test' }, { cookie: admin.headers.cookie })).status).toBe(403);
    expect((await request('/api/admin/invitations', { email: 'new@example.test' }, member.headers)).status).toBe(403);
    expect((await request('/api/admin/invitations', { email: 'EXISTING@example.test' }, admin.headers)).status).toBe(409);
    const peer = addUser('other-admin@example.test', 'administrator');
    expect((await request(`/api/admin/users/${peer.id}/reset-password`, {}, admin.headers)).status).toBe(403);
    const otherTeam = secureIds.id();
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(otherTeam, 'Other team', '2026-09-05T10:00:00.000Z');
    const outside = addUser('outside@example.test', 'member', otherTeam);
    expect((await request(`/api/admin/users/${outside.id}/reset-password`, {}, admin.headers)).status).toBe(404);
    expect(database.prepare('SELECT count(*) AS count FROM team_members WHERE user_id = ? AND team_id = ?').get(outside.id, teamId)).toEqual({ count: 0 });
    const invitation = await invite();
    const body = { token: invitation.token, displayName: 'Member', password };
    expect((await request('/api/auth/invitation/accept', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await request('/api/auth/invitation/accept', body, { authorization: `Bearer ${secureIds.token(32)}` })).status).toBe(403);
    expect((await request('/api/auth/invitation/accept', body, { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await request('/api/auth/invitation/accept', { ...body, displayName: 'x'.repeat(9_000) })).status).toBe(413);
  });

  it('resets a password once and revokes sessions, pending approvals, device tokens, derived tokens and node credentials', async () => {
    const { request, reset, database, addUser, teamId, server } = setup();
    const member = addUser('member@example.test');
    const now = server.clock.now().toISOString();
    const expiresAt = '2026-09-20T10:00:00.000Z';
    const projectId = secureIds.id();
    const machineId = secureIds.id();
    const deviceId = secureIds.id();
    database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, teamId, 'Test', member.id, now, now);
    database.prepare("INSERT INTO machines(id, team_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'enrolled', ?, ?)").run(machineId, teamId, 'Fixture machine', now, now);
    database.prepare('INSERT INTO device_credentials(id, machine_id, credential_hash, created_at) VALUES (?, ?, ?, ?)').run(secureIds.id(), machineId, hashToken(secureIds.token(32)), now);
    database.prepare('INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, machine_id, token_hash, permissions_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(deviceId, member.id, teamId, 'Fixture machine', machineId, hashToken(secureIds.token(32)), '["project:read"]', now, expiresAt);
    database.prepare('INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at, device_token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(secureIds.id(), member.id, projectId, hashToken(secureIds.token(32)), '{}', now, expiresAt, deviceId);
    database.prepare('INSERT INTO device_authorization_requests(id, device_code_hash, user_code_hash, machine_name, requested_permissions_json, permissions_json, user_id, team_id, created_at, expires_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(secureIds.id(), hashToken(secureIds.token(32)), hashToken(secureIds.token(32)), 'Pending fixture', '["project:read"]', '["project:read"]', member.id, teamId, now, expiresAt, now);
    const first = await reset(member.id);
    const replacement = await reset(member.id);
    expect((await request(`/api/auth/password/reset?token=${first.token}`)).status).toBe(400);
    expect((await request(`/api/auth/password/reset?token=${replacement.token}`)).status).toBe(200);
    let notifications = 0;
    subscribeSessionAuthorizationChanges(server, () => { notifications += 1; });
    const nextPassword = 'recipient chose this new password';
    const responses = await Promise.all([1, 2].map(() => request('/api/auth/password/reset', { token: replacement.token, newPassword: nextPassword })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(responses.every((response) => !response.headers.get('set-cookie'))).toBe(true);
    expect(notifications).toBe(1);
    for (const table of ['web_sessions', 'user_device_tokens', 'api_tokens', 'device_authorization_requests']) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ? AND revoked_at IS NULL`).get(member.id)).toEqual({ count: 0 });
    }
    expect(database.prepare('SELECT count(*) AS count FROM device_credentials WHERE machine_id = ? AND revoked_at IS NULL').get(machineId)).toEqual({ count: 0 });
    expect(database.prepare('SELECT status FROM machines WHERE id = ?').get(machineId)).toEqual({ status: 'revoked' });
    const user = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(member.id) as { password_hash: string };
    expect(await verifyPassword(password, user.password_hash)).toBe(false);
    expect(await verifyPassword(nextPassword, user.password_hash)).toBe(true);
    const audit = JSON.stringify(database.prepare('SELECT * FROM audit_records').all());
    expect(audit).toContain('auth.password_reset.consume');
    expect(audit).not.toContain(replacement.token);
    expect(audit).not.toContain(nextPassword);
  });

  it('does not let forwarding headers or changing invalid tokens evade bounded attempts', async () => {
    const { request } = setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request('/api/auth/password/reset', { token: secureIds.token(32), newPassword: password }, { 'x-forwarded-for': `203.0.113.${attempt}` })).status).toBe(400);
    }
    const limited = await request('/api/auth/password/reset', { token: secureIds.token(32), newPassword: password }, { 'x-forwarded-for': '198.51.100.1' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});
