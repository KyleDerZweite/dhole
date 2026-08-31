import type { NodeCommand, RuntimeDescriptor } from '@dhole-control/shared';
import { ClaudeCodeRuntimeAdapter } from './claude.js';
import { CodexRuntimeAdapter } from './codex.js';
import { FakeRuntimeAdapter } from './fake.js';
import { KimiCodeRuntimeAdapter } from './kimi.js';
import { OpenAICompatibleRuntimeAdapter, type OpenAICompatibleOptions } from './openai.js';
import type { RuntimeAdapter, RuntimeAdapterOptions, RuntimeExecutionContext, RuntimeExecutionResult, RuntimeKind } from './types.js';

export * from './types.js';
export * from './protocol.js';
export * from './discovery.js';
export * from './fake.js';
export * from './codex.js';
export * from './claude.js';
export * from './kimi.js';
export * from './openai.js';

export interface RuntimeRegistryOptions {
  codex?: RuntimeAdapterOptions;
  'claude-code'?: RuntimeAdapterOptions;
  'kimi-code'?: RuntimeAdapterOptions;
  'openai-compatible'?: OpenAICompatibleOptions;
  includeFake?: boolean;
}

/** Compile-time registry; runtime plugin loading is intentionally unsupported. */
export class RuntimeRegistry extends Map<RuntimeKind, RuntimeAdapter> {
  async discover(): Promise<RuntimeDescriptor[]> {
    const descriptors: RuntimeDescriptor[] = [];
    for (const [kind, adapter] of this) {
      const discover = (adapter as RuntimeAdapter & { discover?: () => Promise<RuntimeDescriptor['availability']> }).discover;
      if (discover) await discover.call(adapter);
      descriptors.push(adapter.descriptor(`runtime-${kind}`));
    }
    return descriptors;
  }

  async execute(kind: RuntimeKind, command: NodeCommand, context?: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const adapter = this.get(kind);
    if (!adapter) throw new Error(`Unknown runtime kind ${kind}`);
    return adapter.execute(command, context);
  }

  async close(): Promise<void> {
    for (const adapter of this.values()) await adapter.close?.();
  }
}

export function createRuntimeRegistry(options: RuntimeRegistryOptions = {}): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  if (options.includeFake !== false) registry.set('fake', new FakeRuntimeAdapter());
  registry.set('codex', new CodexRuntimeAdapter(options.codex));
  registry.set('claude-code', new ClaudeCodeRuntimeAdapter(options['claude-code']));
  registry.set('kimi-code', new KimiCodeRuntimeAdapter(options['kimi-code']));
  registry.set('openai-compatible', new OpenAICompatibleRuntimeAdapter(options['openai-compatible']));
  return registry;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

export function runtimeRegistryOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeRegistryOptions {
  const codex = environmentValue(environment, 'DHOLE_CODEX_EXECUTABLE');
  const claude = environmentValue(environment, 'DHOLE_CLAUDE_EXECUTABLE');
  const kimi = environmentValue(environment, 'DHOLE_KIMI_EXECUTABLE');
  const baseUrl = environmentValue(environment, 'DHOLE_OPENAI_BASE_URL');
  const model = environmentValue(environment, 'DHOLE_OPENAI_MODEL');
  return {
    includeFake: ['1', 'true'].includes(environmentValue(environment, 'DHOLE_NODE_ENABLE_FAKE')?.toLowerCase() ?? ''),
    ...(codex ? { codex: { executable: codex } } : {}),
    ...(claude ? { 'claude-code': { executable: claude } } : {}),
    ...(kimi ? { 'kimi-code': { executable: kimi } } : {}),
    ...(baseUrl || model ? { 'openai-compatible': { ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) } } : {}),
  };
}

export const runtimeRegistry = createRuntimeRegistry(runtimeRegistryOptionsFromEnvironment());
