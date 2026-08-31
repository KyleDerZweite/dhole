import type { NodeCommand, RuntimeCapabilities } from '@dhole-control/shared';
import { randomUUID } from 'node:crypto';
import { discoverExecutable } from './discovery.js';
import { BoundedStdioProcess, normalizeRuntimeError } from './protocol.js';
import { descriptorFor, eventEmitter, type RuntimeAdapter, type RuntimeAdapterEvent, type RuntimeAdapterOptions, type RuntimeExecutionContext, type RuntimeExecutionResult, throwIfAborted } from './types.js';

const capabilities: RuntimeCapabilities = {
  sessionCreation: true,
  sessionResume: true,
  nextTurnMessage: true,
  activeTurnSteering: false,
  cancellation: true,
  approvalResponses: false,
  historyReplay: true,
  structuredToolEvents: true,
  nativeSubagentObservation: false,
  // NodeCommand accepts only text prompts; this adapter does not send media
  // blocks or a structured-output request to Claude Code.
  imageInput: false,
  structuredOutput: false,
  repositoryEditing: true,
  terminalTools: true,
};

interface ClaudeSession {
  process: BoundedStdioProcess;
  sessionId: string;
}

/** Claude Code CLI stream-json adapter. Queue-next is supported; active steering is not. */
export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly protocolVersion = 'claude.stream-json.v1';
  readonly capabilities = capabilities;
  readonly availability;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly fixture: boolean;
  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(options: RuntimeAdapterOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.args = options.args ?? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
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

  descriptor(id = 'runtime-claude-code'): ReturnType<typeof descriptorFor> { return descriptorFor(this, id); }

  private spawnSession(sessionId: string, context: RuntimeExecutionContext, resume = false, create = false): ClaudeSession {
    throwIfAborted(context.signal);
    const args = [...this.args];
    if (create) args.push('--session-id', sessionId);
    else if (resume) args.push('--resume', sessionId);
    const process = new BoundedStdioProcess(this.executable, args, {
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(this.env || context.env ? { env: { ...this.env, ...context.env } } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      stdoutLimit: 2 * 1024 * 1024,
      stderrLimit: 64 * 1024,
    });
    const session = { process, sessionId };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async readEvents(session: ClaudeSession, context: RuntimeExecutionContext, onEvent?: (event: RuntimeAdapterEvent) => void): Promise<RuntimeAdapterEvent[]> {
    const events: RuntimeAdapterEvent[] = [];
    const deadline = Date.now() + Math.max(1_000, context.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const line = await session.process.next(context.signal, Math.max(1, deadline - Date.now()));
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch {
        const event = { type: 'runtime.raw', raw: line };
        events.push(event);
        onEvent?.(event);
        continue;
      }
      if (!value || typeof value !== 'object') {
        const event = { type: 'runtime.raw', raw: value };
        events.push(event);
        onEvent?.(event);
        continue;
      }
      const frame = value as Record<string, unknown>;
      const type = typeof frame.type === 'string' ? frame.type : '';
      const event: RuntimeAdapterEvent = { ...frame, type: this.mapType(type), nativeType: type };
      events.push(event);
      onEvent?.(event);
      if (type === 'result' || type === 'message_stop' || type === 'done' || frame.stop_reason) break;
    }
    return events;
  }

  private mapType(type: string): string {
    if (type === 'assistant' || type === 'content_block_delta' || type === 'message_delta') return 'message.delta';
    if (type === 'result' || type === 'message_stop') return 'message.completed';
    if (type.includes('tool')) return type.includes('result') || type.includes('stop') ? 'tool.call.completed' : 'tool.call.started';
    if (type.includes('permission') || type.includes('approval')) return 'approval.requested';
    return type ? `runtime.${type}` : 'runtime.raw';
  }

  private async send(session: ClaudeSession, message: string, context: RuntimeExecutionContext, onEvent?: (event: RuntimeAdapterEvent) => void): Promise<RuntimeAdapterEvent[]> {
    try {
      session.process.send({ type: 'user', message: { role: 'user', content: message } });
      return await this.readEvents(session, context, onEvent);
    } catch (error) {
      this.evictSession(session);
      throw error;
    }
  }

  private evictSession(session: ClaudeSession): void {
    for (const [id, candidate] of this.sessions) if (candidate === session) this.sessions.delete(id);
    void session.process.close().catch(() => undefined);
  }

  async execute(command: NodeCommand, context: RuntimeExecutionContext = {}): Promise<RuntimeExecutionResult> {
    const events: RuntimeAdapterEvent[] = [];
    const emit = eventEmitter(context, events);
    try {
      switch (command.kind) {
        case 'create_runtime_session': {
          const id = randomUUID();
          this.spawnSession(id, context, false, true);
          emit({ type: 'session.created', runtimeSessionId: id });
          return { runtimeSessionId: id, events };
        }
        case 'resume_runtime_session': {
          const existing = this.sessions.get(command.runtimeSessionId);
          if (!existing || existing.process.child.exitCode !== null) {
            if (existing) this.evictSession(existing);
            this.spawnSession(command.runtimeSessionId, context, true);
          }
          emit({ type: 'session.resumed', runtimeSessionId: command.runtimeSessionId });
          return { runtimeSessionId: command.runtimeSessionId, events };
        }
        case 'send_message': {
          const existing = this.sessions.get(command.runtimeSessionId);
          if (existing && existing.process.child.exitCode !== null) this.evictSession(existing);
          const session = this.sessions.get(command.runtimeSessionId) ?? this.spawnSession(command.runtimeSessionId, context, true);
          const received = await this.send(session, command.message, context, emit);
          const text = received.filter((event) => event.type === 'message.completed').map((event) => event.result ?? event.text ?? event.content).filter((value) => typeof value === 'string').join('');
          emit({ type: 'turn.completed', runtimeSessionId: command.runtimeSessionId, turnId: command.operationKey });
          return { runtimeSessionId: command.runtimeSessionId, turnId: command.operationKey, ...(text ? { text } : {}), events };
        }
        case 'steer':
          throw new Error('Claude Code does not support active turn steering; queue the next message instead');
        case 'cancel': {
          const session = this.sessions.get(command.runtimeSessionId);
          if (session) {
            this.evictSession(session);
            session.process.kill();
          }
          emit({ type: 'turn.cancelled', runtimeSessionId: command.runtimeSessionId, ...(command.turnId ? { turnId: command.turnId } : {}) });
          return { runtimeSessionId: command.runtimeSessionId, events };
        }
        case 'answer_approval': throw new Error('Claude Code approval responses are not supported by this adapter');
        default: return { events };
      }
    } catch (error) {
      throw normalizeRuntimeError(error, 'Claude Code operation failed');
    }
  }

  async close(): Promise<void> {
    for (const session of new Set(this.sessions.values())) await session.process.close().catch(() => undefined);
    this.sessions.clear();
  }
}
