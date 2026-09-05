import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, DholeApp, ServerContext } from '../../lib/module.js';
import { hashPassword, hashToken } from '../../lib/security.js';
import { getSessionAuthentication, notifySessionAuthorizationChanged } from '../../lib/session-auth.js';
import { revokeUserDeviceAuthorizations } from '../access/device.js';
import { BoundedRateLimiter, csrfMiddleware, NativePasswordSchema, recordAudit, requireAdmin } from './core.js';

const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const QuerySchema = z.object({ token: TokenSchema }).strict();
const InvitationSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: z.enum(['administrator', 'member']).default('member'),
  expiresInHours: z.number().int().min(1).max(168).default(24),
}).strict();

interface Grant {
  id: string;
  kind: 'invitation' | 'password_reset';
  team_id: string;
  team_name: string;
  user_id: string | null;
  email: string;
  role: 'administrator' | 'member';
  created_by: string;
  expires_at: string;
}

function invalidGrant(): HttpError {
  return new HttpError(400, 'account_grant_invalid', 'This account link is invalid or expired. Request a new link from your administrator');
}

function grant(server: ServerContext, token: string, kind: Grant['kind']): Grant {
  const row = server.database.prepare(`SELECT g.*, t.name AS team_name FROM account_grants g
    JOIN teams t ON t.id = g.team_id
    JOIN users creator ON creator.id = g.created_by AND creator.disabled_at IS NULL
    JOIN team_members admin ON admin.user_id = creator.id AND admin.team_id = g.team_id AND admin.role = 'administrator'
    WHERE g.token_hash = ? AND g.kind = ? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ?`)
    .get(hashToken(token), kind, server.clock.now().toISOString()) as Grant | undefined;
  const target = row?.user_id ? server.database.prepare(`SELECT u.id FROM users u
    JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
    WHERE u.id = ? AND u.disabled_at IS NULL AND u.email = ?
      AND (tm.role <> 'administrator' OR u.id = ?)`)
    .get(row.team_id, row.user_id, row.email, row.created_by) : undefined;
  if (!row || (kind === 'password_reset' && !target)) throw invalidGrant();
  return row;
}

function emailHint(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function requestBoundary(c: Context<AppEnvironment>, server: ServerContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== server.config.publicOrigin.origin) throw new HttpError(403, 'origin_denied', 'Request origin is not allowed');
  if (c.req.header('authorization')) throw new HttpError(403, 'browser_request_required', 'Use the account setup page');
}

function limit(c: Context<AppEnvironment>, server: ServerContext, limiter: BoundedRateLimiter, bucket: string, max: number): void {
  let address = 'unknown';
  try { address = getConnInfo(c).remote.address ?? address; } catch { /* In-process requests share a conservative bucket. */ }
  const rate = limiter.allow(`account-grant:${bucket}:${address}`, max, 60_000, server.clock.now().getTime());
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter));
    throw new HttpError(429, 'rate_limited', 'Too many account requests. Try again later');
  }
}

function queryToken(c: Context<AppEnvironment>): string {
  const input = QuerySchema.safeParse(c.req.query());
  if (!input.success || c.req.queries('token')?.length !== 1) throw invalidGrant();
  return input.data.token;
}

function consume(server: ServerContext, row: Grant): string {
  const now = server.clock.now().toISOString();
  const changed = server.database.prepare(`UPDATE account_grants SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(now, row.id, now);
  if (changed.changes !== 1) throw invalidGrant();
  return now;
}

function currentAdmin(c: Context<AppEnvironment>, server: ServerContext) {
  const session = getSessionAuthentication(server, c.req.header('cookie'));
  if (!session) throw new HttpError(401, 'authentication_required', 'Sign in again to issue an account link');
  if (session.user.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
  return session.user;
}

function revokePrior(server: ServerContext, kind: Grant['kind'], target: string, actorId: string, teamId: string): void {
  const statement = server.database.prepare(`SELECT id FROM account_grants
    WHERE kind = ? AND ${kind === 'invitation' ? 'email = ? AND team_id = ?' : 'user_id = ?'}
      AND consumed_at IS NULL AND revoked_at IS NULL`);
  const rows = (kind === 'invitation' ? statement.all(kind, target, teamId) : statement.all(kind, target)) as Array<{ id: string }>;
  for (const row of rows) {
    server.database.prepare('UPDATE account_grants SET revoked_at = ? WHERE id = ?').run(server.clock.now().toISOString(), row.id);
    recordAudit(server, { actorType: 'user', actorId, action: `auth.${kind}.revoke`, targetType: 'account_grant', targetId: row.id, outcome: 'allowed' });
  }
}

export function revokeUserAccountGrants(server: ServerContext, userId: string, actorId: string): void {
  const rows = server.database.prepare(`SELECT id, kind FROM account_grants
    WHERE (user_id = ? OR created_by = ?) AND consumed_at IS NULL AND revoked_at IS NULL`)
    .all(userId, userId) as Array<{ id: string; kind: Grant['kind'] }>;
  for (const row of rows) {
    server.database.prepare('UPDATE account_grants SET revoked_at = ? WHERE id = ?').run(server.clock.now().toISOString(), row.id);
    recordAudit(server, { actorType: 'user', actorId, action: `auth.${row.kind}.revoke`, targetType: 'account_grant', targetId: row.id, outcome: 'allowed' });
  }
}

/** Closed enrollment and recovery links are issued by a human administrator and delivered out of band. */
export function registerAccountGrantRoutes(app: DholeApp, server: ServerContext): void {
  const limiter = new BoundedRateLimiter();
  const AcceptSchema = z.object({ token: TokenSchema, displayName: z.string().trim().min(1).max(160), password: NativePasswordSchema }).strict();
  const ResetSchema = z.object({ token: TokenSchema, newPassword: NativePasswordSchema }).strict();
  const admin = async (c: Context<AppEnvironment>): Promise<void> => {
    requestBoundary(c, server);
    await requireAdmin(c, async () => undefined);
    await csrfMiddleware(server, limiter)(c, async () => undefined);
    limit(c, server, limiter, 'issue', 20);
  };
  const publicRequest = (c: Context<AppEnvironment>, bucket: string, max: number): void => {
    requestBoundary(c, server);
    limit(c, server, limiter, bucket, max);
  };
  const audited = (action: string, handler: (c: Context<AppEnvironment>) => Promise<Response>) => async (c: Context<AppEnvironment>): Promise<Response> => {
    try { return await handler(c); }
    catch (error) {
      recordAudit(server, { actorType: 'user', actorId: c.get('user')?.id, action, targetType: 'account_grant', outcome: error instanceof HttpError && error.status < 500 ? 'denied' : 'failed' });
      throw error;
    }
  };

  app.post('/api/admin/invitations', audited('auth.invitation.issue', async (c) => {
    await admin(c);
    const input = await parseJson(c, InvitationSchema, 4_096);
    const now = server.clock.now();
    const expiresAt = new Date(now.getTime() + input.expiresInHours * 3_600_000).toISOString();
    const id = server.ids.id();
    const token = server.ids.token(32);
    server.database.transaction(() => {
      const actor = currentAdmin(c, server);
      if (server.database.prepare('SELECT id FROM users WHERE email = ?').get(input.email)) throw new HttpError(409, 'email_in_use', 'An account with that email already exists');
      revokePrior(server, 'invitation', input.email, actor.id, actor.teamId);
      server.database.prepare(`INSERT INTO account_grants(id, kind, team_id, email, role, token_hash, created_by, created_at, expires_at)
        VALUES (?, 'invitation', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, actor.teamId, input.email, input.role, hashToken(token), actor.id, now.toISOString(), expiresAt);
      recordAudit(server, { actorType: 'user', actorId: actor.id, action: 'auth.invitation.issue', targetType: 'account_grant', targetId: id, outcome: 'allowed', detail: { role: input.role, expiresAt } });
    }).immediate();
    return c.json({ invitation: { id, email: input.email, role: input.role, expiresAt, setupUrl: `${server.config.publicOrigin.origin}/#invitation=${token}` } }, 201);
  }));

  app.get('/api/auth/invitation', (c) => {
    publicRequest(c, 'review', 60);
    const row = grant(server, queryToken(c), 'invitation');
    return c.json({ invitation: { emailHint: emailHint(row.email), teamName: row.team_name, role: row.role, expiresAt: row.expires_at } });
  });

  app.post('/api/auth/invitation/accept', audited('auth.invitation.accept', async (c) => {
    publicRequest(c, 'consume', 10);
    const input = await parseJson(c, AcceptSchema, 8_192);
    grant(server, input.token, 'invitation');
    const passwordHash = await hashPassword(input.password);
    server.database.transaction(() => {
      const row = grant(server, input.token, 'invitation');
      if (server.database.prepare('SELECT id FROM users WHERE email = ?').get(row.email)) throw invalidGrant();
      const now = consume(server, row);
      const userId = server.ids.id();
      server.database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, row.email, input.displayName, passwordHash, now, now);
      server.database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(row.team_id, userId, row.role, now);
      recordAudit(server, { actorType: 'user', actorId: userId, action: 'auth.invitation.accept', targetType: 'account_grant', targetId: row.id, outcome: 'allowed', detail: { role: row.role } });
    }).immediate();
    return c.json({ ok: true }, 201);
  }));

  app.post('/api/admin/users/:id/reset-password', audited('auth.password_reset.issue', async (c) => {
    await admin(c);
    await parseJson(c, z.object({}).strict(), 1_024);
    const userId = z.string().min(1).max(160).parse(c.req.param('id'));
    const now = server.clock.now();
    const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
    const id = server.ids.id();
    const token = server.ids.token(32);
    server.database.transaction(() => {
      const actor = currentAdmin(c, server);
      const target = server.database.prepare(`SELECT u.email, tm.role FROM users u
        JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ? WHERE u.id = ? AND u.disabled_at IS NULL`)
        .get(actor.teamId, userId) as { email: string; role: Grant['role'] } | undefined;
      if (!target) throw new HttpError(404, 'user_not_found', 'User not found');
      if (target.role === 'administrator' && actor.id !== userId) {
        throw new HttpError(403, 'administrator_reset_denied', 'Administrators must request their own password reset');
      }
      revokePrior(server, 'password_reset', userId, actor.id, actor.teamId);
      server.database.prepare(`INSERT INTO account_grants(id, kind, team_id, user_id, email, role, token_hash, created_by, created_at, expires_at)
        VALUES (?, 'password_reset', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, actor.teamId, userId, target.email, target.role, hashToken(token), actor.id, now.toISOString(), expiresAt);
      recordAudit(server, { actorType: 'user', actorId: actor.id, action: 'auth.password_reset.issue', targetType: 'account_grant', targetId: id, outcome: 'allowed', detail: { userId, expiresAt } });
    }).immediate();
    return c.json({ reset: { id, expiresAt, setupUrl: `${server.config.publicOrigin.origin}/#password-reset=${token}` } }, 201);
  }));

  app.get('/api/auth/password/reset', (c) => {
    publicRequest(c, 'review', 60);
    const row = grant(server, queryToken(c), 'password_reset');
    return c.json({ reset: { emailHint: emailHint(row.email), expiresAt: row.expires_at } });
  });

  app.post('/api/auth/password/reset', audited('auth.password_reset.consume', async (c) => {
    publicRequest(c, 'consume', 10);
    const input = await parseJson(c, ResetSchema, 8_192);
    grant(server, input.token, 'password_reset');
    const passwordHash = await hashPassword(input.newPassword);
    server.events.transaction(() => {
      const row = grant(server, input.token, 'password_reset');
      const now = consume(server, row);
      const userId = row.user_id!;
      server.database.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, now, userId);
      server.database.prepare('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      server.database.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      revokeUserDeviceAuthorizations(server, userId, userId);
      revokeUserAccountGrants(server, userId, userId);
      recordAudit(server, { actorType: 'user', actorId: userId, action: 'auth.password_reset.consume', targetType: 'account_grant', targetId: row.id, outcome: 'allowed' });
    });
    notifySessionAuthorizationChanged(server);
    return c.json({ ok: true });
  }));
}
