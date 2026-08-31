import type { NodeCommand, RuntimeCapabilities, RuntimeDescriptor } from '@dhole-control/shared';
export type RuntimeKind = RuntimeDescriptor['kind'];

/** A bounded event emitted by an adapter while executing a node command. */
export interface RuntimeAdapterEvent {
  type: string;
  [key: string]: unknown;
}

export interface RuntimeExecutionContext {
  /** The workspace cwd is already canonicalized by the node command dispatcher. */
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Secret material is injected by the dispatcher and is never serialized into a command. */
  secret?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Runtime events are normalized by the caller and persisted by the node journal. */
  emit?: ((event: RuntimeAdapterEvent) => void) | undefined;
  /** Optional controlled tool executor for API runtimes. */
  executeTool?: ((name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
  /** Maximum wall-clock duration for a single operation. */
  timeoutMs?: number | undefined;
  /** Maximum model/tool rounds for an API runtime. */
  maxRounds?: number | undefined;
}

export interface RuntimeExecutionResult {
  runtimeSessionId?: string;
  turnId?: string;
  text?: string;
  events?: RuntimeAdapterEvent[];
  [key: string]: unknown;
}

export interface RuntimeAdapterOptions {
  executable?: string;
  /** Optional argv override used by deterministic protocol fixtures. */
  args?: readonly string[];
  version?: string;
  env?: NodeJS.ProcessEnv;
  fixture?: boolean;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly label: string;
  readonly protocolVersion: string;
  readonly capabilities: RuntimeCapabilities;
  readonly availability: RuntimeDescriptor['availability'];
  descriptor(id?: string): RuntimeDescriptor;
  execute(command: NodeCommand, context?: RuntimeExecutionContext): Promise<RuntimeExecutionResult>;
  close?(): Promise<void>;
}

export interface RuntimeDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  paths?: Partial<Record<RuntimeKind, string>>;
}

export function eventEmitter(context: RuntimeExecutionContext | undefined, events: RuntimeAdapterEvent[]): (event: RuntimeAdapterEvent) => void {
  return (event) => {
    events.push(event);
    context?.emit?.(event);
  };
}

export function descriptorFor(
  adapter: Pick<RuntimeAdapter, 'kind' | 'label' | 'protocolVersion' | 'capabilities' | 'availability'>,
  id = `runtime-${adapter.kind}`,
): RuntimeDescriptor {
  return {
    id,
    kind: adapter.kind,
    label: adapter.label,
    protocolVersion: adapter.protocolVersion,
    capabilities: adapter.capabilities,
    availability: adapter.availability,
  };
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'Operation cancelled');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

/** Extract plain text from provider result/event shapes without serializing objects. */
export function normalizeRuntimeText(value: unknown): string {
  const seen = new Set<object>();
  const visit = (candidate: unknown): string => {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate)) return candidate.map(visit).join('');
    if (!candidate || typeof candidate !== 'object') return '';
    if (seen.has(candidate)) return '';
    seen.add(candidate);
    const object = candidate as Record<string, unknown>;
    for (const key of ['text', 'delta', 'content', 'output', 'message', 'result']) {
      if (key in object) {
        const text = visit(object[key]);
        if (text) return text;
      }
    }
    return '';
  };
  return visit(value);
}
