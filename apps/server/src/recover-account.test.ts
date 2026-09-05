import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { secureIds, systemClock } from './lib/clock.js';
import { loadConfig } from './lib/config.js';
import { openDatabase } from './lib/database.js';
import { EventStore } from './lib/events.js';
import { HttpError } from './lib/http.js';
import type { AppEnvironment, ServerContext } from './lib/module.js';
import { hashPassword, hashToken, verifyPassword } from './lib/security.js';
import { coreModule } from './modules/core/core.js';
import { runAccountRecovery } from './recover-account.js';

const databases: ServerContext['database'][] = [];
const directories: string[] = [];
let passwordHash: string;
beforeAll(async () => { passwordHash = await hashPassword('the existing administrator password'); });
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dhole-account-recovery-'));
  directories.push(directory);
  const path = join(directory, 'dhole.db');
  const outputPath = join(directory, 'recovery.json');
  const database = openDatabase(path, systemClock);
  databases.push(database);
  const now = systemClock.now().toISOString();
  const teamId = secureIds.id();
  const userId = secureIds.id();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, 'Fixture team', now);
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'admin@example.test', 'Administrator', passwordHash, now, now);
  database.prepare("INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, 'administrator', ?)").run(teamId, userId, now);
  const args = ['--database', path, '--email', 'admin@example.test', '--output', outputPath, '--origin', 'https://dhole.example.test'];
  const run = (values = args) => {
    const messages: string[] = [];
    const result = runAccountRecovery(values, (message) => { messages.push(message); });
    const file = JSON.parse(readFileSync(result.outputPath, 'utf8')) as { setupUrl: string; expiresAt: string };
    return { ...result, ...file, messages, token: new URLSearchParams(new URL(file.setupUrl).hash.slice(1)).get('password-reset')! };
  };
  return { directory, path, outputPath, database, teamId, userId, now, args, run };
}

describe('offline sole-administrator recovery', () => {
  it('writes a private link with a hashed one-hour grant that the normal reset consumer accepts once', async () => {
    const f = fixture();
    const before = Date.now();
    const result = f.run();
    expect(statSync(f.outputPath).mode & 0o777).toBe(0o600);
    expect(result.messages).toEqual([`Account recovery link written to ${f.outputPath}`]);
    expect(result.messages.join('')).not.toContain(result.token);
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(f.database.prepare('SELECT password_hash FROM users WHERE id = ?').get(f.userId)).toEqual({ password_hash: passwordHash });
    expect(f.database.prepare('SELECT token_hash, consumed_at, revoked_at FROM account_grants').get()).toEqual({ token_hash: hashToken(result.token), consumed_at: null, revoked_at: null });
    expect(f.database.prepare('SELECT actor_type, action FROM audit_records').get()).toEqual({ actor_type: 'system', action: 'auth.operator_recovery.issue' });
    expect(JSON.stringify(f.database.prepare('SELECT * FROM account_grants').all()) + JSON.stringify(f.database.prepare('SELECT * FROM audit_records').all())).not.toContain(result.token);

    const sessionToken = secureIds.token(32);
    f.database.prepare('INSERT INTO web_sessions(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(secureIds.id(), f.userId, hashToken(sessionToken), hashToken(secureIds.token(24)), f.now, f.now, result.expiresAt);
    const context: ServerContext = {
      config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: f.path, DHOLE_PUBLIC_ORIGIN: 'https://dhole.example.test' }),
      database: f.database, clock: systemClock, ids: secureIds, events: new EventStore(f.database, systemClock, secureIds), enabledModules: new Set(['core', 'access']),
    };
    const app = new Hono<AppEnvironment>();
    coreModule.register(app, context);
    app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : 'internal_error' }, error instanceof HttpError ? error.status : 500));
    const consume = () => app.request('/api/auth/password/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: result.token, newPassword: 'the recovered administrator password' }) });
    const accepted = await consume();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('set-cookie')).toBeNull();
    expect((await consume()).status).toBe(400);
    expect(f.database.prepare('SELECT count(*) AS count FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL').get(f.userId)).toEqual({ count: 0 });
    const user = f.database.prepare('SELECT password_hash FROM users WHERE id = ?').get(f.userId) as { password_hash: string };
    expect(await verifyPassword('the recovered administrator password', user.password_hash)).toBe(true);
  });

  it('replaces prior recovery grants and rolls back without damaging them when output creation fails', () => {
    const f = fixture();
    const first = f.run();
    const replacementPath = join(f.directory, 'replacement.json');
    const replacement = f.run(f.args.map((value) => value === f.outputPath ? replacementPath : value));
    expect(f.database.prepare('SELECT revoked_at FROM account_grants WHERE token_hash = ?').get(hashToken(first.token))).toEqual({ revoked_at: expect.any(String) });
    expect(f.database.prepare('SELECT count(*) AS count FROM account_grants WHERE revoked_at IS NULL').get()).toEqual({ count: 1 });
    const before = f.database.prepare('SELECT * FROM account_grants ORDER BY id').all();
    const auditCount = f.database.prepare('SELECT count(*) AS count FROM audit_records').get();
    expect(() => f.run()).toThrow('unused output path');
    expect(f.database.prepare('SELECT * FROM account_grants ORDER BY id').all()).toEqual(before);
    expect(f.database.prepare('SELECT count(*) AS count FROM audit_records').get()).toEqual(auditCount);
    expect(JSON.parse(readFileSync(f.outputPath, 'utf8'))).toMatchObject({ setupUrl: first.setupUrl });
    expect(f.database.prepare('SELECT revoked_at FROM account_grants WHERE token_hash = ?').get(hashToken(replacement.token))).toEqual({ revoked_at: null });
  });

  it('requires the sole active native administrator and refuses missing, member, disabled, or ambiguous accounts', () => {
    const f = fixture();
    const rejected = () => {
      expect(() => f.run()).toThrow('sole active native administrator');
      expect(existsSync(f.outputPath)).toBe(false);
      expect(f.database.prepare('SELECT count(*) AS count FROM account_grants').get()).toEqual({ count: 0 });
    };
    expect(() => f.run(f.args.map((value) => value === 'admin@example.test' ? 'missing@example.test' : value))).toThrow('sole active native administrator');
    f.database.prepare("UPDATE team_members SET role = 'member' WHERE user_id = ?").run(f.userId);
    rejected();
    f.database.prepare("UPDATE team_members SET role = 'administrator' WHERE user_id = ?").run(f.userId);
    f.database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(f.now, f.userId);
    rejected();
    f.database.prepare('UPDATE users SET disabled_at = NULL, password_hash = ? WHERE id = ?').run('external-identity', f.userId);
    rejected();
    f.database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, f.userId);
    const secondId = secureIds.id();
    f.database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(secondId, 'second@example.test', 'Second administrator', passwordHash, f.now, f.now);
    f.database.prepare("INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, 'administrator', ?)").run(f.teamId, secondId, f.now);
    rejected();
  });

  it('removes the new private output and preserves prior authority when the database commit fails', () => {
    const f = fixture();
    const first = f.run();
    const secondPath = join(f.directory, 'failed-replacement.json');
    f.database.exec(`CREATE TABLE recovery_commit_failure(user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_recovery AFTER INSERT ON audit_records WHEN NEW.action = 'auth.operator_recovery.issue'
      BEGIN INSERT INTO recovery_commit_failure(user_id) VALUES ('missing-user'); END;`);
    expect(() => f.run(f.args.map((value) => value === f.outputPath ? secondPath : value))).toThrow('could not be issued');
    expect(existsSync(secondPath)).toBe(false);
    expect(f.database.prepare('SELECT count(*) AS count FROM account_grants').get()).toEqual({ count: 1 });
    expect(f.database.prepare('SELECT revoked_at FROM account_grants WHERE token_hash = ?').get(hashToken(first.token))).toEqual({ revoked_at: null });
    expect(f.database.prepare('SELECT count(*) AS count FROM audit_records').get()).toEqual({ count: 1 });
  });

  it('requires explicit safe arguments and never creates a database or overwrites an output link', () => {
    const f = fixture();
    expect(() => runAccountRecovery([], () => undefined)).toThrow('Supply --database');
    expect(() => f.run(f.args.map((value) => value === f.path ? 'relative.db' : value))).toThrow('Supply --database');
    for (const origin of ['http://remote.example.test', 'https://user:password@example.test', 'https://dhole.example.test/path', 'https://dhole.example.test/?query=yes', 'https://dhole.example.test/#fragment']) {
      expect(() => f.run(f.args.map((value) => value === 'https://dhole.example.test' ? origin : value))).toThrow('Supply --database');
    }
    const missing = join(f.directory, 'missing.db');
    expect(() => f.run(f.args.map((value) => value === f.path ? missing : value))).toThrow('must already exist');
    expect(existsSync(missing)).toBe(false);
    chmodSync(f.path, 0o644);
    expect(() => f.run()).toThrow('private regular file');
    chmodSync(f.path, 0o600);
    const symlink = join(f.directory, 'linked.db');
    symlinkSync(f.path, symlink);
    expect(() => f.run(f.args.map((value) => value === f.path ? symlink : value))).toThrow('private regular file');
    const target = join(f.directory, 'keep.txt');
    writeFileSync(target, 'preserve this file');
    symlinkSync(target, f.outputPath);
    expect(() => f.run()).toThrow('unused output path');
    expect(readFileSync(target, 'utf8')).toBe('preserve this file');
    expect(f.database.prepare('SELECT count(*) AS count FROM account_grants').get()).toEqual({ count: 0 });
  });

  it('refuses databases missing the migration and accepts an explicit loopback origin', () => {
    const f = fixture();
    const row = f.database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 14').get() as { name: string; checksum: string };
    f.database.prepare('DELETE FROM schema_migrations WHERE version = 14').run();
    expect(() => f.run()).toThrow('current account recovery migration');
    expect(existsSync(f.outputPath)).toBe(false);
    f.database.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (14, ?, ?, ?)').run(row.name, row.checksum, f.now);
    const result = f.run(f.args.map((value) => value === 'https://dhole.example.test' ? 'http://127.0.0.1:4173' : value));
    expect(new URL(result.setupUrl).origin).toBe('http://127.0.0.1:4173');
  });
});
