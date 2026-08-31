import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import { throwIfAborted } from './types.js';

export const DEFAULT_STDOUT_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_STDERR_LIMIT = 64 * 1024;

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  [key: string]: unknown;
}

/**
 * Newline-delimited process transport. It deliberately keeps framing separate
 * from protocol mapping so adapters can preserve unknown provider events.
 */
export class BoundedStdioProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: AsyncLineQueue;
  readonly stderrChunks: string[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private readonly stdoutLimit: number;
  private readonly stderrLimit: number;
  private readonly lineReader: Interface;

  constructor(
    executable: string,
    args: readonly string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdoutLimit?: number; stderrLimit?: number } = {},
  ) {
    this.stdoutLimit = options.stdoutLimit ?? DEFAULT_STDOUT_LIMIT;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
    this.child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.lines = new AsyncLineQueue();
    this.lineReader = createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => {
      this.stdoutBytes += Buffer.byteLength(line) + 1;
      if (this.stdoutBytes > this.stdoutLimit) {
        this.lines.fail(new Error('Runtime stdout exceeded limit'));
        this.kill();
        return;
      }
      this.lines.push(line);
    });
    this.lineReader.once('close', () => this.lines.end());
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      this.stderrBytes += Buffer.byteLength(text);
      if (this.stderrBytes <= this.stderrLimit) this.stderrChunks.push(text);
    });
    this.child.once('error', (error) => this.lines.fail(error));
    this.child.once('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') this.lines.fail(new Error(`Runtime exited with ${code ?? signal ?? 'unknown'}`));
      this.lines.end();
    });
    if (options.signal) {
      if (options.signal.aborted) this.kill();
      else options.signal.addEventListener('abort', () => this.kill(), { once: true });
    }
  }

  send(value: unknown): void {
    if (!this.child.stdin.writable) throw new Error('Runtime stdin is closed');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async next(signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    throwIfAborted(signal);
    const result = await this.lines.next(signal, timeoutMs);
    throwIfAborted(signal);
    if (result.done) throw new Error('Runtime process closed stdout');
    return result.value;
  }

  async nextJson(signal?: AbortSignal, timeoutMs?: number): Promise<JsonRpcMessage> {
    const line = await this.next(signal, timeoutMs);
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object') throw new Error('JSON-RPC frame must be an object');
      return value as JsonRpcMessage;
    } catch {
      throw new Error('Runtime emitted invalid JSON');
    }
  }

  kill(): void {
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  async close(): Promise<void> {
    this.lineReader.close();
    this.kill();
    if (this.child.exitCode === null) await once(this.child, 'exit').catch(() => undefined);
  }
}

interface QueueWaiter {
  resolve: (result: IteratorResult<string>) => void;
  reject: (error: Error) => void;
}

class AsyncLineQueue {
  private values: string[] = [];
  private waiters: QueueWaiter[] = [];
  private failure: Error | undefined;
  private closed = false;

  push(value: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.failure = error;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  next(signal?: AbortSignal, timeoutMs?: number): Promise<IteratorResult<string>> {
    if (this.failure) return Promise.reject(this.failure);
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const remove = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        remove();
        cleanup();
        callback();
      };
      const onAbort = (): void => settle(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation cancelled')));
      const waiter: QueueWaiter = {
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      };
      this.waiters.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => settle(() => reject(new Error('Runtime response timed out'))), Math.max(1, timeoutMs));
    });
  }
}

export function rpcError(frame: JsonRpcMessage): Error | undefined {
  if (!frame.error) return undefined;
  return new Error(frame.error.message ?? `Runtime JSON-RPC error ${frame.error.code ?? 'unknown'}`);
}

export function boundedRequestId(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value.slice(0, 256);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface PendingRpc {
  notifications: JsonRpcMessage[];
  onNotification?: (notification: JsonRpcMessage) => void;
  resolve: (value: { response: JsonRpcMessage; notifications: JsonRpcMessage[] }) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/** One reader per process; concurrent requests are demultiplexed by JSON-RPC id. */
export class JsonRpcDemux {
  private readonly pending = new Map<number | string, PendingRpc>();
  private closed = false;

  constructor(private readonly process: BoundedStdioProcess) {
    void this.readLoop();
  }

  request(
    id: number | string,
    frame: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
    onNotification?: (notification: JsonRpcMessage) => void,
  ): Promise<{ response: JsonRpcMessage; notifications: JsonRpcMessage[] }> {
    if (this.closed) return Promise.reject(new Error('Runtime process is closed'));
    if (this.pending.has(id)) return Promise.reject(new Error(`Duplicate JSON-RPC request id ${String(id)}`));
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = {
        notifications: [],
        resolve,
        reject,
        ...(onNotification ? { onNotification } : {}),
        ...(signal ? { signal } : {}),
      };
      const cleanup = (): void => {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.onAbort && signal) signal.removeEventListener('abort', pending.onAbort);
      };
      const remove = (): void => {
        this.pending.delete(id);
        cleanup();
      };
      pending.resolve = (value) => { remove(); resolve(value); };
      pending.reject = (error) => { remove(); reject(error); };
      pending.onAbort = (): void => pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation cancelled'));
      this.pending.set(id, pending);
      if (signal?.aborted) pending.onAbort();
      else signal?.addEventListener('abort', pending.onAbort, { once: true });
      if (!this.pending.has(id)) return;
      if (timeoutMs !== undefined) pending.timer = setTimeout(() => pending.reject(new Error('Runtime response timed out')), Math.max(1, timeoutMs));
      try {
        this.process.send(frame);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop(error = new Error('Runtime process closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const frame = await this.process.nextJson();
        if (typeof frame.method === 'string' && frame.method.length > 0 && frame.id !== undefined && frame.id !== null) {
          // JSON-RPC requests may carry an id; they are inbound server calls,
          // never responses, even when an outbound id collides.
          this.dispatchNotification(frame);
          continue;
        }
        if (frame.id !== undefined && frame.id !== null) {
          const pending = this.pending.get(frame.id);
          // Late responses to an aborted request are intentionally discarded.
          if (!pending) continue;
          const error = rpcError(frame);
          if (error) pending.reject(error);
          else pending.resolve({ response: frame, notifications: pending.notifications });
          continue;
        }
        this.dispatchNotification(frame);
      }
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatchNotification(frame: JsonRpcMessage): void {
    // ponytail: route notifications to the oldest active request; add
    // provider turn-id correlation if a runtime multiplexes turns.
    const pending = this.pending.values().next().value as PendingRpc | undefined;
    if (pending) {
      pending.notifications.push(frame);
      pending.onNotification?.(frame);
    }
  }
}

export async function readUntilResponse(
  process: BoundedStdioProcess,
  id: number | string,
  signal?: AbortSignal,
  timeoutMs?: number,
  onNotification?: (notification: JsonRpcMessage) => void,
): Promise<{ response: JsonRpcMessage; notifications: JsonRpcMessage[] }> {
  const notifications: JsonRpcMessage[] = [];
  const deadline = timeoutMs === undefined ? undefined : Date.now() + Math.max(1, timeoutMs);
  while (true) {
    const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    if (remaining === 0) throw new Error('Runtime response timed out');
    const frame = await process.nextJson(signal, remaining);
    if (frame.id === id) {
      const error = rpcError(frame);
      if (error) throw error;
      return { response: frame, notifications };
    }
    notifications.push(frame);
    onNotification?.(frame);
  }
}

export function normalizeRuntimeError(error: unknown, fallback = 'Runtime operation failed'): Error {
  if (error instanceof Error) {
    const message = error.message.slice(0, 2_000);
    return new Error(message || fallback);
  }
  return new Error(typeof error === 'string' ? error.slice(0, 2_000) : fallback);
}
