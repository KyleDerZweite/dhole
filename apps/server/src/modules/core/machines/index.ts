import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { NodeClientMessageSchema, NodeCommandSchema, NodeHelloSchema, NodeRuntimeEventSchema, type NodeClientMessage, type NodeCommand, type NodeRuntimeEvent } from '@dhole-control/shared';
import type { Context } from 'hono';
import type { WebSocket } from 'ws';
import type { Clock, IdSource } from '../../../lib/clock.js';
import { secureIds, systemClock } from '../../../lib/clock.js';
import type { DatabaseConnection } from '../../../lib/database.js';
import type { EventStore } from '../../../lib/events.js';
import { parseJson } from '../../../lib/http.js';
import type { AuthenticatedUser, DholeApp, ServerContext } from '../../../lib/module.js';
import { hashToken, redactText, tokenMatches } from '../../../lib/security.js';
import { subscribeSessionAuthorizationChanges } from '../../../lib/session-auth.js';
import { canAccessProject } from '../projects.js';

const PROTOCOL = 'dhole.node.v1' as const;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_ENROLLMENT_TTL_MS = 15 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const MAX_STATUS_RESULT_BYTES = 64 * 1024;
const MAX_TERMINAL_STATUS_RESULT_BYTES = 900 * 1024;
const MAX_STATUS_DEPTH = 4;
const MAX_STATUS_ENTRIES = 64;
const MAX_STATUS_ARRAY_ITEMS = 128;
const DURABLE_RUNTIME_EVENT_KINDS = new Set(['approval.requested', 'tool.call.started', 'tool.call.completed']);
const SENSITIVE_STATUS_KEY = /secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie/i;
const SENSITIVE_STATUS_ASSIGNMENT = /((?:secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;"']+)/gi;
const OPAQUE_STATUS_KEY = /^(?:raw|stdout|stderr|body|content)(?:[A-Z_-].*)?$/iu;

export type MachineStatus = 'enrolled' | 'connected' | 'disconnected' | 'stale' | 'revoked';
export type CommandState = 'queued' | 'delivered' | 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled' | 'expired';

export interface EnrollmentToken {
  id: string;
  token: string;
  teamId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

export interface EnrollmentResult {
  machineId: string;
  teamId: string;
  machineName: string;
  credential: string;
  credentialId: string;
  consumedAt: string;
}

export interface IssueEnrollmentTokenInput {
  teamId: string;
  label: string;
  createdBy: string;
  ttlMs?: number;
}

export interface EnqueueCommandInput {
  machineId: string;
  command: NodeCommand;
  projectId?: string;
}

export interface NodeConnection {
  machineId: string;
  socket: WebSocket;
  connectedAt: string;
}

export type RuntimeEventHandler = (input: { projectId: string; machineId: string; commandId: string; operationKey: string; event: NodeRuntimeEvent }) => void;

export class MachineError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'MachineError';
  }
}

function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

function assertTokenTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 7 * 24 * 60 * 60_000) {
    throw new MachineError('invalid_ttl', 'Enrollment token TTL must be positive and no more than seven days', 422);
  }
  return Math.floor(ttlMs);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}

function safeJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function redactStatusValue(value: unknown, depth = 0, fieldKey?: string): unknown {
  if (depth > MAX_STATUS_DEPTH) return '[TRUNCATED]';
  if (fieldKey && OPAQUE_STATUS_KEY.test(fieldKey)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactStatusString(value, 4_096);
  if (Array.isArray(value)) return value.slice(0, MAX_STATUS_ARRAY_ITEMS).map((item) => redactStatusValue(item, depth + 1));
  if (typeof value !== 'object') return '[TRUNCATED]';
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_STATUS_ENTRIES)) {
    const boundedKey = key.slice(0, 160);
    output[boundedKey] = SENSITIVE_STATUS_KEY.test(key) ? '[REDACTED]' : redactStatusValue(item, depth + 1, key);
  }
  return output;
}

function redactStatusString(value: string, maxLength: number): string {
  return redactText(value, maxLength).replace(SENSITIVE_STATUS_ASSIGNMENT, '$1[REDACTED]');
}

function redactStatusResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const sanitized = redactStatusValue(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return {};
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_STATUS_RESULT_BYTES) {
    const text = (sanitized as Record<string, unknown>).text;
    return typeof text === 'string' ? { text, truncated: true } : { truncated: true };
  }
  return sanitized as Record<string, unknown>;
}

function runtimeEventKind(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['eventKind', 'type']) if (typeof record[key] === 'string') return record[key];
  return undefined;
}

function isDurableRuntimeEvent(value: unknown): boolean {
  return DURABLE_RUNTIME_EVENT_KINDS.has(runtimeEventKind(value) ?? '');
}

function redactTerminalStatusResult(value: Record<string, unknown> | undefined): { result?: Record<string, unknown>; durableOverflow: boolean } {
  if (value === undefined) return { durableOverflow: false };
  const rawEventValue = value.events;
  const sanitized = redactStatusValue(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'events')));
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return { result: {}, durableOverflow: false };
  const result = sanitized as Record<string, unknown>;
  const rawEvents = Array.isArray(rawEventValue)
    ? rawEventValue.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>
    : [];
  const eventEntries = rawEvents.map((raw) => {
    const bounded = redactStatusValue(raw) as Record<string, unknown>;
    const kind = runtimeEventKind(bounded);
    if (kind && typeof bounded.eventKind !== 'string') bounded.eventKind = kind;
    return { raw, bounded };
  });
  if (Array.isArray(rawEventValue)) result.events = eventEntries.map((entry) => entry.bounded);

  let encoded = JSON.stringify(result);
  let droppedTransientEvents = 0;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_STATUS_RESULT_BYTES && Array.isArray(result.events)) {
    const events = result.events as Record<string, unknown>[];
    for (let index = eventEntries.length - 1; index >= 0 && Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_STATUS_RESULT_BYTES; index -= 1) {
      if (isDurableRuntimeEvent(eventEntries[index]?.raw)) continue;
      events.splice(index, 1);
      eventEntries.splice(index, 1);
      droppedTransientEvents += 1;
      encoded = JSON.stringify(result);
    }
  }
  if (droppedTransientEvents > 0) {
    result.runtimeEventsTruncated = true;
    result.droppedTransientEvents = droppedTransientEvents;
    encoded = JSON.stringify(result);
  }
  const protectedKeys = new Set(['runtimeSessionId', 'turnId', 'text', 'events', 'runtimeEventsTruncated', 'droppedTransientEvents']);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_STATUS_RESULT_BYTES) {
    for (const key of Object.keys(result).reverse()) {
      if (protectedKeys.has(key)) continue;
      delete result[key];
      encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_TERMINAL_STATUS_RESULT_BYTES) break;
    }
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_STATUS_RESULT_BYTES && eventEntries.some((entry) => isDurableRuntimeEvent(entry.raw))) {
    return { durableOverflow: true };
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_STATUS_RESULT_BYTES) return { result: { truncated: true }, durableOverflow: false };
  return { result, durableOverflow: false };
}

function redactArtifactResult(value: Record<string, unknown> | undefined, payloadJson: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const command = (() => {
    try { return safeJson(JSON.parse(payloadJson) as unknown); } catch { return {}; }
  })();
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (typeof command.repositoryId === 'string') metadata.repositoryId = command.repositoryId.slice(0, 160);
  const relativePath = typeof value.relativePath === 'string' ? value.relativePath : typeof command.relativePath === 'string' ? command.relativePath : undefined;
  if (relativePath && relativePath.length <= 1_024 && !relativePath.includes('\0') && !relativePath.startsWith('/') && !relativePath.startsWith('\\') && !/^[A-Za-z]:[\\/]/u.test(relativePath) && !relativePath.split(/[\\/]/u).includes('..')) metadata.relativePath = relativePath;
  if (typeof value.encoding === 'string') metadata.encoding = redactStatusString(value.encoding, 32);
  if (typeof value.byteLength === 'number' && Number.isFinite(value.byteLength) && value.byteLength >= 0) metadata.byteLength = Math.min(1_048_576, Math.floor(value.byteLength));
  return metadata;
}

function closeSocketSafely(socket: WebSocket, code: number, reason: string): void {
  try {
    let bounded = redactStatusString(reason, 120);
    while (Buffer.byteLength(bounded, 'utf8') > 120) bounded = bounded.slice(0, -1);
    socket.close(code, bounded);
  } catch { /* a concurrently closed socket is harmless */ }
}

/**
 * Machine domain service. It owns enrollment, machine state, allowlists and the
 * durable command queue. The browser-facing API is deliberately thin; node
 * sockets use `createNodeConnectionHandler` below.
 */
export class MachineService {
  readonly #connections = new Map<string, NodeConnection>();
  #runtimeEventHandler: RuntimeEventHandler | undefined;
  #machineAuthorizationCheck: ((machineId: string) => boolean) | undefined;

  constructor(
    readonly database: DatabaseConnection,
    readonly clock: Clock = systemClock,
    readonly ids: IdSource = secureIds,
    readonly options: { heartbeatIntervalMs?: number; staleAfterMs?: number } = {},
    private readonly events?: EventStore,
  ) {}

  setRuntimeEventHandler(handler: RuntimeEventHandler): void { this.#runtimeEventHandler = handler; }

  setMachineAuthorizationCheck(check: (machineId: string) => boolean): void {
    this.#machineAuthorizationCheck = check;
    this.disconnectUnauthorizedMachines();
  }

  disconnectUnauthorizedMachines(): void {
    for (const [machineId, connection] of this.#connections) {
      if (this.getMachine(machineId)?.status === 'revoked' || !this.machineAuthorizationAllowed(machineId)) {
        this.disconnect(machineId, connection.socket);
        closeSocketSafely(connection.socket, 4003, 'machine authorization ended');
      }
    }
  }

  private machineAuthorizationAllowed(machineId: string): boolean {
    return this.#machineAuthorizationCheck?.(machineId) ?? true;
  }

  private requireMachineAuthorization(machineId: string): void {
    if (!this.machineAuthorizationAllowed(machineId)) throw new MachineError('machine_authorization_revoked', 'Machine authorization has ended', 403);
  }

  private transaction<T>(operation: () => T): T {
    // Machine may be called from a larger EventStore/database transaction.  Do
    // not create a nested better-sqlite3 transaction in that case; the caller
    // owns commit/rollback and EventStore will flush its outbox afterwards.
    if (this.database.inTransaction) return operation();
    return this.events ? this.events.transaction(operation) : this.database.transaction(operation)();
  }

  private appendCommandEvent(
    projectId: string | null | undefined,
    eventKind: 'command.queued' | 'command.acknowledged' | 'command.completed',
    commandId: string,
    machineId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.events || !projectId) return;
    this.events.append({
      projectId,
      eventKind,
      aggregateType: 'node_command',
      aggregateId: commandId,
      actor: eventKind === 'command.queued' ? { type: 'system' } : { type: 'node', machineId },
      source: { kind: 'platform', adapter: 'fleet' },
      payload,
    });
  }

  private appendMachineAudit(machineId: string, action: 'machine.connected' | 'machine.disconnected', occurredAt: string): void {
    this.appendAudit(action, 'machine', machineId, { type: 'node', id: machineId }, {}, occurredAt);
  }

  private appendAudit(
    action: string,
    targetType: string,
    targetId: string,
    actor: { type: 'user' | 'node' | 'system'; id?: string },
    detail: Record<string, unknown> = {},
    occurredAt = nowIso(this.clock),
  ): void {
    // Machine team/machine configuration has no required project aggregate. Keep
    // it in the project-less immutable audit stream and never include raw
    // enrollment/device credentials in detail payloads.
    this.database.prepare(`
      INSERT INTO audit_records(id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'allowed', ?, ?)
    `).run(this.ids.id(), actor.type, actor.id ?? null, action, targetType, targetId, JSON.stringify(redactStatusResult(detail) ?? {}), occurredAt);
  }

  issueEnrollmentToken(input: IssueEnrollmentTokenInput): EnrollmentToken;
  issueEnrollmentToken(teamId: string, label: string, createdBy: string, ttlMs?: number): EnrollmentToken;
  issueEnrollmentToken(
    inputOrTeam: IssueEnrollmentTokenInput | string,
    labelArg?: string,
    createdByArg?: string,
    ttlArg?: number,
  ): EnrollmentToken {
    const input: IssueEnrollmentTokenInput = typeof inputOrTeam === 'string'
      ? { teamId: inputOrTeam, label: labelArg ?? 'node', createdBy: createdByArg ?? '', ...(ttlArg === undefined ? {} : { ttlMs: ttlArg }) }
      : inputOrTeam;
    if (!input.teamId || !input.label || !input.createdBy) throw new MachineError('invalid_enrollment_request', 'teamId, label and createdBy are required', 422);
    const ttlMs = assertTokenTtl(input.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS);
    const createdAt = this.clock.now();
    const token = this.ids.token(32);
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const id = this.ids.id();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO node_enrollment_tokens(id, team_id, token_hash, label, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.teamId, hashToken(token), input.label, input.createdBy, createdAt.toISOString(), expiresAt.toISOString());
      this.appendAudit('enrollment_token.issued', 'enrollment_token', id, { type: 'user', id: input.createdBy }, {
        teamId: input.teamId,
        label: input.label,
        expiresAt: expiresAt.toISOString(),
      }, createdAt.toISOString());
    });
    return { id, token, teamId: input.teamId, label: input.label, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  consumeEnrollmentToken(token: string, machineName?: string): EnrollmentResult {
    if (!token || token.length > 512) throw new MachineError('invalid_enrollment_token', 'Enrollment token is invalid', 401);
    const consumedAt = nowIso(this.clock);
    const hash = hashToken(token);
    const result = this.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, team_id, label, expires_at, consumed_at, revoked_at
        FROM node_enrollment_tokens
        WHERE token_hash = ?
      `).get(hash) as { id: string; team_id: string; label: string; expires_at: string; consumed_at: string | null; revoked_at: string | null } | undefined;
      if (!row || row.consumed_at || row.revoked_at || Date.parse(row.expires_at) <= Date.parse(consumedAt)) {
        throw new MachineError('invalid_enrollment_token', 'Enrollment token is invalid, expired, revoked, or already consumed', 401);
      }
      const machineId = this.ids.id();
      const credentialId = this.ids.id();
      const credential = this.ids.token(32);
      const name = (machineName?.trim() || row.label).slice(0, 160);
      const updated = this.database.prepare(`
        UPDATE node_enrollment_tokens
        SET consumed_at = ?, consumed_by_machine_id = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).run(consumedAt, machineId, row.id, consumedAt);
      if (updated.changes !== 1) throw new MachineError('invalid_enrollment_token', 'Enrollment token was already consumed', 409);
      this.database.prepare(`
        INSERT INTO machines(id, team_id, name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'enrolled', ?, ?)
      `).run(machineId, row.team_id, name, consumedAt, consumedAt);
      this.database.prepare(`
        INSERT INTO device_credentials(id, machine_id, credential_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(credentialId, machineId, hashToken(credential), consumedAt);
      this.appendAudit('enrollment_token.consumed', 'enrollment_token', row.id, { type: 'system' }, {
        machineId,
        credentialId,
        machineName: name,
      }, consumedAt);
      return { machineId, teamId: row.team_id, machineName: name, credential, credentialId, consumedAt };
    });
    return result;
  }

  revokeEnrollmentToken(id: string, actorId?: string): void {
    const revokedAt = nowIso(this.clock);
    this.transaction(() => {
      const changed = this.database.prepare('UPDATE node_enrollment_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND revoked_at IS NULL').run(revokedAt, id);
      if (changed.changes === 1) this.appendAudit('enrollment_token.revoked', 'enrollment_token', id, actorId ? { type: 'user', id: actorId } : { type: 'system' }, {}, revokedAt);
    });
  }

  revokeEnrollmentTokensForUser(userId: string, actorId: string): void {
    this.transaction(() => {
      const rows = this.database.prepare('SELECT id FROM node_enrollment_tokens WHERE created_by = ? AND consumed_at IS NULL AND revoked_at IS NULL').all(userId) as Array<{ id: string }>;
      for (const row of rows) this.revokeEnrollmentToken(row.id, actorId);
    });
  }

  revokeMachine(machineId: string, actorId: string): void {
    const at = nowIso(this.clock);
    this.transaction(() => {
      const machine = this.getMachine(machineId);
      if (!machine) throw new MachineError('machine_not_found', 'Machine not found', 404);
      const credentials = this.database.prepare('SELECT id FROM device_credentials WHERE machine_id = ? AND revoked_at IS NULL').all(machineId) as Array<{ id: string }>;
      this.database.prepare('UPDATE device_credentials SET revoked_at = ? WHERE machine_id = ? AND revoked_at IS NULL').run(at, machineId);
      const changed = this.database.prepare("UPDATE machines SET status = 'revoked', available_slots = 0, updated_at = ? WHERE id = ? AND status <> 'revoked'").run(at, machineId);
      const actor = { type: 'user' as const, id: actorId };
      for (const credential of credentials) this.appendAudit('device_credential.revoked', 'device_credential', credential.id, actor, { machineId }, at);
      if (changed.changes === 1) this.appendAudit('machine.revoked', 'machine', machineId, actor, { revokedCredentialCount: credentials.length }, at);
    });
    const closeRevokedConnection = (): void => {
      if (!this.database.open || this.database.inTransaction || this.getMachine(machineId)?.status !== 'revoked') return;
      const current = this.#connections.get(machineId);
      if (current) {
        this.#connections.delete(machineId);
        closeSocketSafely(current.socket, 4003, 'machine revoked');
      }
    };
    // Device enrollment may revoke inside its own transaction. A rollback
    // must leave the previous authenticated transport usable.
    if (this.database.inTransaction) queueMicrotask(closeRevokedConnection);
    else closeRevokedConnection();
  }

  replaceDeviceCredential(machineId: string, actorId?: string): { credentialId: string; credential: string } {
    const createdAt = nowIso(this.clock);
    const row = this.getMachine(machineId);
    if (!row) throw new MachineError('machine_not_found', 'Machine not found', 404);
    if (row.status === 'revoked') throw new MachineError('machine_revoked', 'Machine has been revoked', 403);
    this.requireMachineAuthorization(machineId);
    const credentialId = this.ids.id();
    const credential = this.ids.token(32);
    this.transaction(() => {
      const prior = this.database.prepare('SELECT id FROM device_credentials WHERE machine_id = ? AND revoked_at IS NULL').all(machineId) as Array<{ id: string }>;
      this.database.prepare('INSERT INTO device_credentials(id, machine_id, credential_hash, created_at) VALUES (?, ?, ?, ?)').run(credentialId, machineId, hashToken(credential), createdAt);
      this.database.prepare('UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, ?), replaced_by = ? WHERE machine_id = ? AND id <> ? AND revoked_at IS NULL').run(createdAt, credentialId, machineId, credentialId);
      const actor = actorId ? { type: 'user' as const, id: actorId } : { type: 'system' as const };
      for (const previous of prior) this.appendAudit('device_credential.revoked', 'device_credential', previous.id, actor, { machineId, replacedBy: credentialId }, createdAt);
      this.appendAudit('device_credential.replaced', 'device_credential', credentialId, actor, { machineId, revokedCredentialCount: prior.length }, createdAt);
    });
    const current = this.#connections.get(machineId);
    if (current) {
      // Replacing a credential revokes the currently authenticated transport
      // immediately; otherwise that socket could continue issuing commands.
      this.disconnect(machineId, current.socket);
      closeSocketSafely(current.socket, 4003, 'device credential replaced');
    }
    return { credentialId, credential };
  }

  authenticateNode(machineId: string, credential: string): boolean {
    if (!machineId || !credential) return false;
    if (!this.machineAuthorizationAllowed(machineId)) return false;
    const rows = this.database.prepare(`
      SELECT d.id, d.credential_hash FROM device_credentials d
      JOIN machines m ON m.id = d.machine_id
      WHERE d.machine_id = ? AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > ?) AND m.status <> 'revoked'
    `).all(machineId, nowIso(this.clock)) as Array<{ id: string; credential_hash: string }>;
    const match = rows.find((row) => tokenMatches(credential, row.credential_hash));
    if (!match) return false;
    this.database.prepare('UPDATE device_credentials SET last_used_at = ? WHERE id = ?').run(nowIso(this.clock), match.id);
    return true;
  }

  listMachines(teamId?: string): Array<Record<string, unknown>> {
    const rows = (teamId
      ? this.database.prepare('SELECT * FROM machines WHERE team_id = ? ORDER BY name').all(teamId)
      : this.database.prepare('SELECT * FROM machines ORDER BY name').all()) as Array<Record<string, unknown>>;
    return rows;
  }

  getMachine(machineId: string): Record<string, unknown> | undefined {
    return this.database.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as Record<string, unknown> | undefined;
  }

  heartbeat(machineId: string, availableSlots: number, runtimes: readonly unknown[] = []): void {
    const at = nowIso(this.clock);
    const machine = this.database.prepare('SELECT status FROM machines WHERE id = ?').get(machineId) as { status: MachineStatus } | undefined;
    if (!machine) throw new MachineError('machine_not_found', 'Machine not found', 404);
    if (machine.status === 'revoked') throw new MachineError('machine_revoked', 'Machine has been revoked', 403);
    this.requireMachineAuthorization(machineId);
    this.transaction(() => {
      const transitioned = machine.status !== 'connected';
      this.database.prepare(`UPDATE machines SET status = 'connected', available_slots = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`).run(Math.max(0, Math.min(1000, Math.floor(availableSlots))), at, at, machineId);
      if (transitioned) this.appendMachineAudit(machineId, 'machine.connected', at);
      this.database.prepare("UPDATE runtime_registrations SET available = 0, unavailable_reason = 'Runtime was not reported by the latest heartbeat', observed_at = ? WHERE machine_id = ?").run(at, machineId);
      for (const runtime of runtimes) {
        const item = safeJson(runtime);
        if (typeof item.id !== 'string' || typeof item.kind !== 'string' || typeof item.label !== 'string' || typeof item.protocolVersion !== 'string') continue;
        const caps = JSON.stringify(redactStatusResult(safeJson(item.capabilities)) ?? {});
        const availability = safeJson(item.availability);
        const existing = this.database.prepare('SELECT id FROM runtime_registrations WHERE machine_id = ? AND kind = ? AND label = ?').get(machineId, item.kind, item.label) as { id: string } | undefined;
        this.database.prepare(`
          INSERT INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, executable_reference, observed_version, available, unavailable_reason, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(machine_id, kind, label) DO UPDATE SET
            protocol_version=excluded.protocol_version, capabilities_json=excluded.capabilities_json,
            executable_reference=excluded.executable_reference, observed_version=excluded.observed_version,
            available=excluded.available, unavailable_reason=excluded.unavailable_reason, observed_at=excluded.observed_at
        `).run(
          existing?.id ?? this.ids.id(), machineId, item.kind, redactStatusString(item.label, 120), redactStatusString(item.protocolVersion, 80), caps,
          typeof availability.executable === 'string' ? redactStatusString(availability.executable, 240) : null,
          typeof availability.version === 'string' ? redactStatusString(availability.version, 120) : null,
          availability.available === true ? 1 : 0,
          typeof availability.reason === 'string' ? redactStatusString(availability.reason, 500) : null,
          at,
        );
      }
    });
  }

  disconnect(machineId: string, socket?: WebSocket): void {
    const current = this.#connections.get(machineId);
    if (socket && current && current.socket !== socket) return;
    this.#connections.delete(machineId);
    const at = nowIso(this.clock);
    this.transaction(() => {
      const machine = this.database.prepare('SELECT status FROM machines WHERE id = ?').get(machineId) as { status: MachineStatus } | undefined;
      if (!machine) return;
      const transitioned = machine.status !== 'disconnected' && machine.status !== 'revoked';
      this.database.prepare(`UPDATE machines SET status = 'disconnected', updated_at = ? WHERE id = ? AND status <> 'revoked'`).run(at, machineId);
      if (transitioned) this.appendMachineAudit(machineId, 'machine.disconnected', at);
    });
  }

  markStale(): number {
    const cutoff = new Date(this.clock.now().getTime() - (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)).toISOString();
    const at = nowIso(this.clock);
    return this.database.prepare(`
      UPDATE machines SET status = 'stale', updated_at = ?
      WHERE status IN ('connected', 'disconnected') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
    `).run(at, cutoff).changes;
  }

  addRepositoryAllowlist(machineId: string, repositoryId: string, canonicalRoot: string, actorId?: string): void {
    if (!isAbsolute(canonicalRoot)) throw new MachineError('invalid_repository_root', 'Repository root must be absolute', 422);
    const normalized = resolve(canonicalRoot);
    const at = nowIso(this.clock);
    this.transaction(() => {
      const existing = this.database.prepare('SELECT canonical_root FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').get(machineId, repositoryId) as { canonical_root: string } | undefined;
      this.database.prepare(`INSERT INTO machine_repository_allowlists(machine_id, repository_id, canonical_root, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine_id, repository_id) DO UPDATE SET canonical_root=excluded.canonical_root`).run(machineId, repositoryId, normalized, at);
      this.appendAudit('repository_allowlist.added', 'machine_repository_allowlist', `${machineId}:${repositoryId}`, actorId ? { type: 'user', id: actorId } : { type: 'system' }, {
        machineId,
        repositoryId,
        replaced: Boolean(existing),
      }, at);
    });
  }

  removeRepositoryAllowlist(machineId: string, repositoryId: string, actorId?: string): void {
    const at = nowIso(this.clock);
    this.transaction(() => {
      const changed = this.database.prepare('DELETE FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').run(machineId, repositoryId);
      if (changed.changes === 1) this.appendAudit('repository_allowlist.removed', 'machine_repository_allowlist', `${machineId}:${repositoryId}`, actorId ? { type: 'user', id: actorId } : { type: 'system' }, { machineId, repositoryId }, at);
    });
  }

  isRepositoryAllowed(machineId: string, repositoryId: string, candidatePath?: string): boolean {
    const row = this.database.prepare('SELECT canonical_root FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').get(machineId, repositoryId) as { canonical_root: string } | undefined;
    if (!row) return false;
    if (!candidatePath) return true;
    try {
      const root = realpathSync.native(row.canonical_root);
      const candidate = realpathSync.native(candidatePath);
      return isWithin(root, candidate);
    } catch {
      return false;
    }
  }

  enqueueCommand(input: EnqueueCommandInput): Record<string, unknown>;
  enqueueCommand(machineId: string, command: NodeCommand, projectId?: string): Record<string, unknown>;
  enqueueCommand(inputOrMachine: EnqueueCommandInput | string, commandArg?: NodeCommand, projectIdArg?: string): Record<string, unknown> {
    const input: EnqueueCommandInput = typeof inputOrMachine === 'string' ? { machineId: inputOrMachine, command: commandArg!, ...(projectIdArg ? { projectId: projectIdArg } : {}) } : inputOrMachine;
    const parsed = NodeCommandSchema.safeParse(input.command);
    if (!parsed.success) throw new MachineError('invalid_command', parsed.error.issues[0]?.message ?? 'Invalid node command', 422);
    const command = parsed.data;
    const machine = this.database.prepare('SELECT status, team_id FROM machines WHERE id = ?').get(input.machineId) as { status: MachineStatus; team_id: string } | undefined;
    if (!machine) throw new MachineError('machine_not_found', 'Machine not found', 404);
    if (input.projectId) {
      const project = this.database.prepare('SELECT id FROM projects WHERE id = ? AND team_id = ?').get(input.projectId, machine.team_id);
      if (!project) throw new MachineError('project_not_allowed', 'Project is not owned by the machine team', 403);
    }
    if ('repositoryId' in command) {
      if (!this.isRepositoryAllowed(input.machineId, command.repositoryId)) {
        throw new MachineError('repository_not_allowed', 'Repository is not allowlisted for this machine', 403);
      }
      if (input.projectId) {
        const repository = this.database.prepare('SELECT id FROM repositories WHERE id = ? AND project_id = ?').get(command.repositoryId, input.projectId);
        if (!repository) throw new MachineError('repository_not_allowed', 'Repository is not part of the command project', 403);
      }
    }
    const existing = this.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(input.machineId, command.operationKey) as Record<string, unknown> | undefined;
    if (existing) {
      let existingCommand: unknown;
      try { existingCommand = JSON.parse(String(existing.payload_json)) as unknown; } catch { existingCommand = undefined; }
      if ((existing.project_id ?? null) !== (input.projectId ?? null) || canonicalJson(existingCommand) !== canonicalJson(command)) {
        throw new MachineError('operation_key_conflict', 'Operation key is already bound to a different command', 409);
      }
      return this.commandRow(existing);
    }
    if (machine.status === 'revoked') throw new MachineError('machine_revoked', 'Machine has been revoked', 403);
    this.requireMachineAuthorization(input.machineId);
    const at = nowIso(this.clock);
    let inserted = false;
    try {
      this.transaction(() => {
        this.database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(command.commandId, input.machineId, input.projectId ?? null, command.operationKey, command.kind, JSON.stringify(command), at, command.expiresAt, at);
        inserted = true;
        this.appendCommandEvent(input.projectId ?? null, 'command.queued', command.commandId, input.machineId, {
          operationKey: command.operationKey,
          kind: command.kind,
          machineId: input.machineId,
        });
      });
    } catch (error) {
      const duplicate = this.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(input.machineId, command.operationKey) as Record<string, unknown> | undefined;
      if (!duplicate) throw error;
      let duplicateCommand: unknown;
      try { duplicateCommand = JSON.parse(String(duplicate.payload_json)) as unknown; } catch { duplicateCommand = undefined; }
      if ((duplicate.project_id ?? null) !== (input.projectId ?? null) || canonicalJson(duplicateCommand) !== canonicalJson(command)) {
        throw new MachineError('operation_key_conflict', 'Operation key is already bound to a different command', 409);
      }
      return this.commandRow(duplicate);
    }
    const row = this.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(input.machineId, command.operationKey) as Record<string, unknown>;
    // Sessions defer delivery until their transaction commits. Direct calls
    // deliver once this method's own transaction has committed.
    if (inserted && !this.database.inTransaction) this.deliverPending(input.machineId);
    return this.commandRow(row);
  }

  listCommands(machineId: string): Array<Record<string, unknown>> {
    const rows = this.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? ORDER BY created_at').all(machineId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.commandRow(row));
  }

  getCommand(machineId: string, operationKey: string): Record<string, unknown> | undefined {
    const row = this.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(machineId, operationKey) as Record<string, unknown> | undefined;
    return row ? this.commandRow(row) : undefined;
  }

  attachConnection(machineId: string, socket: WebSocket, journalOperations: readonly { operationKey: string; state: string }[] = []): void {
    const machine = this.getMachine(machineId);
    if (!machine) throw new MachineError('machine_not_found', 'Machine not found', 404);
    if (machine.status === 'revoked') throw new MachineError('machine_revoked', 'Machine has been revoked', 403);
    this.requireMachineAuthorization(machineId);
    const previous = this.#connections.get(machineId);
    if (previous && previous.socket !== socket) {
      closeSocketSafely(previous.socket, 4001, 'replaced by reconnect');
    }
    this.#connections.set(machineId, { machineId, socket, connectedAt: nowIso(this.clock) });
    const at = nowIso(this.clock);
    const journal = new Map(journalOperations.map((item) => [item.operationKey, item.state]));
    this.transaction(() => {
      const machine = this.database.prepare('SELECT status FROM machines WHERE id = ?').get(machineId) as { status: MachineStatus } | undefined;
      if (!machine) return;
      const transitioned = machine.status !== 'connected';
      this.database.prepare(`UPDATE machines SET status = 'connected', last_connected_at = ?, updated_at = ? WHERE id = ? AND status <> 'revoked'`).run(at, at, machineId);
      if (transitioned && machine.status !== 'revoked') this.appendMachineAudit(machineId, 'machine.connected', at);
      for (const item of journalOperations) {
        // A terminal journal summary still needs its full status replay. Keep
        // retired commands pending reconciliation so retirement cannot cancel
        // a queued row whose result was already produced by the node.
        const state = item.operationKey.startsWith('orchestration:') && ['completed', 'failed'].includes(item.state) ? 'uncertain' : item.state;
        if (!['accepted', 'running', 'uncertain'].includes(state)) continue;
        const command = this.database.prepare('SELECT id FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(machineId, item.operationKey) as { id: string } | undefined;
        if (!command) continue;
        const current = this.database.prepare('SELECT state, project_id FROM node_commands WHERE id = ?').get(command.id) as { state: CommandState; project_id: string | null } | undefined;
        if (!current) continue;
        const terminal = current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled' || current.state === 'expired';
        if (terminal) continue;
        const rank: Record<string, number> = { queued: 0, delivered: 1, accepted: 2, running: 3, uncertain: 3.5, completed: 4, failed: 4, cancelled: 4, expired: 4 };
        if ((rank[state] ?? 0) < (rank[current.state] ?? 0)) continue;
        const changed = this.database.prepare('UPDATE node_commands SET state = ?, acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ? WHERE id = ? AND state NOT IN (\'completed\', \'failed\', \'cancelled\', \'expired\')').run(state, at, at, command.id);
        if (changed.changes === 1 && (rank[current.state] ?? 0) < 2) {
          this.appendCommandEvent(current.project_id, 'command.acknowledged', command.id, machineId, { operationKey: item.operationKey, state });
        }
      }
    });
    // Reconcile asks the node for a durable status; it is not command
    // redelivery. This includes uncertain operations so an operator can
    // resolve the ambiguity with a later terminal status.
    const incomplete = this.database.prepare(`SELECT operation_key FROM node_commands WHERE machine_id = ? AND state NOT IN ('completed', 'failed', 'cancelled', 'expired')`).all(machineId) as Array<{ operation_key: string }>;
    // Terminal journal summaries intentionally omit result/error details. Ask
    // the node to replay those statuses so a lost final frame is recoverable.
    const terminalNeedsReconcile = journalOperations
      .filter((item) => item.state === 'completed' || item.state === 'failed')
      .filter((item) => {
        const command = this.database.prepare('SELECT state FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(machineId, item.operationKey) as { state: CommandState } | undefined;
        return Boolean(command && !['completed', 'failed', 'cancelled', 'expired'].includes(command.state));
      })
      .map((item) => item.operationKey);
    const operationKeys = [...new Set([...incomplete.map((item) => item.operation_key), ...terminalNeedsReconcile])];
    const sendConnectionMessages = (): void => {
      if (this.#connections.get(machineId)?.socket !== socket || this.getMachine(machineId)?.status === 'revoked') return;
      if (!this.machineAuthorizationAllowed(machineId)) { this.disconnectUnauthorizedMachines(); return; }
      this.send(socket, { type: 'welcome', protocol: PROTOCOL, heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS });
      this.send(socket, { type: 'reconcile', protocol: PROTOCOL, operationKeys });
      this.deliverPending(machineId, journal);
    };
    // Avoid sending a command while an outer transaction can still roll back.
    if (this.database.inTransaction) queueMicrotask(() => { if (!this.database.inTransaction) sendConnectionMessages(); });
    else sendConnectionMessages();
  }

  connection(machineId: string): NodeConnection | undefined {
    return this.#connections.get(machineId);
  }

  connectNode(machineId: string, socket: WebSocket, journalOperations: readonly { operationKey: string; state: string }[] = []): void {
    this.attachConnection(machineId, socket, journalOperations);
  }

  updateMachineHeartbeat(machineId: string, availableSlots: number, runtimes: readonly unknown[] = []): void {
    this.heartbeat(machineId, availableSlots, runtimes);
  }

  enqueueNodeCommand(input: EnqueueCommandInput): Record<string, unknown> {
    return this.enqueueCommand(input);
  }

  updateCommandStatus(machineId: string, status: Extract<NodeClientMessage, { type: 'command_status' }>): void {
    this.handleStatus(machineId, status);
  }

  handleStatus(machineId: string, status: Extract<NodeClientMessage, { type: 'command_status' }>): void {
    let errorSummary = status.error === undefined ? undefined : redactStatusString(status.error, 2_000);
    const terminalEvents: NodeRuntimeEvent[] = [];
    this.transaction(() => {
      const machine = this.database.prepare('SELECT status FROM machines WHERE id = ?').get(machineId) as { status: MachineStatus } | undefined;
      if (!machine) throw new MachineError('machine_not_found', 'Machine not found', 404);
      if (machine.status === 'revoked') throw new MachineError('machine_revoked', 'Machine has been revoked', 403);
      this.requireMachineAuthorization(machineId);
      const row = this.database.prepare('SELECT state, project_id, kind, payload_json, result_json, error_summary FROM node_commands WHERE machine_id = ? AND id = ? AND operation_key = ?').get(machineId, status.commandId, status.operationKey) as { state: CommandState; project_id: string | null; kind: string; payload_json: string; result_json: string | null; error_summary: string | null } | undefined;
      if (!row) return;
      let result: Record<string, unknown> | undefined;
      let durableResultOverflow = false;
      if (row.kind === 'read_session_artifact') result = redactArtifactResult(status.result, row.payload_json);
      else {
        const bounded = redactTerminalStatusResult(status.result);
        result = bounded.result;
        durableResultOverflow = bounded.durableOverflow;
      }
      const at = status.occurredAt;
      const terminal = !durableResultOverflow && (status.state === 'completed' || status.state === 'failed');
      const next = durableResultOverflow ? 'uncertain' : status.state as CommandState;
      if (durableResultOverflow) errorSummary = 'Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely';
      const existingTerminal = row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled' || row.state === 'expired';
      if (existingTerminal) return;
      const rank: Record<string, number> = { queued: 0, delivered: 1, accepted: 2, running: 3, uncertain: 3.5, completed: 4, failed: 4, cancelled: 4, expired: 4 };
      if ((rank[next] ?? 0) < (rank[row.state] ?? 0)) return;
      const resultJson = durableResultOverflow ? null : result === undefined ? row.result_json : JSON.stringify(result);
      const errorJson = errorSummary === undefined ? row.error_summary : errorSummary;
      const changed = this.database.prepare(`UPDATE node_commands SET state = ?, result_json = ?, error_summary = ?, acknowledged_at = COALESCE(acknowledged_at, ?), delivered_at = COALESCE(delivered_at, ?), completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE machine_id = ? AND id = ? AND operation_key = ? AND state NOT IN ('completed', 'failed', 'cancelled', 'expired')`).run(
        next,
        resultJson,
        errorJson,
        at,
        at,
        terminal ? 1 : 0,
        terminal ? at : null,
        at,
        machineId,
        status.commandId,
        status.operationKey,
      );
      if (changed.changes !== 1) return;
      if ((rank[next] ?? 0) >= 2 && (rank[row.state] ?? 0) < 2) {
        this.appendCommandEvent(row.project_id, 'command.acknowledged', status.commandId, machineId, {
          operationKey: status.operationKey,
          state: next,
        });
      }
      if (terminal) {
        const listed = result && Array.isArray(result.events) ? result.events : [];
        for (const item of listed) {
          const candidate = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
          const eventPayload = candidate ? Object.fromEntries(Object.entries(candidate).filter(([key]) => !['type', 'protocol', 'commandId', 'operationKey', 'eventId', 'sequence', 'eventKind', 'occurredAt'].includes(key))) : {};
          const event = candidate && NodeRuntimeEventSchema.safeParse({ type: 'runtime_event', protocol: PROTOCOL, commandId: status.commandId, operationKey: status.operationKey, sequence: candidate.sequence, eventId: candidate.eventId, eventKind: candidate.eventKind, payload: safeJson(eventPayload), occurredAt: status.occurredAt }).success
            ? { type: 'runtime_event' as const, protocol: PROTOCOL, commandId: status.commandId, operationKey: status.operationKey, sequence: candidate.sequence as number, eventId: candidate.eventId as string, eventKind: candidate.eventKind as string, payload: safeJson(eventPayload), occurredAt: status.occurredAt }
            : undefined;
          if (event) terminalEvents.push(event);
        }
        // A terminal result may carry durable runtime events (approval/tool
        // lifecycle). Reduce those while the command transaction is still
        // open; a reducer failure must roll back terminal command state so a
        // reconnect can safely replay the status. Live runtime_event frames
        // continue through handleRuntimeEvent and own their transaction.
        if (this.#runtimeEventHandler && row.project_id) {
          for (const event of terminalEvents) this.#runtimeEventHandler({ projectId: row.project_id, machineId, commandId: status.commandId, operationKey: status.operationKey, event });
        }
        let priorResult: Record<string, unknown> | undefined;
        if (result === undefined && row.result_json) {
          try {
            const prior = JSON.parse(row.result_json) as Record<string, unknown>;
            priorResult = row.kind === 'read_session_artifact' ? redactArtifactResult(prior, row.payload_json) : redactTerminalStatusResult(prior).result;
          } catch { priorResult = undefined; }
        }
        this.appendCommandEvent(row.project_id, 'command.completed', status.commandId, machineId, {
          operationKey: status.operationKey,
          state: next,
          ...(result === undefined ? (priorResult === undefined ? {} : { result: priorResult }) : { result }),
          ...(errorSummary === undefined ? (row.error_summary === null ? {} : { error: redactStatusString(row.error_summary, 2_000) }) : { error: errorSummary }),
        });
      }
    });
  }

  handleRuntimeEvent(machineId: string, event: NodeRuntimeEvent): void {
    if (!this.#runtimeEventHandler) return;
    this.requireMachineAuthorization(machineId);
    const row = this.database.prepare("SELECT c.project_id FROM node_commands c JOIN machines m ON m.id = c.machine_id WHERE c.machine_id = ? AND c.id = ? AND c.operation_key = ? AND m.status <> 'revoked'").get(machineId, event.commandId, event.operationKey) as { project_id: string | null } | undefined;
    if (!row?.project_id) return;
    this.#runtimeEventHandler({ projectId: row.project_id, machineId, commandId: event.commandId, operationKey: event.operationKey, event });
  }

  deliverPending(machineId: string, journal = new Map<string, string>()): void {
    if (this.database.inTransaction) return;
    if (this.getMachine(machineId)?.status === 'revoked') return;
    if (!this.machineAuthorizationAllowed(machineId)) { this.disconnectUnauthorizedMachines(); return; }
    const connection = this.#connections.get(machineId);
    if (!connection) return;
    try { if (connection.socket.readyState !== 1) return; } catch { return; }
    // `uncertain` means the node may already have performed the side effect.
    // It is operator-reconciled: never expire or redeliver it from this queue.
    const rows = this.database.prepare(`SELECT * FROM node_commands WHERE machine_id = ? AND state IN ('queued', 'delivered', 'accepted', 'running') AND (state = 'queued' OR operation_key NOT GLOB 'orchestration:*') ORDER BY created_at LIMIT 100`).all(machineId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (String(row.operation_key).startsWith('orchestration:')) {
        // Only queued commands are provably undelivered. Accepted/running
        // commands may already have caused an external side effect; leave
        // those states for normal reconciliation and never pretend cancelled.
        if (row.state === 'queued') {
          const cancelledAt = nowIso(this.clock);
          this.transaction(() => {
            const changed = this.database.prepare("UPDATE node_commands SET state = 'cancelled', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND machine_id = ? AND state = 'queued'").run(cancelledAt, cancelledAt, row.id, machineId);
            if (changed.changes === 1) {
              const projectId = typeof row.project_id === 'string' ? row.project_id : null;
              this.appendCommandEvent(projectId, 'command.completed', String(row.id), machineId, { operationKey: String(row.operation_key), state: 'cancelled', reason: 'orchestration is retired' });
            }
          });
        }
        continue;
      }
      if (Date.parse(String(row.expires_at)) <= this.clock.now().getTime()) {
        this.database.prepare("UPDATE node_commands SET state = 'expired', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'failed', 'cancelled', 'expired')").run(nowIso(this.clock), nowIso(this.clock), row.id);
        continue;
      }
      const operationKey = String(row.operation_key);
      const journalState = journal.get(operationKey);
      if (journalState === 'completed' || journalState === 'failed' || journalState === 'uncertain') continue;
      const command = JSON.parse(String(row.payload_json)) as NodeCommand;
      if (!this.send(connection.socket, { type: 'command', protocol: PROTOCOL, command })) return;
      this.database.prepare('UPDATE node_commands SET state = CASE WHEN state = \'queued\' THEN \'delivered\' ELSE state END, attempt_count = attempt_count + 1, delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ?').run(nowIso(this.clock), nowIso(this.clock), row.id);
    }
  }

  private commandRow(row: Record<string, unknown>): Record<string, unknown> {
    let result: Record<string, unknown> | undefined;
    if (row.result_json) {
      try {
        const parsed = JSON.parse(String(row.result_json)) as unknown;
        const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
        result = row.kind === 'read_session_artifact'
          ? redactArtifactResult(record, String(row.payload_json))
          : redactTerminalStatusResult(record).result;
      } catch { result = undefined; }
    }
    return {
      id: row.id,
      machineId: row.machine_id,
      projectId: row.project_id,
      operationKey: row.operation_key,
      kind: row.kind,
      command: JSON.parse(String(row.payload_json)) as NodeCommand,
      state: row.state,
      attemptCount: row.attempt_count,
      result,
      error: row.error_summary === null || row.error_summary === undefined ? row.error_summary : redactStatusString(String(row.error_summary), 2_000),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  }

  private send(socket: WebSocket, message: unknown): boolean {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) return false;
    try {
      if (socket.readyState !== 1) return false;
      socket.send(encoded);
      // A close can race between the readiness check and send().  Treat a
      // socket that is no longer open as undelivered so the durable queue is
      // retried on reconnect.
      return socket.readyState === 1;
    } catch {
      return false;
    }
  }
}

export interface NodeConnectionHandlerOptions {
  maxFrameBytes?: number;
  authenticationTimeoutMs?: number;
  /** Credential extracted from the WebSocket HTTP Authorization header by the main upgrade handler. */
  credential?: string;
  /** Optional machine identity extracted by the main upgrade handler. */
  machineId?: string;
  /** Raw Authorization header, accepted as a convenience for direct integrations/tests. */
  authorization?: string;
}

export function bearerCredential(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
  return match?.[1];
}

/** Validate a replaceable device credential from the WebSocket HTTP header. */
export function authenticateNodeCredential(machines: MachineService, machineId: string, authorization: string | undefined): boolean {
  const credential = bearerCredential(authorization);
  return Boolean(credential && machines.authenticateNode(machineId, credential));
}

/** Attach an authenticated outbound node WebSocket to the machines service. */
export function handleNodeConnection(socket: WebSocket, machines: MachineService, options: NodeConnectionHandlerOptions = {}): () => void {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const timeoutMs = options.authenticationTimeoutMs ?? 10_000;
  let machineId: string | undefined;
  let authenticated = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (!authenticated) closeSocketSafely(socket, 4003, 'authentication timeout');
  }, timeoutMs);
  const onMessage = (data: WebSocket.RawData): void => {
    try {
      const raw = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data as Buffer[]);
      if (raw.byteLength > maxFrameBytes) { closeSocketSafely(socket, 1009, 'frame too large'); return; }
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(raw.toString('utf8')) as unknown; } catch { closeSocketSafely(socket, 1003, 'invalid json'); return; }
      if (!authenticated) {
        const candidate = parsedJson as Record<string, unknown>;
        const candidateMachineId = typeof candidate.machineId === 'string' ? candidate.machineId : '';
        const credential = options.credential ?? bearerCredential(options.authorization);
        const parsed = NodeHelloSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== 'hello' || !credential || (options.machineId && options.machineId !== candidateMachineId) || !machines.authenticateNode(candidateMachineId, credential)) { closeSocketSafely(socket, 4003, 'authentication failed'); return; }
        authenticated = true;
        machineId = candidateMachineId;
        if (timer) clearTimeout(timer);
        timer = undefined;
        machines.attachConnection(machineId, socket, parsed.data.journalOperations);
        return;
      }
      const parsed = NodeClientMessageSchema.safeParse(parsedJson);
      if (!parsed.success || parsed.data.protocol !== PROTOCOL || !machineId) { closeSocketSafely(socket, 1003, 'invalid node message'); return; }
      const current = machines.connection(machineId);
      if (!current || current.socket !== socket) { closeSocketSafely(socket, 4003, 'node connection is no longer active'); return; }
      const credential = options.credential ?? bearerCredential(options.authorization);
      if (!credential || !machines.authenticateNode(machineId, credential)) {
        machines.disconnect(machineId, socket);
        closeSocketSafely(socket, 4003, 'machine authorization ended');
        return;
      }
      if (parsed.data.type === 'heartbeat') machines.heartbeat(machineId, parsed.data.availableSlots, parsed.data.runtimes);
      else if (parsed.data.type === 'command_status') machines.handleStatus(machineId, parsed.data);
      else if (parsed.data.type === 'runtime_event') machines.handleRuntimeEvent(machineId, parsed.data);
    } catch (error) {
      // MachineError (including a late heartbeat/status from a revoked machine)
      // is a protocol-level rejection, not an uncaught WebSocket exception.
      if (error instanceof MachineError) closeSocketSafely(socket, 4003, error.message);
      else closeSocketSafely(socket, 1011, 'node message failed');
    }
  };
  socket.on('message', onMessage);
  const onClose = (): void => {
    if (timer) clearTimeout(timer);
    if (machineId) {
      try { machines.disconnect(machineId, socket); } catch { /* socket teardown must remain best-effort */ }
    }
  };
  socket.on('close', onClose);
  socket.on('error', onClose);
  return () => { socket.off('message', onMessage); socket.off('close', onClose); socket.off('error', onClose); if (timer) clearTimeout(timer); };
}

export function createNodeConnectionHandler(machines: MachineService, options: NodeConnectionHandlerOptions = {}): (socket: WebSocket) => () => void {
  return (socket) => handleNodeConnection(socket, machines, options);
}

function userFromContext(context: Context): AuthenticatedUser | undefined {
  const user = context.get('user' as never) as AuthenticatedUser | undefined;
  return user?.id && user.teamId && user.role ? user : undefined;
}

function requireMachineAdmin(context: Context): AuthenticatedUser & { role: 'administrator' } {
  const user = userFromContext(context);
  if (!user) throw new MachineError('authentication_required', 'Authentication is required', 401);
  if (user.role !== 'administrator') throw new MachineError('administrator_required', 'Administrator access is required', 403);
  return { ...user, role: 'administrator' };
}

function requireMachineOperatorAdmin(context: Context): AuthenticatedUser & { role: 'administrator' } {
  if (context.req.header('cookie') || context.req.header('origin')) throw new MachineError('api_token_required', 'Credential rotation requires an administrator API token', 403);
  const user = requireMachineAdmin(context);
  const credential = context.get('credential' as never) as { tokenId?: unknown; runId?: unknown; permissions?: readonly unknown[] } | undefined;
  if (!credential || typeof credential.tokenId !== 'string' || credential.tokenId.length < 1 || credential.runId !== undefined || !credential.permissions?.includes('fleet:admin')) {
    throw new MachineError('api_token_required', 'Credential rotation requires an administrator API token', 403);
  }
  return user;
}

const IssueTokenSchema = z.object({ teamId: z.string().min(1).max(160).optional(), label: z.string().min(1).max(160), createdBy: z.string().min(1).max(160).optional(), ttlMs: z.number().int().optional() });
const ConsumeTokenSchema = z.object({ token: z.string().min(1).max(512), machineName: z.string().min(1).max(160).optional() });
const AllowlistSchema = z.object({ repositoryId: z.string().min(1).max(160), canonicalRoot: z.string().min(1).max(4096) });
const CommandSchema = z.object({ command: NodeCommandSchema, projectId: z.string().min(1).max(160).optional() });

export function createMachineService(context: ServerContext): MachineService {
  const existing = machineServices.get(context);
  if (existing) return existing;
  const service = new MachineService(context.database, context.clock, context.ids, context.config.demo ? { staleAfterMs: 24 * 60 * 60 * 1_000 } : {}, context.events);
  subscribeSessionAuthorizationChanges(context, () => service.disconnectUnauthorizedMachines());
  machineServices.set(context, service);
  return service;
}

const machineServices = new WeakMap<ServerContext, MachineService>();

export function registerMachineRoutes(app: DholeApp, context: ServerContext): void {
  const machines = createMachineService(context);
  const adminMachine = (c: Context): AuthenticatedUser & { role: 'administrator' } => {
    const user = requireMachineAdmin(c);
    const machineId = c.req.param('machineId');
    if (!machineId) throw new MachineError('machine_not_found', 'Machine not found', 404);
    const machine = machines.getMachine(machineId);
    if (!machine || machine.team_id !== user.teamId) throw new MachineError('machine_not_found', 'Machine not found', 404);
    return user;
  };
  app.on('POST', ['/api/machines/enrollment-tokens', '/api/fleet/enrollment-tokens'], async (c) => {
    const body = await parseJson(c, IssueTokenSchema);
    const user = requireMachineAdmin(c);
    if (body.teamId && body.teamId !== user.teamId) throw new MachineError('team_forbidden', 'Enrollment tokens are scoped to your team', 403);
    const issued = machines.issueEnrollmentToken({ teamId: user.teamId, label: body.label, createdBy: user.id, ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }) });
    return c.json(issued, 201);
  });
  app.on('POST', ['/api/machines/enrollment/consume', '/api/fleet/enrollment/consume'], async (c) => {
    const body = await parseJson(c, ConsumeTokenSchema);
    return c.json(machines.consumeEnrollmentToken(body.token, body.machineName));
  });
  app.on('GET', ['/api/machines', '/api/fleet/machines'], (c) => {
    const user = userFromContext(c);
    if (!user) throw new MachineError('authentication_required', 'Authentication is required', 401);
    return c.json(machines.listMachines(user.teamId));
  });
  app.on('POST', ['/api/machines/:machineId/allowlist', '/api/fleet/machines/:machineId/allowlist'], async (c) => {
    const user = adminMachine(c);
    const body = await parseJson(c, AllowlistSchema);
    const repository = context.database.prepare('SELECT project_id FROM repositories WHERE id = ?').get(body.repositoryId) as { project_id: string } | undefined;
    if (!repository || !canAccessProject(context, user, repository.project_id, true)) throw new MachineError('repository_not_found', 'Repository not found', 404);
    machines.addRepositoryAllowlist(c.req.param('machineId'), body.repositoryId, body.canonicalRoot, user.id);
    return c.json({ ok: true });
  });
  app.on('GET', ['/api/machines/:machineId/commands', '/api/fleet/machines/:machineId/commands'], (c) => { adminMachine(c); return c.json(machines.listCommands(c.req.param('machineId'))); });
  app.on('POST', ['/api/machines/:machineId/revoke', '/api/fleet/machines/:machineId/revoke'], (c) => {
    const user = adminMachine(c);
    machines.revokeMachine(c.req.param('machineId'), user.id);
    return c.json({ ok: true });
  });
  app.on('POST', ['/api/machines/:machineId/commands', '/api/fleet/machines/:machineId/commands'], async (c) => {
    const user = adminMachine(c);
    const body = await parseJson(c, CommandSchema);
    if (body.projectId && !canAccessProject(context, user, body.projectId, true)) throw new MachineError('project_not_found', 'Project not found', 404);
    if ('repositoryId' in body.command) {
      const repository = context.database.prepare('SELECT project_id FROM repositories WHERE id = ?').get(body.command.repositoryId) as { project_id: string } | undefined;
      if (!repository || !canAccessProject(context, user, repository.project_id, true)) throw new MachineError('repository_not_found', 'Repository not found', 404);
    }
    return c.json(machines.enqueueCommand({ machineId: c.req.param('machineId'), command: body.command, ...(body.projectId ? { projectId: body.projectId } : {}) }), 202);
  });
  app.on('POST', ['/api/machines/:machineId/credential/replace', '/api/fleet/machines/:machineId/credential/replace'], (c) => {
    const user = requireMachineOperatorAdmin(c);
    const machineId = c.req.param('machineId');
    const machine = machines.getMachine(machineId);
    if (!machine || machine.team_id !== user.teamId) throw new MachineError('machine_not_found', 'Machine not found', 404);
    return c.json(machines.replaceDeviceCredential(machineId, user.id));
  });
}
