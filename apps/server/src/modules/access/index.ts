import { z } from 'zod';
import { ProjectTokenPermissionSchema, type TokenPermission } from '@dhole-control/shared';
import type { DholeModule, AuthenticatedCredential, AuthenticatedUser, ServerContext } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { hashToken } from '../../lib/security.js';
import { recordAudit } from '../core/index.js';
import { canAccessProject } from '../core/projects.js';
import { registerDeviceRoutes } from './device.js';

export { revokeUserDeviceAuthorizations } from './device.js';

const TOKEN_PERMISSION_SET = new Set<string>(ProjectTokenPermissionSchema.options);

const TokenInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  runId: z.string().min(1).max(160).optional(),
  permissions: z.array(ProjectTokenPermissionSchema).min(1).max(16),
  expiresInSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).default(24 * 60 * 60),
});

interface TokenRow {
  id: string;
  user_id: string | null;
  project_id: string;
  run_id: string | null;
  scopes_json: string;
  expires_at: string;
  user_email: string | null;
  display_name: string | null;
  role: AuthenticatedUser['role'] | null;
  team_id: string | null;
}

interface TokenAuditRow {
  id: string;
  project_id: string;
  run_id: string | null;
  scopes_json: string;
}

function bearer(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+([^\s]+)$/iu.exec(header.trim()) : undefined;
  return match?.[1];
}

function routePermission(path: string, method: string): TokenPermission | undefined {
  if (/^\/api\/(?:fleet\/)?machines\/[^/]+\/credential\/replace$/u.test(path)) return method === 'POST' ? 'fleet:admin' : undefined;
  if (method === 'GET' && /^\/api\/projects\/[^/]+\/(?:check|state|sessions)$/u.test(path)) return 'project:read';
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/(?:sessions|sessions\/[^/]+\/(?:heartbeat|repo)|claims|claims\/[^/]+\/(?:complete|release|revive)|check|agent-events)$/u.test(path)) return 'coordination:write';
  if (method === 'DELETE' && /^\/api\/projects\/[^/]+\/sessions\/[^/]+$/u.test(path)) return 'coordination:write';
  if (method === 'PATCH' && /^\/api\/projects\/[^/]+\/claims\/[^/]+$/u.test(path)) return 'coordination:write';
  if (method === 'GET' && /^\/api\/gateway\/(?:connections|requests|requests\/export|accounts|summary|prices|usage|connections\/[^/]+\/(?:collection|catalog|revisions|config|management-history))$/u.test(path)) return 'gateway:read';
  if (method === 'POST' && /^\/api\/gateway\/connections\/[^/]+\/ingest$/u.test(path)) return 'gateway:ingest';
  if (method === 'GET' && /^\/api\/gateway\/connections\/[^/]+\/catalog\/tokens$/u.test(path)) return 'gateway:manage';
  if ((method === 'GET' || method === 'DELETE') && /^\/api\/gateway\/connections\/[^/]+\/oauth\/[^/]+$/u.test(path)) return 'gateway:manage';
  if (method === 'POST' && /^\/api\/gateway\/connections\/[^/]+\/oauth(?:\/[^/]+\/callback)?$/u.test(path)) return 'gateway:manage';
  if (method === 'POST' && /^\/api\/gateway\/(?:connections|prices|connections\/[^/]+\/(?:archive|secrets|rollback|config\/(?:preview|apply)|accounts\/refresh|accounts\/[^/]+\/status|health|sync|prune|catalog\/(?:refresh|tokens)))$/u.test(path)) return 'gateway:manage';
  if (method === 'PATCH' && /^\/api\/gateway\/connections\/[^/]+(?:\/catalog\/models\/[^/]+)?$/u.test(path)) return 'gateway:manage';
  if (method === 'DELETE' && /^\/api\/gateway\/connections\/[^/]+(?:\/catalog\/tokens\/[^/]+)?$/u.test(path)) return 'gateway:manage';
  return undefined;
}

function pathProject(path: string): string | undefined {
  const match = /^\/api\/projects\/([^/]+)\//u.exec(path);
  try { return match?.[1] ? decodeURIComponent(match[1]) : undefined; } catch { return undefined; }
}

function storedPermissions(value: unknown): string[] {
  if (Array.isArray(value)) return z.array(z.string()).parse(value);
  return z.object({ permissions: z.array(z.string()) }).parse(value).permissions;
}

function auditToken(
  context: Parameters<typeof recordAudit>[0],
  actor: AuthenticatedUser,
  action: 'api_token.create' | 'api_token.revoke',
  tokenId: string,
  projectId: string,
  runId: string | null,
  permissions: readonly string[],
): void {
  const safePermissions = permissions.filter((permission) => TOKEN_PERMISSION_SET.has(permission));
  recordAudit(context, {
    projectId,
    actorType: 'user',
    actorId: actor.id,
    action,
    targetType: 'api_token',
    targetId: tokenId,
    outcome: 'allowed',
    detail: { projectId, runId, permissions: safePermissions },
  });
}

function resolveToken(context: ServerContext, rawToken: string, requiredPermission: TokenPermission, path: string): { actor: AuthenticatedUser; credential: AuthenticatedCredential } {
  const now = context.clock.now().toISOString();
  const row = context.database.prepare(`
    SELECT t.*, u.email AS user_email, u.display_name, tm.role, tm.team_id
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
    JOIN projects p ON p.id = t.project_id
    JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = u.id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
    AND (t.device_token_id IS NULL OR EXISTS (
      SELECT 1 FROM user_device_tokens d WHERE d.id = t.device_token_id
      AND d.user_id = u.id AND d.team_id = p.team_id AND d.revoked_at IS NULL AND d.expires_at > ?
    ))
  `).get(hashToken(rawToken), now, now) as TokenRow | undefined;
  if (!row?.user_id || !row.user_email || !row.display_name || !row.role || !row.team_id) {
    throw new HttpError(401, 'token_invalid', 'The API token is invalid or expired');
  }
  const projectId = pathProject(path);
  const gatewayPermission = requiredPermission.startsWith('gateway:');
  if (!gatewayPermission && requiredPermission !== 'fleet:admin' && (!projectId || projectId !== row.project_id)) throw new HttpError(403, 'token_scope_denied', 'The API token is not valid for this project');
  const permissions = storedPermissions(JSON.parse(row.scopes_json) as unknown);
  if (!permissions.includes(requiredPermission)) throw new HttpError(403, 'token_scope_denied', 'The API token lacks the required permission');
  if ((gatewayPermission || requiredPermission === 'fleet:admin') && row.run_id) throw new HttpError(403, 'token_scope_denied', 'A run-scoped API token cannot perform this operation');
  if ((requiredPermission === 'fleet:admin' || requiredPermission === 'gateway:manage' || requiredPermission === 'gateway:ingest') && row.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
  const actor: AuthenticatedUser = { id: row.user_id, email: row.user_email, displayName: row.display_name, role: row.role, teamId: row.team_id };
  if (!canAccessProject(context, actor, row.project_id, !requiredPermission.endsWith(':read'))) throw new HttpError(403, 'token_scope_denied', 'The API token no longer has the required project access');
  const credential: AuthenticatedCredential = {
    tokenId: row.id,
    projectId: row.project_id,
    permissions,
    userId: row.user_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
  };
  if (requiredPermission === 'fleet:admin') {
    const rawMachineId = /^\/api\/(?:fleet\/)?machines\/([^/]+)\/credential\/replace$/u.exec(path)?.[1];
    let machineId: string | undefined;
    try { machineId = rawMachineId ? decodeURIComponent(rawMachineId) : undefined; } catch { machineId = undefined; }
    const machine = machineId
      ? context.database.prepare('SELECT id FROM machines WHERE id = ? AND team_id = ?').get(machineId, row.team_id)
      : undefined;
    if (!machine) throw new HttpError(403, 'fleet_scope_denied', 'The API token is not valid for this machine team');
  }
  return { actor, credential };
}

export const accessModule: DholeModule = {
  id: 'access',
  register(app, context): void {
    registerDeviceRoutes(app, context);
    app.use('/api/*', async (requestContext, next) => {
      const path = requestContext.req.path;
      const method = requestContext.req.method;
      if (method === 'POST' && ['/api/machines/enrollment/consume', '/api/fleet/enrollment/consume'].includes(path)) return next();
      if (method === 'GET' && /^\/api\/gateway\/catalog\/v1\/[^/]+\/(?:generic|opencode|codex)$/u.test(path)) return next();
      if (method === 'GET' && /^\/api\/gateway\/fixture(?:\/v0\/management\/(?:config|usage-queue))?$/u.test(path) && context.config.environment !== 'production') return next();

      const authorization = requestContext.req.header('authorization');
      if (authorization === undefined && requestContext.get('user')) return next();
      const requiredPermission = routePermission(path, method);
      const rawToken = bearer(authorization);
      if (!requiredPermission || !rawToken) throw new HttpError(401, 'authentication_required', 'Authentication is required');
      const authenticated = resolveToken(context, rawToken, requiredPermission, path);
      const originalAuthorization = JSON.stringify(authenticated);
      requestContext.set('credential', authenticated.credential);
      requestContext.set('user', authenticated.actor);
      requestContext.set('assertAuthorizationCurrent', () => {
        const current = resolveToken(context, rawToken, requiredPermission, path);
        if (JSON.stringify(current) !== originalAuthorization) throw new HttpError(401, 'authorization_changed', 'Authorization changed while the request was being processed');
      });
      context.database.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(context.clock.now().toISOString(), authenticated.credential.tokenId);
      return next();
    });

    app.get('/api/admin/tokens', (requestContext) => {
      const actor = requestContext.get('user');
      if (!actor || actor.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
      const rows = context.database.prepare(`
        SELECT t.id, t.project_id, t.run_id, t.scopes_json, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
        FROM api_tokens t JOIN projects p ON p.id = t.project_id
        WHERE p.team_id = ? ORDER BY t.created_at DESC
      `).all(actor.teamId) as Array<Record<string, unknown>>;
      return requestContext.json({ tokens: rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        runId: row.run_id,
        permissions: storedPermissions(JSON.parse(String(row.scopes_json)) as unknown),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      })) });
    });

    app.post('/api/admin/tokens', async (requestContext) => {
      const actor = requestContext.get('user');
      if (!actor || actor.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
      const input = await parseJson(requestContext, TokenInputSchema);
      if (!canAccessProject(context, actor, input.projectId, input.permissions.some((permission) => !permission.endsWith(':read')))) throw new HttpError(404, 'project_not_found', 'Project not found');
      if (input.runId) {
        const run = context.database.prepare('SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?').get(input.runId, input.projectId) as { id: string } | undefined;
        if (!run) throw new HttpError(404, 'run_not_found', 'Run not found');
      }
      const id = context.ids.id();
      const token = context.ids.token(32);
      const createdAt = context.clock.now();
      const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1_000).toISOString();
      context.events.transaction(() => {
        requestContext.get('assertAuthorizationCurrent')?.();
        context.database.prepare(`
          INSERT INTO api_tokens(id, user_id, project_id, run_id, token_hash, scopes_json, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, actor.id, input.projectId, input.runId ?? null, hashToken(token), JSON.stringify({ projectId: input.projectId, ...(input.runId ? { runId: input.runId } : {}), permissions: input.permissions }), createdAt.toISOString(), expiresAt);
        auditToken(context, actor, 'api_token.create', id, input.projectId, input.runId ?? null, input.permissions);
      });
      return requestContext.json({ id, token, projectId: input.projectId, runId: input.runId, permissions: input.permissions, expiresAt }, 201);
    });

    app.delete('/api/admin/tokens/:tokenId', (requestContext) => {
      const actor = requestContext.get('user');
      if (!actor || actor.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
      const tokenId = requestContext.req.param('tokenId');
      const revokedAt = context.clock.now().toISOString();
      context.events.transaction(() => {
        const token = context.database.prepare(`
          SELECT t.id, t.project_id, t.run_id, t.scopes_json
          FROM api_tokens t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.team_id = ? AND t.revoked_at IS NULL
        `).get(tokenId, actor.teamId) as TokenAuditRow | undefined;
        if (!token) throw new HttpError(404, 'token_not_found', 'API token not found');
        const changed = context.database.prepare(`
          UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE team_id = ?) AND revoked_at IS NULL
        `).run(revokedAt, tokenId, actor.teamId);
        if (changed.changes !== 1) throw new HttpError(404, 'token_not_found', 'API token not found');
        auditToken(context, actor, 'api_token.revoke', token.id, token.project_id, token.run_id, storedPermissions(JSON.parse(token.scopes_json) as unknown));
      });
      return requestContext.json({ ok: true });
    });
  },
};
