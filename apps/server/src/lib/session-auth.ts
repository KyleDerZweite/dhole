import { z } from 'zod';
import type { AuthenticatedUser, ServerContext } from './module.js';
import { hashToken } from './security.js';

const authorizationListeners = new WeakMap<ServerContext, Set<() => void>>();
const SessionTokenSchema = z.string().min(16).max(512);

export function subscribeSessionAuthorizationChanges(context: ServerContext, listener: () => void): () => void {
  let listeners = authorizationListeners.get(context);
  if (!listeners) {
    listeners = new Set();
    authorizationListeners.set(context, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Call after a committed logout, account disable, or authorization change. */
export function notifySessionAuthorizationChanged(context: ServerContext): void {
  for (const listener of authorizationListeners.get(context) ?? []) listener();
}

export function loadSessionUser(context: ServerContext, tokenHash: string): AuthenticatedUser | undefined {
  const row = context.database.prepare(`
    SELECT u.id, u.email, u.display_name, tm.role, tm.team_id
    FROM web_sessions ws
    JOIN users u ON u.id = ws.user_id
    JOIN team_members tm ON tm.user_id = u.id
    WHERE ws.token_hash = ? AND ws.revoked_at IS NULL AND ws.expires_at > ? AND u.disabled_at IS NULL
    ORDER BY tm.created_at LIMIT 1
  `).get(tokenHash, context.clock.now().toISOString()) as {
    id: string;
    email: string;
    display_name: string;
    role: AuthenticatedUser['role'];
    team_id: string;
  } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role, teamId: row.team_id } : undefined;
}

export function getSessionAuthentication(context: ServerContext, cookieHeader: string | undefined): { user: AuthenticatedUser; tokenHash: string } | undefined {
  const encoded = cookieHeader?.split(';').map((item) => item.trim()).find((item) => item.startsWith('dhole_session='))?.slice('dhole_session='.length);
  if (!encoded) return undefined;
  let token: string;
  try { token = decodeURIComponent(encoded); } catch { return undefined; }
  if (!SessionTokenSchema.safeParse(token).success) return undefined;
  const tokenHash = hashToken(token);
  const user = loadSessionUser(context, tokenHash);
  return user ? { user, tokenHash } : undefined;
}
