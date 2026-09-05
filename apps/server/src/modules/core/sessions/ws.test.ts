import { describe, expect, it } from 'vitest';
import { EventStore } from '../../../lib/events.js';
import { openDatabase } from '../../../lib/database.js';
import type { Clock, IdSource } from '../../../lib/clock.js';
import type { AuthenticatedUser, ServerContext } from '../../../lib/module.js';
import type { EventEnvelope } from '@dhole-control/shared';
import { createSessionsWebSocketHandler, SessionSubscriptionHub } from './ws.js';
import type { SessionsService } from './service.js';

const user: AuthenticatedUser = { id: 'u1', email: 'u1@example.test', displayName: 'One', role: 'member', teamId: 'team-1' };

function context(eventStore?: ServerContext['events']): ServerContext {
  const database = openDatabase(':memory:', clock);
  database.exec(`INSERT INTO teams(id,name,created_at) VALUES ('team-1','Team','2026-08-31T00:00:00.000Z');
    INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES ('u1','u1@example.test','One','x','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');
    INSERT INTO team_members(team_id,user_id,role,created_at) VALUES ('team-1','u1','member','2026-08-31T00:00:00.000Z');
    INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('p1','team-1','Project','u1','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');`);
  return { config: {} as ServerContext['config'], database, clock, ids, events: eventStore ?? new EventStore(database, clock, ids) };
}

const clock: Clock = { now: () => new Date('2026-08-31T00:00:00.000Z') };
const ids: IdSource = { id: (() => { let sequence = 0; return () => `event-${++sequence}`; })(), token: () => 'token-value-long-enough' };

function fakeService(): SessionsService {
  return {
    canRead: () => true,
    getSummary: () => ({ id: 's1', projectId: 'p1', title: 'Session', state: 'idle', createdBy: 'u1', createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }),
    publicEvent: (event: EventEnvelope) => event,
  } as unknown as SessionsService;
}

function event(sequence: number): EventEnvelope {
  return {
    protocol: 'dhole.event',
    schemaVersion: 1,
    eventId: `race-${sequence}`,
    eventKind: 'session.created',
    projectId: 'p1',
    projectSequence: sequence,
    aggregateType: 'session',
    aggregateId: 's1',
    actor: { type: 'system' },
    source: { kind: 'platform', adapter: 'test' },
    occurredAt: '2026-08-31T00:00:00.000Z',
    payload: { sessionId: 's1', sequence },
  };
}

describe('SessionSubscriptionHub replay handoff', () => {
  it('rejects invalid subscription cursor and session shapes before replay', () => {
    for (const input of [{ type: 'subscribe', sessionId: 's1', afterSequence: -1 }, { type: 'subscribe', sessionId: '' }, { type: 'subscribe', sessionId: 's1', afterSequence: '1' }]) {
      const serverContext = context();
      const handler = createSessionsWebSocketHandler(serverContext, fakeService());
      const callbacks = new Map<string, (...args: unknown[]) => void>();
      const closed: number[] = [];
      const frames: string[] = [];
      const socket = { readyState: 1, send: (frame: string) => frames.push(frame), close: (code?: number) => closed.push(code ?? 0), on: (name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); } };
      handler.handle(socket, user);
      callbacks.get('message')?.(JSON.stringify(input));
      expect(closed).toEqual([1008]);
      expect(frames).toEqual([]);
      handler.hub.close();
      serverContext.database.close();
    }
  });

  it('does not miss an event delivered in the old query-before-register race window', () => {
    let listener: ((value: EventEnvelope) => void) | undefined;
    let injected = false;
    const raceEvent = event(1);
    const events = {
      subscribe(callback: (value: EventEnvelope) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
      listAfter() {
        if (!injected) {
          injected = true;
          listener?.(raceEvent);
        }
        return [];
      },
    } as unknown as ServerContext['events'];
    const serverContext = context(events);
    serverContext.database.prepare('UPDATE projects SET event_sequence = 1 WHERE id = \'p1\'').run();
    const frames: unknown[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(JSON.parse(value) as unknown) };
    const hub = new SessionSubscriptionHub(serverContext, fakeService());
    hub.subscribe(socket, user, 's1', 0);
    const replayed = frames.flatMap((frame) => {
      const value = frame as { type?: string; events?: EventEnvelope[] };
      return value.type === 'events' ? value.events ?? [] : [];
    });
    expect(replayed.map((item) => item.eventId)).toEqual(['race-1']);
    hub.close();
  });

  it('suppresses an outbox delivery that duplicates a replayed sequence', () => {
    const database = openDatabase(':memory:', clock);
    database.exec(`INSERT INTO teams(id,name,created_at) VALUES ('team-1','Team','2026-08-31T00:00:00.000Z');
      INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES ('u1','u1@example.test','One','x','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');
      INSERT INTO team_members(team_id,user_id,role,created_at) VALUES ('team-1','u1','member','2026-08-31T00:00:00.000Z');
      INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('p1','team-1','Project','u1','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');`);
    const eventStore = new EventStore(database, clock, ids);
    eventStore.transaction(() => eventStore.append({ projectId: 'p1', eventKind: 'session.created', aggregateType: 'session', aggregateId: 's1', actor: { type: 'system' }, source: { kind: 'platform', adapter: 'test' }, payload: { sessionId: 's1' } }));
    const serverContext = { config: {} as ServerContext['config'], database, clock, ids, events: eventStore };
    const frames: string[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(value) };
    const hub = new SessionSubscriptionHub(serverContext, fakeService());
    hub.subscribe(socket, user, 's1', 0);
    eventStore.flushOutbox();
    const replayed = frames.flatMap((frame) => {
      const value = JSON.parse(frame) as { type?: string; event?: EventEnvelope; events?: EventEnvelope[] };
      return value.type === 'events' ? value.events ?? [] : value.type === 'event' && value.event ? [value.event] : [];
    });
    expect(replayed).toHaveLength(1);
    hub.close();
  });

  it('routes durable events by their aggregate identity, not provider payload session ids', () => {
    const serverContext = context();
    serverContext.database.exec("INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES ('s1','p1','One','idle','u1','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z'),('s2','p1','Two','idle','u1','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');");
    const service = fakeService();
    const hub = new SessionSubscriptionHub(serverContext, service);
    const first: string[] = [];
    const second: string[] = [];
    const socket = (frames: string[]) => ({ readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(value) });
    hub.subscribe(socket(first), user, 's1');
    hub.subscribe(socket(second), user, 's2');
    const eventStore = serverContext.events as EventStore;
    eventStore.transaction(() => eventStore.append({ projectId: 'p1', eventKind: 'tool.call.completed', aggregateType: 'session', aggregateId: 's1', actor: { type: 'system' }, source: { kind: 'platform', adapter: 'test' }, payload: { sessionId: 's2', tool: 'read' } }));
    eventStore.flushOutbox();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    hub.close();
  });

  it('pages durable replay beyond one thousand rows and keeps each frame bounded', () => {
    const database = openDatabase(':memory:', clock);
    database.exec(`INSERT INTO teams(id,name,created_at) VALUES ('team-1','Team','2026-08-31T00:00:00.000Z');
      INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES ('u1','u1@example.test','One','x','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');
      INSERT INTO team_members(team_id,user_id,role,created_at) VALUES ('team-1','u1','member','2026-08-31T00:00:00.000Z');
      INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('p1','team-1','Project','u1','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z');`);
    const eventStore = new EventStore(database, clock, ids);
    eventStore.transaction(() => {
      for (let sequence = 1; sequence <= 1_205; sequence += 1) eventStore.append({ projectId: 'p1', eventKind: 'session.created', aggregateType: 'session', aggregateId: 's1', actor: { type: 'system' }, source: { kind: 'platform', adapter: 'test' }, payload: { sessionId: 's1', sequence } });
    });
    const serverContext = { config: {} as ServerContext['config'], database, clock, ids, events: eventStore };
    const frames: string[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(value) };
    const hub = new SessionSubscriptionHub(serverContext, fakeService());
    hub.subscribe(socket, user, 's1', 0);
    const replayed = frames.flatMap((frame) => {
      const value = JSON.parse(frame) as { type?: string; events?: EventEnvelope[] };
      return value.type === 'events' ? value.events ?? [] : [];
    });
    expect(replayed).toHaveLength(1_205);
    expect(replayed.map((item) => item.projectSequence)).toEqual([...Array(1_205)].map((_, index) => index + 1));
    expect(frames.every((frame) => Buffer.byteLength(frame, 'utf8') <= 256 * 1024)).toBe(true);
    hub.close();
  });

  it('publishes transient runtime deltas only to currently authorized subscribers', () => {
    const serverContext = context();
    const allowed = new Set(['u1', 'u2']);
    const service = {
      canRead: (candidate: AuthenticatedUser) => allowed.has(candidate.id),
      getSummary: () => ({ id: 's1', projectId: 'p1', title: 'Session', state: 'idle', createdBy: 'u1', createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }),
      publicEvent: (value: EventEnvelope) => value,
    } as unknown as SessionsService;
    const hub = new SessionSubscriptionHub(serverContext, service);
    const first: string[] = [];
    const second: string[] = [];
    const socket = (frames: string[]) => ({ readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(value) });
    const secondUser: AuthenticatedUser = { ...user, id: 'u2', email: 'u2@example.test' };
    hub.subscribe(socket(first), user, 's1');
    hub.subscribe(socket(second), secondUser, 's1');
    allowed.delete('u2');
    expect(hub.publishTransient('s1', { kind: 'message.delta', text: 'Bearer secret-token', nativeSessionId: 'native-1', apiKey: 'sk-secret-value', nested: [[{ nativeSessionId: 'nested-native', apiKey: 'nested-key', cookie: 'nested-cookie' }]] })).toBe(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const frame = JSON.parse(first[0]!) as { type: string; payload: Record<string, unknown> };
    expect(frame.type).toBe('transient');
    expect(frame.payload.nativeSessionId).toBe('[REDACTED]');
    expect(frame.payload.apiKey).toBe('[REDACTED]');
    expect(frame.payload.text).toBe('[REDACTED]');
    expect(JSON.stringify(frame)).not.toContain('nested-native');
    expect(JSON.stringify(frame)).not.toContain('nested-key');
    expect(JSON.stringify(frame)).not.toContain('nested-cookie');
    hub.close();
  });
});
