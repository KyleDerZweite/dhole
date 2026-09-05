import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServerContext } from '../../lib/module.js';
import { HttpError } from '../../lib/http.js';
import { hashToken, tokenMatches } from '../../lib/security.js';

const OAUTH_LIFETIME_MS = 10 * 60_000;
const RESPONSE_LIMIT = 128 * 1024;
const IdentitySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i),
});
const AccessTokenSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  token_type: z.string().transform((value) => value.toLowerCase()).pipe(z.literal('bearer')),
});

export interface GithubIdentity {
  githubUserId: number;
  login: string;
}

interface PendingLogin {
  browserHash: string;
  verifier: string;
  expiresAt: number;
  userId: string;
  sessionHash: string;
}

export interface GithubLinkBinding { userId: string; sessionHash: string }

/** OAuth tokens exist only during the exchange. Restarting invalidates pending logins. */
export class GithubOAuth {
  readonly #pending = new Map<string, PendingLogin>();

  constructor(private readonly server: ServerContext, private readonly fetcher: typeof fetch = fetch) {}

  start(binding: GithubLinkBinding): { authorizeUrl: string; browserToken: string } {
    const config = this.server.config.githubAuth;
    if (!config) throw new HttpError(503, 'github_unavailable', 'GitHub sign-in is unavailable');
    const now = this.server.clock.now().getTime();
    for (const [key, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(key);
    if (this.#pending.size >= 1_000) throw new HttpError(429, 'rate_limited', 'Too many pending sign-ins');
    const state = this.server.ids.token(32);
    const browserToken = this.server.ids.token(32);
    const verifier = this.server.ids.token(48);
    this.#pending.set(hashToken(state), { ...binding, browserHash: hashToken(browserToken), verifier, expiresAt: now + OAUTH_LIFETIME_MS });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString(), browserToken };
  }

  async complete(state: string, browserToken: string | undefined, code: string | undefined, binding: GithubLinkBinding | undefined): Promise<GithubIdentity> {
    const pending = this.#pending.get(hashToken(state));
    this.#pending.delete(hashToken(state));
    if (!pending || !browserToken || !binding || pending.userId !== binding.userId || pending.sessionHash !== binding.sessionHash
      || !tokenMatches(browserToken, pending.browserHash) || pending.expiresAt <= this.server.clock.now().getTime()) {
      throw new HttpError(403, 'github_state_invalid', 'GitHub sign-in expired or belongs to another browser');
    }
    if (!code) throw new HttpError(403, 'github_authorization_denied', 'GitHub sign-in was not authorized');
    const config = this.server.config.githubAuth;
    if (!config) throw new HttpError(503, 'github_unavailable', 'GitHub sign-in is unavailable');
    try {
      const token = AccessTokenSchema.parse(await this.request('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: this.callbackUrl(), code_verifier: pending.verifier }),
      }));
      const identity = IdentitySchema.parse(await this.request('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token.access_token}`, 'x-github-api-version': '2022-11-28' },
      }));
      return { githubUserId: identity.id, login: identity.login };
    } catch {
      throw new HttpError(503, 'github_unavailable', 'GitHub sign-in failed. Try again later');
    }
  }

  private callbackUrl(): string {
    return new URL('/api/auth/github/callback', this.server.config.publicOrigin).toString();
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(url, {
        ...init,
        headers: { accept: 'application/json', 'user-agent': 'Dhole', ...init.headers },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > RESPONSE_LIMIT || !response.body) throw new Error('GitHub response unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) {
            await reader.cancel();
            throw new Error('GitHub response too large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Returns a server-verified identity only while its account remains authorized. */
export function getGithubIdentity(server: ServerContext, userId: string): GithubIdentity | undefined {
  const row = server.database.prepare(`SELECT gi.github_user_id, gi.login FROM github_identities gi
    JOIN users u ON u.id = gi.user_id WHERE gi.user_id = ? AND gi.status = 'active' AND u.disabled_at IS NULL`).get(userId) as
    { github_user_id: number; login: string } | undefined;
  return row ? { githubUserId: row.github_user_id, login: row.login } : undefined;
}

export function linkGithubIdentity(server: ServerContext, userId: string, identity: GithubIdentity): void {
  server.database.transaction(() => {
    const now = server.clock.now().toISOString();
    if (!server.database.prepare('SELECT id FROM users WHERE id = ? AND disabled_at IS NULL').get(userId)) throw new HttpError(401, 'authentication_required', 'Authentication is required');
    const existing = server.database.prepare('SELECT user_id, github_user_id FROM github_identities WHERE user_id = ? OR github_user_id = ?')
      .all(userId, identity.githubUserId) as { user_id: string; github_user_id: number }[];
    if (existing.some((row) => row.user_id !== userId || row.github_user_id !== identity.githubUserId)) {
      throw new HttpError(409, 'github_identity_conflict', 'This GitHub account cannot be linked');
    }
    server.database.prepare(`INSERT INTO github_identities(user_id, github_user_id, login, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, status = 'active', updated_at = excluded.updated_at`)
      .run(userId, identity.githubUserId, identity.login, now, now);
  }).immediate();
}
