import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeDescriptor } from '@dhole-control/shared';
import type { RuntimeKind } from './types.js';
type RuntimeAvailability = RuntimeDescriptor['availability'];

const execFileAsync = promisify(execFile);

/** Discover an executable without invoking a shell or accepting shell syntax. */
export async function discoverExecutable(
  candidates: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RuntimeAvailability> {
  for (const candidate of candidates) {
    if (!candidate || /[;&|`$<>\n\r]/.test(candidate)) continue;
    try {
      const result = await execFileAsync(candidate, ['--version'], {
        env: options.env,
        timeout: options.timeoutMs ?? 2_000,
        windowsHide: true,
        maxBuffer: 32 * 1024,
      });
      const version = `${result.stdout ?? ''}`.trim().split(/\r?\n/, 1)[0]?.slice(0, 120);
      return { available: true, executable: candidate, ...(version ? { version } : {}) };
    } catch {
      // Missing binaries and failed version probes are intentionally indistinguishable.
    }
  }
  return { available: false, reason: 'Runtime executable is unavailable' };
}

export interface RuntimeExecutableMap {
  codex?: string;
  'claude-code'?: string;
  'kimi-code'?: string;
}

export function executableCandidates(kind: RuntimeKind, paths: RuntimeExecutableMap = {}): string[] {
  const explicit = paths[kind as keyof RuntimeExecutableMap];
  if (explicit) return [explicit];
  switch (kind) {
    case 'codex': return ['codex'];
    case 'claude-code': return ['claude'];
    case 'kimi-code': return ['kimi'];
    default: return [];
  }
}
