import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';
import { migrateDatabase, openDatabase, readMigrations, type MigrationRecord } from './database.js';
import { EventStore } from './events.js';

const directories: string[] = [];
const currentVersion = readMigrations().at(-1)!.version;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('migrates an empty database through the current schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-migrate-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'dhole.db'), systemClock);
    expect(database.prepare('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: currentVersion });
    expect(database.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it.each([6, currentVersion - 1])('migrates schema %i without losing rows', (previousVersion) => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-previous-'));
    directories.push(directory);
    const path = join(directory, 'dhole.db');
    const previous = openDatabase(path, systemClock, previousVersion);
    previous.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Test', '2026-08-30T00:00:00.000Z');
    previous.close();
    const current = openDatabase(path, systemClock);
    expect(current.prepare('SELECT name FROM teams WHERE id = ?').get('team-1')).toEqual({ name: 'Test' });
    expect(current.prepare("SELECT count(*) count FROM sqlite_master WHERE name = 'memory_generations'").get()).toEqual({ count: 1 });
    expect(current.prepare('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: currentVersion });
    expect(current.prepare("SELECT count(*) count FROM sqlite_master WHERE name = 'coordination_agent_events'").get()).toEqual({ count: 1 });
    current.close();
  });

  it('installs integrity indexes and active-generation guards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dhole-integrity-'));
    directories.push(directory);
    const database = openDatabase(join(directory, 'dhole.db'), systemClock);

    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'coordination_%' ORDER BY name").all()).toEqual([
      { name: 'coordination_agent_events' },
      { name: 'coordination_agent_executions' },
      { name: 'coordination_claim_components' },
      { name: 'coordination_claim_files' },
      { name: 'coordination_claim_settlements' },
      { name: 'coordination_claims' },
      { name: 'coordination_conflicts' },
      { name: 'coordination_findings' },
      { name: 'coordination_repo_reports' },
      { name: 'coordination_sessions' },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('coordination_claim_files_lookup', 'coordination_claim_components_lookup', 'event_native_id') ORDER BY name").all()).toEqual([
      { name: 'coordination_claim_components_lookup' },
      { name: 'coordination_claim_files_lookup' },
      { name: 'event_native_id' },
    ]);
    const eventIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'event_native_id'").get() as { sql: string };
    expect(eventIndex.sql).toMatch(/COALESCE\(source_adapter, ''\)/);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_%active%' ORDER BY name").all()).toEqual([
      { name: 'memory_generation_active_delete' },
      { name: 'memory_pack_active_generation_valid' },
      { name: 'memory_pack_active_generation_valid_insert' },
    ]);

    database.exec(`
      INSERT INTO teams(id, name, created_at) VALUES ('team', 'Team', '2026-08-30T00:00:00.000Z');
      INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at)
        VALUES ('user', 'user@example.test', 'User', 'hash', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
        VALUES ('project', 'team', 'Project', 'user', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    `);
    const insertEvent = database.prepare(`
      INSERT INTO event_log(event_id, project_id, project_sequence, event_kind, schema_version, aggregate_type, aggregate_id,
        actor_type, source_kind, source_native_event_id, payload_json, occurred_at)
      VALUES (?, 'project', ?, 'test', 1, 'test', ?, 'system', 'platform', 'native-1', '{}', '2026-08-30T00:00:00.000Z')
    `);
    insertEvent.run('event-1', 1, 'aggregate-1');
    expect(() => insertEvent.run('event-2', 2, 'aggregate-2')).toThrow(/unique/i);
    expect(() => database.prepare('DELETE FROM projects WHERE id = ?').run('project')).toThrow(/immutable history/);
    expect(() => database.prepare('DELETE FROM teams WHERE id = ?').run('team')).toThrow(/immutable history/);
    database.prepare(`
      INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
      VALUES ('audit-project', 'team', 'Audit project', 'user', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO audit_records(id, project_id, actor_type, action, target_type, outcome, occurred_at)
      VALUES ('audit-1', 'audit-project', 'system', 'test', 'project', 'allowed', '2026-08-30T00:00:00.000Z')
    `).run();
    expect(() => database.prepare('DELETE FROM projects WHERE id = ?').run('audit-project')).toThrow(/immutable history/);

    expect(() => database.prepare(`
      INSERT INTO memory_packs(id, project_id, stable_key, name, scope, active_generation_id, created_at)
      VALUES ('invalid-pack', 'project', 'invalid', 'Invalid', 'project', 'missing-generation', '2026-08-30T00:00:00.000Z')
    `).run()).toThrow(/active generation must belong/);
    database.prepare(`
      INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at)
      VALUES ('pack-1', 'project', 'pack', 'Pack', 'project', '2026-08-30T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO memory_generations(id, pack_id, generation, content_hash, state, created_by, created_at)
      VALUES ('generation-1', 'pack-1', 1, 'hash-1', 'active', 'user', '2026-08-30T00:00:00.000Z')
    `).run();
    database.prepare('UPDATE memory_packs SET active_generation_id = ? WHERE id = ?').run('generation-1', 'pack-1');
    expect(() => database.prepare('DELETE FROM memory_generations WHERE id = ?').run('generation-1')).toThrow(/active memory generation/);
    database.close();
  });

  it('re-reads the migration ledger inside each immediate transaction', () => {
    const database = new Database(':memory:');
    const migration: MigrationRecord = {
      version: 1,
      name: '001_transaction_test.sql',
      checksum: 'transaction-test',
      sql: 'CREATE TABLE migration_marker (id INTEGER PRIMARY KEY); INSERT INTO migration_marker(id) VALUES (1);',
    };
    migrateDatabase(database, systemClock, [migration]);
    migrateDatabase(database, systemClock, [migration]);
    expect(database.prepare('SELECT count(*) count FROM migration_marker').get()).toEqual({ count: 1 });
    database.close();
  });

  it('keeps event and audit history append-only while allowing outbox delivery', async () => {
    const database = openDatabase(':memory:', systemClock);
    database.exec(`
      INSERT INTO teams(id, name, created_at) VALUES ('team', 'Team', '2026-08-30T00:00:00.000Z');
      INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at)
        VALUES ('user', 'user@example.test', 'User', 'hash', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
        VALUES ('project', 'team', 'Project', 'user', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    `);
    const events = new EventStore(database, systemClock, {
      id: () => 'event-1',
      token: () => 'token',
    });
    const delivered: string[] = [];
    events.subscribe((event) => delivered.push(event.eventId));
    events.transaction(() => events.append({
      projectId: 'project',
      eventKind: 'progress.changed',
      aggregateType: 'run',
      aggregateId: 'run-1',
      actor: { type: 'system' },
      source: { kind: 'platform', adapter: 'database-test' },
      payload: { progress: 1 },
    }));
    events.flushOutbox();
    expect(delivered).toEqual(['event-1']);
    expect(database.prepare('SELECT outbox_delivered_at IS NOT NULL AS delivered FROM event_log WHERE event_id = ?').get('event-1')).toEqual({ delivered: 1 });

    const eventImmutableColumns = [
      'event_id', 'project_id', 'project_sequence', 'event_kind', 'schema_version', 'aggregate_type', 'aggregate_id',
      'parent_aggregate_id', 'actor_type', 'actor_id', 'source_kind', 'source_adapter', 'source_native_event_id',
      'raw_reference', 'idempotency_key', 'payload_json', 'occurred_at',
    ];
    for (const column of eventImmutableColumns) {
      expect(() => database.prepare(`UPDATE event_log SET ${column} = ${column} WHERE event_id = 'event-1'`).run()).toThrow(/append-only/);
    }
    expect(() => database.prepare('DELETE FROM event_log WHERE event_id = ?').run('event-1')).toThrow(/append-only/);

    database.prepare(`
      INSERT INTO audit_records(id, project_id, actor_type, action, target_type, outcome, occurred_at)
      VALUES ('audit-1', 'project', 'system', 'test', 'project', 'allowed', '2026-08-30T00:00:00.000Z')
    `).run();
    const auditImmutableColumns = ['id', 'project_id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'outcome', 'detail_json', 'occurred_at'];
    for (const column of auditImmutableColumns) {
      expect(() => database.prepare(`UPDATE audit_records SET ${column} = ${column} WHERE id = 'audit-1'`).run()).toThrow(/append-only/);
    }
    expect(() => database.prepare('DELETE FROM audit_records WHERE id = ?').run('audit-1')).toThrow(/append-only/);
    expect(() => database.prepare('DELETE FROM projects WHERE id = ?').run('project')).toThrow(/immutable history/);

    database.prepare(`
      INSERT INTO coordination_sessions(id, project_id, agent_label, capability_hash, created_at, last_seen_at, expires_at)
      VALUES ('coord-session', 'project', 'Agent', 'capabilities', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
      VALUES ('other-project', 'team', 'Other project', 'user', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run();
    const insertExecution = database.prepare(`
      INSERT INTO coordination_agent_executions(
        id, project_id, session_id, run_hash, agent_hash, parent_hash, parent_execution_id,
        harness, name, role, task, state, state_reason, provenance, started_at, updated_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'fixture', 'Agent', 'worker', 'test', 'running', NULL, '{}', ?, ?, NULL)
    `);
    insertExecution.run('execution-1', 'project', 'coord-session', 'run-1', 'agent-1', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    expect(() => insertExecution.run('execution-missing-project', 'missing-project', null, 'run-2', 'agent-2', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')).toThrow(/coordination execution/);
    expect(() => insertExecution.run('execution-missing-session', 'project', 'missing-session', 'run-3', 'agent-3', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')).toThrow(/coordination execution/);
    insertExecution.run('execution-other-project', 'other-project', null, 'run-4', 'agent-4', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    expect(() => database.prepare("DELETE FROM projects WHERE id = 'other-project'").run()).toThrow(/coordination executions/);
    const insertAgentEvent = database.prepare(`
      INSERT INTO coordination_agent_events(project_id, event_id, execution_id, payload_hash, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertAgentEvent.run('project', 'agent-event-1', 'execution-1', 'payload', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    expect(() => insertAgentEvent.run('other-project', 'agent-event-2', 'execution-1', 'payload', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')).toThrow(/coordination event/);
    expect(() => database.prepare("UPDATE coordination_agent_events SET project_id = 'other-project' WHERE event_id = 'agent-event-1'").run()).toThrow(/coordination event/);
    expect(() => database.prepare("UPDATE coordination_agent_executions SET project_id = 'other-project', session_id = NULL WHERE id = 'execution-1'").run()).toThrow(/coordination execution/);
    expect(() => database.prepare("UPDATE coordination_sessions SET project_id = 'other-project' WHERE id = 'coord-session'").run()).toThrow(/session project/);
    expect(() => database.prepare("DELETE FROM coordination_sessions WHERE id = 'coord-session'").run()).toThrow(/coordination session/);
    // EventStore schedules an outbox drain after each transaction; let that
    // microtask observe the still-open connection before closing this fixture.
    await Promise.resolve();
    database.close();
  });
});
