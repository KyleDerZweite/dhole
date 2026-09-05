import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedUser, DholeApp, ServerContext } from '../../lib/module.js';
import { notifySessionAuthorizationChanged } from '../../lib/session-auth.js';
import { authMiddleware, BoundedRateLimiter, csrfMiddleware, getCurrentUser, recordAudit, type PublicProject, type PublicRepository } from './core.js';

export type ProjectPermission = 'owner' | 'editor' | 'viewer';
const MemberRoleSchema = z.enum(['editor', 'viewer']);
const MemberSchema = z.strictObject({ role: MemberRoleSchema });
const ProjectCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_096).default(''),
});
const IdSchema = z.string().min(1).max(160);
const ProjectRepositorySchema = z.strictObject({
  label: z.string().trim().min(1).max(160),
  canonicalRemote: z.string().trim().min(1).max(2_048).refine((value) => {
    if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
    if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/u.test(value)) return !value.includes('/../');
    try {
      const url = new URL(value);
      return ['https:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname) && url.pathname !== '/'
        && !url.password && !url.search && !url.hash
        && (url.protocol === 'ssh:' ? url.username === 'git' : !url.username);
    } catch { return false; }
  }, 'Use an HTTPS or Git SSH repository remote without credentials').optional(),
  defaultBranch: z.string().trim().min(1).max(256).optional(),
});

interface PermissionRow { id: string; permission: ProjectPermission | null }
type ProjectContext = Pick<ServerContext, 'database'>;
type ProjectUser = Pick<AuthenticatedUser, 'id'> & Partial<Pick<AuthenticatedUser, 'teamId'>>;

// Resolve authority from live native account records, never caller-supplied roles
// or repository names. An explicit viewer grant also limits legacy team access.
const permissionQuery = `SELECT p.id, CASE
  WHEN tm.role = 'administrator' OR p.created_by = u.id THEN 'owner'
  WHEN pm.role IS NOT NULL THEN pm.role
  WHEN p.visibility = 'team' THEN 'editor'
  ELSE NULL END AS permission
  FROM projects p
  JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?
  JOIN users u ON u.id = tm.user_id AND u.disabled_at IS NULL
  LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
  WHERE (? IS NULL OR p.team_id = ?)`;

export function projectPermission(context: ProjectContext, user: ProjectUser, projectId: string): ProjectPermission | undefined {
  const row = context.database.prepare(`${permissionQuery} AND p.id = ?`).get(user.id, user.teamId ?? null, user.teamId ?? null, projectId) as PermissionRow | undefined;
  return row?.permission ?? undefined;
}

export function canAccessProject(context: ProjectContext, user: ProjectUser, projectId: string, write = false): boolean {
  const permission = projectPermission(context, user, projectId);
  return permission !== undefined && (!write || permission !== 'viewer');
}

export function accessibleProjectIds(context: ProjectContext, user: ProjectUser, write = false): string[] {
  const rows = context.database.prepare(`${permissionQuery} ORDER BY p.updated_at DESC, p.id`).all(user.id, user.teamId ?? null, user.teamId ?? null) as PermissionRow[];
  return rows.filter((row) => row.permission !== null && (!write || row.permission !== 'viewer')).map((row) => row.id);
}

/** A local project has native ownership; it does not assert remote repository rights. */
export function createProject(context: ServerContext, user: AuthenticatedUser, input: { name: string; description?: string }): PublicProject {
  const data = ProjectCreateSchema.parse(input);
  return context.database.transaction(() => {
    const active = context.database.prepare(`SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = ? AND tm.team_id = ? AND u.disabled_at IS NULL`).get(user.id, user.teamId);
    if (!active) throw new HttpError(403, 'project_creation_denied', 'Active team membership is required');
    const duplicate = context.database.prepare('SELECT 1 FROM projects WHERE team_id = ? AND name = ?').get(user.teamId, data.name);
    if (duplicate) throw new HttpError(409, 'project_name_in_use', 'A project with that name already exists');
    const now = context.clock.now().toISOString();
    const id = context.ids.id();
    context.database.prepare(`INSERT INTO projects(id, team_id, name, description, created_by, created_at, updated_at, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'private')`).run(id, user.teamId, data.name, data.description, user.id, now, now);
    recordAudit(context, { projectId: id, actorType: 'user', actorId: user.id, action: 'project.create', targetType: 'project', targetId: id, outcome: 'allowed' });
    return { id, teamId: user.teamId, name: data.name, description: data.description, eventSequence: 0, createdBy: user.id, createdAt: now, updatedAt: now };
  }).immediate();
}

/** Repository metadata records a reference and grants no remote repository rights. */
export function createProjectRepository(context: ServerContext, user: AuthenticatedUser, projectId: string, input: { label: string; canonicalRemote?: string; defaultBranch?: string }): PublicRepository {
  const data = ProjectRepositorySchema.parse(input);
  return context.database.transaction(() => {
    if (!canAccessProject(context, user, projectId, true)) throw new HttpError(404, 'project_not_found', 'Project not found');
    const duplicate = context.database.prepare('SELECT 1 FROM repositories WHERE project_id = ? AND label = ?').get(projectId, data.label);
    if (duplicate) throw new HttpError(409, 'repository_label_in_use', 'A repository with that label already exists');
    const id = context.ids.id();
    const now = context.clock.now().toISOString();
    context.database.prepare(`INSERT INTO repositories(id, project_id, label, canonical_remote, default_branch, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, data.label, data.canonicalRemote ?? null, data.defaultBranch ?? null, user.id, now, now);
    recordAudit(context, { projectId, actorType: 'user', actorId: user.id, action: 'repository.register', targetType: 'repository', targetId: id, outcome: 'allowed' });
    return { id, projectId, label: data.label, canonicalRemote: data.canonicalRemote, localPathConfigured: false, defaultBranch: data.defaultBranch, createdBy: user.id, createdAt: now, updatedAt: now };
  }).immediate();
}

function requireOwner(context: ServerContext, actor: AuthenticatedUser, projectId: string): void {
  const permission = projectPermission(context, actor, projectId);
  if (permission === 'owner') return;
  recordAudit(context, { actorType: 'user', actorId: actor.id, action: 'project.members.manage', targetType: 'project', targetId: projectId, outcome: 'denied' });
  if (!permission) throw new HttpError(404, 'project_not_found', 'Project not found');
  throw new HttpError(403, 'project_owner_required', 'Project owner access is required');
}

function requireMemberTarget(context: ServerContext, actor: AuthenticatedUser, projectId: string, userId: string, removing = false): void {
  const target = context.database.prepare(`SELECT u.id, p.created_by, tm.role FROM projects p
    JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?
    JOIN users u ON u.id = tm.user_id ${removing ? '' : 'AND u.disabled_at IS NULL'}
    WHERE p.id = ? AND p.team_id = ?`).get(userId, projectId, actor.teamId) as { id: string; created_by: string; role: string } | undefined;
  if (!target) throw new HttpError(404, 'user_not_found', 'Active team member not found');
  if (target.created_by === userId || target.role === 'administrator') throw new HttpError(409, 'project_owner_immutable', 'Creator and administrator access cannot be changed through project membership');
}

function revokeProjectAuthorization(context: ServerContext, projectId: string, userId: string): void {
  const now = context.clock.now().toISOString();
  context.database.prepare('UPDATE api_tokens SET revoked_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL').run(now, projectId, userId);
  context.database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
}

export function setProjectMember(context: ServerContext, actor: AuthenticatedUser, projectId: string, userId: string, role: 'editor' | 'viewer'): void {
  IdSchema.parse(projectId);
  IdSchema.parse(userId);
  MemberRoleSchema.parse(role);
  context.database.transaction(() => {
    requireOwner(context, actor, projectId);
    requireMemberTarget(context, actor, projectId, userId);
    const target = { ...actor, id: userId };
    const previous = projectPermission(context, target, projectId);
    const now = context.clock.now().toISOString();
    context.database.prepare(`INSERT INTO project_members(project_id, user_id, role, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`)
      .run(projectId, userId, role, actor.id, now, now);
    if (previous === 'editor' && role === 'viewer') revokeProjectAuthorization(context, projectId, userId);
    recordAudit(context, { projectId, actorType: 'user', actorId: actor.id, action: 'project.member.set', targetType: 'user', targetId: userId, outcome: 'allowed', detail: { previousRole: previous ?? null, role } });
  }).immediate();
  notifySessionAuthorizationChanged(context);
}

export function removeProjectMember(context: ServerContext, actor: AuthenticatedUser, projectId: string, userId: string): void {
  IdSchema.parse(projectId);
  IdSchema.parse(userId);
  context.database.transaction(() => {
    requireOwner(context, actor, projectId);
    requireMemberTarget(context, actor, projectId, userId, true);
    const project = context.database.prepare('SELECT visibility FROM projects WHERE id = ?').get(projectId) as { visibility: string };
    if (project.visibility === 'team') throw new HttpError(409, 'project_visibility_conflict', 'Make this legacy team project private before removing membership');
    context.database.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    revokeProjectAuthorization(context, projectId, userId);
    recordAudit(context, { projectId, actorType: 'user', actorId: actor.id, action: 'project.member.remove', targetType: 'user', targetId: userId, outcome: 'allowed' });
  }).immediate();
  notifySessionAuthorizationChanged(context);
}

export function registerProjectMembershipRoutes(app: DholeApp, context: ServerContext): void {
  const limiter = new BoundedRateLimiter();
  async function actor(request: Context<AppEnvironment>, mutation: boolean): Promise<AuthenticatedUser> {
    // Project sharing requires the human session. Existing bearer scopes do not
    // delegate membership administration or bypass CSRF with an attached cookie.
    if (request.req.header('authorization') !== undefined) throw new HttpError(403, 'browser_session_required', 'Use your signed-in browser to manage project membership');
    await authMiddleware(request, async () => undefined);
    if (mutation) {
      const origin = request.req.header('origin');
      if (origin !== undefined && origin !== context.config.publicOrigin.origin) throw new HttpError(403, 'origin_denied', 'Request origin is not allowed');
      await csrfMiddleware(context, limiter)(request, async () => undefined);
    }
    return getCurrentUser(request);
  }

  app.get('/api/projects/:projectId/members', async (request) => {
    const user = await actor(request, false);
    const projectId = IdSchema.parse(request.req.param('projectId'));
    requireOwner(context, user, projectId);
    const project = context.database.prepare('SELECT visibility, created_by FROM projects WHERE id = ?').get(projectId) as { visibility: string; created_by: string };
    const members = context.database.prepare(`SELECT pm.user_id AS userId, u.display_name AS displayName, pm.role
      FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? ORDER BY u.display_name, pm.user_id`).all(projectId);
    return request.json({ visibility: project.visibility, ownerId: project.created_by, members });
  });
  app.put('/api/projects/:projectId/members/:userId', async (request) => {
    const user = await actor(request, true);
    const input = await parseJson(request, MemberSchema);
    setProjectMember(context, user, request.req.param('projectId'), request.req.param('userId'), input.role);
    return request.json({ ok: true });
  });
  app.delete('/api/projects/:projectId/members/:userId', async (request) => {
    const user = await actor(request, true);
    removeProjectMember(context, user, request.req.param('projectId'), request.req.param('userId'));
    return request.json({ ok: true });
  });
  app.put('/api/projects/:projectId/visibility', async (request) => {
    const user = await actor(request, true);
    await parseJson(request, z.strictObject({ visibility: z.literal('private') }));
    const projectId = IdSchema.parse(request.req.param('projectId'));
    context.database.transaction(() => {
      requireOwner(context, user, projectId);
      const affected = context.database.prepare(`SELECT tm.user_id FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
        WHERE p.id = ? AND p.visibility = 'team' AND tm.role <> 'administrator' AND tm.user_id <> p.created_by
        AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = tm.user_id)`)
        .all(projectId) as Array<{ user_id: string }>;
      context.database.prepare("UPDATE projects SET visibility = 'private', updated_at = ? WHERE id = ?").run(context.clock.now().toISOString(), projectId);
      for (const member of affected) revokeProjectAuthorization(context, projectId, member.user_id);
      recordAudit(context, { projectId, actorType: 'user', actorId: user.id, action: 'project.visibility.set', targetType: 'project', targetId: projectId, outcome: 'allowed', detail: { visibility: 'private' } });
    }).immediate();
    notifySessionAuthorizationChanged(context);
    return request.json({ ok: true });
  });
}
