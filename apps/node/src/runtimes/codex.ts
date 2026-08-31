import type { NodeCommand, RuntimeCapabilities } from '@dhole-control/shared';
import { discoverExecutable } from './discovery.js';
import { BoundedStdioProcess, boundedRequestId, JsonRpcDemux, normalizeRuntimeError } from './protocol.js';
import { descriptorFor, eventEmitter, normalizeRuntimeText, type RuntimeAdapter, type RuntimeAdapterEvent, type RuntimeAdapterOptions, type RuntimeExecutionContext, type RuntimeExecutionResult, throwIfAborted } from './types.js';

const capabilities: RuntimeCapabilities = {
  sessionCreation: true,
  sessionResume: true,
  nextTurnMessage: true,
  activeTurnSteering: true,
  cancellation: true,
  // Codex approval requests are server -> client JSON-RPC requests. Until
  // pending inbound request IDs are correlated, answering would be unsafe.
  approvalResponses: false,
  historyReplay: true,
  structuredToolEvents: true,
  // NodeCommand accepts only text prompts. Attachments and output schemas are
  // not part of the adapter's request path yet.
  nativeSubagentObservation: false,
  imageInput: false,
  structuredOutput: false,
  repositoryEditing: true,
  terminalTools: true,
};

interface SessionProcess {
  process: BoundedStdioProcess;
  demux: JsonRpcDemux;
  nextId: number;
  initialized: boolean;
  nativeTurnId?: string;
}

/** Codex app-server adapter (newline-delimited JSON-RPC over `codex app-server`). */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'codex' as const;
  readonly label = 'Codex App Server';
  readonly protocolVersion = 'codex.app-server.jsonrpc.v1';
  readonly capabilities = capabilities;
  readonly availability;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly clientVersion: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly fixture: boolean;
  private readonly sessions = new Map<string, SessionProcess>();

  constructor(options: RuntimeAdapterOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.args = options.args ?? ['app-server'];
    this.clientVersion = (options.version ?? '0.1.0').slice(0, 120);
    this.env = options.env;
    this.fixture = options.fixture ?? false;
    this.availability = options.fixture
      ? { available: true, executable: this.executable, version: options.version ?? 'fixture' }
      : { available: false, reason: 'Run discover() before use' };
  }

  async discover(): Promise<ReturnType<typeof descriptorFor>['availability']> {
    if (this.fixture) return { available: true, executable: this.executable, version: 'fixture' };
    const result = await discoverExecutable([this.executable], this.env ? { env: this.env } : {});
    Object.assign(this.availability, result);
    return result;
  }

  descriptor(id = 'runtime-codex'): ReturnType<typeof descriptorFor> { return descriptorFor(this, id); }

  private async session(key: string, context: RuntimeExecutionContext): Promise<SessionProcess> {
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.process.child.exitCode === null) return existing;
      this.evictSession(existing);
    }
    throwIfAborted(context.signal);
    const process = new BoundedStdioProcess(this.executable, this.args, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(this.env || context.env ? { env: { ...this.env, ...context.env } } : {}),
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 64 * 1024,
    });
    const value = { process, demux: new JsonRpcDemux(process), nextId: 1, initialized: false };
    this.sessions.set(key, value);
    try {
      await this.request(value, 'initialize', {
        clientInfo: { name: 'dhole-node', title: 'Dhole Node', version: this.clientVersion },
      }, context);
      process.send({ jsonrpc: '2.0', method: 'initialized' });
      value.initialized = true;
      return value;
    } catch (error) {
      this.sessions.delete(key);
      await process.close().catch(() => undefined);
      throw normalizeRuntimeError(error, 'Codex initialization failed');
    }
  }

  private async request(session: SessionProcess, method: string, params: unknown, context: RuntimeExecutionContext, onNotification?: (event: RuntimeAdapterEvent) => void): Promise<{ result: unknown; notifications: RuntimeAdapterEvent[] }> {
    const id = session.nextId++;
    try {
      const response = await session.demux.request(
        id,
        { jsonrpc: '2.0', id, method, params },
        context.signal,
        context.timeoutMs ?? 30_000,
        (frame) => onNotification?.(this.mapFrame(frame)),
      );
      return { result: response.response.result, notifications: response.notifications.map((frame) => this.mapFrame(frame)) };
    } catch (error) {
      if (!context.signal?.aborted || session.process.child.exitCode !== null) this.evictSession(session);
      throw error;
    }
  }

  private evictSession(session: SessionProcess): void {
    for (const [key, candidate] of this.sessions) if (candidate === session) this.sessions.delete(key);
    session.demux.stop();
    void session.process.close().catch(() => undefined);
  }

  private mapFrame(frame: Record<string, unknown>): RuntimeAdapterEvent {
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    const params = frame.params && typeof frame.params === 'object' ? frame.params as Record<string, unknown> : {};
    if (!method) return { type: 'runtime.raw', raw: frame };
    if (method.includes('delta') || method.includes('text')) return { type: 'message.delta', delta: params.delta ?? params.text ?? params, nativeMethod: method };
    if (method.includes('approval') || method.includes('permission')) {
      const requestId = boundedRequestId(frame.id);
      return { type: 'approval.requested', ...params, nativeMethod: method, ...(requestId === undefined ? {} : { nativeRequestId: requestId }) };
    }
    if (method.includes('tool')) return { type: method.includes('complete') ? 'tool.call.completed' : 'tool.call.started', ...params, nativeMethod: method };
    if (method.includes('turn')) return { type: method.includes('complete') ? 'turn.completed' : 'turn.started', ...params, nativeMethod: method };
    if (method.includes('thread')) return { type: method.includes('resume') ? 'session.resumed' : 'session.updated', ...params, nativeMethod: method };
    return { type: 'runtime.raw', nativeMethod: method, params };
  }

  async execute(command: NodeCommand, context: RuntimeExecutionContext = {}): Promise<RuntimeExecutionResult> {
    const events: RuntimeAdapterEvent[] = [];
    const emit = eventEmitter(context, events);
    try {
      switch (command.kind) {
        case 'create_runtime_session': {
          const session = await this.session(command.runtimeSessionKey, context);
          const response = await this.request(session, 'thread/start', { cwd: context.cwd }, context, emit);
          const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
          const runtimeSessionId = String(result.threadId ?? ((result.thread && typeof result.thread === 'object' ? (result.thread as Record<string, unknown>).id : '') || command.runtimeSessionKey));
          this.sessions.set(runtimeSessionId, session);
          emit({ type: 'session.created', runtimeSessionId });
          return { runtimeSessionId, events };
        }
        case 'resume_runtime_session': {
          const session = await this.session(command.runtimeSessionId, context);
          await this.request(session, 'thread/resume', { threadId: command.runtimeSessionId, cwd: context.cwd }, context, emit);
          emit({ type: 'session.resumed', runtimeSessionId: command.runtimeSessionId });
          return { runtimeSessionId: command.runtimeSessionId, events };
        }
        case 'send_message': {
          const session = await this.session(command.runtimeSessionId, context);
          const response = await this.request(session, 'turn/start', { threadId: command.runtimeSessionId, input: [{ type: 'text', text: command.message }] }, context, emit);
          const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
          const turn = result.turn && typeof result.turn === 'object' ? result.turn as Record<string, unknown> : {};
          const turnId = String(result.turnId ?? turn.id ?? result.id ?? command.operationKey);
          session.nativeTurnId = turnId;
          const text = normalizeRuntimeText(response.result) || normalizeRuntimeText(response.notifications);
          emit({ type: 'turn.completed', runtimeSessionId: command.runtimeSessionId, turnId, text });
          return { runtimeSessionId: command.runtimeSessionId, turnId, text, result: response.result, events };
        }
        case 'steer': {
          const session = await this.session(command.runtimeSessionId, context);
          const response = await this.request(session, 'turn/steer', { threadId: command.runtimeSessionId, expectedTurnId: command.turnId, input: [{ type: 'text', text: command.message }] }, context, emit);
          const text = normalizeRuntimeText(response.result) || normalizeRuntimeText(response.notifications);
          const turn = response.result && typeof response.result === 'object' && (response.result as Record<string, unknown>).turn && typeof (response.result as Record<string, unknown>).turn === 'object'
            ? (response.result as Record<string, unknown>).turn as Record<string, unknown>
            : {};
          const nativeTurnId = String(turn.id ?? command.turnId);
          session.nativeTurnId = nativeTurnId;
          emit({ type: 'turn.steered', runtimeSessionId: command.runtimeSessionId, turnId: nativeTurnId, text });
          return { runtimeSessionId: command.runtimeSessionId, turnId: nativeTurnId, text, result: response.result, events };
        }
        case 'cancel': {
          const session = await this.session(command.runtimeSessionId, context);
          const nativeTurnId = command.turnId ?? session.nativeTurnId;
          await this.request(session, 'turn/interrupt', { threadId: command.runtimeSessionId, ...(nativeTurnId ? { turnId: nativeTurnId } : {}) }, context, emit);
          emit({ type: 'turn.cancelled', runtimeSessionId: command.runtimeSessionId, ...(nativeTurnId ? { turnId: nativeTurnId } : {}) });
          return { runtimeSessionId: command.runtimeSessionId, ...(nativeTurnId ? { turnId: nativeTurnId } : {}), events };
        }
        case 'answer_approval': throw new Error('Codex approval responses are not supported by this adapter');
        default:
          return { events };
      }
    } catch (error) {
      throw normalizeRuntimeError(error, 'Codex operation failed');
    }
  }

  async close(): Promise<void> {
    for (const session of new Set(this.sessions.values())) {
      session.demux.stop();
      await session.process.close().catch(() => undefined);
    }
    this.sessions.clear();
  }
}
