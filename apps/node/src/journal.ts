import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type JournalState = 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain';

export interface JournalOperation {
  operationKey: string;
  commandId: string;
  state: JournalState;
  updatedAt: string;
  result?: Record<string, unknown>;
  error?: string;
}

interface JournalDocument {
  version: 1;
  operations: Record<string, JournalOperation>;
}

export interface JournalClock {
  now(): Date;
}

const systemJournalClock: JournalClock = { now: () => new Date() };
const MAX_TERMINAL_OPERATIONS = 1_000;

/**
 * Crash-safe, bounded operation journal. Every transition is written and fsynced
 * before the caller is expected to perform an external side effect.
 */
export class OperationJournal {
  readonly path: string;
  readonly #clock: JournalClock;
  #document: JournalDocument;

  constructor(path: string, clock: JournalClock = systemJournalClock) {
    this.path = path;
    this.#clock = clock;
    const { document, recovered } = this.readDocument(path);
    this.#document = document;
    // A daemon restart severs the link between a journal entry and its
    // external side effect.  Never present an accepted/running command as
    // safely replayable when its payload is not durable in this journal.
    if (recovered) this.persist();
  }

  private readDocument(path: string): { document: JournalDocument; recovered: boolean } {
    if (!existsSync(path)) return { document: { version: 1, operations: {} }, recovered: false };
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch (error) { throw new Error(`Unable to read operation journal: ${String(error)}`); }
    if (!value || typeof value !== 'object') throw new Error('Operation journal is invalid');
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !record.operations || typeof record.operations !== 'object') throw new Error('Unsupported operation journal format');
    let recovered = false;
    const operations: Record<string, JournalOperation> = {};
    for (const [operationKey, rawOperation] of Object.entries(record.operations as Record<string, JournalOperation>)) {
      const operation = { ...rawOperation };
      if (operation.state === 'accepted' || operation.state === 'running') {
        operation.state = 'uncertain';
        operation.error = 'Operation outcome is uncertain after node restart';
        operation.updatedAt = this.#clock.now().toISOString();
        recovered = true;
      }
      operations[operationKey] = operation;
    }
    return { document: { version: 1, operations }, recovered };
  }

  get size(): number { return Object.keys(this.#document.operations).length; }

  get(operationKey: string): JournalOperation | undefined {
    const operation = this.#document.operations[operationKey];
    return operation ? { ...operation } : undefined;
  }

  list(): JournalOperation[] {
    return Object.values(this.#document.operations).map((operation) => ({ ...operation }));
  }

  /** Record accepted before any side effect. Duplicate keys return the original operation. */
  accept(operationKey: string, commandId: string, updatedAt = this.#clock.now().toISOString()): JournalOperation {
    const existing = this.#document.operations[operationKey];
    if (existing) return { ...existing };
    const operation: JournalOperation = { operationKey, commandId, state: 'accepted', updatedAt };
    this.#document.operations[operationKey] = operation;
    this.persist();
    return { ...operation };
  }

  accepted(operationKey: string, commandId: string, updatedAt?: string): JournalOperation {
    return this.accept(operationKey, commandId, updatedAt);
  }

  transition(operationKey: string, state: JournalState, detail: { result?: Record<string, unknown>; error?: string; updatedAt?: string } = {}): JournalOperation {
    const existing = this.#document.operations[operationKey];
    if (!existing) throw new Error(`Unknown operation ${operationKey}`);
    const operation: JournalOperation = {
      ...existing,
      state,
      updatedAt: detail.updatedAt ?? this.#clock.now().toISOString(),
      ...(detail.result === undefined ? {} : { result: detail.result }),
      ...(detail.error === undefined ? {} : { error: detail.error }),
    };
    this.#document.operations[operationKey] = operation;
    this.persist();
    if (state === 'completed' || state === 'failed') this.pruneTerminalOperations();
    return { ...operation };
  }

  markRunning(operationKey: string, updatedAt?: string): JournalOperation { return this.transition(operationKey, 'running', updatedAt ? { updatedAt } : {}); }
  running(operationKey: string, updatedAt?: string): JournalOperation { return this.markRunning(operationKey, updatedAt); }
  complete(operationKey: string, result: Record<string, unknown> = {}, updatedAt?: string): JournalOperation { return this.transition(operationKey, 'completed', { result, ...(updatedAt ? { updatedAt } : {}) }); }
  completed(operationKey: string, result: Record<string, unknown> = {}, updatedAt?: string): JournalOperation { return this.complete(operationKey, result, updatedAt); }
  fail(operationKey: string, error: string, updatedAt?: string): JournalOperation { return this.transition(operationKey, 'failed', { error: error.slice(0, 2_000), ...(updatedAt ? { updatedAt } : {}) }); }
  failed(operationKey: string, error: string, updatedAt?: string): JournalOperation { return this.fail(operationKey, error, updatedAt); }
  uncertain(operationKey: string, error?: string, updatedAt?: string): JournalOperation { return this.transition(operationKey, 'uncertain', { ...(error ? { error: error.slice(0, 2_000) } : {}), ...(updatedAt ? { updatedAt } : {}) }); }
  markUncertain(operationKey: string, error?: string, updatedAt?: string): JournalOperation { return this.uncertain(operationKey, error, updatedAt); }

  /** Return the compact state sent during node reconnect authentication. */
  summarize(max = 10_000): Array<Pick<JournalOperation, 'operationKey' | 'state' | 'updatedAt'>> {
    return this.list().slice(-max).map(({ operationKey, state, updatedAt }) => ({ operationKey, state, updatedAt }));
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.#document), undefined, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    try {
      const directoryFd = openSync(dirname(this.path), 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { /* unsupported directory fsync */ }
    chmodSync(this.path, 0o600);
  }

  private pruneTerminalOperations(): void {
    const terminal = Object.entries(this.#document.operations)
      .filter(([, operation]) => operation.state === 'completed' || operation.state === 'failed');
    if (terminal.length <= MAX_TERMINAL_OPERATIONS) return;
    for (const [operationKey] of terminal.slice(0, terminal.length - MAX_TERMINAL_OPERATIONS)) delete this.#document.operations[operationKey];
    this.persist();
  }
}

export const Journal = OperationJournal;
