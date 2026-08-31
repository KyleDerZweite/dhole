import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Clock } from './clock.js';

export type DatabaseConnection = Database.Database;

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

const defaultMigrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function readMigrations(directory = defaultMigrationDirectory): MigrationRecord[] {
  return readdirSync(directory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.slice(0, 3), 10);
      const sql = readFileSync(resolve(directory, name), 'utf8');
      return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export function migrateDatabase(
  database: DatabaseConnection,
  clock: Clock,
  migrations = readMigrations(),
  targetVersion = Number.POSITIVE_INFINITY,
): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');

  // A malformed migration set is ambiguous: applying either duplicate record
  // could leave the ledger looking valid while running different SQL. Fail
  // before taking a write lock so the caller can fix the migration bundle.
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version ${migration.version}`);
    if (names.has(migration.name)) throw new Error(`Duplicate migration name ${migration.name}`);
    versions.add(migration.version);
    names.add(migration.name);
  }

  const apply = database.transaction((migration: MigrationRecord) => {
    // Re-read the ledger while holding the IMMEDIATE write transaction. A
    // second process may have opened the database after the first process read
    // its initial snapshot; that process must observe and verify the row here
    // instead of attempting to run the migration twice.
    const applied = database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?').get(migration.version) as
      | { name: string; checksum: string }
      | undefined;
    if (applied) {
      if (applied.name !== migration.name) throw new Error(`Applied migration ${migration.version} name changed`);
      if (applied.checksum !== migration.checksum) throw new Error(`Applied migration ${migration.version} checksum changed`);
      return;
    }

    database.exec(migration.sql);
    database
      .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.name, migration.checksum, clock.now().toISOString());
  });
  for (const migration of migrations) {
    if (migration.version > targetVersion) continue;
    apply.immediate(migration);
  }
}

export function openDatabase(path: string, clock: Clock, targetVersion?: number): DatabaseConnection {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  migrateDatabase(database, clock, readMigrations(), targetVersion);
  const hasFts = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'memory_fts'").get() as { count: number };
  if (hasFts.count > 0) database.prepare('SELECT count(*) AS count FROM memory_fts').get();
  return database;
}
