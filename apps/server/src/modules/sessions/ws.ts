import type { EventEnvelope } from '@dhole-control/shared';
import type { WebSocket } from 'ws';
import type { AuthenticatedUser, ServerContext } from '../../lib/module.js';
import { redactText } from '../../lib/security.js';
import { SessionsError, SessionsService } from './service.js';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 128;
const TRANSIENT_SENSITIVE_KEY = /(?:secret|token|password|authorization|credential|api[-_]?key|private[-_]?key)/iu;
const TRANSIENT_RUNTIME_ID_KEY = /^(?:runtimeSessionId|nativeSessionId|native_session_id|runtime_session_id)$/u;

export type SessionTransientPayload = Record<string, unknown>;

export interface SessionSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

interface Subscription {
  sessionId: string;
  user: AuthenticatedUser;
  socket: SessionSocket;
  closed: boolean;
  replaying: boolean;
  queuedEvents: Map<number, EventEnvelope>;
  lastSentSequence: number;
  unsubscribe: () => void;
}

export class SessionSubscriptionHub {
  readonly #subscriptions = new Set<Subscription>();
  readonly #service: SessionsService;
  readonly #stopEvents: () => void;
  readonly #database: ServerContext['database'];
  readonly #events: ServerContext['events'];

  constructor(context: ServerContext, service = new SessionsService(context)) {
    this.#service = service;
    this.#database = context.database;
    this.#events = context.events;
    const stop = context.events.subscribe((event) => this.publish(event));
    this.#stopEvents = () => { stop(); };
  }

  subscribe(socket: SessionSocket, user: AuthenticatedUser, sessionId: string, afterSequence = 0): () => void {
    if (!this.#service.canRead(user, sessionId)) throw new SessionsError(403, 'session_forbidden', 'Session subscription is not authorized');
    const summary = this.#service.getSummary(sessionId);
    if (!summary) throw new SessionsError(404, 'session_not_found', 'Session was not found');
    const startSequence = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const subscription: Subscription = { sessionId, user, socket, closed: false, replaying: true, queuedEvents: new Map(), lastSentSequence: startSequence, unsubscribe: () => undefined };
    subscription.unsubscribe = () => {
      if (subscription.closed) return;
      subscription.closed = true;
      this.#subscriptions.delete(subscription);
    };
    this.#subscriptions.add(subscription);
    try {
      // Register before reading durable history. Any event delivered while the
      // bounded replay is in progress is held and merged by project sequence.
      const watermark = this.currentProjectSequence(summary.projectId);
      const replay = this.replayEvents(summary.projectId, sessionId, startSequence, watermark);
      this.flushReplay(subscription, sessionId, replay, startSequence);
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    }
    return subscription.unsubscribe;
  }

  unsubscribeAll(socket: SessionSocket): void {
    for (const subscription of [...this.#subscriptions]) if (subscription.socket === socket) subscription.unsubscribe();
  }

  /** Publishes a non-durable runtime delta to currently authorized subscribers. */
  publishTransient(sessionId: string, payload: SessionTransientPayload): number {
    let delivered = 0;
    const safePayload = sanitizeTransientPayload(payload);
    for (const subscription of this.#subscriptions) {
      if (subscription.closed || subscription.sessionId !== sessionId) continue;
      if (!this.#service.canRead(subscription.user, sessionId)) {
        subscription.unsubscribe();
        continue;
      }
      if (this.send(subscription, { type: 'transient', sessionId, payload: safePayload })) delivered += 1;
    }
    return delivered;
  }

  close(): void {
    this.#stopEvents();
    for (const subscription of [...this.#subscriptions]) subscription.unsubscribe();
  }

  private publish(event: EventEnvelope): void {
    for (const subscription of this.#subscriptions) {
      if (subscription.closed || !this.isSessionEvent(event, subscription.sessionId)) continue;
      if (!this.#service.canRead(subscription.user, subscription.sessionId)) {
        subscription.unsubscribe();
        continue;
      }
      const publicEvent = this.#service.publicEvent(event);
      if (subscription.replaying) {
        if (publicEvent.projectSequence > subscription.lastSentSequence) subscription.queuedEvents.set(publicEvent.projectSequence, publicEvent);
      } else if (publicEvent.projectSequence > subscription.lastSentSequence) {
        this.send(subscription, { type: 'event', event: publicEvent });
        if (!subscription.closed) subscription.lastSentSequence = publicEvent.projectSequence;
      }
    }
  }

  private currentProjectSequence(projectId: string): number {
    return (this.#database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get(projectId) as { event_sequence: number } | undefined)?.event_sequence ?? 0;
  }

  private replayEvents(projectId: string, sessionId: string, afterSequence: number, watermark: number): EventEnvelope[] {
    const replay: EventEnvelope[] = [];
    let cursor = afterSequence;
    while (cursor < watermark) {
      const page = this.#events.listAfter(projectId, cursor, 1_000);
      if (!page.length) break;
      for (const event of page) {
        if (event.projectSequence > watermark) break;
        if (this.isSessionEvent(event, sessionId)) replay.push(this.#service.publicEvent(event));
      }
      const nextCursor = page.at(-1)?.projectSequence ?? cursor;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return replay;
  }

  private flushReplay(subscription: Subscription, sessionId: string, replay: EventEnvelope[], afterSequence: number): void {
    const merged = new Map<number, EventEnvelope>();
    for (const event of replay) if (event.projectSequence > afterSequence) merged.set(event.projectSequence, event);
    for (const event of subscription.queuedEvents.values()) {
      if (event.projectSequence > afterSequence) merged.set(event.projectSequence, event);
    }
    subscription.queuedEvents.clear();
    this.sendEvents(subscription, sessionId, [...merged.values()].sort((left, right) => left.projectSequence - right.projectSequence));
    // A synchronous socket implementation can trigger another event while a
    // replay frame is being sent. Drain those events before handing off live.
    while (subscription.queuedEvents.size && !subscription.closed) {
      const queued = [...subscription.queuedEvents.values()].sort((left, right) => left.projectSequence - right.projectSequence);
      subscription.queuedEvents.clear();
      this.sendEvents(subscription, sessionId, queued);
    }
    subscription.replaying = false;
  }

  private sendEvents(subscription: Subscription, sessionId: string, events: EventEnvelope[]): void {
    let batch: EventEnvelope[] = [];
    for (const event of events) {
      if (event.projectSequence <= subscription.lastSentSequence) continue;
      const candidate = [...batch, event];
      if (batch.length && this.frameBytes({ type: 'events', sessionId, events: candidate }) > MAX_FRAME_BYTES) {
        this.send(subscription, { type: 'events', sessionId, events: batch });
        if (!subscription.closed) subscription.lastSentSequence = batch.at(-1)!.projectSequence;
        batch = [event];
      } else {
        batch = candidate;
      }
    }
    if (batch.length) {
      this.send(subscription, { type: 'events', sessionId, events: batch });
      if (!subscription.closed) subscription.lastSentSequence = batch.at(-1)!.projectSequence;
    }
  }

  private frameBytes(payload: unknown): number {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }

  private isSessionEvent(event: EventEnvelope, sessionId: string): boolean {
    return this.sessionIdForEvent(event) === sessionId;
  }

  private sessionIdForEvent(event: EventEnvelope): string | undefined {
    if (event.aggregateType === 'session') return event.aggregateId;
    if (event.parentAggregateId && this.#database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(event.parentAggregateId)) return event.parentAggregateId;
    switch (event.aggregateType) {
      case 'run':
        return (this.#database.prepare('SELECT session_id FROM runs WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      case 'turn':
        return (this.#database.prepare('SELECT session_id FROM session_turns WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      case 'activation':
        return (this.#database.prepare('SELECT r.session_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id JOIN runs r ON r.id = l.run_id WHERE a.id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      case 'agent':
        return (this.#database.prepare('SELECT r.session_id FROM logical_agents l JOIN runs r ON r.id = l.run_id WHERE l.id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      case 'approval':
        return (this.#database.prepare('SELECT session_id FROM approvals WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      case 'message':
        return (this.#database.prepare('SELECT session_id FROM messages WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
      default:
        return undefined;
    }
  }

  private send(subscription: Subscription, payload: unknown): boolean {
    if (subscription.closed || subscription.socket.readyState !== 1) {
      subscription.unsubscribe();
      return false;
    }
    const frame = JSON.stringify(payload);
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      subscription.unsubscribe();
      subscription.socket.close?.(1009, 'frame too large');
      return false;
    }
    const buffered = subscription.socket.bufferedAmount ?? 0;
    if (buffered > MAX_BUFFERED_BYTES) {
      subscription.unsubscribe();
      subscription.socket.close?.(1013, 'slow client');
      return false;
    }
    try {
      subscription.socket.send(frame);
      // `ws.send()` may enqueue bytes synchronously. Re-check after sending so
      // a client that crossed the high-water mark is disconnected promptly;
      // checking only before send lets one large burst bypass backpressure.
      const afterSendBuffered = subscription.socket.bufferedAmount ?? 0;
      if (afterSendBuffered > MAX_BUFFERED_BYTES) {
        subscription.unsubscribe();
        subscription.socket.close?.(1013, 'slow client');
      }
      return true;
    } catch {
      subscription.unsubscribe();
      subscription.socket.close?.(1011, 'send failed');
      return false;
    }
  }
}

function sanitizeTransientPayload(payload: SessionTransientPayload, depth = 0): SessionTransientPayload {
  if (depth > 4) return { value: '[REDACTED]' };
  const output: SessionTransientPayload = {};
  for (const [key, value] of Object.entries(payload).slice(0, 128)) {
    if (TRANSIENT_SENSITIVE_KEY.test(key) || TRANSIENT_RUNTIME_ID_KEY.test(key)) {
      output[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 128).map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? sanitizeTransientPayload(entry as SessionTransientPayload, depth + 1)
        : typeof entry === 'string' ? redactText(entry.slice(0, 200_000), 200_000) : entry);
    } else if (value && typeof value === 'object') {
      output[key] = sanitizeTransientPayload(value as SessionTransientPayload, depth + 1);
    } else if (typeof value === 'string') {
      output[key] = redactText(value.slice(0, 200_000), 200_000);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export interface SessionsWebSocketHandler {
  hub: SessionSubscriptionHub;
  handle(socket: SessionSocket, user: AuthenticatedUser): void;
}

/** Creates the app-level authenticated subscription handler used by the server's upgrade path. */
export function createSessionsWebSocketHandler(context: ServerContext, service?: SessionsService): SessionsWebSocketHandler {
  const hub = new SessionSubscriptionHub(context, service ?? new SessionsService(context));
  return {
    hub,
    handle(socket, user) {
      const subscriptions = new Map<string, () => void>();
      socket.on?.('message', (raw: unknown) => {
        const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw && typeof raw === 'object' && 'toString' in raw ? String(raw) : '';
        if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
          socket.close?.(1009, 'frame too large');
          return;
        }
        let message: unknown;
        try { message = JSON.parse(text); } catch { socket.close?.(1003, 'invalid json'); return; }
        if (!message || typeof message !== 'object') return;
        const input = message as { type?: unknown; sessionId?: unknown; afterSequence?: unknown };
        if (input.type === 'unsubscribe' && typeof input.sessionId === 'string') {
          subscriptions.get(input.sessionId)?.();
          subscriptions.delete(input.sessionId);
          return;
        }
        if (input.type !== 'subscribe' || typeof input.sessionId !== 'string') return;
        const after = typeof input.afterSequence === 'number' && Number.isInteger(input.afterSequence) && input.afterSequence >= 0 ? input.afterSequence : 0;
        subscriptions.get(input.sessionId)?.();
        try {
          subscriptions.set(input.sessionId, hub.subscribe(socket, user, input.sessionId, after));
          socket.send(JSON.stringify({ type: 'subscribed', sessionId: input.sessionId }));
        } catch (error) {
          const code = error instanceof SessionsError ? error.code : 'subscription_failed';
          socket.send(JSON.stringify({ type: 'error', code }));
        }
      });
      socket.on?.('close', () => { for (const unsubscribe of subscriptions.values()) unsubscribe(); hub.unsubscribeAll(socket); });
    },
  };
}

export type AppWebSocket = WebSocket | SessionSocket;
