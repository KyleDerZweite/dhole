import type { NodeCommand, RuntimeCapabilities } from '@dhole-control/shared';
import { abortError, descriptorFor, eventEmitter, type RuntimeAdapter, type RuntimeAdapterEvent, type RuntimeAdapterOptions, type RuntimeExecutionContext, type RuntimeExecutionResult, throwIfAborted } from './types.js';

export interface OpenAICompatibleOptions extends RuntimeAdapterOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  allowedTools?: readonly string[];
  maxBodyBytes?: number;
}

interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: unknown[]; }

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 100_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key)/i.test(key)) output[key] = '[REDACTED]';
      else output[key] = redactValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

async function readBoundedResponse(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new Error('OpenAI response exceeds configured limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await (signal ? new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        const settle = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const onAbort = (): void => {
          void reader.cancel().catch(() => undefined);
          settle(() => reject(abortError(signal.reason)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then((result) => settle(() => resolve(result)), (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
        if (signal.aborted) onAbort();
      }) : reader.read());
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error('OpenAI response exceeds configured limit');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* pending read is being cancelled */ }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const capabilities: RuntimeCapabilities = {
  sessionCreation: true,
  sessionResume: false,
  nextTurnMessage: true,
  activeTurnSteering: false,
  cancellation: true,
  approvalResponses: false,
  historyReplay: false,
  structuredToolEvents: true,
  nativeSubagentObservation: false,
  // NodeCommand is text-only and this adapter does not send a response
  // schema/structured-output request.
  imageInput: false,
  structuredOutput: false,
  repositoryEditing: false,
  // allowedTools is an opt-in generic executor hook; no terminal tool is
  // implemented or advertised by the Dhole node path.
  terminalTools: false,
};

/** OpenAI-compatible Chat Completions adapter with bounded, allow-listed tool rounds. */
export class OpenAICompatibleRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'OpenAI-Compatible API';
  readonly protocolVersion = 'openai.chat-completions.v1';
  readonly capabilities = capabilities;
  readonly availability;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly maxBodyBytes: number;
  private readonly sessions = new Map<string, ChatMessage[]>();
  private readonly sessionControllers = new Map<string, AbortController>();

  constructor(options: OpenAICompatibleOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:4000/v1');
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
      throw new Error('OpenAI-compatible baseUrl must be an HTTP(S) URL without credentials');
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/, '');
    this.model = options.model ?? 'default';
    this.apiKey = options.apiKey;
    this.allowedTools = new Set(options.allowedTools ?? []);
    this.maxBodyBytes = options.maxBodyBytes ?? 1 * 1024 * 1024;
    this.availability = options.fixture
      ? { available: true, executable: 'http', version: options.version ?? 'fixture' }
      : options.baseUrl
        ? { available: true, executable: this.baseUrl }
        : { available: false, reason: 'Configure DHOLE_OPENAI_BASE_URL before use' };
  }

  descriptor(id = 'runtime-openai-compatible'): ReturnType<typeof descriptorFor> { return descriptorFor(this, id); }

  async discover(): Promise<ReturnType<typeof descriptorFor>['availability']> {
    return this.availability;
  }

  private endpoint(): string { return `${this.baseUrl}/chat/completions`; }

  private async complete(messages: ChatMessage[], context: RuntimeExecutionContext, tools: RuntimeAdapterEvent[]): Promise<{ message: Record<string, unknown>; rounds: number }> {
    const maxRounds = Math.max(1, Math.min(16, context.maxRounds ?? 4));
    const deadline = Date.now() + Math.max(500, context.timeoutMs ?? 60_000);
    const working = [...messages];
    for (let round = 0; round < maxRounds; round += 1) {
      throwIfAborted(context.signal);
      if (Date.now() >= deadline) throw new Error('OpenAI tool loop timed out');
      const payload: Record<string, unknown> = { model: this.model, messages: working, stream: false };
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) > this.maxBodyBytes) throw new Error('OpenAI request body exceeds configured limit');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('OpenAI request timed out')), Math.max(100, deadline - Date.now()));
      const onAbort = () => controller.abort(context.signal?.reason);
      context.signal?.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      try {
        response = await fetch(this.endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.apiKey || context.secret ? { authorization: `Bearer ${this.apiKey ?? context.secret}` } : {}) },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        throw new Error(`OpenAI request failed: ${error instanceof Error ? error.message.slice(0, 500) : 'network error'}`);
      }
      let text: string;
      try {
        text = await readBoundedResponse(response, this.maxBodyBytes, controller.signal);
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      }
      throwIfAborted(controller.signal);
      let decoded: unknown;
      try { decoded = JSON.parse(text) as unknown; } catch { decoded = undefined; }
      if (!response.ok) {
        const errorMessage = decoded && typeof decoded === 'object' && 'error' in decoded && typeof (decoded as { error?: unknown }).error === 'object'
          ? String(((decoded as { error: { message?: unknown } }).error).message ?? `HTTP ${response.status}`)
          : `HTTP ${response.status}`;
        throw new Error(`OpenAI API error: ${errorMessage.slice(0, 500)}`);
      }
      const choice = decoded && typeof decoded === 'object' && Array.isArray((decoded as { choices?: unknown }).choices)
        ? ((decoded as { choices: unknown[] }).choices[0] as { message?: unknown } | undefined)?.message
        : undefined;
      if (!choice || typeof choice !== 'object') throw new Error('OpenAI response did not contain a message');
      const message = choice as Record<string, unknown>;
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!toolCalls.length) return { message, rounds: round + 1 };
      working.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') throw new Error('Invalid tool call from OpenAI response');
        const fn = (call as { function?: unknown }).function;
        if (!fn || typeof fn !== 'object') throw new Error('Invalid tool function from OpenAI response');
        const name = String((fn as { name?: unknown }).name ?? '');
        if (!name || !this.allowedTools.has(name)) throw new Error(`Tool ${name || '(unnamed)'} is not allowed`);
        let input: unknown = {};
        const rawArgs = (fn as { arguments?: unknown }).arguments;
        if (typeof rawArgs === 'string') {
          try { input = JSON.parse(rawArgs) as unknown; } catch { throw new Error(`Tool ${name} arguments are not valid JSON`); }
        } else if (rawArgs !== undefined) input = rawArgs;
        const started = { type: 'tool.call.started', name, input: redactValue(input) };
        tools.push(started);
        context.emit?.(started);
        const output = context.executeTool ? await context.executeTool(name, input, context.signal) : (() => { throw new Error(`No executor configured for tool ${name}`); })();
        const callId = String((call as { id?: unknown }).id ?? `${name}-${round}`);
        working.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(output).slice(0, 100_000) });
        const completed = { type: 'tool.call.completed', name, output: redactValue(output) };
        tools.push(completed);
        context.emit?.(completed);
      }
    }
    throw new Error('OpenAI tool loop exceeded maximum rounds');
  }

  async execute(command: NodeCommand, context: RuntimeExecutionContext = {}): Promise<RuntimeExecutionResult> {
    const events: RuntimeAdapterEvent[] = [];
    const emit = eventEmitter(context, events);
    switch (command.kind) {
      case 'create_runtime_session': {
        const id = `openai-${command.runtimeSessionKey}`;
        this.sessions.set(id, []);
        emit({ type: 'session.created', runtimeSessionId: id });
        return { runtimeSessionId: id, events };
      }
      case 'resume_runtime_session':
        throw new Error('OpenAI-compatible runtime does not support durable session resume');
      case 'send_message': {
        const messages = this.sessions.get(command.runtimeSessionId) ?? [];
        messages.push({ role: 'user', content: command.message });
        const controller = new AbortController();
        const onAbort = (): void => controller.abort(context.signal?.reason);
        if (context.signal?.aborted) onAbort();
        else context.signal?.addEventListener('abort', onAbort, { once: true });
        this.sessionControllers.set(command.runtimeSessionId, controller);
        try {
          const result = await this.complete(messages, { ...context, signal: controller.signal }, events);
          const content = typeof result.message.content === 'string' ? result.message.content : '';
          messages.push({ role: 'assistant', content });
          this.sessions.set(command.runtimeSessionId, messages);
          emit({ type: 'message.completed', runtimeSessionId: command.runtimeSessionId, turnId: command.operationKey, text: content });
          return { runtimeSessionId: command.runtimeSessionId, turnId: command.operationKey, text: content, events };
        } finally {
          context.signal?.removeEventListener('abort', onAbort);
          if (this.sessionControllers.get(command.runtimeSessionId) === controller) this.sessionControllers.delete(command.runtimeSessionId);
        }
      }
      case 'steer': throw new Error('OpenAI-compatible runtime does not support active turn steering');
      case 'answer_approval': throw new Error('OpenAI-compatible runtime does not support approval responses');
      case 'cancel': {
        this.sessionControllers.get(command.runtimeSessionId)?.abort(new Error('Runtime turn cancelled'));
        emit({ type: 'turn.cancelled', runtimeSessionId: command.runtimeSessionId, ...(command.turnId ? { turnId: command.turnId } : {}) });
        return { runtimeSessionId: command.runtimeSessionId, events };
      }
      default: return { events };
    }
  }

  async close(): Promise<void> {
    for (const controller of this.sessionControllers.values()) controller.abort(new Error('Runtime adapter closed'));
    this.sessionControllers.clear();
    this.sessions.clear();
  }
}
