import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../../lib/config.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import { migrateDatabase, openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedUser, ServerContext } from '../../lib/module.js';
import { hashToken } from '../../lib/security.js';
import { subscribeSessionAuthorizationChanges } from '../../lib/session-auth.js';
import { coreModule } from './core.js';
import { accessibleProjectIds, canAccessProject, createProject, createProjectRepository, projectPermission, removeProjectMember, setProjectMember } from './projects.js';

const contexts: ServerContext[] = [];
afterEach(() => { for (const context of contexts.splice(0)) context.database.close(); });

function setup(version?: number) {
  const database = openDatabase(':memory:', systemClock, version);
  const context: ServerContext = {
    config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:' }),
    database, clock: systemClock, ids: secureIds, events: new EventStore(database, systemClock, secureIds),
  };
  contexts.push(context);
  const now = systemClock.now().toISOString();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team', 'Team', now);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('other-team', 'Other team', now);
  function user(id: string, teamId = 'team', role: AuthenticatedUser['role'] = 'member'): AuthenticatedUser {
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, `${id}@example.test`, id, 'unused', now, now);
    database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(teamId, id, role, now);
    return { id, email: `${id}@example.test`, displayName: id, teamId, role };
  }
  const owner = user('owner');
  const peer = user('peer');
  const viewer = user('viewer');
  const admin = user('admin', 'team', 'administrator');
  const stranger = user('stranger', 'other-team', 'administrator');
  const app = new Hono<AppEnvironment>();
  coreModule.register(app, context);
  app.onError((error, c) => c.json({ error: { code: error instanceof HttpError ? error.code : 'internal_error' } }, error instanceof HttpError ? error.status : 500));
  function session(actor: AuthenticatedUser) {
    const token = secureIds.token(32);
    const csrf = secureIds.token(24);
    database.prepare('INSERT INTO web_sessions(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(secureIds.id(), actor.id, hashToken(token), hashToken(csrf), now, now, new Date(Date.now() + 60_000).toISOString());
    return { cookie: `dhole_session=${token}`, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  }
  return { context, app, owner, peer, viewer, admin, stranger, session, now };
}

describe('native project authorization', () => {
  it('keeps new local projects private and resolves native owner, administrator, editor, and viewer access', () => {
    const { context, owner, peer, viewer, admin, stranger } = setup();
    const project = createProject(context, owner, { name: 'Local work' });
    expect(context.database.prepare('SELECT visibility FROM projects WHERE id = ?').get(project.id)).toEqual({ visibility: 'private' });
    expect(projectPermission(context, owner, project.id)).toBe('owner');
    expect(projectPermission(context, admin, project.id)).toBe('owner');
    expect(projectPermission(context, peer, project.id)).toBeUndefined();
    expect(projectPermission(context, stranger, project.id)).toBeUndefined();
    const claimedAdmin: AuthenticatedUser = { ...peer, role: 'administrator' };
    expect(projectPermission(context, claimedAdmin, project.id)).toBeUndefined();
    expect(projectPermission(context, { ...owner, teamId: stranger.teamId }, project.id)).toBeUndefined();
    setProjectMember(context, owner, project.id, peer.id, 'editor');
    setProjectMember(context, admin, project.id, viewer.id, 'viewer');
    expect(canAccessProject(context, peer, project.id, true)).toBe(true);
    expect(canAccessProject(context, viewer, project.id)).toBe(true);
    expect(canAccessProject(context, viewer, project.id, true)).toBe(false);
    expect(accessibleProjectIds(context, viewer)).toEqual([project.id]);
    expect(accessibleProjectIds(context, viewer, true)).toEqual([]);
    expect(canAccessProject({ database: context.database }, { id: viewer.id }, project.id)).toBe(true);
    context.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(context.clock.now().toISOString(), peer.id);
    expect(canAccessProject(context, peer, project.id)).toBe(false);
    context.database.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run('team', viewer.id);
    expect(canAccessProject(context, viewer, project.id)).toBe(false);
  });

  it('checks private project reads, listing, writes, ownership, CSRF, and cross-team membership at HTTP boundaries', async () => {
    const { context, app, owner, peer, viewer, stranger, session } = setup();
    const project = createProject(context, owner, { name: 'Private work' });
    const ownerHeaders = session(owner);
    const peerHeaders = session(peer);
    const viewerHeaders = session(viewer);
    expect((await app.request(`/api/projects/${project.id}`, { headers: peerHeaders })).status).toBe(404);
    const listing = await app.request('/api/projects', { headers: peerHeaders });
    expect(await listing.json()).toEqual({ projects: [] });
    expect((await app.request(`/api/projects/${project.id}/members/${peer.id}`, { method: 'PUT', headers: { cookie: ownerHeaders.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'editor' }) })).status).toBe(403);
    expect((await app.request(`/api/projects/${project.id}/members/${peer.id}`, { method: 'PUT', headers: { ...ownerHeaders, origin: 'https://other.example' }, body: JSON.stringify({ role: 'editor' }) })).status).toBe(403);
    expect((await app.request(`/api/projects/${project.id}/members/${peer.id}`, { method: 'PUT', headers: { ...ownerHeaders, authorization: 'Bearer unknown' }, body: JSON.stringify({ role: 'editor' }) })).status).toBe(403);
    expect((await app.request(`/api/projects/${project.id}/members/${stranger.id}`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ role: 'editor' }) })).status).toBe(404);
    expect((await app.request(`/api/projects/${project.id}/members/${viewer.id}`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ role: 'viewer' }) })).status).toBe(200);
    expect((await app.request(`/api/projects/${project.id}`, { headers: viewerHeaders })).status).toBe(200);
    expect((await app.request(`/api/projects/${project.id}`, { method: 'PATCH', headers: viewerHeaders, body: JSON.stringify({ name: 'Denied write' }) })).status).toBe(404);
    expect((await app.request(`/api/projects/${project.id}/members/${peer.id}`, { method: 'PUT', headers: viewerHeaders, body: JSON.stringify({ role: 'editor' }) })).status).toBe(403);
    expect((await app.request(`/api/projects/${project.id}/members/${owner.id}`, { method: 'DELETE', headers: ownerHeaders })).status).toBe(409);
    expect((await app.request(`/api/projects/${project.id}/members`, { headers: ownerHeaders })).status).toBe(200);
  });

  it('revokes project tokens and open browser sessions on reduction or removal, keeping audit atomic and immutable', () => {
    const { context, owner, peer, session, now } = setup();
    const project = createProject(context, owner, { name: 'Revocable' });
    const other = createProject(context, owner, { name: 'Other work' });
    setProjectMember(context, owner, project.id, peer.id, 'editor');
    session(peer);
    context.database.prepare(`INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at)
      VALUES ('device', ?, ?, 'fixture', ?, '[]', ?, ?)`).run(peer.id, peer.teamId, hashToken('fixture-device-token'), now, '2099-01-01T00:00:00.000Z');
    for (const [id, projectId] of [['derived', project.id], ['other', other.id]]) {
      context.database.prepare(`INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, device_token_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, '[]', 'device', ?, ?)`).run(id, peer.id, projectId, hashToken(`${id}-token`), now, '2099-01-01T00:00:00.000Z');
    }
    let notifications = 0;
    const unsubscribe = subscribeSessionAuthorizationChanges(context, () => { notifications += 1; });
    setProjectMember(context, owner, project.id, peer.id, 'viewer');
    expect(notifications).toBe(1);
    expect(context.database.prepare("SELECT revoked_at FROM api_tokens WHERE id = 'derived'").get()).toEqual({ revoked_at: expect.any(String) });
    expect(context.database.prepare("SELECT revoked_at FROM api_tokens WHERE id = 'other'").get()).toEqual({ revoked_at: null });
    expect(context.database.prepare("SELECT revoked_at FROM user_device_tokens WHERE id = 'device'").get()).toEqual({ revoked_at: null });
    expect(context.database.prepare('SELECT revoked_at FROM web_sessions WHERE user_id = ?').get(peer.id)).toEqual({ revoked_at: expect.any(String) });
    expect(context.database.prepare("SELECT detail_json FROM audit_records WHERE action = 'project.member.set' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ detail_json: JSON.stringify({ previousRole: 'editor', role: 'viewer' }) });
    expect(() => context.database.prepare("UPDATE audit_records SET action = 'changed'").run()).toThrow();

    context.database.exec(`CREATE TRIGGER reject_member_audit BEFORE INSERT ON audit_records WHEN new.action = 'project.member.remove'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => removeProjectMember(context, owner, project.id, peer.id)).toThrow('audit unavailable');
    expect(projectPermission(context, peer, project.id)).toBe('viewer');
    expect(notifications).toBe(1);
    context.database.exec('DROP TRIGGER reject_member_audit');
    removeProjectMember(context, owner, project.id, peer.id);
    expect(canAccessProject(context, peer, project.id)).toBe(false);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('backfills only existing projects with explicit legacy team visibility and lets the owner retire that access', async () => {
    const { context, app, owner, peer, viewer, session, now } = setup(12);
    context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', owner.teamId, 'Legacy', owner.id, now, now);
    migrateDatabase(context.database, context.clock);
    expect(context.database.prepare("SELECT visibility FROM projects WHERE id = 'legacy'").get()).toEqual({ visibility: 'team' });
    expect(projectPermission(context, peer, 'legacy')).toBe('editor');
    setProjectMember(context, owner, 'legacy', viewer.id, 'viewer');
    expect(canAccessProject(context, viewer, 'legacy', true)).toBe(false);
    expect(() => removeProjectMember(context, owner, 'legacy', viewer.id)).toThrow('Make this legacy team project private');
    const response = await app.request('/api/projects/legacy/visibility', { method: 'PUT', headers: session(owner), body: JSON.stringify({ visibility: 'private' }) });
    expect(response.status).toBe(200);
    expect(canAccessProject(context, peer, 'legacy')).toBe(false);
    expect(canAccessProject(context, viewer, 'legacy')).toBe(true);
    const fresh = createProject(context, owner, { name: 'Fresh' });
    expect(canAccessProject(context, peer, fresh.id)).toBe(false);
  });

  it('records local and Codeberg project metadata without treating remote names as authority or storing credentials', () => {
    const { context, owner, peer } = setup();
    const project = createProject(context, owner, { name: 'Codeberg' });
    const repository = createProjectRepository(context, owner, project.id, { label: 'source', canonicalRemote: 'https://codeberg.org/team/repo.git' });
    expect(repository.canonicalRemote).toBe('https://codeberg.org/team/repo.git');
    expect(repository.localPathConfigured).toBe(false);
    expect(canAccessProject(context, peer, project.id)).toBe(false);
    for (const canonicalRemote of ['https://user:secret@codeberg.org/team/repo.git', '/home/user/private', 'file:///home/user/private', 'https://codeberg.org/team/repo?token=secret']) {
      expect(() => createProjectRepository(context, owner, project.id, { label: 'rejected', canonicalRemote })).toThrow();
    }
    expect(() => createProjectRepository(context, peer, project.id, { label: 'unauthorized' })).toThrow('Project not found');
    expect(context.database.prepare('SELECT count(*) AS count FROM repositories').get()).toEqual({ count: 1 });
  });
});
