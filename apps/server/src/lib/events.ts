import type { EventActorSchema, EventEnvelope, EventKind, EventSourceSchema } from '@dhole-control/shared';
import type { z } from 'zod';
import type { Clock, IdSource } from './clock.js';
import type { DatabaseConnection } from './database.js';

type EventActor = z.infer<typeof EventActorSchema>;
type EventSource = z.infer<typeof EventSourceSchema>;

export interface AppendEventInput {
  projectId: string;
  eventKind: EventKind;
  aggregateType: string;
  aggregateId: string;
  parentAggregateId?: string | undefined;
  actor: EventActor;
  source: EventSource;
  idempotencyKey?: string | undefined;
  payload: Record<string, unknown>;
}

export type EventListener = (event: EventEnvelope) => void;

export class EventStore {
  readonly #listeners = new Set<EventListener>();

  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock,
    private readonly ids: IdSource,
  ) {}

  transaction<T>(operation: () => T): T {
    const result = this.database.transaction(operation)();
    queueMicrotask(() => {
      if (!this.database.open) return;
      try {
        this.flushOutbox();
      } catch {
        // The durable row stays pending; maintenance retries it. Listener
        // failures must not become unhandled microtask exceptions.
      }
    });
    return result;
  }

  append(input: AppendEventInput): EventEnvelope {
    if (!this.database.inTransaction) throw new Error('Events must be appended inside EventStore.transaction');
    const prior = input.idempotencyKey
      ? this.database.prepare('SELECT * FROM event_log WHERE project_id = ? AND idempotency_key = ?').get(input.projectId, input.idempotencyKey) as EventRow | undefined
      : input.source.nativeEventId
        ? this.database.prepare("SELECT * FROM event_log WHERE project_id = ? AND COALESCE(source_adapter, '') = ? AND source_native_event_id = ?")
          .get(input.projectId, input.source.adapter ?? '', input.source.nativeEventId) as EventRow | undefined
        : undefined;
    if (prior) {
      const event = rowToEvent(prior);
      if (!matchesInput(event, input)) throw new Error('Event idempotency key was reused with different content');
      return event;
    }
    const sequenceRow = this.database
      .prepare('UPDATE projects SET event_sequence = event_sequence + 1 WHERE id = ? RETURNING event_sequence')
      .get(input.projectId) as { event_sequence: number } | undefined;
    if (!sequenceRow) throw new Error(`Unknown project ${input.projectId}`);
    const event: EventEnvelope = {
      protocol: 'dhole.event',
      schemaVersion: 1,
      eventId: this.ids.id(),
      eventKind: input.eventKind,
      projectId: input.projectId,
      projectSequence: sequenceRow.event_sequence,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      actor: input.actor,
      source: input.source,
      occurredAt: this.clock.now().toISOString(),
      payload: input.payload,
      ...(input.parentAggregateId ? { parentAggregateId: input.parentAggregateId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    this.database.prepare(`
      INSERT INTO event_log(
        event_id, project_id, project_sequence, event_kind, schema_version,
        aggregate_type, aggregate_id, parent_aggregate_id, actor_type, actor_id,
        source_kind, source_adapter, source_native_event_id, raw_reference,
        idempotency_key, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.projectId,
      event.projectSequence,
      event.eventKind,
      event.schemaVersion,
      event.aggregateType,
      event.aggregateId,
      event.parentAggregateId ?? null,
      event.actor.type,
      event.actor.type === 'user' ? event.actor.userId : event.actor.type === 'node' ? event.actor.machineId : event.actor.type === 'runtime' ? event.actor.runtimeId : null,
      event.source.kind,
      event.source.adapter ?? null,
      event.source.nativeEventId ?? null,
      event.source.rawReference ?? null,
      event.idempotencyKey ?? null,
      JSON.stringify(event.payload),
      event.occurredAt,
    );
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  listAfter(projectId: string, sequence: number, limit = 1_000): EventEnvelope[] {
    const rows = this.database
      .prepare('SELECT * FROM event_log WHERE project_id = ? AND project_sequence > ? ORDER BY project_sequence LIMIT ?')
      .all(projectId, sequence, Math.min(limit, 10_000)) as EventRow[];
    return rows.map(rowToEvent);
  }

  flushOutbox(): void {
    const rows = this.database
      .prepare('SELECT * FROM event_log WHERE outbox_delivered_at IS NULL ORDER BY project_id, project_sequence LIMIT 1000')
      .all() as EventRow[];
    const deliveredAt = this.clock.now().toISOString();
    const mark = this.database.prepare('UPDATE event_log SET outbox_delivered_at = ? WHERE event_id = ? AND outbox_delivered_at IS NULL');
    for (const row of rows) {
      const event = rowToEvent(row);
      for (const listener of this.#listeners) listener(event);
      mark.run(deliveredAt, event.eventId);
    }
  }
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(item as Record<string, unknown>).sort()) {
      const child = (item as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = normalize(child);
    }
    return output;
  };
  return JSON.stringify(normalize(value));
}

function matchesInput(event: EventEnvelope, input: AppendEventInput): boolean {
  return event.eventKind === input.eventKind
    && event.aggregateType === input.aggregateType
    && event.aggregateId === input.aggregateId
    && event.parentAggregateId === input.parentAggregateId
    && canonicalJson(event.actor) === canonicalJson(input.actor)
    && canonicalJson(event.source) === canonicalJson(input.source)
    && canonicalJson(event.payload) === canonicalJson(input.payload);
}

interface EventRow {
  event_id: string;
  project_id: string;
  project_sequence: number;
  event_kind: EventKind;
  schema_version: 1;
  aggregate_type: string;
  aggregate_id: string;
  parent_aggregate_id: string | null;
  actor_type: 'user' | 'node' | 'runtime' | 'system';
  actor_id: string | null;
  source_kind: EventSource['kind'];
  source_adapter: string | null;
  source_native_event_id: string | null;
  raw_reference: string | null;
  idempotency_key: string | null;
  payload_json: string;
  occurred_at: string;
}

function rowToEvent(row: EventRow): EventEnvelope {
  const actor: EventActor = row.actor_type === 'user'
    ? { type: 'user', userId: row.actor_id ?? '' }
    : row.actor_type === 'node'
      ? { type: 'node', machineId: row.actor_id ?? '' }
      : row.actor_type === 'runtime'
        ? { type: 'runtime', runtimeId: row.actor_id ?? '' }
        : { type: 'system' };
  return {
    protocol: 'dhole.event',
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    eventKind: row.event_kind,
    projectId: row.project_id,
    projectSequence: row.project_sequence,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    actor,
    source: {
      kind: row.source_kind,
      ...(row.source_adapter ? { adapter: row.source_adapter } : {}),
      ...(row.source_native_event_id ? { nativeEventId: row.source_native_event_id } : {}),
      ...(row.raw_reference ? { rawReference: row.raw_reference } : {}),
    },
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    ...(row.parent_aggregate_id ? { parentAggregateId: row.parent_aggregate_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
  };
}
