import type { NodeCommand, RuntimeCapabilities } from '@dhole-control/shared';
import { resolve } from 'node:path';
import { discoverExecutable } from './discovery.js';
import { BoundedStdioProcess, boundedRequestId, JsonRpcDemux, normalizeRuntimeError } from './protocol.js';
import { descriptorFor, eventEmitter, normalizeRuntimeText, type RuntimeAdapter, type RuntimeAdapterEvent, type RuntimeAdapterOptions, type RuntimeExecutionContext, type RuntimeExecutionResult, throwIfAborted } from './types.js';

const defaultCapabilities: RuntimeCapabilities = {
  sessionCreation: true,
  // ACP session/load support is negotiated during initialize. Until the
  // agent proves it, do not publish resume/history as available.
  sessionResume: false,
  nextTurnMessage: true,
  activeTurnSteering: false,
  cancellation: true,
  // ACP permission requests are agent -> client; answering requires retaining
  // the inbound JSON-RPC request id, which this adapter does not yet expose.
  approvalResponses: false,
  historyReplay: false,
  structuredToolEvents: true,
  nativeSubagentObservation: false,
  // NodeCommand carries text only, and this ACP client exposes no media or
  // structured-output request shape.
  imageInput: false,
  structuredOutput: false,
  // Dhole advertises neither ACP filesystem nor terminal client capability.
  repositoryEditing: false,
  terminalTools: false,
};

interface KimiSession { process: BoundedStdioProcess; demux: JsonRpcDemux; nextId: number; loadSession: boolean; }

function supportsSessionLoad(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const capabilities = [result.agentCapabilities, result.capabilities].find((candidate) => candidate && typeof candidate === 'object') as Record<string, unknown> | undefined;
  if (!capabilities) return false;
  if (capabilities.loadSession === true || capabilities.sessionLoad === true) return true;
  const session = capabilities.sessionCapabilities;
  return Boolean(session && typeof session === 'object' && (session as Record<string, unknown>).load === true);
}

/** Kimi Code ACP v1 adapter over newline-delimited JSON-RPC. */
export class KimiCodeRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'kimi-code' as const;
  readonly label = 'Kimi Code (ACP)';
  readonly protocolVersion = 'acp.v1';
  readonly capabilities = { ...defaultCapabilities };
  readonly availability;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly clientVersion: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly fixture: boolean;
  private readonly sessions = new Map<string, KimiSession>();

  constructor(options: RuntimeAdapterOptions = {}) {
    this.executable = options.executable ?? 'kimi';
    this.args = options.args ?? ['acp'];
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

  descriptor(id = 'runtime-kimi-code'): ReturnType<typeof descriptorFor> { return descriptorFor(this, id); }

  private async session(id: string, context: RuntimeExecutionContext): Promise<KimiSession> {
    const existing = this.sessions.get(id);
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
    const value = { process, demux: new JsonRpcDemux(process), nextId: 1, loadSession: false };
    this.sessions.set(id, value);
    try {
      const initialized = await this.request(value, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
        },
        clientInfo: { name: 'dhole-node', title: 'Dhole Node', version: this.clientVersion },
      }, context);
      value.loadSession = supportsSessionLoad(initialized.result);
      this.capabilities.sessionResume = value.loadSession;
      this.capabilities.historyReplay = value.loadSession;
      return value;
    } catch (error) {
      this.sessions.delete(id);
      await process.close().catch(() => undefined);
      throw error;
    }
  }

  private mapFrame(frame: Record<string, unknown>): RuntimeAdapterEvent {
    const method = typeof frame.method === 'string' ? frame.method : '';
    const params = frame.params && typeof frame.params === 'object' ? frame.params as Record<string, unknown> : {};
    if (method === 'session/update') {
      const update = params.update && typeof params.update === 'object' ? params.update as Record<string, unknown> : {};
      const updateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
      if (updateType === 'agent_message_chunk' || updateType === 'agent_message' || updateType === 'text') {
        return { type: 'message.delta', text: normalizeRuntimeText(update.content ?? update.text ?? update.delta), nativeMethod: method, nativeUpdate: updateType };
      }
      if (updateType === 'tool_call' || updateType === 'tool_call_update') {
        return { type: updateType === 'tool_call_update' ? 'tool.call.completed' : 'tool.call.started', ...update, nativeMethod: method, nativeUpdate: updateType };
      }
      return { type: 'runtime.raw', ...update, nativeMethod: method, nativeUpdate: updateType || undefined };
    }
    if (method.includes('permission') || method.includes('request_permission')) {
      const requestId = boundedRequestId(frame.id);
      return { type: 'approval.requested', ...params, nativeMethod: method, ...(requestId === undefined ? {} : { nativeRequestId: requestId }) };
    }
    if (method.includes('prompt') || method.includes('message') || method.includes('text')) return { type: 'message.delta', ...params, nativeMethod: method };
    if (method.includes('tool')) return { type: method.includes('complete') ? 'tool.call.completed' : 'tool.call.started', ...params, nativeMethod: method };
    if (method.includes('session')) return { type: method.includes('resume') || method.includes('load') ? 'session.resumed' : 'session.updated', ...params, nativeMethod: method };
    return { type: 'runtime.raw', ...(method ? { nativeMethod: method } : {}), raw: frame };
  }

  private async request(session: KimiSession, method: string, params: unknown, context: RuntimeExecutionContext, onNotification?: (event: RuntimeAdapterEvent) => void): Promise<{ result: unknown; notifications: RuntimeAdapterEvent[] }> {
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

  private evictSession(session: KimiSession): void {
    for (const [key, candidate] of this.sessions) if (candidate === session) this.sessions.delete(key);
    session.demux.stop();
    void session.process.close().catch(() => undefined);
  }

  async execute(command: NodeCommand, context: RuntimeExecutionContext = {}): Promise<RuntimeExecutionResult> {
    const events: RuntimeAdapterEvent[] = [];
    const emit = eventEmitter(context, events);
    try {
      switch (command.kind) {
        case 'create_runtime_session': {
          const session = await this.session(command.runtimeSessionKey, context);
          const response = await this.request(session, 'session/new', { mcpServers: [], cwd: resolve(context.cwd ?? process.cwd()) }, context, emit);
          const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
          const runtimeSessionId = String(result.sessionId ?? result.id ?? command.runtimeSessionKey);
          this.sessions.set(runtimeSessionId, session);
          emit({ type: 'session.created', runtimeSessionId });
          return { runtimeSessionId, events };
        }
        case 'resume_runtime_session': {
          const session = await this.session(command.runtimeSessionId, context);
          if (!session.loadSession) throw new Error('Kimi ACP agent does not advertise session/load support');
          const response = await this.request(session, 'session/load', { mcpServers: [], cwd: resolve(context.cwd ?? process.cwd()), sessionId: command.runtimeSessionId }, context, emit);
          emit({ type: 'session.resumed', runtimeSessionId: command.runtimeSessionId });
          return { runtimeSessionId: command.runtimeSessionId, result: response.result, events };
        }
        case 'send_message': {
          const session = await this.session(command.runtimeSessionId, context);
          const response = await this.request(session, 'session/prompt', { sessionId: command.runtimeSessionId, prompt: [{ type: 'text', text: command.message }] }, context, emit);
          const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
          const turnId = String(result.turnId ?? result.id ?? command.operationKey);
          const text = normalizeRuntimeText(response.result) || normalizeRuntimeText(response.notifications);
          emit({ type: 'turn.completed', runtimeSessionId: command.runtimeSessionId, turnId, text });
          return { runtimeSessionId: command.runtimeSessionId, turnId, text, result: response.result, events };
        }
        case 'steer': throw new Error('Kimi ACP does not support active turn steering; queue the next message instead');
        case 'cancel': {
          const session = await this.session(command.runtimeSessionId, context);
          // ACP defines session/cancel as a notification (no response id), so
          // write it directly and let the shared demux continue reading turns.
          session.process.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: command.runtimeSessionId } });
          emit({ type: 'turn.cancelled', runtimeSessionId: command.runtimeSessionId, ...(command.turnId ? { turnId: command.turnId } : {}) });
          return { runtimeSessionId: command.runtimeSessionId, events };
        }
        case 'answer_approval': throw new Error('Kimi ACP permission responses are not supported by this adapter');
        default: return { events };
      }
    } catch (error) {
      throw normalizeRuntimeError(error, 'Kimi ACP operation failed');
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
