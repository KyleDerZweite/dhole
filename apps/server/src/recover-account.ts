import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { secureIds } from './lib/clock.js';
import { readMigrations } from './lib/database.js';
import { hashToken } from './lib/security.js';

class RecoveryError extends Error {}

const AbsolutePathSchema = z.string().min(1).max(4_096).refine((value) => isAbsolute(value) && !value.includes('\0'));
const OptionsSchema = z.object({
  database: AbsolutePathSchema,
  email: z.string().trim().email().max(320),
  output: AbsolutePathSchema,
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname));
  }),
}).strict();

function privateDirectory(path: string, uid: number): void {
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0 || realpathSync(path) !== path) {
    throw new RecoveryError('Database and output directories must be caller-owned, nonsymlinked, and not writable by group or others');
  }
}

/** Offline recovery writes the only plaintext reset link to an explicitly selected private file. */
export function runAccountRecovery(args: string[], output: (message: string) => void = (message) => process.stdout.write(`${message}\n`)): { outputPath: string; expiresAt: string } {
  let options: z.infer<typeof OptionsSchema>;
  try {
    const parsed = parseArgs({ args, options: { database: { type: 'string' }, email: { type: 'string' }, output: { type: 'string' }, origin: { type: 'string' } }, strict: true, allowPositionals: false });
    options = OptionsSchema.parse(parsed.values);
  } catch {
    throw new RecoveryError('Supply --database and --output as absolute paths, --email, and --origin as HTTPS or loopback HTTP');
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new RecoveryError('Recovery requires a system with caller-owned private files');
  let stat: ReturnType<typeof lstatSync>;
  try {
    privateDirectory(dirname(options.database), uid);
    privateDirectory(dirname(options.output), uid);
    stat = lstatSync(options.database);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || realpathSync(options.database) !== options.database) {
      throw new RecoveryError('The database must be an existing caller-owned private regular file without links');
    }
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('The database and output directory must already exist');
  }

  let database: Database.Database | undefined;
  let outputCreated = false;
  let expiresAt: string;
  try {
    database = new Database(options.database, { fileMustExist: true, timeout: 5_000 });
    const opened = lstatSync(options.database);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new RecoveryError('The database changed while opening it');
    database.pragma('foreign_keys = ON');
    const migration = readMigrations().find((entry) => entry.version === 14);
    const applied = database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 14').get() as { name: string; checksum: string } | undefined;
    if (!migration || applied?.name !== migration.name || applied.checksum !== migration.checksum) {
      throw new RecoveryError('The database must already have the current account recovery migration');
    }
    const db = database;
    expiresAt = db.transaction(() => {
      const administrators = db.prepare(`SELECT COUNT(DISTINCT u.id) AS count FROM users u
        JOIN team_members tm ON tm.user_id = u.id WHERE u.disabled_at IS NULL AND tm.role = 'administrator'`).get() as { count: number };
      const user = db.prepare(`SELECT u.id, u.email, tm.team_id FROM users u JOIN team_members tm ON tm.user_id = u.id
        WHERE u.email = ? AND u.disabled_at IS NULL AND u.password_hash LIKE 'scrypt$%' AND tm.role = 'administrator'
        ORDER BY tm.created_at, tm.team_id LIMIT 1`).get(options.email) as { id: string; email: string; team_id: string } | undefined;
      if (administrators.count !== 1 || !user) throw new RecoveryError('Recovery is limited to the sole active native administrator');
      const now = new Date();
      const expires = new Date(now.getTime() + 3_600_000).toISOString();
      const id = secureIds.id();
      const token = secureIds.token(32);
      const audit = (action: string, grantId: string): void => {
        db.prepare(`INSERT INTO audit_records(id, actor_type, action, target_type, target_id, outcome, detail_json, occurred_at)
          VALUES (?, 'system', ?, 'account_grant', ?, 'allowed', ?, ?)`)
          .run(secureIds.id(), action, grantId, JSON.stringify({ userId: user.id, expiresAt: expires }), now.toISOString());
      };
      const prior = db.prepare("SELECT id FROM account_grants WHERE kind = 'password_reset' AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL").all(user.id) as Array<{ id: string }>;
      for (const grant of prior) {
        db.prepare('UPDATE account_grants SET revoked_at = ? WHERE id = ?').run(now.toISOString(), grant.id);
        audit('auth.operator_recovery.revoke', grant.id);
      }
      db.prepare(`INSERT INTO account_grants(id, kind, team_id, user_id, email, role, token_hash, created_by, created_at, expires_at)
        VALUES (?, 'password_reset', ?, ?, ?, 'administrator', ?, ?, ?, ?)`)
        .run(id, user.team_id, user.id, user.email, hashToken(token), user.id, now.toISOString(), expires);
      audit('auth.operator_recovery.issue', id);
      const descriptor = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      outputCreated = true;
      try {
        fchmodSync(descriptor, 0o600);
        writeFileSync(descriptor, `${JSON.stringify({ setupUrl: `${new URL(options.origin).origin}/#password-reset=${token}`, expiresAt: expires })}\n`, 'utf8');
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      return expires;
    }).immediate();
  } catch (error) {
    if (outputCreated) unlinkSync(options.output);
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('Recovery could not be issued. Check the existing database, migration and unused output path');
  } finally { database?.close(); }
  output(`Account recovery link written to ${options.output}`);
  return { outputPath: options.output, expiresAt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runAccountRecovery(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof RecoveryError ? error.message : 'Account recovery failed'}\n`);
    process.exitCode = 1;
  }
}
