import { describe, expect, it } from 'vitest';
import { NodeCommandSchema, NodeRuntimeEventSchema, RelativePathSchema, RuntimeCapabilitiesSchema } from './index.js';

describe('locked contracts', () => {
  it('rejects an arbitrary node shell command', () => {
    expect(() => NodeCommandSchema.parse({ kind: 'shell', command: 'whoami' })).toThrow();
  });

  it('requires runtime steering to be an explicit capability', () => {
    expect(() => RuntimeCapabilitiesSchema.parse({ activeTurnSteering: false })).toThrow();
  });

  it('rejects POSIX and Windows repository path escapes', () => {
    for (const path of ['/tmp/escape', '../escape', '..\\escape', 'C:\\escape', '\\\\server\\share']) {
      expect(RelativePathSchema.safeParse(path).success).toBe(false);
    }
    expect(RelativePathSchema.parse('.dhole/worktrees/item')).toBe('.dhole/worktrees/item');
  });

  it('bounds and validates runtime event frames', () => {
    expect(NodeRuntimeEventSchema.safeParse({ type: 'runtime_event', protocol: 'dhole.node.v1', commandId: 'command-1', operationKey: 'operation-1', sequence: 1, eventId: 'command-1:1', eventKind: 'approval.requested', payload: { summary: 'Allow?' }, occurredAt: new Date().toISOString() }).success).toBe(true);
    expect(NodeRuntimeEventSchema.safeParse({ type: 'runtime_event', protocol: 'dhole.node.v1', commandId: 'command-1', operationKey: 'operation-1', sequence: 0, eventId: 'command-1:0', eventKind: 'approval.requested', occurredAt: new Date().toISOString() }).success).toBe(false);
  });
});
