import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import { hashPassword, hashToken, redactText, tokenMatches, verifyPassword } from '../../lib/security.js';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedUser, DholeApp, DholeModule, ServerContext } from '../../lib/module.js';

/**
 * Browser-facing authentication and project primitives.  The module deliberately
 * keeps sessions opaque: only a random bearer token is ever placed in a cookie;
 * the database stores hashes of both the session and CSRF tokens.
 */

const SESSION_COOKIE = 'dhole_session';
const CSRF_COOKIE = 'dhole_csrf';
const SESSION_DAYS = 7;
const serverByContext = new WeakMap<object, ServerContext>();

const LoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1_024),
});

const UserSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(160),
  password: z.string().min(12).max(1_024),
  role: z.enum(['administrator', 'member']).default('member'),
});

const BootstrapSchema = UserSchema.extend({ teamName: z.string().trim().min(1).max(160).default('Dhole') });

const ProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_096).default(''),
});

const ProjectUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(160), description: z.string().max(4_096) })
  .partial()
  .refine((value) => value.name !== undefined || value.description !== undefined, 'At least one project field is required');

const RepositorySchema = z.object({
  label: z.string().trim().min(1).max(160),
  canonicalRemote: z.string().trim().max(2_048).optional(),
  localPathHint: z
    .string()
    .trim()
    .max(4_096)
    .refine((value) => !value.includes('\0'), 'Repository path contains an invalid character')
    .optional(),
  defaultBranch: z.string().trim().min(1).max(256).optional(),
});

export interface AuditInput {
  projectId?: string | undefined;
  actorType: 'user' | 'node' | 'runtime' | 'system';
  actorId?: string | undefined;
  action: string;
  targetType: string;
  targetId?: string | undefined;
  outcome: 'allowed' | 'denied' | 'failed';
  detail?: Record<string, unknown> | undefined;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: AuthenticatedUser['role'];
  teamId: string;
  createdAt: string;
}

export interface PublicProject {
  id: string;
  teamId: string;
  name: string;
  description: string;
  eventSequence: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicRepository {
  id: string;
  projectId: string;
  label: string;
  canonicalRemote?: string | undefined;
  localPathConfigured: boolean;
  defaultBranch?: string | undefined;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

/** Bounded in-memory limiter; a process restart intentionally resets it. */
export class BoundedRateLimiter {
  readonly #entries = new Map<string, RateEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  allow(key: string, max: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfter: number } {
    if (this.#entries.size > this.maxEntries) {
      for (const [entryKey, entry] of this.#entries) {
        if (entry.resetAt <= now || this.#entries.size > this.maxEntries) this.#entries.delete(entryKey);
        if (this.#entries.size <= this.maxEntries) break;
      }
    }
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (current.count >= max) return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)) };
    current.count += 1;
    return { allowed: true, retryAfter: 0 };
  }
}

export function recordAudit(context: ServerContext, input: AuditInput): void {
  const detail = input.detail ? redactDetail(input.detail) : '{}';
  context.database
    .prepare(
      `INSERT INTO audit_records
       (id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      context.ids.id(),
      input.projectId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.outcome,
      detail,
      context.clock.now().toISOString(),
    );
}

export function auditAllowed(context: ServerContext, user: AuthenticatedUser, action: string, targetType: string, targetId?: string, detail?: Record<string, unknown>): void {
  recordAudit(context, { actorType: 'user', actorId: user.id, action, targetType, ...(targetId ? { targetId } : {}), outcome: 'allowed', ...(detail ? { detail } : {}) });
}

export function auditDenied(context: ServerContext, user: AuthenticatedUser | undefined, action: string, targetType: string, targetId?: string, detail?: Record<string, unknown>): void {
  recordAudit(context, { actorType: 'user', ...(user ? { actorId: user.id } : {}), action, targetType, ...(targetId ? { targetId } : {}), outcome: 'denied', ...(detail ? { detail } : {}) });
}

function redactDetail(detail: Record<string, unknown>): string {
  try {
    const redacted = redactText(JSON.stringify(detail));
    JSON.parse(redacted);
    return redacted;
  } catch {
    return '{}';
  }
}

function requestIp(context: Context<AppEnvironment>): string {
  try {
    return getConnInfo(context).remote.address ?? 'unknown';
  } catch {
    // Hono's in-process request helper has no transport socket. A shared bucket
    // is conservative and, unlike forwarding headers, cannot be spoofed.
    return 'unknown';
  }
}

function requireAuthRequest(context: Context<AppEnvironment>, server: ServerContext): void {
  const origin = context.req.header('origin');
  if (origin !== undefined && origin !== server.config.publicOrigin.origin) throw new HttpError(403, 'origin_denied', 'Request origin is not allowed');
  const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(400, 'invalid_content_type', 'Content-Type must be application/json');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function setCookie(context: Context<AppEnvironment>, name: string, value: string, production: boolean, httpOnly: boolean, maxAge?: number): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=' + (production ? 'Strict' : 'Lax')];
  if (httpOnly) parts.push('HttpOnly');
  if (production) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  context.header('Set-Cookie', parts.join('; '), { append: true });
}

function clearCookies(context: Context<AppEnvironment>, production: boolean): void {
  setCookie(context, SESSION_COOKIE, '', production, true, 0);
  setCookie(context, CSRF_COOKIE, '', production, false, 0);
}

function publicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, teamId: row.team_id, createdAt: row.created_at };
}

function publicProject(row: ProjectRow): PublicProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    eventSequence: row.event_sequence,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicRepository(row: RepositoryRow): PublicRepository {
  const canonicalRemote = safeRemote(row.canonical_remote);
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    ...(canonicalRemote ? { canonicalRemote } : {}),
    localPathConfigured: row.local_path_hint !== null,
    ...(row.default_branch ? { defaultBranch: row.default_branch } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeRemote(value: string | null): string | undefined {
  if (!value) return undefined;
  // Never echo credentials embedded in a remote URL back to the browser.
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return value.includes('@') ? '[redacted remote]' : redactText(value, 2_048);
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  role: AuthenticatedUser['role'];
  team_id: string;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  description: string;
  event_sequence: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RepositoryRow {
  id: string;
  project_id: string;
  label: string;
  canonical_remote: string | null;
  local_path_hint: string | null;
  default_branch: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function userFromContext(context: Context<AppEnvironment>): AuthenticatedUser | undefined {
  return context.get('user');
}

function serverFromContext(context: Context<AppEnvironment>): ServerContext {
  const server = serverByContext.get(context);
  if (!server) throw new Error('Core middleware requires core context');
  return server;
}

export function getCurrentUser(context: Context<AppEnvironment>): AuthenticatedUser {
  const user = userFromContext(context);
  if (!user) throw new HttpError(401, 'authentication_required', 'Authentication is required');
  return user;
}

function loadSessionUser(context: Context<AppEnvironment>, server: ServerContext): AuthenticatedUser | undefined {
  const token = cookieValue(context.req.header('cookie'), SESSION_COOKIE);
  if (!token || token.length < 16) return undefined;
  const now = server.clock.now().toISOString();
  const row = server.database
    .prepare(
      `SELECT u.id, u.email, u.display_name, tm.role, tm.team_id
       FROM web_sessions ws
       JOIN users u ON u.id = ws.user_id
       JOIN team_members tm ON tm.user_id = u.id
       WHERE ws.token_hash = ? AND ws.revoked_at IS NULL AND ws.expires_at > ? AND u.disabled_at IS NULL
       ORDER BY tm.created_at LIMIT 1`,
    )
    .get(hashToken(token), now) as UserRow | undefined;
  if (!row) return undefined;
  server.database.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now, hashToken(token));
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, teamId: row.team_id };
}

export const authMiddleware: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  const server = serverFromContext(context);
  const user = userFromContext(context) ?? loadSessionUser(context, server);
  if (!user) throw new HttpError(401, 'authentication_required', 'Authentication is required');
  context.set('user', user);
  await next();
};

/** Alias kept short for modules that need a normal authentication middleware. */
export const requireUser = authMiddleware;

export const requireAdmin: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  await authMiddleware(context, async () => {
    const user = getCurrentUser(context);
    if (user.role !== 'administrator') {
      const server = serverFromContext(context);
      auditDenied(server, user, 'admin.access', 'admin');
      throw new HttpError(403, 'administrator_required', 'Administrator access is required');
    }
    await next();
  });
};

/** Factory form is convenient for `app.use('/admin/*', requireAdministrator())`. */
export function requireAdministrator(): MiddlewareHandler<AppEnvironment> {
  return requireAdmin;
}

export const requireProjectAccess: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  await authMiddleware(context, async () => {
    const server = serverFromContext(context);
    const user = getCurrentUser(context);
    const projectId = context.req.param('projectId') ?? context.req.param('id');
    if (!projectId) throw new HttpError(400, 'project_id_required', 'A project id is required');
    const project = server.database
      .prepare(
        `SELECT p.id FROM projects p
         JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?
         WHERE p.id = ?`,
      )
      .get(user.id, projectId) as { id: string } | undefined;
    if (!project) {
      auditDenied(server, user, 'project.access', 'project', projectId);
      throw new HttpError(404, 'project_not_found', 'Project not found');
    }
    await next();
  });
};

export const requireSessionParticipant: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  await authMiddleware(context, async () => {
    const server = serverFromContext(context);
    const user = getCurrentUser(context);
    const sessionId = context.req.param('sessionId') ?? context.req.param('id');
    if (!sessionId) throw new HttpError(400, 'session_id_required', 'A session id is required');
    const participant = server.database
      .prepare(
        `SELECT s.id FROM sessions s
         JOIN team_members tm ON tm.team_id = (SELECT team_id FROM projects WHERE id = s.project_id) AND tm.user_id = ?
         LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.user_id = ? AND sp.left_at IS NULL
         WHERE s.id = ? AND (sp.user_id IS NOT NULL OR tm.role = 'administrator')`,
      )
      .get(user.id, user.id, sessionId) as { id: string } | undefined;
    if (!participant) {
      auditDenied(server, user, 'session.access', 'session', sessionId);
      throw new HttpError(404, 'session_not_found', 'Session not found');
    }
    await next();
  });
};

/**
 * CSRF uses the opaque token returned at login and mirrored in a readable cookie.
 * Requiring a header makes cross-site form submissions fail even when cookies are
 * attached by the browser.
 */
export function csrfMiddleware(server: ServerContext, limiter: BoundedRateLimiter): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const user = getCurrentUser(context);
    const sessionToken = cookieValue(context.req.header('cookie'), SESSION_COOKIE);
    const csrfToken = context.req.header('x-csrf-token') ?? context.req.header('x-xsrf-token');
    const result = limiter.allow(`sensitive:${requestIp(context)}:${user.id}`, 120, 60_000);
    if (!result.allowed) {
      context.header('Retry-After', String(result.retryAfter));
      throw new HttpError(429, 'rate_limited', 'Too many sensitive requests');
    }
    if (!sessionToken || !csrfToken) {
      auditDenied(server, user, 'csrf.check', 'request');
      throw new HttpError(403, 'csrf_required', 'A CSRF token is required');
    }
    const row = server.database.prepare('SELECT csrf_hash FROM web_sessions WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(sessionToken)) as { csrf_hash: string } | undefined;
    if (!row || !tokenMatches(csrfToken, row.csrf_hash)) {
      auditDenied(server, user, 'csrf.check', 'request');
      throw new HttpError(403, 'csrf_invalid', 'The CSRF token is invalid');
    }
    await next();
  };
}

async function authorizeMutation(
  context: Context<AppEnvironment>,
  server: ServerContext,
  limiter: BoundedRateLimiter,
  authorize: MiddlewareHandler<AppEnvironment> = authMiddleware,
): Promise<void> {
  await authorize(context, async () => {
    await csrfMiddleware(server, limiter)(context, async () => undefined);
  });
}

function responseUser(user: PublicUser): Record<string, unknown> {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, teamId: user.teamId, createdAt: user.createdAt };
}

function createdSession(server: ServerContext, userId: string): { token: string; csrfToken: string; expiresAt: string } {
  const token = server.ids.token(32);
  const csrfToken = server.ids.token(24);
  const now = server.clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  server.database
    .prepare(
      `INSERT INTO web_sessions(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(server.ids.id(), userId, hashToken(token), hashToken(csrfToken), now.toISOString(), now.toISOString(), expiresAt);
  return { token, csrfToken, expiresAt };
}

function userByEmail(server: ServerContext, email: string): UserRow | undefined {
  return server.database
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, tm.role, tm.team_id
       FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE u.email = ? AND u.disabled_at IS NULL ORDER BY tm.created_at LIMIT 1`,
    )
    .get(email) as UserRow | undefined;
}

function clientError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  return Response.json({ error: { code: 'internal_error', message: 'An internal error occurred' } }, { status: 500 });
}

function json(context: Context<AppEnvironment>, value: Record<string, unknown>, init?: { status?: ContentfulStatusCode }): Response {
  return context.json(value, init);
}

function withErrors<T extends AppEnvironment>(handler: (context: Context<T>) => Response | Promise<Response>): (context: Context<T>) => Promise<Response> {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      return clientError(error);
    }
  };
}

export const coreModule: DholeModule = {
  id: 'core',
  register(app: DholeApp, server: ServerContext): void {
    const limiter = new BoundedRateLimiter();
    // Middleware context is intentionally private to this module.  It lets the
    // exported auth middleware share the exact same DB/clock without global state.
    app.use('*', async (context, next) => {
      serverByContext.set(context, server);
      const user = loadSessionUser(context, server);
      if (user) context.set('user', user);
      try {
        await next();
      } catch (error) {
        if (error instanceof HttpError) return clientError(error);
        throw error;
      }
    });
    app.use('*', async (context, next) => {
      const method = context.req.method.toUpperCase();
      const path = context.req.path;
      const cookie = context.req.header('cookie') ?? '';
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/') && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/bootstrap');
      // Session-cookie API clients must prove intent on every mutation. Routes
      // also perform object/role checks; this guard covers modules registered
      // after Core (Fleet, Runtime, Sessions, ...).
      if (mutating && cookie.includes(`${SESSION_COOKIE}=`)) await authorizeMutation(context, server, limiter);
      await next();
    });

    const health = withErrors(async (context) => {
      server.database.prepare('SELECT 1').get();
      return json(context, { ok: true, status: 'ok', service: 'dhole', now: server.clock.now().toISOString() });
    });
    app.get('/health', health);
    app.get('/healthz', health);
    app.get('/api/health', health);
    app.get('/api/healthz', health);

    app.post('/api/auth/bootstrap', withErrors(async (context) => {
      requireAuthRequest(context, server);
      const rate = limiter.allow(`bootstrap:${requestIp(context)}`, 5, 60_000);
      if (!rate.allowed) {
        context.header('Retry-After', String(rate.retryAfter));
        throw new HttpError(429, 'rate_limited', 'Too many authentication attempts');
      }
      const existing = server.database.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
      if (existing) throw new HttpError(409, 'bootstrap_unavailable', 'An administrator already exists');
      const input = await parseJson(context, BootstrapSchema);
      const now = server.clock.now().toISOString();
      const teamId = server.ids.id();
      const userId = server.ids.id();
      await hashAndInsertUser(server, { ...input, role: 'administrator' }, userId, teamId, now, input.teamName, true, true);
      const session = createdSession(server, userId);
      const row = userByEmail(server, input.email);
      if (!row) throw new Error('Bootstrap user was not created');
      setCookie(context, SESSION_COOKIE, session.token, server.config.environment === 'production', true);
      setCookie(context, CSRF_COOKIE, session.csrfToken, server.config.environment === 'production', false);
      return json(context, { user: responseUser(publicUser(row)), csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { status: 201 });
    }));

    app.post('/api/auth/login', withErrors(async (context) => {
      requireAuthRequest(context, server);
      const input = await parseJson(context, LoginSchema);
      const rateKey = `login:${requestIp(context)}:${input.email.toLowerCase()}`;
      const rate = limiter.allow(rateKey, 10, 60_000);
      if (!rate.allowed) {
        context.header('Retry-After', String(rate.retryAfter));
        throw new HttpError(429, 'rate_limited', 'Too many authentication attempts');
      }
      const row = userByEmail(server, input.email);
      const valid = row ? await verifyPassword(input.password, row.password_hash) : false;
      if (!row || !valid) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
      const session = createdSession(server, row.id);
      setCookie(context, SESSION_COOKIE, session.token, server.config.environment === 'production', true);
      setCookie(context, CSRF_COOKIE, session.csrfToken, server.config.environment === 'production', false);
      auditAllowed(server, publicUser(row), 'auth.login', 'user', row.id);
      return json(context, { user: responseUser(publicUser(row)), csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    }));

    app.post('/api/auth/logout', withErrors(async (context) => {
      await authorizeMutation(context, server, limiter);
      const token = cookieValue(context.req.header('cookie'), SESSION_COOKIE);
      if (token) server.database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(server.clock.now().toISOString(), hashToken(token));
      const user = getCurrentUser(context);
      auditAllowed(server, user, 'auth.logout', 'user', user.id);
      clearCookies(context, server.config.environment === 'production');
      return json(context, { ok: true });
    }));

    app.get('/api/auth/me', withErrors(async (context) => {
      await authMiddleware(context, async () => undefined);
      const user = getCurrentUser(context);
      const row = userByEmail(server, user.email);
      if (!row) throw new HttpError(401, 'authentication_required', 'Authentication is required');
      const csrfToken = cookieValue(context.req.header('cookie'), CSRF_COOKIE);
      return json(context, { user: responseUser(publicUser(row)), ...(csrfToken ? { csrfToken } : {}) });
    }));

    app.get('/api/users', withErrors(async (context) => {
      await requireAdmin(context, async () => undefined);
      const user = getCurrentUser(context);
      const rows = server.database
        .prepare(
          `SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, tm.role, tm.team_id
           FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ? ORDER BY u.created_at, u.id`,
        )
        .all(user.teamId) as UserRow[];
      return json(context, { users: rows.map((row) => responseUser(publicUser(row))) });
    }));
    app.get('/api/admin/users', withErrors(async (context) => {
      await requireAdmin(context, async () => undefined);
      const user = getCurrentUser(context);
      const rows = server.database
        .prepare(
          `SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, tm.role, tm.team_id
           FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ? ORDER BY u.created_at, u.id`,
        )
        .all(user.teamId) as UserRow[];
      return json(context, { users: rows.map((row) => responseUser(publicUser(row))) });
    }));
    const createUser = withErrors(async (context) => {
      await authorizeMutation(context, server, limiter, requireAdmin);
      const actor = getCurrentUser(context);
      const input = await parseJson(context, UserSchema);
      const existing = server.database.prepare('SELECT id FROM users WHERE email = ?').get(input.email) as { id: string } | undefined;
      if (existing) throw new HttpError(409, 'email_in_use', 'A user with that email already exists');
      const now = server.clock.now().toISOString();
      const id = server.ids.id();
      await hashAndInsertUser(server, input, id, actor.teamId, now, 'Dhole', false);
      const row = userByEmail(server, input.email);
      if (!row) throw new Error('User was not created');
      auditAllowed(server, actor, 'user.create', 'user', id, { role: input.role });
      return json(context, { user: responseUser(publicUser(row)) }, { status: 201 });
    });
    app.post('/api/users', createUser);
    app.post('/api/admin/users', createUser);

    app.get('/api/projects', withErrors(async (context) => {
      await authMiddleware(context, async () => undefined);
      const user = getCurrentUser(context);
      const rows = server.database
        .prepare(
          `SELECT p.id, p.team_id, p.name, p.description, p.event_sequence, p.created_by, p.created_at, p.updated_at
           FROM projects p JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?
           ORDER BY p.updated_at DESC, p.id`,
        )
        .all(user.id) as ProjectRow[];
      return json(context, { projects: rows.map(publicProject) });
    }));

    app.post('/api/projects', withErrors(async (context) => {
      await authorizeMutation(context, server, limiter);
      const user = getCurrentUser(context);
      const input = await parseJson(context, ProjectCreateSchema);
      const duplicate = server.database.prepare('SELECT id FROM projects WHERE team_id = ? AND name = ?').get(user.teamId, input.name) as { id: string } | undefined;
      if (duplicate) throw new HttpError(409, 'project_name_in_use', 'A project with that name already exists');
      const now = server.clock.now().toISOString();
      const id = server.ids.id();
      const row = server.database.transaction(() => {
        server.database
          .prepare(
            `INSERT INTO projects(id, team_id, name, description, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, user.teamId, input.name, input.description, user.id, now, now);
        auditAllowed(server, user, 'project.create', 'project', id);
        return server.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
      })();
      return json(context, { project: publicProject(row) }, { status: 201 });
    }));

    app.get('/api/projects/:projectId', withErrors(async (context) => {
      await requireProjectAccess(context, async () => undefined);
      const row = server.database.prepare('SELECT * FROM projects WHERE id = ?').get(context.req.param('projectId')) as ProjectRow | undefined;
      if (!row) throw new HttpError(404, 'project_not_found', 'Project not found');
      const repositories = server.database.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at, id').all(row.id) as RepositoryRow[];
      return json(context, { project: publicProject(row), repositories: repositories.map(publicRepository) });
    }));

    const updateProject = withErrors(async (context) => {
      await requireProjectAccess(context, async () => undefined);
      await csrfMiddleware(server, limiter)(context, async () => undefined);
      const user = getCurrentUser(context);
      const projectId = context.req.param('projectId');
      const input = await parseJson(context, ProjectUpdateSchema);
      const current = server.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
      if (!current) throw new HttpError(404, 'project_not_found', 'Project not found');
      const name = input.name ?? current.name;
      const description = input.description ?? current.description;
      const duplicate = server.database.prepare('SELECT id FROM projects WHERE team_id = ? AND name = ? AND id <> ?').get(current.team_id, name, current.id) as { id: string } | undefined;
      if (duplicate) throw new HttpError(409, 'project_name_in_use', 'A project with that name already exists');
      const now = server.clock.now().toISOString();
      const row = server.database.transaction(() => {
        server.database.prepare('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, now, current.id);
        auditAllowed(server, user, 'project.update', 'project', current.id);
        return server.database.prepare('SELECT * FROM projects WHERE id = ?').get(current.id) as ProjectRow;
      })();
      return json(context, { project: publicProject(row) });
    });
    app.patch('/api/projects/:projectId', updateProject);
    app.put('/api/projects/:projectId', updateProject);

    app.delete('/api/projects/:projectId', withErrors(async (context) => {
      await requireProjectAccess(context, async () => undefined);
      await csrfMiddleware(server, limiter)(context, async () => undefined);
      const user = getCurrentUser(context);
      const projectId = context.req.param('projectId');
      const row = server.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
      if (!row) throw new HttpError(404, 'project_not_found', 'Project not found');
      auditDenied(server, user, 'project.delete', 'project', projectId, { reason: 'append_only_history' });
      throw new HttpError(409, 'project_deletion_not_supported', 'Project deletion is not supported because project history is append-only');
    }));

    app.get('/api/projects/:projectId/repositories', withErrors(async (context) => {
      await requireProjectAccess(context, async () => undefined);
      const projectId = context.req.param('projectId');
      const rows = server.database.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at, id').all(projectId) as RepositoryRow[];
      return json(context, { repositories: rows.map(publicRepository) });
    }));

    const registerRepository = withErrors(async (context) => {
      await requireProjectAccess(context, async () => undefined);
      await csrfMiddleware(server, limiter)(context, async () => undefined);
      const user = getCurrentUser(context);
      const projectId = context.req.param('projectId');
      const input = await parseJson(context, RepositorySchema);
      const duplicate = server.database.prepare('SELECT id FROM repositories WHERE project_id = ? AND label = ?').get(projectId, input.label) as { id: string } | undefined;
      if (duplicate) throw new HttpError(409, 'repository_label_in_use', 'A repository with that label already exists');
      const now = server.clock.now().toISOString();
      const id = server.ids.id();
      const row = server.database.transaction(() => {
        server.database
          .prepare(
            `INSERT INTO repositories(id, project_id, label, canonical_remote, local_path_hint, default_branch, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, projectId, input.label, input.canonicalRemote ?? null, input.localPathHint ?? null, input.defaultBranch ?? null, user.id, now, now);
        auditAllowed(server, user, 'repository.register', 'repository', id, { projectId });
        return server.database.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as RepositoryRow;
      })();
      return json(context, { repository: publicRepository(row) }, { status: 201 });
    });
    app.post('/api/projects/:projectId/repositories', registerRepository);
    app.post('/api/projects/:projectId/repository', registerRepository);
  },
};

async function hashAndInsertUser(
  server: ServerContext,
  input: { email: string; displayName: string; password: string; role: AuthenticatedUser['role'] },
  userId: string,
  teamId: string,
  now: string,
  teamName = 'Dhole',
  createTeam = true,
  requireEmpty = false,
): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  server.database.transaction(() => {
    if (requireEmpty && server.database.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      throw new HttpError(409, 'bootstrap_unavailable', 'An administrator already exists');
    }
    if (createTeam) server.database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, teamName, now);
    server.database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, input.email, input.displayName, passwordHash, now, now);
    server.database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(teamId, userId, input.role, now);
  })();
}

export default coreModule;
