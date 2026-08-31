import { z } from 'zod';
import type { DholeModule, AuthenticatedCredential, AuthenticatedUser } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { hashToken } from '../../lib/security.js';
import { recordAudit } from '../core/index.js';

const TOKEN_PERMISSIONS = [
  'project:read',
  'coordination:write',
  'fleet:admin',
  'children:write',
  'memory:read',
  'memory:propose',
  'skills:read',
  'skills:propose',
  'benchmarks:run',
] as const;
const TOKEN_PERMISSION_SET = new Set<string>(TOKEN_PERMISSIONS);

const TokenInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  runId: z.string().min(1).max(160).optional(),
  permissions: z.array(z.enum(TOKEN_PERMISSIONS)).min(1).max(16),
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

function compatibilityAccess(path: string, method: string): 'project:read' | 'coordination:write' | 'fleet:admin' | undefined {
  if (/^\/api\/fleet\/machines\/[^/]+\/credential\/replace$/u.test(path)) return method === 'POST' ? 'fleet:admin' : undefined;
  if (!/^\/api\/projects\/[^/]+\/(?:sessions|claims|check|state|agent-events)(?:\/|$)/u.test(path)) return undefined;
  return method === 'GET' ? 'project:read' : 'coordination:write';
}

function pathProject(path: string): string | undefined {
  const match = /^\/api\/projects\/([^/]+)\//u.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
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

export const accessModule: DholeModule = {
  id: 'access',
  register(app, context): void {
    app.use('/api/*', async (requestContext, next) => {
      if (requestContext.get('user')) return next();
      const path = requestContext.req.path;
      if (path === '/api/fleet/enrollment/consume') return next();
      if (path.startsWith('/api/gateway/fixture') && context.config.environment !== 'production') return next();

      const requiredPermission = compatibilityAccess(path, requestContext.req.method);
      const rawToken = bearer(requestContext.req.header('authorization'));
      if (!requiredPermission || !rawToken) throw new HttpError(401, 'authentication_required', 'Authentication is required');
      const now = context.clock.now().toISOString();
      const row = context.database.prepare(`
        SELECT t.*, u.email AS user_email, u.display_name, tm.role, tm.team_id
        FROM api_tokens t
        JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
        JOIN projects p ON p.id = t.project_id
        JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = u.id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
      `).get(hashToken(rawToken), now) as TokenRow | undefined;
      if (!row?.user_id || !row.user_email || !row.display_name || !row.role || !row.team_id) {
        throw new HttpError(401, 'token_invalid', 'The API token is invalid or expired');
      }
      const projectId = pathProject(path);
      if (requiredPermission !== 'fleet:admin' && (!projectId || projectId !== row.project_id)) throw new HttpError(403, 'token_scope_denied', 'The API token is not valid for this project');
      const permissions = storedPermissions(JSON.parse(row.scopes_json) as unknown);
      if (!permissions.includes(requiredPermission)) throw new HttpError(403, 'token_scope_denied', 'The API token lacks the required permission');
      const credential: AuthenticatedCredential = {
        tokenId: row.id,
        projectId: row.project_id,
        permissions,
        userId: row.user_id,
        ...(row.run_id ? { runId: row.run_id } : {}),
      };
      requestContext.set('credential', credential);
      requestContext.set('user', {
        id: row.user_id,
        email: row.user_email,
        displayName: row.display_name,
        role: row.role,
        teamId: row.team_id,
      });
      if (requiredPermission === 'fleet:admin') {
        const rawMachineId = /^\/api\/fleet\/machines\/([^/]+)\/credential\/replace$/u.exec(path)?.[1];
        let machineId: string | undefined;
        try { machineId = rawMachineId ? decodeURIComponent(rawMachineId) : undefined; } catch { machineId = undefined; }
        const machine = machineId
          ? context.database.prepare('SELECT id FROM machines WHERE id = ? AND team_id = ?').get(machineId, row.team_id)
          : undefined;
        if (!machine) throw new HttpError(403, 'fleet_scope_denied', 'The API token is not valid for this machine team');
      }
      context.database.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
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
      const project = context.database.prepare('SELECT id FROM projects WHERE id = ? AND team_id = ?').get(input.projectId, actor.teamId) as { id: string } | undefined;
      if (!project) throw new HttpError(404, 'project_not_found', 'Project not found');
      if (input.runId) {
        const run = context.database.prepare('SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?').get(input.runId, input.projectId) as { id: string } | undefined;
        if (!run) throw new HttpError(404, 'run_not_found', 'Run not found');
      }
      const id = context.ids.id();
      const token = context.ids.token(32);
      const createdAt = context.clock.now();
      const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1_000).toISOString();
      context.events.transaction(() => {
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
