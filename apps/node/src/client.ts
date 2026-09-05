import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { NodeCommandSchema, NodeServerMessageSchema, type NodeCommand, type RuntimeDescriptor } from '@dhole-control/shared';
import { loadNodeConfig, resolveCredential, type NodeConfig } from './config.js';
import { createWorktree, removeWorktree } from './git.js';
import { OperationJournal, type JournalOperation } from './journal.js';
import type { RuntimeAdapterEvent } from './runtimes/types.js';

const PROTOCOL = 'dhole.node.v1' as const;
const OPEN = 1;
const SENSITIVE_KEY = /(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key)/i;
// Skip empty/very short configured values so common text is not globally clobbered.
const MIN_REDACTABLE_SECRET_LENGTH = 4;

function redactText(value: string, maxLength = 2_000, secrets: readonly string[] = []): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  for (const secret of [...new Set(secrets)].filter((candidate) => candidate.length >= MIN_REDACTABLE_SECRET_LENGTH).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted.slice(0, maxLength);
}

function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value, 100_000, secrets);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, secrets, depth + 1);
    return result;
  }
  return value;
}

function redactRecord(value: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  return redactValue(value, secrets) as Record<string, unknown>;
}

function boundedRecord(value: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  const safe = redactRecord(value, secrets);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded, 'utf8') <= 64 * 1024) return safe;
  return { truncated: true, preview: redactText(encoded, 60 * 1024, secrets) };
}

const DURABLE_RUNTIME_EVENT_KINDS = new Set(['approval.requested', 'tool.call.started', 'tool.call.completed']);
const MAX_TERMINAL_RESULT_BYTES = 900 * 1024;
const MAX_RUNTIME_EVENT_SEQUENCE = 10_000;

function runtimeEventKind(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['eventKind', 'type']) if (typeof record[key] === 'string') return record[key];
  return undefined;
}

function isDurableRuntimeEvent(value: unknown): boolean {
  return DURABLE_RUNTIME_EVENT_KINDS.has(runtimeEventKind(value) ?? '');
}

function boundedRuntimeEvent(value: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  const safe = redactRecord(value, secrets);
  const kind = runtimeEventKind(safe);
  if (kind && typeof safe.eventKind !== 'string') safe.eventKind = kind;
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded, 'utf8') <= 64 * 1024) return safe;
  const compact: Record<string, unknown> = {
    truncated: true,
    preview: redactText(encoded, 60 * 1024, secrets),
  };
  for (const key of ['type', 'protocol', 'commandId', 'operationKey', 'eventKind', 'eventId', 'sequence', 'occurredAt', 'turnId', 'runtimeSessionId']) {
    if (safe[key] !== undefined) compact[key] = safe[key];
  }
  return compact;
}

function boundedResult(value: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  // Events are bounded independently so a long stream is not silently cut by
  // redactValue's generic array limit before durable fallback selection runs.
  const rawEventValue = value.events;
  const safe = redactRecord(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'events')), secrets);
  const result: Record<string, unknown> = {};
  for (const key of ['runtimeSessionId', 'turnId', 'text']) if (typeof safe[key] === 'string') result[key] = String(safe[key]).slice(0, key === 'text' ? 200_000 : 240);
  const rawEvents = Array.isArray(rawEventValue) ? rawEventValue.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const eventEntries = rawEvents.map((raw) => ({ raw, bounded: boundedRuntimeEvent(raw, secrets) }));
  let droppedTransientEvents = 0;
  for (let index = eventEntries.length - 1; index >= 0; index -= 1) {
    const eventSequence = eventEntries[index]?.raw.sequence;
    if (typeof eventSequence !== 'number' || (Number.isInteger(eventSequence) && eventSequence > 0 && eventSequence <= MAX_RUNTIME_EVENT_SEQUENCE)) continue;
    if (isDurableRuntimeEvent(eventEntries[index]?.raw)) throw new Error('Runtime emitted more than 10000 events; durable runtime event cannot be represented safely');
    eventEntries.splice(index, 1);
    droppedTransientEvents += 1;
  }
  if (Array.isArray(rawEventValue)) result.events = eventEntries.map((entry) => entry.bounded);
  const extraKeys = Object.keys(safe).filter((key) => !(key in result) && key !== 'events');
  for (const key of extraKeys) result[key] = safe[key];

  let encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_RESULT_BYTES && Array.isArray(result.events)) {
    const events = result.events as Record<string, unknown>[];
    for (let index = eventEntries.length - 1; index >= 0 && Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_RESULT_BYTES; index -= 1) {
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
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_RESULT_BYTES) {
    for (const key of extraKeys.reverse()) {
      if (!(key in result)) continue;
      delete result[key];
      encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_TERMINAL_RESULT_BYTES) break;
    }
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_RESULT_BYTES) {
    throw new Error('Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely');
  }
  return result;
}

export interface NodeCommandExecutor {
  execute?(command: NodeCommand, context: NodeCommandExecutionContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  discoverRuntimes?(): Promise<RuntimeDescriptor[]> | RuntimeDescriptor[];
  listRepositories?(): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  createWorktree?(command: Extract<NodeCommand, { kind: 'create_worktree' }>, context: NodeCommandExecutionContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  removeWorktree?(command: Extract<NodeCommand, { kind: 'remove_worktree' }>, context: NodeCommandExecutionContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  readSessionArtifact?(command: Extract<NodeCommand, { kind: 'read_session_artifact' }>, context: NodeCommandExecutionContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface NodeCommandExecutionContext {
  cwd?: string;
  repositoryRoot?: string;
  secret?: string;
  signal?: AbortSignal;
  node: NodeClient;
  journal: OperationJournal;
  emit?: (event: RuntimeAdapterEvent) => void;
}

export interface NodeClientOptions {
  config?: NodeConfig;
  journal?: OperationJournal;
  executor?: NodeCommandExecutor;
  socketFactory?: (url: URL) => WebSocket;
  onError?: (error: Error) => void;
  onState?: (state: string) => void;
}

interface RuntimeAdapter {
  descriptor?: (id?: string) => RuntimeDescriptor;
  execute?: (command: NodeCommand, context: NodeCommandExecutionContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  handleCommand?: (command: NodeCommand, context: NodeCommandExecutionContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  close?: () => Promise<void> | void;
}

type RuntimeRegistry = Map<string, RuntimeAdapter> | Record<string, RuntimeAdapter>;

interface RuntimeRegistryModule {
  runtimeRegistry?: RuntimeRegistry;
  registry?: RuntimeRegistry;
  default?: RuntimeRegistry;
}

interface RuntimeSessionMapping {
  runtimeKey: string;
  cwd?: string;
  secretReference?: string;
}

/** Outward-connecting node transport with bounded reconnect and durable command execution. */
export class NodeClient {
  readonly config: NodeConfig;
  readonly journal: OperationJournal;
  readonly executor: NodeCommandExecutor;
  readonly #socketFactory: (url: URL) => WebSocket;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #onState: ((state: string) => void) | undefined;
  #socket: WebSocket | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #stopped = true;
  #heartbeatIntervalMs: number;
  readonly #inFlight = new Set<string>();
  readonly #sessionRuntimes = new Map<string, RuntimeSessionMapping>();
  readonly #sessionQueues = new Map<string, Promise<void>>();
  readonly #sessionControllers = new Map<string, AbortController>();
  /** Runtime sessions fenced by an explicit cancel until resumed/newly created. */
  readonly #cancelledSessions = new Set<string>();
  readonly #pendingCreates = new Set<Promise<void>>();

  constructor(options: NodeClientOptions = {}) {
    this.config = options.config ?? loadNodeConfig();
    this.journal = options.journal ?? new OperationJournal(this.config.journalPath);
    this.executor = options.executor ?? {};
    this.#socketFactory = options.socketFactory ?? ((url) => {
      const credentials = resolveCredential(this.config);
      return new WebSocket(url.toString(), {
        maxPayload: this.config.maxFrameBytes,
        ...(credentials ? { headers: { Authorization: `Bearer ${credentials.credential}` } } : {}),
      });
    });
    this.#onError = options.onError;
    this.#onState = options.onState;
    this.#heartbeatIntervalMs = this.config.heartbeatIntervalMs;
  }

  get socket(): WebSocket | undefined { return this.#socket; }
  get connected(): boolean { return this.#socket?.readyState === OPEN; }

  start(): void {
    if (!this.#stopped) return;
    const credentials = resolveCredential(this.config);
    if (!credentials) throw new Error('Node credentials are not configured; set DHOLE_NODE_MACHINE_ID/CREDENTIAL or credential.json');
    this.#stopped = false;
    this.connect();
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#sessionControllers.values()) controller.abort(new Error('Node stopped'));
    this.#sessionControllers.clear();
    void this.loadRuntimeRegistry().then((registry) => {
      const adapters = registry instanceof Map ? [...registry.values()] : Object.values(registry);
      return Promise.all(adapters.map((adapter) => adapter.close?.()));
    }).catch(() => undefined);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#reconnectTimer = undefined;
    this.#heartbeatTimer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState <= 1) socket.close(1000, 'node stopped');
    this.#onState?.('stopped');
  }

  connect(): void {
    if (this.#stopped) return;
    const credentials = resolveCredential(this.config);
    if (!credentials) { this.fail(new Error('Node credentials are missing')); return; }
    const socket = this.#socketFactory(this.config.serverUrl);
    this.#socket = socket;
    this.#onState?.('connecting');
    socket.on('open', () => {
      if (this.#socket !== socket || this.#stopped) return;
      this.#reconnectAttempt = 0;
      this.#onState?.('connected');
      this.send({
        type: 'hello', protocol: PROTOCOL, machineId: credentials.machineId,
        daemonVersion: this.config.daemonVersion,
        journalOperations: this.journal.summarize(),
      });
      this.startHeartbeat();
    });
    socket.on('message', (data) => {
      if (this.#socket !== socket || this.#stopped) return;
      void this.onMessage(data, socket).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
    });
    socket.on('close', () => this.onDisconnect(socket));
    socket.on('error', (error) => {
      if (this.#socket !== socket || this.#stopped) return;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private onDisconnect(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#socket = undefined;
    this.#onState?.('disconnected');
    if (!this.#stopped && !this.#reconnectTimer) {
      const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** this.#reconnectAttempt);
      this.#reconnectAttempt = Math.min(this.#reconnectAttempt + 1, 20);
      this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; this.connect(); }, delay);
    }
  }

  private startHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => { this.sendHeartbeat(); }, this.#heartbeatIntervalMs);
    this.sendHeartbeat();
  }

  async sendHeartbeat(): Promise<void> {
    let runtimes: RuntimeDescriptor[] = [];
    try {
      runtimes = this.executor.discoverRuntimes ? await this.executor.discoverRuntimes() : await this.discoverRuntimes();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    this.send({ type: 'heartbeat', protocol: PROTOCOL, sentAt: new Date().toISOString(), availableSlots: Math.max(0, 1 - this.#inFlight.size), runtimes });
  }

  private async onMessage(data: WebSocket.RawData, socket: WebSocket): Promise<void> {
    if (this.#socket !== socket || this.#stopped) return;
    const raw = Buffer.isBuffer(data)
      ? data
      : typeof data === 'string'
        ? Buffer.from(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data as Buffer[]);
    if (raw.byteLength > this.config.maxFrameBytes) { socket.close(1009, 'frame too large'); return; }
    let json: unknown;
    try { json = JSON.parse(raw.toString('utf8')) as unknown; } catch { socket.close(1003, 'invalid json'); return; }
    const parsed = NodeServerMessageSchema.safeParse(json);
    if (!parsed.success || parsed.data.protocol !== PROTOCOL) { socket.close(1003, 'invalid server message'); return; }
    if (parsed.data.type === 'welcome') {
      this.#heartbeatIntervalMs = parsed.data.heartbeatIntervalMs;
      this.startHeartbeat();
    } else if (parsed.data.type === 'reconcile') {
      for (const operationKey of parsed.data.operationKeys) {
        const operation = this.journal.get(operationKey);
        if (operation) this.sendStatus(operation);
      }
    } else if (parsed.data.type === 'command') {
      await this.handleCommand(parsed.data.command);
    }
  }

  private async handleCommand(command: NodeCommand): Promise<void> {
    const parsed = NodeCommandSchema.safeParse(command);
    if (!parsed.success) return;
    command = parsed.data;
    if (command.kind === 'cancel') this.#cancelledSessions.add(command.runtimeSessionId);
    let executionStarted = false;
    const existing = this.journal.get(command.operationKey);
    if (existing) {
      this.sendStatus(existing, command.commandId, this.secretValuesForCommand(command));
      return;
    }
    const accepted = this.journal.accept(command.operationKey, command.commandId);
    this.sendStatus(accepted);
    if (this.#inFlight.has(command.operationKey)) return;
    this.#inFlight.add(command.operationKey);
    try {
      const sessionKey = this.sessionCommandKey(command);
      const controller = command.kind === 'cancel' || !sessionKey ? undefined : new AbortController();
      let commandSecrets: readonly string[] = [];
      let settleCreate: (() => void) | undefined;
      const pendingCreate = command.kind === 'create_runtime_session'
        ? new Promise<void>((resolve) => { settleCreate = resolve; })
        : undefined;
      if (pendingCreate) this.#pendingCreates.add(pendingCreate);
      const run = async (): Promise<void> => {
        try {
          if (command.kind === 'create_runtime_session') this.#cancelledSessions.delete(command.runtimeSessionKey);
          if (command.kind === 'resume_runtime_session') this.#cancelledSessions.delete(command.runtimeSessionId);
          // A command can be queued behind another session operation.  Stop
          // aborts active work, but queued `.then(run)` callbacks still fire;
          // fail them before markRunning so no adapter side effect starts
          // after the daemon has been stopped.
          if (this.#stopped) {
            const failed = this.journal.fail(command.operationKey, 'node stopped before execution');
            this.sendStatus(failed, failed.commandId, commandSecrets);
            return;
          }
          const runtimeSessionKey = this.sessionCommandKey(command);
          if (runtimeSessionKey && this.#cancelledSessions.has(runtimeSessionKey) && command.kind !== 'cancel' && command.kind !== 'resume_runtime_session' && command.kind !== 'create_runtime_session') {
            const failed = this.journal.fail(command.operationKey, 'runtime session was cancelled before execution');
            this.sendStatus(failed, failed.commandId, commandSecrets);
            return;
          }
          if (Date.parse(command.expiresAt) <= Date.now()) {
            const failed = this.journal.fail(command.operationKey, 'command expired before execution');
            this.sendStatus(failed);
            return;
          }
          if (command.kind !== 'create_runtime_session' && command.kind !== 'resume_runtime_session' && 'runtimeSessionId' in command && !this.#sessionRuntimes.has(command.runtimeSessionId)) {
            // ponytail: the wire has no create→provider-ID correlation, so wait for current creates; add explicit correlation when the protocol evolves.
            await Promise.all(this.#pendingCreates);
          }
          commandSecrets = this.secretValuesForCommand(command);
          const running = this.journal.markRunning(command.operationKey);
          this.sendStatus(running);
          const result = await this.executeSessionCommand(command, controller, () => { executionStarted = true; });
          // Bound before persisting. If durable runtime events cannot fit the
          // frame budget, completion must fail into the uncertain state rather
          // than recording a result the server cannot safely replay.
          const terminalResult = boundedResult(result, commandSecrets);
          const completed = this.journal.complete(command.operationKey, terminalResult);
          this.sendStatus(completed, completed.commandId, commandSecrets);
        } finally {
          if (pendingCreate) {
            this.#pendingCreates.delete(pendingCreate);
            settleCreate?.();
          }
        }
      };
      if (!sessionKey || command.kind === 'cancel') {
        await run();
      } else {
        const prior = this.#sessionQueues.get(sessionKey) ?? Promise.resolve();
        let current!: Promise<void>;
        current = this.#sessionQueues.has(sessionKey)
          ? prior.catch(() => undefined).then(run)
          : run();
        current = current.finally(() => {
          if (this.#sessionQueues.get(sessionKey) === current) this.#sessionQueues.delete(sessionKey);
        });
        this.#sessionQueues.set(sessionKey, current);
        await current;
      }
    } catch (error) {
      const commandSecrets = this.secretValuesForCommand(command);
      const summary = redactText(error instanceof Error ? error.message : String(error), 2_000, commandSecrets);
          const ambiguous = executionStarted && ['create_runtime_session', 'resume_runtime_session', 'send_message', 'steer', 'cancel', 'answer_approval'].includes(command.kind);
      const terminal = ambiguous ? this.journal.uncertain(command.operationKey, summary) : this.journal.fail(command.operationKey, summary);
      this.sendStatus(terminal, terminal.commandId, commandSecrets);
    } finally {
      this.#inFlight.delete(command.operationKey);
    }
  }

  private sessionCommandKey(command: NodeCommand): string | undefined {
    if (command.kind === 'create_runtime_session') return command.runtimeSessionKey;
    if ('runtimeSessionId' in command) return command.runtimeSessionId;
    return undefined;
  }

  private secretValuesForCommand(command: NodeCommand): readonly string[] {
    const secretReference = command.kind === 'create_runtime_session' || command.kind === 'resume_runtime_session'
      ? command.secretReference
      : 'runtimeSessionId' in command
        ? this.#sessionRuntimes.get(command.runtimeSessionId)?.secretReference
        : undefined;
    const secret = secretReference ? this.config.secrets.get(secretReference) : undefined;
    return secret ? [secret] : [];
  }

  private async executeSessionCommand(command: NodeCommand, controller?: AbortController, onExecutionStart?: () => void): Promise<Record<string, unknown>> {
    const key = this.sessionCommandKey(command);
    if (command.kind === 'cancel') {
      const active = key ? this.#sessionControllers.get(key) : undefined;
      active?.abort(new Error('Runtime turn cancelled'));
      return this.execute(command, undefined, onExecutionStart);
    }
    const activeController = controller ?? new AbortController();
    if (key) this.#sessionControllers.set(key, activeController);
    try {
      return await this.execute(command, activeController.signal, onExecutionStart);
    } finally {
      if (key && this.#sessionControllers.get(key) === activeController) this.#sessionControllers.delete(key);
    }
  }

  private async execute(command: NodeCommand, signal?: AbortSignal, onExecutionStart?: () => void): Promise<Record<string, unknown>> {
    const repositoryRoot = 'repositoryId' in command ? await this.repositoryRoot(command.repositoryId) : undefined;
    const session = 'runtimeSessionId' in command ? this.#sessionRuntimes.get(command.runtimeSessionId) : undefined;
    if ('runtimeSessionId' in command && !session && command.kind !== 'resume_runtime_session') {
      throw new Error(`Runtime session ${command.runtimeSessionId} is not mapped; resume it before sending commands`);
    }
    const runtimeKey = 'runtimeId' in command ? command.runtimeId : session?.runtimeKey;
    const secretReference = command.kind === 'create_runtime_session' || command.kind === 'resume_runtime_session'
      ? command.secretReference
      : session?.secretReference;
    const secret = secretReference ? this.config.secrets.get(secretReference) : undefined;
    if (secretReference && !secret) throw new Error(`Secret reference ${secretReference} is not configured on this node`);
    const cwd = command.kind === 'create_runtime_session'
      ? await this.repositoryPath(command.repositoryId, command.cwd)
      : command.kind === 'resume_runtime_session'
        ? session?.cwd ?? repositoryRoot
        : session?.cwd;
    let sequence = 0;
    const emitted: RuntimeAdapterEvent[] = [];
    const context: NodeCommandExecutionContext = {
      node: this,
      journal: this.journal,
      ...(signal ? { signal } : {}),
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(cwd ? { cwd } : {}),
      ...(secret ? { secret } : {}),
      emit: (event) => {
        const eventKind = (typeof event.type === 'string' ? event.type : 'runtime.event').slice(0, 80);
        if (sequence >= MAX_RUNTIME_EVENT_SEQUENCE) {
          if (DURABLE_RUNTIME_EVENT_KINDS.has(eventKind)) throw new Error('Runtime emitted more than 10000 events; durable runtime event cannot be represented safely');
          return;
        }
        sequence += 1;
        const payload = boundedRecord(Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'eventId', 'sequence', 'eventKind', 'commandId', 'operationKey'].includes(key))), secret ? [secret] : []);
        // Operation keys are scoped to a machine on the server. Include the
        // command ID so equal keys on two machines cannot collide in the
        // project-level event deduplication index.
        const eventId = `runtime-${createHash('sha256').update(`${command.commandId}:${command.operationKey}:${sequence}`).digest('hex')}:${sequence}`;
        const runtimeEvent = { type: 'runtime_event' as const, protocol: PROTOCOL, commandId: command.commandId, operationKey: command.operationKey, sequence, eventId, eventKind, payload, occurredAt: new Date().toISOString() };
        emitted.push({ type: eventKind, eventId: runtimeEvent.eventId, sequence, eventKind, ...payload });
        this.send(runtimeEvent);
      },
    };
    onExecutionStart?.();
    let result: Record<string, unknown>;
    if (this.executor.execute) result = await this.executor.execute(command, context);
    else if (command.kind === 'discover_runtimes') result = { runtimes: await this.discoverRuntimes() };
    else if (command.kind === 'list_repositories') {
      result = { repositories: this.executor.listRepositories ? await this.executor.listRepositories() : await this.listRepositories() };
    } else if (command.kind === 'create_worktree') {
      if (!repositoryRoot) throw new Error(`Repository ${command.repositoryId} is unavailable on this node`);
      result = this.executor.createWorktree
        ? await this.executor.createWorktree(command, context)
        : await this.createWorktree(command, repositoryRoot);
    } else if (command.kind === 'remove_worktree') {
      if (!repositoryRoot) throw new Error(`Repository ${command.repositoryId} is unavailable on this node`);
      result = this.executor.removeWorktree
        ? await this.executor.removeWorktree(command, context)
        : await this.removeWorktree(command, repositoryRoot);
    } else if (command.kind === 'read_session_artifact') {
      result = this.executor.readSessionArtifact
        ? await this.executor.readSessionArtifact(command, context)
        : await this.readSessionArtifact(command);
    } else if (command.kind === 'report_health') {
      result = { ok: true, inFlight: this.#inFlight.size, repositories: this.config.repositories.size };
    } else {
      const registry = await this.loadRuntimeRegistry();
      const adapter = runtimeKey ? this.registryGet(registry, runtimeKey) ?? this.registryGet(registry, runtimeKey.replace(/^runtime-/u, '')) : undefined;
      if (!adapter) throw new Error(`Runtime ${runtimeKey ?? 'unknown'} is not registered`);
      if (adapter.execute) result = await adapter.execute(command, context);
      else if (adapter.handleCommand) result = await adapter.handleCommand(command, context);
      else throw new Error(`Runtime ${runtimeKey ?? 'unknown'} cannot execute commands`);
    }
    if (typeof result.runtimeSessionId === 'string' && runtimeKey) {
      const mapping = { runtimeKey, ...(cwd ? { cwd } : {}), ...(secretReference ? { secretReference } : {}) };
      this.#sessionRuntimes.set(result.runtimeSessionId, mapping);
      if (command.kind === 'create_runtime_session') this.#sessionRuntimes.set(command.runtimeSessionKey, mapping);
    }
    if (emitted.length) result = { ...result, events: emitted };
    return result;
  }

  private async repositoryRoot(repositoryId: string): Promise<string> {
    const configured = this.config.repositories.get(repositoryId);
    if (!configured) throw new Error(`Repository ${repositoryId} is not configured on this node`);
    try {
      return await realpath(configured);
    } catch {
      throw new Error(`Repository ${repositoryId} is unavailable on this node`);
    }
  }

  private async repositoryPath(repositoryId: string, relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) throw new Error('Repository command paths must be relative');
    const root = await this.repositoryRoot(repositoryId);
    const candidate = resolve(root, relativePath);
    const resolved = await realpath(candidate).catch(() => undefined);
    if (!resolved || !this.isWithin(root, resolved)) throw new Error('Repository command path escapes the configured root or does not exist');
    return resolved;
  }

  private isWithin(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }

  private async listRepositories(): Promise<Record<string, unknown>[]> {
    return await Promise.all([...this.config.repositories.keys()].sort().map(async (repositoryId) => {
      try {
        await this.repositoryRoot(repositoryId);
        return { repositoryId, available: true };
      } catch {
        return { repositoryId, available: false };
      }
    }));
  }

  private async createWorktree(command: Extract<NodeCommand, { kind: 'create_worktree' }>, repositoryRoot: string): Promise<Record<string, unknown>> {
    await createWorktree(repositoryRoot, command.relativeTarget, command.branch, [repositoryRoot], command.baseRevision);
    return { repositoryId: command.repositoryId, relativeTarget: command.relativeTarget, created: true };
  }

  private async removeWorktree(command: Extract<NodeCommand, { kind: 'remove_worktree' }>, repositoryRoot: string): Promise<Record<string, unknown>> {
    await removeWorktree(repositoryRoot, command.relativeTarget, [repositoryRoot]);
    return { repositoryId: command.repositoryId, relativeTarget: command.relativeTarget, removed: true };
  }

  private async readSessionArtifact(command: Extract<NodeCommand, { kind: 'read_session_artifact' }>): Promise<Record<string, unknown>> {
    const path = await this.repositoryPath(command.repositoryId, command.relativePath);
    const file = await open(path, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error('Session artifact is not a regular file');
      if (metadata.size > command.maxBytes) throw new Error('Session artifact exceeds maxBytes');
      const content = Buffer.alloc(metadata.size);
      const { bytesRead } = await file.read(content, 0, content.length, 0);
      return {
        repositoryId: command.repositoryId,
        relativePath: command.relativePath,
        encoding: 'base64',
        content: content.subarray(0, bytesRead).toString('base64'),
        byteLength: bytesRead,
      };
    } finally {
      await file.close();
    }
  }

  private async discoverRuntimes(): Promise<RuntimeDescriptor[]> {
    const registry = await this.loadRuntimeRegistry();
    const discover = (registry as RuntimeRegistry & { discover?: () => Promise<RuntimeDescriptor[]> }).discover;
    if (typeof discover === 'function') return await discover.call(registry);
    const adapters = registry instanceof Map ? [...registry.entries()] : Object.entries(registry);
    return adapters.flatMap(([key, adapter]) => adapter.descriptor ? [adapter.descriptor(`runtime-${key}`)] : []);
  }

  private async loadRuntimeRegistry(): Promise<RuntimeRegistry> {
    // The static registry is the only runtime extension point. It is provided by
    // apps/node/src/runtimes/index.ts and intentionally not loaded from user input.
    const module = await import('./runtimes/index.js') as RuntimeRegistryModule;
    return module.runtimeRegistry ?? module.registry ?? module.default ?? new Map<string, RuntimeAdapter>();
  }

  private registryGet(registry: RuntimeRegistry, key: string): RuntimeAdapter | undefined {
    return registry instanceof Map ? registry.get(key) : registry[key];
  }

  private sendStatus(operation: JournalOperation, commandId = operation.commandId, secrets: readonly string[] = []): void {
    this.send({ type: 'command_status', protocol: PROTOCOL, commandId, operationKey: operation.operationKey, state: operation.state, ...(operation.result ? { result: boundedResult(operation.result, secrets) } : {}), ...(operation.error ? { error: redactText(operation.error, 2_000, secrets) } : {}), occurredAt: operation.updatedAt });
  }

  private send(message: unknown): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return false;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > this.config.maxFrameBytes) return false;
    try { socket.send(encoded); return true; } catch { return false; }
  }

  private fail(error: Error): void { this.#onError?.(error); }
}

export function createNodeClient(options: NodeClientOptions = {}): NodeClient { return new NodeClient(options); }
