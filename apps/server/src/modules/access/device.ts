import { randomBytes, sign } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { z } from 'zod';
import { TokenPermissionSchema } from '@dhole-control/shared';
import type { AppEnvironment, AuthenticatedUser, DholeApp, ServerContext } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { hashToken, redactText } from '../../lib/security.js';
import { getSessionAuthentication } from '../../lib/session-auth.js';
import { BoundedRateLimiter, csrfMiddleware, recordAudit } from '../core/index.js';
import { getGithubIdentity } from '../core/github.js';
import { canAccessProject, createProject, createProjectRepository } from '../core/projects.js';
import { createMachineService, type EnrollmentResult } from '../core/machines/index.js';

const PermissionsSchema = z.array(TokenPermissionSchema).min(1).max(TokenPermissionSchema.options.length).transform((values) => [...new Set(values)]);
const ADMIN_PERMISSIONS = new Set(['fleet:admin', 'gateway:ingest', 'gateway:manage']);
const DEFAULT_PERMISSIONS = ['project:read', 'coordination:write'] as const;
const CODE_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const UserCodeSchema = z.string().trim().regex(/^[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}$/u).transform((value) => value.replace('-', '').toUpperCase());
const StartSchema = z.object({ machineName: z.string().trim().min(1).max(160), permissions: PermissionsSchema.default([...DEFAULT_PERMISSIONS]) }).strict();
const PollSchema = z.object({ deviceCode: z.string().min(32).max(256) }).strict();
const ApproveSchema = z.object({ userCode: UserCodeSchema, permissions: PermissionsSchema }).strict();
const ProjectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual'), projectId: z.string().min(1).max(160), permissions: PermissionsSchema.default([...DEFAULT_PERMISSIONS]) }).strict(),
  z.object({ mode: z.literal('github'), remote: z.string().trim().min(1).max(512), permissions: PermissionsSchema.default([...DEFAULT_PERMISSIONS]) }).strict(),
]);
const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_096).optional(),
  repository: z.object({ label: z.string().trim().min(1).max(160), canonicalRemote: z.string().trim().max(2_048).optional(), defaultBranch: z.string().trim().min(1).max(256).optional() }).strict().optional(),
}).strict();

interface DeviceRequest {
  id: string;
  machine_name: string;
  requested_permissions_json: string;
  permissions_json: string | null;
  user_id: string | null;
  team_id: string | null;
  expires_at: string;
  last_polled_at: string | null;
  approved_at: string | null;
  revoked_at: string | null;
  consumed_at: string | null;
}

interface DeviceToken {
  id: string;
  user_id: string;
  team_id: string;
  machine_name: string;
  machine_id: string | null;
  permissions_json: string;
  expires_at: string;
  role: AuthenticatedUser['role'];
  email: string;
  display_name: string;
}

function human(c: Context<AppEnvironment>, server: ServerContext): AuthenticatedUser {
  if (c.req.header('authorization') || !c.req.header('cookie')?.includes('dhole_session=')) {
    throw new HttpError(403, 'browser_session_required', 'Use your signed-in browser to approve or revoke machines');
  }
  const authentication = getSessionAuthentication(server, c.req.header('cookie'));
  if (!authentication) throw new HttpError(401, 'authentication_required', 'Sign in before managing machine authorization');
  return authentication.user;
}

function machineOnly(c: Context<AppEnvironment>): void {
  if (c.req.header('cookie') || c.req.header('origin') || c.get('user')) {
    throw new HttpError(403, 'machine_client_required', 'This credential exchange is available only to machine clients');
  }
  c.header('Cache-Control', 'no-store');
}

function deviceToken(c: Context<AppEnvironment>, server: ServerContext): DeviceToken {
  machineOnly(c);
  const token = /^Bearer\s+(\S+)$/iu.exec(c.req.header('authorization') ?? '')?.[1];
  if (!token || token.length > 512) throw new HttpError(401, 'device_token_invalid', 'The machine authorization is invalid or expired');
  const now = server.clock.now().toISOString();
  const row = server.database.prepare(`
    SELECT d.*, tm.role, u.email, u.display_name FROM user_device_tokens d
    JOIN users u ON u.id = d.user_id AND u.disabled_at IS NULL
    JOIN team_members tm ON tm.user_id = d.user_id AND tm.team_id = d.team_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ?
  `).get(hashToken(token), now) as DeviceToken | undefined;
  if (!row) throw new HttpError(401, 'device_token_invalid', 'The machine authorization is invalid or expired');
  server.database.prepare('UPDATE user_device_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return row;
}

function deviceUser(device: DeviceToken): AuthenticatedUser {
  return { id: device.user_id, teamId: device.team_id, role: device.role, email: device.email, displayName: device.display_name };
}

/** Legacy enrollment has no user-device binding. Bound nodes retain their owner's current authority. */
export function machineDeviceAuthorized(server: ServerContext, machineId: string): boolean {
  const bound = server.database.prepare('SELECT id FROM user_device_tokens WHERE machine_id = ?').get(machineId);
  if (!bound) return true;
  const rows = server.database.prepare(`SELECT d.user_id, d.permissions_json FROM user_device_tokens d
    JOIN users u ON u.id = d.user_id AND u.disabled_at IS NULL
    JOIN machines m ON m.id = d.machine_id AND m.team_id = d.team_id
    JOIN team_members tm ON tm.user_id = d.user_id AND tm.team_id = d.team_id AND tm.role = 'administrator'
    WHERE d.machine_id = ? AND d.revoked_at IS NULL AND d.expires_at > ?
  `).all(machineId, server.clock.now().toISOString()) as Array<{ user_id: string; permissions_json: string }>;
  return rows.some((row) => {
    try {
      return PermissionsSchema.parse(JSON.parse(row.permissions_json)).includes('fleet:admin');
    } catch { return false; }
  });
}

/** Account disablement and role changes permanently revoke previously granted machine authority. */
export function revokeUserDeviceAuthorizations(server: ServerContext, userId: string, actorId: string): void {
  server.events.transaction(() => {
    const now = server.clock.now().toISOString();
    createMachineService(server).revokeEnrollmentTokensForUser(userId, actorId);
    const requests = server.database.prepare('SELECT id FROM device_authorization_requests WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL').all(userId) as Array<{ id: string }>;
    for (const request of requests) {
      server.database.prepare('UPDATE device_authorization_requests SET revoked_at = ? WHERE id = ?').run(now, request.id);
      audit(server, actorId, 'device.request_revoked', request.id);
    }
    const rows = server.database.prepare('SELECT id, machine_id FROM user_device_tokens WHERE user_id = ? AND revoked_at IS NULL').all(userId) as Array<{ id: string; machine_id: string | null }>;
    for (const row of rows) {
      server.database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(now, row.id);
      server.database.prepare('UPDATE api_tokens SET revoked_at = ? WHERE device_token_id = ? AND revoked_at IS NULL').run(now, row.id);
      if (row.machine_id) createMachineService(server).revokeMachine(row.machine_id, actorId);
      audit(server, actorId, 'device.revoked', row.id);
    }
  });
}

function audit(server: ServerContext, userId: string, action: string, id: string, detail?: Record<string, unknown>): void {
  recordAudit(server, { actorType: 'user', actorId: userId, action, targetType: 'device_authorization', targetId: id, outcome: 'allowed', detail });
}

function checkedRequest(row: DeviceRequest | undefined, now: string): DeviceRequest {
  if (!row) throw new HttpError(400, 'device_code_invalid', 'The authorization code is invalid');
  if (row.expires_at <= now) throw new HttpError(400, 'device_code_expired', 'The authorization code has expired. Start machine authorization again');
  if (row.revoked_at) throw new HttpError(400, 'device_code_revoked', 'The authorization code was revoked. Start machine authorization again');
  if (row.consumed_at) throw new HttpError(400, 'device_code_used', 'The authorization code has already been used');
  return row;
}

function limit(c: Context<AppEnvironment>, server: ServerContext, limiter: BoundedRateLimiter, bucket: string, max: number, windowMs = 60_000): void {
  let address = 'unknown';
  try { address = getConnInfo(c).remote.address ?? address; } catch { /* In-process requests share the bounded fallback bucket. */ }
  const result = limiter.allow(`${bucket}:${address}`, max, windowMs, server.clock.now().getTime());
  if (!result.allowed) {
    c.header('Retry-After', String(result.retryAfter));
    throw new HttpError(429, 'rate_limited', 'Too many authorization requests. Try again later');
  }
}

function githubRemote(remote: string): { owner: string; repository: string; canonicalRemote: string } {
  const path = remote.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/iu, '').replace(/\.git$/iu, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/u.exec(path);
  if (!match?.[1] || !match[2] || match[2] === '.' || match[2] === '..') throw new HttpError(422, 'github_remote_invalid', 'Use an unambiguous GitHub push remote without credentials');
  const owner = match[1].toLowerCase();
  const repository = match[2].toLowerCase();
  return { owner, repository, canonicalRemote: `https://github.com/${owner}/${repository}.git` };
}

async function githubJson<T>(path: string, token: string, schema: z.ZodType<T>, body?: Record<string, unknown>): Promise<T> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Dhole', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      throw new HttpError(403, 'github_access_denied', 'The GitHub App must be installed on this repository and your linked GitHub account must have write or admin permission');
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('GitHub unavailable'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing GitHub response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512 * 1024) { await reader.cancel(); throw new Error('GitHub response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'github_verification_unavailable', 'GitHub repository permission could not be verified. Try again later');
  }
}

async function verifiedGithubRepository(server: ServerContext, device: DeviceToken, remote: string): Promise<{ id: number; canonicalRemote: string; name: string; defaultBranch: string }> {
  const app = server.config.githubApp;
  if (!app) throw new HttpError(503, 'github_app_not_configured', 'The server operator must configure a GitHub App before repository authorization is available');
  const identity = getGithubIdentity(server, device.user_id);
  if (!identity) throw new HttpError(403, 'github_identity_required', 'Sign in with GitHub before authorizing this repository');
  const normalized = githubRemote(remote);
  const now = Math.floor(server.clock.now().getTime() / 1_000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 300, iss: app.appId })}`;
  let jwt: string;
  try { jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), app.privateKey).toString('base64url')}`; }
  catch { throw new HttpError(503, 'github_app_not_configured', 'The GitHub App signing key is invalid'); }
  const repoPath = `/repos/${normalized.owner}/${normalized.repository}`;
  const installation = await githubJson(`${repoPath}/installation`, jwt, z.object({ id: z.number().int().positive().safe() }));
  const issued = await githubJson(`/app/installations/${installation.id}/access_tokens`, jwt, z.object({
    token: z.string().min(1).max(1_024), permissions: z.record(z.string(), z.string()),
  }), { repositories: [normalized.repository], permissions: { metadata: 'read' } });
  if (Object.entries(issued.permissions).some(([key, value]) => key !== 'metadata' || value !== 'read')) {
    throw new HttpError(503, 'github_verification_unavailable', 'GitHub returned broader repository permissions than requested');
  }
  const repo = await githubJson(repoPath, issued.token, z.object({ id: z.number().int().positive().safe(), full_name: z.string().max(200), default_branch: z.string().min(1).max(256) }));
  const permission = await githubJson(`${repoPath}/collaborators/${encodeURIComponent(identity.login)}/permission`, issued.token, z.object({
    permission: z.string(), user: z.object({ id: z.number().int().positive().safe() }),
  }));
  if (getGithubIdentity(server, device.user_id)?.githubUserId !== identity.githubUserId || permission.user.id !== identity.githubUserId || !['write', 'admin'].includes(permission.permission) || repo.full_name.toLowerCase() !== `${normalized.owner}/${normalized.repository}`) {
    throw new HttpError(403, 'github_push_required', 'Your linked GitHub account must have write or admin permission on this push repository');
  }
  return { id: repo.id, canonicalRemote: normalized.canonicalRemote, name: repo.full_name, defaultBranch: repo.default_branch };
}

export function registerDeviceRoutes(app: DholeApp, server: ServerContext): void {
  const limiter = new BoundedRateLimiter();
  createMachineService(server).setMachineAuthorizationCheck((machineId) => machineDeviceAuthorized(server, machineId));
  app.get('/api/auth/device/status', (c) => {
    const device = deviceToken(c, server);
    const machine = device.machine_id ? server.database.prepare('SELECT status FROM machines WHERE id = ?').get(device.machine_id) as { status: string } | undefined : undefined;
    return c.json({ id: device.id, permissions: PermissionsSchema.parse(JSON.parse(device.permissions_json)), expiresAt: device.expires_at, machineId: device.machine_id, machineStatus: machine?.status ?? null });
  });
  app.post('/api/auth/device/start', async (c) => {
    machineOnly(c);
    limit(c, server, limiter, 'start', 10);
    const input = await parseJson(c, StartSchema, 4_096);
    const now = server.clock.now();
    const pending = server.database.prepare('SELECT COUNT(*) AS count FROM device_authorization_requests WHERE expires_at > ? AND consumed_at IS NULL AND revoked_at IS NULL').get(now.toISOString()) as { count: number };
    if (pending.count >= 1_000) throw new HttpError(429, 'rate_limited', 'Too many pending machine authorizations');
    const deviceCode = server.ids.token(32);
    const code = randomBytes(4).toString('hex').toUpperCase();
    const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    server.database.transaction(() => {
      server.database.prepare('DELETE FROM device_authorization_requests WHERE expires_at <= ?').run(now.toISOString());
      server.database.prepare(`INSERT INTO device_authorization_requests(id, device_code_hash, user_code_hash, machine_name, requested_permissions_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(server.ids.id(), hashToken(deviceCode), hashToken(code), redactText(input.machineName), JSON.stringify(input.permissions), now.toISOString(), new Date(now.getTime() + CODE_TTL_MS).toISOString());
    })();
    const verificationUri = new URL('/connect', server.config.publicOrigin).href;
    return c.json({ deviceCode, userCode, verificationUri, verificationUriComplete: `${verificationUri}?user_code=${userCode}`, expiresIn: CODE_TTL_MS / 1_000, interval: POLL_INTERVAL_MS / 1_000 }, 201);
  });

  app.get('/api/auth/device/requests/:userCode', (c) => {
    human(c, server);
    limit(c, server, limiter, 'review', 30);
    const code = UserCodeSchema.safeParse(c.req.param('userCode'));
    if (!code.success) throw new HttpError(400, 'device_code_invalid', 'The authorization code is invalid');
    const row = checkedRequest(server.database.prepare('SELECT * FROM device_authorization_requests WHERE user_code_hash = ?').get(hashToken(code.data)) as DeviceRequest | undefined, server.clock.now().toISOString());
    c.header('Cache-Control', 'no-store');
    return c.json({ machineName: row.machine_name, permissions: PermissionsSchema.parse(JSON.parse(row.requested_permissions_json)), expiresAt: row.expires_at, status: row.approved_at ? 'approved' : 'pending' });
  });

  app.post('/api/auth/device/approve', async (c) => {
    const actor = human(c, server);
    await csrfMiddleware(server, limiter)(c, async () => undefined);
    limit(c, server, limiter, 'approve', 20);
    const input = await parseJson(c, ApproveSchema, 4_096);
    const now = server.clock.now().toISOString();
    server.events.transaction(() => {
      const active = human(c, server);
      if (active.id !== actor.id || active.teamId !== actor.teamId) throw new HttpError(403, 'device_scope_denied', 'The approving user no longer has the required access');
      const row = checkedRequest(server.database.prepare('SELECT * FROM device_authorization_requests WHERE user_code_hash = ?').get(hashToken(input.userCode)) as DeviceRequest | undefined, now);
      if (row.approved_at) throw new HttpError(409, 'device_already_approved', 'This machine authorization was already approved');
      const requested = PermissionsSchema.parse(JSON.parse(row.requested_permissions_json));
      if (input.permissions.some((permission) => !requested.includes(permission)) || (input.permissions.some((permission) => ADMIN_PERMISSIONS.has(permission)) && active.role !== 'administrator')) {
        throw new HttpError(403, 'device_scope_denied', 'Only requested permissions you are authorized to grant may be approved');
      }
      server.database.prepare('UPDATE device_authorization_requests SET user_id = ?, team_id = ?, permissions_json = ?, approved_at = ? WHERE id = ?').run(actor.id, actor.teamId, JSON.stringify(input.permissions), now, row.id);
      audit(server, actor.id, 'device.approve', row.id, { permissions: input.permissions });
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true });
  });

  app.post('/api/auth/device/poll', async (c) => {
    machineOnly(c);
    limit(c, server, limiter, 'poll', 120);
    const input = await parseJson(c, PollSchema, 4_096);
    const now = server.clock.now();
    const row = checkedRequest(server.database.prepare('SELECT * FROM device_authorization_requests WHERE device_code_hash = ?').get(hashToken(input.deviceCode)) as DeviceRequest | undefined, now.toISOString());
    if (row.last_polled_at && now.getTime() - Date.parse(row.last_polled_at) < POLL_INTERVAL_MS) {
      c.header('Retry-After', String(POLL_INTERVAL_MS / 1_000));
      throw new HttpError(429, 'slow_down', 'Wait five seconds between authorization polls');
    }
    server.database.prepare('UPDATE device_authorization_requests SET last_polled_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    if (!row.user_id || !row.team_id || !row.permissions_json) throw new HttpError(400, 'authorization_pending', 'Approve this machine in your signed-in browser');
    const active = server.database.prepare(`SELECT tm.role FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE u.id = ? AND u.disabled_at IS NULL AND tm.team_id = ?`).get(row.user_id, row.team_id) as { role: string } | undefined;
    const permissions = PermissionsSchema.parse(JSON.parse(row.permissions_json));
    if (!active || (permissions.some((permission) => ADMIN_PERMISSIONS.has(permission)) && active.role !== 'administrator')) throw new HttpError(403, 'device_scope_denied', 'The approving user no longer has the required access');
    const count = server.database.prepare('SELECT COUNT(*) AS count FROM user_device_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(row.user_id, now.toISOString()) as { count: number };
    if (count.count >= 50) throw new HttpError(409, 'device_limit_reached', 'Revoke an old machine authorization before connecting another machine');
    const token = server.ids.token(32);
    const id = server.ids.id();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
    server.events.transaction(() => {
      const consumed = server.database.prepare('UPDATE device_authorization_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').run(now.toISOString(), row.id, now.toISOString());
      if (consumed.changes !== 1) throw new HttpError(400, 'device_code_used', 'The authorization code has already been used');
      server.database.prepare(`INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.user_id, row.team_id, row.machine_name, hashToken(token), JSON.stringify(permissions), now.toISOString(), expiresAt);
      audit(server, row.user_id!, 'device.authorized', id, { permissions, expiresAt });
    });
    return c.json({ token, id, permissions, expiresAt });
  });

  app.get('/api/auth/devices', (c) => {
    const actor = human(c, server);
    const rows = server.database.prepare('SELECT id, machine_name, machine_id, permissions_json, created_at, expires_at, last_used_at, revoked_at FROM user_device_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(actor.id) as Array<Record<string, unknown>>;
    c.header('Cache-Control', 'no-store');
    return c.json({ devices: rows.map((row) => ({ id: row.id, machineName: row.machine_name, machineId: row.machine_id, permissions: PermissionsSchema.parse(JSON.parse(String(row.permissions_json))), createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at })) });
  });

  app.delete('/api/auth/devices/:id', async (c) => {
    const actor = human(c, server);
    await csrfMiddleware(server, limiter)(c, async () => undefined);
    const id = c.req.param('id');
    const now = server.clock.now().toISOString();
    const row = server.database.prepare('SELECT machine_id FROM user_device_tokens WHERE id = ? AND user_id = ?').get(id, actor.id) as { machine_id: string | null } | undefined;
    if (!row) throw new HttpError(404, 'device_not_found', 'Machine authorization not found');
    server.events.transaction(() => {
      const changed = server.database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
      server.database.prepare('UPDATE api_tokens SET revoked_at = ? WHERE device_token_id = ? AND revoked_at IS NULL').run(now, id);
      if (changed.changes) audit(server, actor.id, 'device.revoked', id);
      if (row.machine_id) createMachineService(server).revokeMachine(row.machine_id, actor.id);
    });
    return c.json({ ok: true });
  });

  app.post('/api/auth/device/projects', async (c) => {
    deviceToken(c, server);
    const input = await parseJson(c, CreateProjectSchema, 16_384);
    const keyResult = z.string().trim().min(1).max(160).optional().safeParse(c.req.header('idempotency-key'));
    if (!keyResult.success) throw new HttpError(422, 'idempotency_key_invalid', 'Idempotency-Key must contain between 1 and 160 characters');
    const device = deviceToken(c, server);
    if (!PermissionsSchema.parse(JSON.parse(device.permissions_json)).includes('projects:create')) throw new HttpError(403, 'device_scope_denied', 'Approve project creation for this machine before creating a project');
    const actor = deviceUser(device);
    const scope = `device-project:${device.id}`;
    const requestHash = hashToken(JSON.stringify(input));
    const result = server.events.transaction(() => {
      if (keyResult.data) {
        const prior = server.database.prepare('SELECT request_hash, response_json FROM idempotency_receipts WHERE scope = ? AND idempotency_key = ?').get(scope, keyResult.data) as { request_hash: string; response_json: string } | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash) throw new HttpError(409, 'idempotency_conflict', 'The project creation key was already used with different details');
          const response = z.object({ project: z.object({ id: z.string() }).passthrough() }).passthrough().parse(JSON.parse(prior.response_json));
          if (!canAccessProject(server, actor, response.project.id)) throw new HttpError(403, 'project_access_denied', 'You no longer have access to this project');
          return response;
        }
        const count = server.database.prepare('SELECT COUNT(*) AS count FROM idempotency_receipts WHERE scope = ?').get(scope) as { count: number };
        if (count.count >= 1_000) throw new HttpError(429, 'project_creation_limit', 'This machine has reached its project creation limit');
      }
      limit(c, server, limiter, `create-project:${device.id}`, 10);
      const project = createProject(server, actor, { name: input.name, ...(input.description !== undefined ? { description: input.description } : {}) });
      const repository = input.repository ? createProjectRepository(server, actor, project.id, {
        label: input.repository.label,
        ...(input.repository.canonicalRemote !== undefined ? { canonicalRemote: input.repository.canonicalRemote } : {}),
        ...(input.repository.defaultBranch !== undefined ? { defaultBranch: input.repository.defaultBranch } : {}),
      }) : undefined;
      const response = { project, ...(repository ? { repository } : {}), authorizationSource: 'native', repositoryVerification: 'unverified' };
      if (keyResult.data) {
        const now = server.clock.now().toISOString();
        server.database.prepare(`INSERT INTO idempotency_receipts(scope, idempotency_key, request_hash, response_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)`).run(scope, keyResult.data, requestHash, JSON.stringify(response), now, now);
      }
      audit(server, actor.id, 'device.project_created', device.id, { projectId: project.id, repositoryId: repository?.id });
      return response;
    });
    return c.json(result, 201);
  });

  app.post('/api/auth/device/project', async (c) => {
    let device = deviceToken(c, server);
    limit(c, server, limiter, `project:${device.id}`, 30);
    const input = await parseJson(c, ProjectSchema, 4_096);
    const allowed = PermissionsSchema.parse(JSON.parse(device.permissions_json));
    if (input.permissions.includes('fleet:admin') || input.permissions.includes('projects:create') || input.permissions.some((permission) => !allowed.includes(permission)) || (input.permissions.some((permission) => ADMIN_PERMISSIONS.has(permission)) && device.role !== 'administrator')) throw new HttpError(403, 'device_scope_denied', 'The machine authorization lacks these project permissions');
    const verified = input.mode === 'github' ? await verifiedGithubRepository(server, device, input.remote) : undefined;
    // GitHub calls await the network, so recheck revocation and membership before issuing a bearer.
    device = deviceToken(c, server);
    if (input.permissions.some((permission) => ADMIN_PERMISSIONS.has(permission)) && device.role !== 'administrator') throw new HttpError(403, 'device_scope_denied', 'The machine owner no longer has the required project permissions');
    const now = server.clock.now();
    const expiresAt = new Date(Math.min(Date.parse(device.expires_at), now.getTime() + (verified ? 300_000 : 3_600_000))).toISOString();
    const token = server.ids.token(32);
    const id = server.ids.id();
    const actor = deviceUser(device);
    const needsWrite = input.permissions.some((permission) => !['project:read', 'memory:read', 'skills:read', 'gateway:read'].includes(permission));
    const binding = server.events.transaction(() => {
      let projectId: string;
      let repositoryId: string | undefined;
      if (input.mode === 'manual') {
        if (!canAccessProject(server, actor, input.projectId, needsWrite)) throw new HttpError(403, 'project_access_denied', 'Your Dhole account needs the required permission on this project');
        projectId = input.projectId;
      } else {
        if (!verified) throw new Error('Missing verified repository');
        const existing = server.database.prepare('SELECT project_id, repository_id FROM github_repository_bindings WHERE team_id = ? AND github_repository_id = ?').get(device.team_id, verified.id) as { project_id: string; repository_id: string } | undefined;
        if (existing) {
          if (!canAccessProject(server, actor, existing.project_id, needsWrite)) throw new HttpError(403, 'project_access_denied', 'GitHub access does not grant membership in this private Dhole project');
          projectId = existing.project_id; repositoryId = existing.repository_id;
        }
        else {
          if (!allowed.includes('projects:create')) throw new HttpError(403, 'device_scope_denied', 'Approve project creation before binding a new GitHub repository');
          projectId = createProject(server, actor, { name: `${verified.name.slice(0, 120)} [GitHub ${verified.id}]` }).id;
          repositoryId = createProjectRepository(server, actor, projectId, { label: verified.name, canonicalRemote: verified.canonicalRemote, defaultBranch: verified.defaultBranch }).id;
          server.database.prepare('INSERT INTO github_repository_bindings(team_id, github_repository_id, project_id, repository_id, verified_at) VALUES (?, ?, ?, ?, ?)').run(device.team_id, verified.id, projectId, repositoryId, now.toISOString());
          audit(server, device.user_id, 'device.repository_bound', device.id, { projectId, repositoryId, githubRepositoryId: verified.id });
        }
        server.database.prepare('UPDATE github_repository_bindings SET verified_at = ? WHERE project_id = ?').run(now.toISOString(), projectId);
      }
      server.database.prepare(`INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at, device_token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, device.user_id, projectId, hashToken(token), JSON.stringify({ projectId, permissions: input.permissions }), now.toISOString(), expiresAt, device.id);
      audit(server, device.user_id, 'device.project_token_created', id, { projectId, permissions: input.permissions, authorizationSource: input.mode, expiresAt });
      return { projectId, ...(repositoryId ? { repositoryId } : {}) };
    });
    return c.json({ ...binding, token, id, permissions: input.permissions, expiresAt, authorizationSource: input.mode }, 201);
  });

  app.post('/api/auth/device/enroll', async (c) => {
    let device = deviceToken(c, server);
    limit(c, server, limiter, `enroll:${device.id}`, 5);
    const input = await parseJson(c, z.object({ machineName: z.string().trim().min(1).max(160).optional() }).strict(), 4_096);
    device = deviceToken(c, server);
    if (device.role !== 'administrator' || !PermissionsSchema.parse(JSON.parse(device.permissions_json)).includes('fleet:admin')) throw new HttpError(403, 'device_scope_denied', 'Administrator machine enrollment permission is required');
    const fleet = createMachineService(server);
    const result = server.events.transaction(() => {
      let enrolled: EnrollmentResult;
      if (device.machine_id) {
        const machine = fleet.getMachine(device.machine_id);
        if (!machine || machine.status === 'revoked') throw new HttpError(403, 'machine_revoked', 'The bound machine has been revoked');
        enrolled = { machineId: device.machine_id, teamId: device.team_id, machineName: String(machine.name), ...fleet.replaceDeviceCredential(device.machine_id, device.user_id), consumedAt: server.clock.now().toISOString() };
      } else {
        let name = input.machineName ?? device.machine_name;
        const named = server.database.prepare('SELECT id, status FROM machines WHERE team_id = ? AND name = ?').get(device.team_id, name) as { id: string; status: string } | undefined;
        if (named) {
          const owned = named.status === 'revoked' && server.database.prepare('SELECT id FROM user_device_tokens WHERE machine_id = ? AND user_id = ?').get(named.id, device.user_id);
          if (!owned) throw new HttpError(409, 'machine_name_in_use', 'Use a unique name for this machine');
          name = `${name.slice(0, 150)}-${server.ids.id().slice(0, 8)}`;
        }
        const enrollment = fleet.issueEnrollmentToken({ teamId: device.team_id, label: name, createdBy: device.user_id });
        enrolled = fleet.consumeEnrollmentToken(enrollment.token, name);
        server.database.prepare('UPDATE user_device_tokens SET machine_id = ? WHERE id = ?').run(enrolled.machineId, device.id);
      }
      server.database.prepare('UPDATE device_credentials SET expires_at = ? WHERE id = ?').run(device.expires_at, enrolled.credentialId);
      return enrolled;
    });
    return c.json(result, 201);
  });
}
