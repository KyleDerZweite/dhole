import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeCommand } from '@dhole-control/shared';
import type WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadNodeConfig } from './config.js';
import { FakeNode, createFakeSocketPair } from './fake.js';
import { NodeClient, type NodeCommandExecutionContext } from './client.js';
import { OperationJournal } from './journal.js';

const directories: string[] = [];
const nodes: FakeNode[] = [];
const clients: NodeClient[] = [];
const priorFakeRuntime = process.env.DHOLE_NODE_ENABLE_FAKE;

beforeAll(() => { process.env.DHOLE_NODE_ENABLE_FAKE = 'true'; });
afterAll(() => {
  if (priorFakeRuntime === undefined) delete process.env.DHOLE_NODE_ENABLE_FAKE;
  else process.env.DHOLE_NODE_ENABLE_FAKE = priorFakeRuntime;
});

afterEach(() => {
  for (const node of nodes.splice(0)) node.stop();
  for (const client of clients.splice(0)) client.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function commandBase(id: string): Pick<NodeCommand, 'commandId' | 'operationKey' | 'issuedAt' | 'expiresAt'> {
  return {
    commandId: id,
    operationKey: `operation-${id}`,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function runCommand(socket: WebSocket, command: NodeCommand): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${command.commandId}`)), 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const value = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>;
      if (value.type !== 'command_status' || value.commandId !== command.commandId || !['completed', 'failed', 'uncertain'].includes(String(value.state))) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command }));
  });
}

function startNode(
  repositoryId: string,
  root: string,
  execute: (command: NodeCommand, context: NodeCommandExecutionContext) => Promise<Record<string, unknown>> | Record<string, unknown>,
  secrets: Record<string, string> = {},
): FakeNode {
  const state = mkdtempSync(join(tmpdir(), 'dhole-node-state-'));
  directories.push(state);
  const node = new FakeNode({
    config: loadNodeConfig({
      DHOLE_NODE_MACHINE_ID: 'machine-1',
      DHOLE_NODE_CREDENTIAL: 'credential-1',
      DHOLE_NODE_STATE_DIR: state,
      DHOLE_NODE_REPOSITORIES: JSON.stringify({ [repositoryId]: root }),
      DHOLE_NODE_SECRETS: JSON.stringify(secrets),
    }),
    executor: { execute, discoverRuntimes: () => [] },
  });
  nodes.push(node);
  node.start();
  return node;
}

describe('node repository command confinement', () => {
  it('emits bounded runtime events with deterministic IDs and redacts exact secrets', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const node = startNode('repository-1', repository, (command, context) => {
      context.emit?.({ type: 'approval.requested', runtimeSessionId: 'native-secret', summary: 'apiKey=fixture-secret' });
      return command.kind === 'create_runtime_session' ? { runtimeSessionId: 'native-secret' } : { runtimeSessionId: 'native-secret', text: 'done' };
    }, { 'provider-secret': 'fixture-secret' });
    const frames: Record<string, unknown>[] = [];
    node.serverSocket?.on('message', (data) => { const value = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>; if (value.type === 'runtime_event') frames.push(value); });
    const status = await runCommand(node.serverSocket!, { ...commandBase('event-create'), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'event-runtime-key', cwd: '.', secretReference: 'provider-secret' });
    expect(status.state).toBe('completed');
    expect(frames[0]?.eventId).toMatch(/^runtime-[0-9a-f]{64}:1$/u);
    expect(JSON.stringify(frames[0])).not.toContain('fixture-secret');
    const sharedPrefix = 'x'.repeat(140);
    const collisionA: NodeCommand = { ...commandBase(`${sharedPrefix}a`), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'event-runtime-collision-a', cwd: '.', secretReference: 'provider-secret' };
    const collisionB: NodeCommand = { ...commandBase(`${sharedPrefix}b`), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'event-runtime-collision-b', cwd: '.', secretReference: 'provider-secret' };
    await runCommand(node.serverSocket!, collisionA);
    await runCommand(node.serverSocket!, collisionB);
    const collisionIds = frames.slice(-2).map((frame) => String(frame.eventId));
    expect(collisionIds[0]).not.toBe(collisionIds[1]);
  });

  it('caps live runtime event sequences and marks an overflowing durable event uncertain', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const frames: Record<string, unknown>[] = [];
    const node = startNode('repository-1', repository, (_command, context) => {
      for (let index = 0; index < 10_000; index += 1) context.emit?.({ type: 'message.delta', text: 'delta' });
      context.emit?.({ type: 'approval.requested', summary: 'durable overflow' });
      return { runtimeSessionId: 'runtime-sequence-overflow' };
    });
    node.serverSocket?.on('message', (data) => {
      const value = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>;
      if (value.type === 'runtime_event') frames.push(value);
    });
    const command: NodeCommand = {
      ...commandBase('sequence-overflow-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-sequence-overflow',
      cwd: '.',
    };
    const status = await runCommand(node.serverSocket!, command);
    expect(status.state).toBe('uncertain');
    expect(status.error).toContain('durable runtime event cannot be represented safely');
    expect(frames).toHaveLength(10_000);
    expect(Math.max(...frames.map((frame) => Number(frame.sequence)))).toBe(10_000);
  });

  it('passes a canonical mapped cwd and reuses its runtime adapter for follow-ups', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    mkdirSync(join(repository, 'workspace'));
    const calls: Array<{ command: NodeCommand; context: NodeCommandExecutionContext }> = [];
    const node = startNode('repository-1', repository, (command, context) => {
      calls.push({ command, context });
      return command.kind === 'create_runtime_session'
        ? { runtimeSessionId: 'runtime-session-1' }
        : { runtimeSessionId: 'runtime-session-1', text: 'done' };
    }, { 'provider-secret-1': 'fixture-value' });
    const socket = node.serverSocket;
    expect(socket).toBeDefined();
    const create: NodeCommand = {
      ...commandBase('create-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-1',
      cwd: 'workspace',
      secretReference: 'provider-secret-1',
    };
    const followUp: NodeCommand = {
      ...commandBase('message-1'),
      kind: 'send_message',
      runtimeSessionId: 'runtime-session-1',
      message: 'finish the task',
    };
    expect((await runCommand(socket!, create)).state).toBe('completed');
    expect((await runCommand(socket!, followUp)).state).toBe('completed');
    expect(calls.map((call) => call.command.kind)).toEqual(['create_runtime_session', 'send_message']);
    expect(calls[0]?.context.cwd).toBe(realpathSync.native(join(repository, 'workspace')));
    expect(calls[1]?.context.cwd).toBe(calls[0]?.context.cwd);
    expect(calls.map((call) => call.context.secret)).toEqual(['fixture-value', 'fixture-value']);
  });

  it('uses the mapped worktree cwd when resuming a runtime session', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    mkdirSync(join(repository, 'workspace'));
    const contexts: NodeCommandExecutionContext[] = [];
    const node = startNode('repository-1', repository, (_command, context) => {
      contexts.push(context);
      return { runtimeSessionId: 'runtime-session-resume' };
    });
    await runCommand(node.serverSocket!, {
      ...commandBase('resume-create-1'), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'resume-session-key', cwd: 'workspace',
    });
    await runCommand(node.serverSocket!, {
      ...commandBase('resume-command-1'), kind: 'resume_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionId: 'runtime-session-resume',
    });
    expect(contexts[1]?.cwd).toBe(realpathSync.native(join(repository, 'workspace')));
  });

  it('fails closed when the repository ID is not configured', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    let executed = false;
    const node = startNode('repository-1', repository, () => {
      executed = true;
      return {};
    });
    const command: NodeCommand = {
      ...commandBase('missing-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-2',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-2',
      cwd: '.',
    };
    const status = await runCommand(node.serverSocket!, command);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('is not configured');
    expect(executed).toBe(false);
  });

  it('rejects a cwd symlink that escapes the configured repository root', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    const outside = mkdtempSync(join(tmpdir(), 'dhole-node-outside-'));
    directories.push(repository, outside);
    symlinkSync(outside, join(repository, 'escape'));
    let executed = false;
    const node = startNode('repository-1', repository, () => {
      executed = true;
      return {};
    });
    const command: NodeCommand = {
      ...commandBase('escape-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-3',
      cwd: 'escape',
    };
    const status = await runCommand(node.serverSocket!, command);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('escapes the configured root');
    expect(executed).toBe(false);
  });

  it('dispatches a mapped session through the built-in fake runtime adapter', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    const state = mkdtempSync(join(tmpdir(), 'dhole-node-state-'));
    directories.push(repository, state);
    const node = new FakeNode({
      config: loadNodeConfig({
        DHOLE_NODE_MACHINE_ID: 'machine-1',
        DHOLE_NODE_CREDENTIAL: 'credential-1',
        DHOLE_NODE_STATE_DIR: state,
        DHOLE_NODE_REPOSITORIES: JSON.stringify({ 'repository-1': repository }),
      }),
    });
    nodes.push(node);
    node.start();
    const create: NodeCommand = {
      ...commandBase('builtin-create-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'builtin-runtime-session-key-1',
      cwd: '.',
    };
    const createStatus = await runCommand(node.serverSocket!, create);
    expect(createStatus.state).toBe('completed');
    const runtimeSessionId = (createStatus.result as Record<string, unknown>).runtimeSessionId;
    expect(runtimeSessionId).toBe('fake-builtin-runtime-session-key-1');
    const followUp: NodeCommand = {
      ...commandBase('builtin-message-1'),
      kind: 'send_message',
      runtimeSessionId: String(runtimeSessionId),
      message: 'objective',
    };
    const followUpStatus = await runCommand(node.serverSocket!, followUp);
    expect(followUpStatus.state).toBe('completed');
    expect((followUpStatus.result as Record<string, unknown>).text).toBe('Fake response: objective');
  });

  it('allows a cancel command to interrupt an active mapped turn', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    let finishTurn: (() => void) | undefined;
    const node = startNode('repository-1', repository, async (command) => {
      if (command.kind === 'create_runtime_session') return { runtimeSessionId: 'runtime-session-cancel' };
      if (command.kind === 'send_message') {
        await new Promise<void>((resolve) => { finishTurn = resolve; });
        return { runtimeSessionId: command.runtimeSessionId, text: 'cancelled turn ended' };
      }
      if (command.kind === 'cancel') {
        finishTurn?.();
        return { runtimeSessionId: command.runtimeSessionId, cancelled: true };
      }
      return {};
    });
    const create: NodeCommand = {
      ...commandBase('cancel-create-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-cancel',
      cwd: '.',
    };
    await runCommand(node.serverSocket!, create);
    const turn: NodeCommand = {
      ...commandBase('cancel-message-1'),
      kind: 'send_message',
      runtimeSessionId: 'runtime-session-cancel',
      message: 'long turn',
    };
    const cancel: NodeCommand = {
      ...commandBase('cancel-command-1'),
      kind: 'cancel',
      runtimeSessionId: 'runtime-session-cancel',
    };
    const [turnStatus, cancelStatus] = await Promise.all([
      runCommand(node.serverSocket!, turn),
      runCommand(node.serverSocket!, cancel),
    ]);
    expect(turnStatus.state).toBe('completed');
    expect(cancelStatus.state).toBe('completed');
  });

  it('cancels the active turn and fences an already-queued follow-up', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    let finishActive: (() => void) | undefined;
    const calls: string[] = [];
    const node = startNode('repository-1', repository, async (command) => {
      calls.push(command.commandId);
      if (command.kind === 'create_runtime_session') return { runtimeSessionId: 'runtime-session-queued-cancel' };
      if (command.kind === 'send_message' && command.message === 'active') {
        await new Promise<void>((resolve) => { finishActive = resolve; });
        return { runtimeSessionId: command.runtimeSessionId, text: 'active done' };
      }
      if (command.kind === 'cancel') {
        finishActive?.();
        return { runtimeSessionId: command.runtimeSessionId, cancelled: true };
      }
      return {};
    });
    await runCommand(node.serverSocket!, {
      ...commandBase('queued-cancel-create'), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'queued-cancel-key', cwd: '.',
    });
    const active: NodeCommand = { ...commandBase('queued-cancel-active'), kind: 'send_message', runtimeSessionId: 'runtime-session-queued-cancel', message: 'active' };
    const queued: NodeCommand = { ...commandBase('queued-cancel-next'), kind: 'send_message', runtimeSessionId: 'runtime-session-queued-cancel', message: 'queued' };
    const cancel: NodeCommand = { ...commandBase('queued-cancel-command'), kind: 'cancel', runtimeSessionId: 'runtime-session-queued-cancel' };
    const [activeStatus, queuedStatus, cancelStatus] = await Promise.all([
      runCommand(node.serverSocket!, active),
      runCommand(node.serverSocket!, queued),
      runCommand(node.serverSocket!, cancel),
    ]);
    expect(activeStatus.state).toBe('completed');
    expect(queuedStatus.state).toBe('failed');
    expect(cancelStatus.state).toBe('completed');
    expect(calls.slice(-2)).toEqual([active.commandId, cancel.commandId]);
  });

  it('fails a queued session command instead of executing it after stop', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    let releaseActive: (() => void) | undefined;
    let activeStarted!: () => void;
    const activeReady = new Promise<void>((resolve) => { activeStarted = resolve; });
    const calls: string[] = [];
    const node = startNode('repository-1', repository, async (command) => {
      calls.push(command.commandId);
      if (command.kind === 'create_runtime_session') return { runtimeSessionId: 'runtime-session-stop' };
      if (command.kind === 'send_message' && command.message === 'active') {
        activeStarted();
        await new Promise<void>((resolve) => { releaseActive = resolve; });
        return { runtimeSessionId: command.runtimeSessionId, text: 'active done' };
      }
      return 'runtimeSessionId' in command ? { runtimeSessionId: command.runtimeSessionId } : {};
    });
    const socket = node.serverSocket!;
    await runCommand(socket, { ...commandBase('stop-create'), kind: 'create_runtime_session', repositoryId: 'repository-1', runtimeId: 'fake', runtimeSessionKey: 'stop-key', cwd: '.' });
    const active: NodeCommand = { ...commandBase('stop-active'), kind: 'send_message', runtimeSessionId: 'runtime-session-stop', message: 'active' };
    const queued: NodeCommand = { ...commandBase('stop-queued'), kind: 'send_message', runtimeSessionId: 'runtime-session-stop', message: 'queued' };
    socket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command: active }));
    await activeReady;
    socket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command: queued }));
    for (let attempt = 0; attempt < 100 && node.client.journal.get(queued.operationKey)?.state !== 'accepted'; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(node.client.journal.get(queued.operationKey)?.state).toBe('accepted');
    node.stop();
    releaseActive?.();
    for (let attempt = 0; attempt < 100 && node.client.journal.get(queued.operationKey)?.state !== 'failed'; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(node.client.journal.get(queued.operationKey)?.state).toBe('failed');
    expect(node.client.journal.get(queued.operationKey)?.error).toContain('stopped before execution');
    expect(calls).toEqual(['stop-create', 'stop-active']);
  });

  it('keeps a newer websocket when an older connection closes late', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const node = startNode('repository-1', repository, async () => ({}));
    const firstServer = node.serverSocket!;
    node.client.connect();
    const newerSocket = node.client.socket;
    expect(newerSocket).toBeDefined();
    firstServer.close();
    expect(node.client.socket).toBe(newerSocket);
    expect(node.client.connected).toBe(true);
  });

  it('automatically reconnects and reconciles a terminal journal operation', async () => {
    const state = mkdtempSync(join(tmpdir(), 'dhole-node-reconnect-state-'));
    directories.push(state);
    const operation = commandBase('reconnect-terminal-1');
    const journal = new OperationJournal(join(state, 'journal.json'));
    journal.accept(operation.operationKey, operation.commandId);
    journal.complete(operation.operationKey, { replayed: true });
    const sockets: Array<{ client: WebSocket; server: WebSocket }> = [];
    const hellos: Array<Record<string, unknown>> = [];
    const statuses: Array<Record<string, unknown>> = [];
    let secondHelloAt = 0;
    let closedAt = 0;
    const node = new NodeClient({
      config: loadNodeConfig({
        DHOLE_NODE_MACHINE_ID: 'machine-reconnect',
        DHOLE_NODE_CREDENTIAL: 'credential-reconnect',
        DHOLE_NODE_STATE_DIR: state,
        DHOLE_NODE_RECONNECT_MIN_MS: '100',
        DHOLE_NODE_RECONNECT_MAX_MS: '1000',
      }),
      journal,
      socketFactory: () => {
        const pair = createFakeSocketPair();
        const socketIndex = sockets.push(pair) - 1;
        pair.server.on('message', (data) => {
          const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>;
          if (message.type === 'hello') {
            hellos.push(message);
            if (socketIndex === 1) secondHelloAt = Date.now();
            pair.server.send(JSON.stringify({ type: 'welcome', protocol: 'dhole.node.v1', heartbeatIntervalMs: 2_000 }));
            if (socketIndex === 1) pair.server.send(JSON.stringify({ type: 'reconcile', protocol: 'dhole.node.v1', operationKeys: [operation.operationKey] }));
          } else if (message.type === 'command_status') statuses.push(message);
        });
        queueMicrotask(() => pair.client.emit('open'));
        return pair.client;
      },
    });
    clients.push(node);
    node.start();
    const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(message)), 2_000);
        const check = (): void => {
          if (predicate()) {
            clearTimeout(deadline);
            resolve();
          } else setTimeout(check, 5);
        };
        check();
      });
    };
    await waitFor(() => hellos.length === 1, 'Timed out waiting for initial hello');
    closedAt = Date.now();
    sockets[0]?.server.close();
    await waitFor(() => hellos.length >= 2, 'Timed out waiting for automatic reconnect');
    await waitFor(() => statuses.some((status) => status.commandId === operation.commandId), 'Timed out waiting for reconciled terminal status');
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(secondHelloAt - closedAt).toBeGreaterThanOrEqual(80);
    expect((hellos[1]?.journalOperations as Array<Record<string, unknown>>).some((item) => item.operationKey === operation.operationKey && item.state === 'completed')).toBe(true);
    expect(statuses.find((status) => status.commandId === operation.commandId)).toMatchObject({ state: 'completed', operationKey: operation.operationKey, result: { replayed: true } });
  });

  it('orders an immediate send behind runtime session creation without a global lock', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const calls: string[] = [];
    const node = startNode('repository-1', repository, async (command) => {
      calls.push(command.kind);
      if (command.kind === 'create_runtime_session') {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return { runtimeSessionId: 'runtime-session-created' };
      }
      if (command.kind === 'send_message') return { runtimeSessionId: command.runtimeSessionId, text: 'ordered' };
      return {};
    });
    const socket = node.serverSocket!;
    const create: NodeCommand = {
      ...commandBase('race-create-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-race',
      cwd: '.',
    };
    const send: NodeCommand = {
      ...commandBase('race-send-1'),
      kind: 'send_message',
      runtimeSessionId: 'runtime-session-created',
      message: 'immediate',
    };
    const completed = new Map<string, Record<string, unknown>>();
    const statuses = (data: WebSocket.RawData): void => {
      const value = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>;
      if (value.type === 'command_status' && value.state === 'completed') completed.set(String(value.commandId), value);
    };
    socket.on('message', statuses);
    socket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command: create }));
    socket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command: send }));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Timed out waiting for immediate runtime send')), 2_000);
      const check = (): void => {
        if (completed.has(create.commandId) && completed.has(send.commandId)) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(check, 5);
      };
      check();
    });
    socket.off('message', statuses);
    expect(calls).toEqual(['create_runtime_session', 'send_message']);
    expect((completed.get(send.commandId)?.result as Record<string, unknown>)?.text).toBe('ordered');
  });

  it('retains durable runtime events after a long transient event list', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const transient = Array.from({ length: 130 }, (_, index) => ({ type: 'message.delta', sequence: index + 1, text: `delta-${index}` }));
    const durable = [
      { type: 'approval.requested', eventKind: 'approval.requested', eventId: 'approval-fallback-1', sequence: 131, summary: 'approve' },
      { type: 'tool.call.started', eventKind: 'tool.call.started', eventId: 'tool-fallback-1', sequence: 132, name: 'fixture-tool' },
      { type: 'tool.call.completed', eventKind: 'tool.call.completed', eventId: 'tool-fallback-2', sequence: 133, name: 'fixture-tool' },
    ];
    const node = startNode('repository-1', repository, () => ({
      runtimeSessionId: 'runtime-event-retention',
      events: [...transient, ...durable],
    }));
    const command: NodeCommand = {
      ...commandBase('event-retention-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-event-retention',
      cwd: '.',
    };
    const status = await runCommand(node.serverSocket!, command);
    expect(status.state).toBe('completed');
    const events = (status.result as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(133);
    expect(events.slice(-3).map((event) => event.eventId)).toEqual(['approval-fallback-1', 'tool-fallback-1', 'tool-fallback-2']);
  });

  it('marks a command uncertain when oversized durable events cannot fit safely', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    directories.push(repository);
    const oversized = 'd'.repeat(70_000);
    const events = Array.from({ length: 16 }, (_, index) => {
      const eventKind = index % 2 === 0 ? 'approval.requested' : 'tool.call.completed';
      return { type: eventKind, eventKind, eventId: `durable-overflow-${index}`, sequence: index + 1, details: oversized };
    });
    const node = startNode('repository-1', repository, () => ({ runtimeSessionId: 'runtime-event-overflow', events }));
    const command: NodeCommand = {
      ...commandBase('event-overflow-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-event-overflow',
      cwd: '.',
    };
    const status = await runCommand(node.serverSocket!, command);
    expect(status.state).toBe('uncertain');
    expect(status.result).toBeUndefined();
    expect(status.error).toBe('Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely');
    expect(node.client.journal.get(command.operationKey)).toMatchObject({ state: 'uncertain', error: 'Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely' });
  });

  it('redacts provider-like secrets from persisted and wire results', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    const state = mkdtempSync(join(tmpdir(), 'dhole-node-state-'));
    directories.push(repository, state);
    const node = new FakeNode({
      config: loadNodeConfig({
        DHOLE_NODE_MACHINE_ID: 'machine-1',
        DHOLE_NODE_CREDENTIAL: 'credential-1',
        DHOLE_NODE_STATE_DIR: state,
        DHOLE_NODE_REPOSITORIES: JSON.stringify({ 'repository-1': repository }),
      }),
      executor: { execute: () => ({ runtimeSessionId: 'runtime-redacted', token: 'sk-1234567890abcdef', text: 'x'.repeat(4_000), nested: { authorization: 'Bearer super-secret' } }) },
    });
    nodes.push(node);
    node.start();
    const command: NodeCommand = {
      ...commandBase('redact-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-redact',
      cwd: '.',
    };
    const status = await runCommand(node.serverSocket!, command);
    const result = status.result as Record<string, unknown>;
    expect(result.token).toBe('[REDACTED]');
    expect(result.text).toHaveLength(4_000);
    expect((result.nested as Record<string, unknown>).authorization).toBe('[REDACTED]');
    expect(JSON.stringify(node.client.journal.get(command.operationKey))).not.toContain('sk-1234567890abcdef');
  });

  it('redacts the opaque command secret from benign result and event text', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dhole-node-repository-'));
    const opaqueSecret = 'opaque-node-secret-98765';
    directories.push(repository);
    const node = startNode('repository-1', repository, (command, context) => command.kind === 'create_runtime_session'
      ? {
        runtimeSessionId: 'runtime-opaque-secret',
        text: `model echoed ${context.secret}`,
        nested: { message: `nested ${context.secret} value` },
        events: [{ type: 'message.delta', text: context.secret }],
      }
      : {}, { 'provider-secret': opaqueSecret });
    const command: NodeCommand = {
      ...commandBase('opaque-secret-1'),
      kind: 'create_runtime_session',
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-opaque-secret',
      cwd: '.',
      secretReference: 'provider-secret',
    };
    const status = await runCommand(node.serverSocket!, command);
    const encoded = JSON.stringify(status);
    expect(encoded).not.toContain(opaqueSecret);
    expect(status.result).toMatchObject({
      text: 'model echoed [REDACTED]',
      nested: { message: 'nested [REDACTED] value' },
      events: [{ type: 'message.delta', text: '[REDACTED]' }],
    });
    expect(JSON.stringify(node.client.journal.get(command.operationKey))).not.toContain(opaqueSecret);
  });
});
