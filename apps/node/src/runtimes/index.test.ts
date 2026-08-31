import { describe, expect, it, vi } from 'vitest';
import type { NodeCommand } from '@dhole-control/shared';
import { FakeRuntimeAdapter, OpenAICompatibleRuntimeAdapter, RuntimeRegistry, createRuntimeRegistry, runtimeRegistryOptionsFromEnvironment } from './index.js';

const base = { commandId: 'command-1', operationKey: 'operation-123', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' } as const;

describe('runtime registry', () => {
  it('keeps compile-time adapters and deterministic fake behavior', async () => {
    const registry = createRuntimeRegistry();
    expect(registry).toBeInstanceOf(RuntimeRegistry);
    expect(registry.get('fake')).toBeInstanceOf(FakeRuntimeAdapter);
    const create = await registry.execute('fake', { ...base, kind: 'create_runtime_session', repositoryId: 'repo-1', runtimeId: 'runtime-1', runtimeSessionKey: 'operation-123', cwd: 'workspace' } as NodeCommand);
    expect(create.runtimeSessionId).toBe('fake-operation-123');
    const turn = await registry.execute('fake', { ...base, kind: 'send_message', runtimeSessionId: String(create.runtimeSessionId), message: 'hello' } as NodeCommand);
    expect(turn.text).toBe('Fake response: hello');
    expect(turn.events?.some((event) => event.type === 'message.completed')).toBe(true);
  });

  it('reports missing installed runtimes as unavailable without spawning a shell', async () => {
    const registry = createRuntimeRegistry({ codex: { executable: '/definitely/missing/codex' }, 'claude-code': { executable: '/definitely/missing/claude' }, 'kimi-code': { executable: '/definitely/missing/kimi' } });
    const descriptors = await registry.discover();
    expect(descriptors.find((descriptor) => descriptor.kind === 'codex')?.availability.available).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.kind === 'claude-code')?.availability.available).toBe(false);
    expect(descriptors.find((descriptor) => descriptor.kind === 'kimi-code')?.availability.available).toBe(false);
  });

  it('maps bounded node environment settings into the static registry', () => {
    expect(runtimeRegistryOptionsFromEnvironment({
      DHOLE_NODE_ENABLE_FAKE: 'true',
      DHOLE_CODEX_EXECUTABLE: '/opt/codex',
      DHOLE_CLAUDE_EXECUTABLE: '/opt/claude',
      DHOLE_KIMI_EXECUTABLE: '/opt/kimi',
      DHOLE_OPENAI_BASE_URL: 'https://gateway.example.test/v1',
      DHOLE_OPENAI_MODEL: 'fixture-model',
    })).toEqual({
      includeFake: true,
      codex: { executable: '/opt/codex' },
      'claude-code': { executable: '/opt/claude' },
      'kimi-code': { executable: '/opt/kimi' },
      'openai-compatible': { baseUrl: 'https://gateway.example.test/v1', model: 'fixture-model' },
    });
  });

  it('aborts an in-flight OpenAI request and rejects unsupported approvals', async () => {
    const adapter = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true });
    const create = await adapter.execute({ ...base, kind: 'create_runtime_session', repositoryId: 'repo-1', runtimeId: 'runtime-1', runtimeSessionKey: 'openai-session', cwd: '.' } as NodeCommand);
    const runtimeSessionId = String(create.runtimeSessionId);
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const send = adapter.execute({ ...base, commandId: 'command-send', operationKey: 'operation-send', kind: 'send_message', runtimeSessionId, message: 'wait' } as NodeCommand, { signal: controller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      controller.abort(new Error('cancelled'));
      await expect(send).rejects.toThrow();
      await expect(adapter.execute({ ...base, commandId: 'command-approval', operationKey: 'operation-approval', kind: 'answer_approval', runtimeSessionId, approvalId: 'approval-1', decision: 'deny' } as NodeCommand)).rejects.toThrow('does not support approval responses');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels chunked OpenAI responses that exceed the body limit', async () => {
    const adapter = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true, maxBodyBytes: 8 });
    const create = await adapter.execute({ ...base, commandId: 'command-large-create', operationKey: 'operation-large-create', kind: 'create_runtime_session', repositoryId: 'repo-1', runtimeId: 'runtime-1', runtimeSessionKey: 'large-session', cwd: '.' } as NodeCommand);
    const runtimeSessionId = String(create.runtimeSessionId);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345678'));
        controller.enqueue(new TextEncoder().encode('9')); // exceeds 8 bytes only after a second chunk
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    try {
      await expect(adapter.execute({ ...base, commandId: 'command-large-send', operationKey: 'operation-large-send', kind: 'send_message', runtimeSessionId, message: 'large' } as NodeCommand)).rejects.toThrow('exceeds configured limit');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts a stalled OpenAI response body', async () => {
    const adapter = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true });
    const create = await adapter.execute({ ...base, commandId: 'command-stall-create', operationKey: 'operation-stall-create', kind: 'create_runtime_session', repositoryId: 'repo-1', runtimeId: 'runtime-1', runtimeSessionKey: 'stall-session', cwd: '.' } as NodeCommand);
    const runtimeSessionId = String(create.runtimeSessionId);
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    try {
      const send = adapter.execute({ ...base, commandId: 'command-stall-send', operationKey: 'operation-stall-send', kind: 'send_message', runtimeSessionId, message: 'stall' } as NodeCommand, { signal: controller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      controller.abort(new Error('cancelled body'));
      await expect(send).rejects.toThrow('cancelled body');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
