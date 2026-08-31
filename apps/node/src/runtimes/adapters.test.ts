import { describe, expect, it, vi } from 'vitest';
import type { NodeCommand } from '@dhole-control/shared';
import { ClaudeCodeRuntimeAdapter } from './claude.js';
import { CodexRuntimeAdapter } from './codex.js';
import { FakeRuntimeAdapter } from './fake.js';
import { KimiCodeRuntimeAdapter } from './kimi.js';
import { OpenAICompatibleRuntimeAdapter } from './openai.js';

const base = { commandId: 'command-1', operationKey: 'operation-123', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' } as const;

const codexFixture = `
const readline = require('node:readline');
let initialized = false;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' && request.params.clientInfo.name === 'dhole-node' && request.params.clientInfo.title === 'Dhole Node' && request.params.clientInfo.version === '0.1.0') send({ jsonrpc: '2.0', id: request.id, result: {} });
  else if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid initialize' } });
  else if (request.method === 'initialized') initialized = true;
  else if (request.method === 'thread/start' && initialized) send({ jsonrpc: '2.0', id: request.id, result: { threadId: 'thread-1' } });
  else if (request.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: request.id, method: 'item/commandExecution/approval', params: { approvalId: 'approval-1', summary: 'fixture approval' } });
    send({ jsonrpc: '2.0', method: 'item/agent_message_delta', params: { delta: 'hello ' } });
    send({ jsonrpc: '2.0', method: 'item/agent_message_delta', params: { delta: 'world' } });
    send({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-1' } } });
  } else if (request.method === 'turn/steer' && request.params.expectedTurnId === 'turn-1') {
    send({ jsonrpc: '2.0', method: 'item/agent_message_delta', params: { delta: 'steered' } });
    send({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'turn-1' } } });
  } else if (request.method === 'turn/interrupt' && request.params.turnId === 'turn-1') {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
  } else send({ jsonrpc: '2.0', id: request.id, result: {} });
});
`;

const kimiFixture = `
const readline = require('node:readline');
const expectedCwd = ${JSON.stringify(process.cwd())};
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' && request.params.protocolVersion === 1 && request.params.clientInfo.name === 'dhole-node' && request.params.clientInfo.title === 'Dhole Node' && request.params.clientInfo.version === '0.1.0' && request.params.clientCapabilities.fs.readTextFile === false && request.params.clientCapabilities.fs.writeTextFile === false && request.params.clientCapabilities.terminal === false) send({ jsonrpc: '2.0', id: request.id, result: { agentCapabilities: { loadSession: true } } });
  else if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid initialize' } });
  else if (request.method === 'session/new' && request.params.mcpServers && Array.isArray(request.params.mcpServers) && request.params.mcpServers.length === 0 && request.params.cwd === expectedCwd) send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'kimi-session' } });
  else if (request.method === 'session/load' && request.params.mcpServers && Array.isArray(request.params.mcpServers) && request.params.mcpServers.length === 0 && request.params.sessionId === 'kimi-session' && request.params.cwd === expectedCwd) send({ jsonrpc: '2.0', id: request.id, result: { loaded: true } });
  else if (request.method === 'session/prompt' && request.params.sessionId === 'kimi-session' && Array.isArray(request.params.prompt) && request.params.prompt[0].type === 'text' && request.params.prompt[0].text === 'hello') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kimi answer' } } } });
    send({ jsonrpc: '2.0', id: request.id, result: { turnId: 'kimi-turn' } });
  } else if (request.method === 'session/cancel') {}
  else send({ jsonrpc: '2.0', id: request.id, result: {} });
});
`;

const kimiNoLoadFixture = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { agentCapabilities: {} } }) + '\\n'); });
`;

const claudeFixture = `
const readline = require('node:readline');
const sessionArg = process.argv[process.argv.indexOf('--session-id') + 1] || '';
const resumeArg = process.argv[process.argv.indexOf('--resume') + 1] || '';
const hasNativeSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionArg);
const hasNativeResumeId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resumeArg);
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if ((hasNativeSessionId || hasNativeResumeId) && request.type === 'user' && request.message && request.message.role === 'user' && request.message.content === 'hello') {
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude answer' }] } });
    send({ type: 'result', result: 'claude answer' });
  }
});
`;

function command(command: NodeCommand['kind'], extra: Record<string, unknown>): NodeCommand {
  return { ...base, kind: command, ...extra } as NodeCommand;
}

describe('runtime capability declarations', () => {
  it('does not advertise unsupported live command shapes', () => {
    const codex = new CodexRuntimeAdapter({ fixture: true });
    const claude = new ClaudeCodeRuntimeAdapter({ fixture: true });
    const kimi = new KimiCodeRuntimeAdapter({ fixture: true });
    const openai = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true });
    const fake = new FakeRuntimeAdapter({ fixture: true });
    const textOnly = { imageInput: false, structuredOutput: false };

    expect(codex.capabilities).toMatchObject({ ...textOnly, nativeSubagentObservation: false, repositoryEditing: true, terminalTools: true });
    expect(claude.capabilities).toMatchObject({ ...textOnly, nativeSubagentObservation: false, repositoryEditing: true, terminalTools: true });
    expect(kimi.capabilities).toMatchObject({ ...textOnly, sessionResume: false, historyReplay: false, repositoryEditing: false, terminalTools: false });
    expect(openai.capabilities).toMatchObject({ ...textOnly, repositoryEditing: false, terminalTools: false });
    expect(fake.capabilities).toMatchObject({ imageInput: true, structuredOutput: true, repositoryEditing: true, terminalTools: true });
  });
});

describe('Codex and Kimi protocol adapters', () => {
  it('normalizes Codex send and steer text while preserving structured notifications', async () => {
    const adapter = new CodexRuntimeAdapter({ executable: process.execPath, args: ['-e', codexFixture, 'app-server'], fixture: true });
    const emitted: unknown[] = [];
    try {
      const created = await adapter.execute(command('create_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionKey: 'codex-key', cwd: 'workspace' }), { emit: (event) => emitted.push(event) });
      const runtimeSessionId = String(created.runtimeSessionId);
      const sent = await adapter.execute(command('send_message', { runtimeSessionId, message: 'hello' }), { emit: (event) => emitted.push(event) });
      expect(sent.text).toBe('hello world');
      expect(sent.events?.some((event) => event.type === 'message.delta')).toBe(true);
      expect(sent.events?.some((event) => event.type === 'approval.requested' && event.nativeRequestId === 3)).toBe(true);
      expect(emitted.some((event) => (event as { type?: string }).type === 'message.delta')).toBe(true);
      const steered = await adapter.execute(command('steer', { runtimeSessionId, turnId: 'turn-1', message: 'change' }), { emit: (event) => emitted.push(event) });
      expect(steered.text).toBe('steered');
      expect(steered.turnId).toBe('turn-1');
      expect(steered.events?.some((event) => event.type === 'message.delta')).toBe(true);
      const cancelled = await adapter.execute(command('cancel', { runtimeSessionId }));
      expect(cancelled.turnId).toBe('turn-1');
      expect(adapter.capabilities.approvalResponses).toBe(false);
      await expect(adapter.execute(command('answer_approval', { runtimeSessionId, approvalId: 'approval', decision: 'deny' }))).rejects.toThrow('approval responses are not supported');
    } finally {
      await adapter.close();
    }
  });

  it('uses ACP session/load with negotiated capability and returns Kimi text', async () => {
    const adapter = new KimiCodeRuntimeAdapter({ executable: process.execPath, args: ['-e', kimiFixture, 'acp'], fixture: true });
    try {
      const created = await adapter.execute(command('create_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionKey: 'kimi-key', cwd: '.' }), { cwd: '.' });
      expect(adapter.capabilities.sessionResume).toBe(true);
      const runtimeSessionId = String(created.runtimeSessionId);
      const sent = await adapter.execute(command('send_message', { runtimeSessionId, message: 'hello' }));
      expect(sent.text).toBe('kimi answer');
      expect(sent.events?.some((event) => event.type === 'message.delta')).toBe(true);
      const loaded = await adapter.execute(command('resume_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionId }), { cwd: '.' });
      expect(loaded.result).toEqual({ loaded: true });
      const cancelled = await adapter.execute(command('cancel', { runtimeSessionId }));
      expect(cancelled.events?.some((event) => event.type === 'turn.cancelled')).toBe(true);
      expect(adapter.capabilities.approvalResponses).toBe(false);
      await expect(adapter.execute(command('answer_approval', { runtimeSessionId, approvalId: 'approval', decision: 'deny' }))).rejects.toThrow('permission responses are not supported');
    } finally {
      await adapter.close();
    }
  });

  it('rejects Kimi resume when initialize does not advertise session/load', async () => {
    const adapter = new KimiCodeRuntimeAdapter({ executable: process.execPath, args: ['-e', kimiNoLoadFixture, 'acp'], fixture: true });
    try {
      await expect(adapter.execute(command('resume_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionId: 'missing-session' }))).rejects.toThrow('does not advertise session/load support');
      expect(adapter.capabilities.sessionResume).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});

describe('OpenAI-compatible capability truthfulness', () => {
  it('does not claim durable resume/history and rejects unknown sessions', async () => {
    const adapter = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true });
    expect(adapter.capabilities.sessionResume).toBe(false);
    expect(adapter.capabilities.historyReplay).toBe(false);
    await expect(adapter.execute(command('resume_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionId: 'unknown-session' }))).rejects.toThrow('does not support durable session resume');
  });

  it('clears in-memory transcripts when closed before reuse', async () => {
    const adapter = new OpenAICompatibleRuntimeAdapter({ baseUrl: 'http://127.0.0.1:4000/v1', fixture: true });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const created = await adapter.execute(command('create_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionKey: 'close-session', cwd: '.' }));
      const runtimeSessionId = String(created.runtimeSessionId);
      await adapter.execute(command('send_message', { runtimeSessionId, message: 'before close' }));
      await adapter.close();
      await adapter.execute(command('send_message', { runtimeSessionId, message: 'after close' }));
      const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages?: unknown[] };
      expect(secondBody.messages).toEqual([{ role: 'user', content: 'after close' }]);
    } finally {
      vi.unstubAllGlobals();
      await adapter.close();
    }
  });
});

describe('Claude Code stream-json adapter', () => {
  it('sends the structured user message shape and keeps approval unsupported', async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({ executable: process.execPath, args: ['-e', claudeFixture, '--'], fixture: true });
    try {
      const created = await adapter.execute(command('create_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionKey: 'claude-key', cwd: '.' }), { cwd: '.' });
      const runtimeSessionId = String(created.runtimeSessionId);
      expect(runtimeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      const sent = await adapter.execute(command('send_message', { runtimeSessionId, message: 'hello' }));
      expect(sent.text).toBe('claude answer');
      expect(adapter.capabilities.approvalResponses).toBe(false);
      await expect(adapter.execute(command('answer_approval', { runtimeSessionId, approvalId: 'approval', decision: 'deny' }))).rejects.toThrow('approval responses are not supported');
      await adapter.close();
      const resumed = new ClaudeCodeRuntimeAdapter({ executable: process.execPath, args: ['-e', claudeFixture, '--'], fixture: true });
      try {
        const resumedResult = await resumed.execute(command('resume_runtime_session', { repositoryId: 'repo', runtimeId: 'runtime', runtimeSessionId }), { cwd: '.' });
        expect(resumedResult.runtimeSessionId).toBe(runtimeSessionId);
        const resumedSent = await resumed.execute(command('send_message', { runtimeSessionId, message: 'hello' }));
        expect(resumedSent.text).toBe('claude answer');
      } finally {
        await resumed.close();
      }
    } finally {
      await adapter.close();
    }
  });
});
