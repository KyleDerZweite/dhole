import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@dhole-control/shared';
import { secureIds } from './clock.js';
import { openDatabase, type DatabaseConnection } from './database.js';
import { EventStore, type AppendEventInput } from './events.js';

const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const databases: DatabaseConnection[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(customClock: { now: () => Date } = clock): { database: DatabaseConnection; events: EventStore } {
  const database = openDatabase(':memory:', customClock);
  databases.push(database);
  database.exec(`
    INSERT INTO teams(id, name, created_at) VALUES ('team', 'Team', '2026-01-01T00:00:00.000Z');
    INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at)
      VALUES ('user', 'user@example.test', 'User', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO team_members(team_id, user_id, role, created_at)
      VALUES ('team', 'user', 'administrator', '2026-01-01T00:00:00.000Z');
    INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
      VALUES ('project-a', 'team', 'Project A', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at)
      VALUES ('project-b', 'team', 'Project B', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  return { database, events: new EventStore(database, customClock, secureIds) };
}

function input(overrides: Partial<AppendEventInput> = {}): AppendEventInput {
  return {
    projectId: 'project-a',
    eventKind: 'progress.changed',
    aggregateType: 'run',
    aggregateId: 'run-1',
    actor: { type: 'system' },
    source: { kind: 'platform', adapter: 'events-test' },
    payload: { progress: 1 },
    ...overrides,
  };
}

describe('EventStore', () => {
  it('allocates a strictly increasing sequence per project', () => {
    const { database, events } = fixture();
    const first = events.transaction(() => events.append(input()));
    const second = events.transaction(() => events.append(input({ aggregateId: 'run-2', payload: { progress: 2 } })));
    const otherProject = events.transaction(() => events.append(input({ projectId: 'project-b', aggregateId: 'run-b' })));

    expect([first.projectSequence, second.projectSequence, otherProject.projectSequence]).toEqual([1, 2, 1]);
    expect(database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get('project-a')).toEqual({ event_sequence: 2 });
    expect(database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get('project-b')).toEqual({ event_sequence: 1 });
    expect(events.listAfter('project-a', 0).map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);
  });

  it('reuses an idempotent event for the same payload and rejects a mismatch', () => {
    const { database, events } = fixture();
    const idempotencyKey = 'idem-events-1';
    const first = events.transaction(() => events.append(input({ idempotencyKey })));
    const retry = events.transaction(() => events.append(input({ idempotencyKey })));

    expect(retry).toEqual(first);
    expect(() => events.transaction(() => events.append(input({ idempotencyKey, payload: { progress: 2 } })))).toThrow(/idempotency/i);
    expect(database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get('project-a')).toEqual({ count: 1 });
    expect(database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get('project-a')).toEqual({ event_sequence: 1 });
  });

  it('deduplicates native event IDs when the source adapter is omitted', () => {
    const { database, events } = fixture();
    const source = { kind: 'provider' as const, nativeEventId: 'provider-event-1' };
    const first = events.transaction(() => events.append(input({ source })));
    const retry = events.transaction(() => events.append(input({ source })));

    expect(retry).toEqual(first);
    expect(() => events.transaction(() => events.append(input({ source, payload: { progress: 2 } })))).toThrow(/idempotency/i);
    expect(database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get('project-a')).toEqual({ count: 1 });
    expect(database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get('project-a')).toEqual({ event_sequence: 1 });
  });

  it('rolls back current-state and event mutations together', () => {
    const { database, events } = fixture();

    expect(() => events.transaction(() => {
      database.prepare('UPDATE projects SET name = ? WHERE id = ?').run('mutated', 'project-a');
      events.append(input());
      throw new Error('force rollback');
    })).toThrow('force rollback');

    expect(database.prepare('SELECT name, event_sequence FROM projects WHERE id = ?').get('project-a')).toEqual({ name: 'Project A', event_sequence: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get('project-a')).toEqual({ count: 0 });
  });

  it('notifies listeners after commit and only for committed events', async () => {
    const { database, events } = fixture();
    const seen: EventEnvelope[] = [];
    events.subscribe((event) => {
      seen.push(event);
      expect(database.prepare('SELECT count(*) AS count FROM event_log WHERE event_id = ?').get(event.eventId)).toEqual({ count: 1 });
    });

    const committed = events.transaction(() => events.append(input()));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([committed]);

    expect(() => events.transaction(() => {
      events.append(input({ aggregateId: 'rolled-back' }));
      throw new Error('rollback before outbox');
    })).toThrow('rollback before outbox');
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get('project-a')).toEqual({ count: 1 });
  });

  it('leaves an outbox row pending when delivery fails, then marks it after retry', async () => {
    const { database, events } = fixture();
    const delivered = events.transaction(() => events.append(input()));
    // Let EventStore's post-commit microtask drain before installing a failing listener.
    await Promise.resolve();
    database.prepare('UPDATE event_log SET outbox_delivered_at = NULL WHERE event_id = ?').run(delivered.eventId);

    let attempts = 0;
    let fail = true;
    const unsubscribe = events.subscribe(() => {
      attempts += 1;
      if (fail) throw new Error('temporary listener failure');
    });
    expect(() => events.flushOutbox()).toThrow('temporary listener failure');
    expect(attempts).toBe(1);
    expect(database.prepare('SELECT outbox_delivered_at FROM event_log WHERE event_id = ?').get(delivered.eventId)).toEqual({ outbox_delivered_at: null });

    fail = false;
    events.flushOutbox();
    expect(attempts).toBe(2);
    expect((database.prepare('SELECT outbox_delivered_at FROM event_log WHERE event_id = ?').get(delivered.eventId) as { outbox_delivered_at: string | null }).outbox_delivered_at).toBe(clock.now().toISOString());
    events.flushOutbox();
    expect(attempts).toBe(2);
    unsubscribe();
  });

  it('keeps a failed automatic delivery pending without an unhandled rejection', async () => {
    const { database, events } = fixture();
    let fail = true;
    events.subscribe(() => {
      if (fail) throw new Error('temporary automatic listener failure');
    });
    const event = events.transaction(() => events.append(input()));
    await Promise.resolve();
    expect(database.prepare('SELECT outbox_delivered_at FROM event_log WHERE event_id = ?').get(event.eventId)).toEqual({ outbox_delivered_at: null });
    fail = false;
    events.flushOutbox();
    expect((database.prepare('SELECT outbox_delivered_at FROM event_log WHERE event_id = ?').get(event.eventId) as { outbox_delivered_at: string | null }).outbox_delivered_at).toBe(clock.now().toISOString());
  });

  it('delivers by project sequence even when the clock moves backwards', async () => {
    let now = new Date('2026-01-02T00:00:00.000Z');
    const { events } = fixture({ now: () => now });
    const delivered: EventEnvelope[] = [];
    events.subscribe((event) => delivered.push(event));

    const first = events.transaction(() => events.append(input({ aggregateId: 'run-later' })));
    now = new Date('2026-01-01T00:00:00.000Z');
    const second = events.transaction(() => events.append(input({ aggregateId: 'run-earlier' })));

    expect(first.occurredAt).toBe('2026-01-02T00:00:00.000Z');
    expect(second.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(delivered).toEqual([]);
    await Promise.resolve();
    expect(delivered.map((event) => event.projectSequence)).toEqual([1, 2]);
    expect(delivered.map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);
  });

  it('does not fail when the database closes before the outbox microtask runs', async () => {
    const { database, events } = fixture();
    events.transaction(() => events.append(input()));
    database.close();
    databases.splice(databases.indexOf(database), 1);
    await Promise.resolve();
  });
});
