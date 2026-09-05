import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge, localWorktreeHash, repositoryBinding, serveStdio } from './bridge.js';
import { writePrivateJson } from './config.js';

const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'dhole-bridge-test-')); directories.push(value); return value; };
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const globalToken = 'fixture-global-agent-token';
const scopedToken = 'fixture-project-scoped-token';
const capability = 'fixture-session-capability';
function fixture() {
  const stateDir = directory();
  writePrivateJson(join(stateDir, 'agent.json'), { serverUrl: 'http://localhost:4173', token: globalToken, id: 'device-1', permissions: ['project:read', 'coordination:write'], expiresAt: '2099-01-01T00:00:00.000Z' });
  const events: Array<{ path: string; method: string; body: Record<string, unknown>; authorization: string | null; capability: string | null }> = [];
  let projectCalls = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    events.push({ path, method: init?.method ?? 'POST', body, authorization: headers.get('Authorization'), capability: headers.get('x-mediation-session') });
    if (path === '/mcp') {
      expect(headers.get('Origin')).toBe('http://localhost:4173');
      expect(headers.get('MCP-Protocol-Version')).toBe('2026-07-28');
    } else {
      expect(headers.get('Origin')).toBeNull();
      expect(headers.get('MCP-Protocol-Version')).toBeNull();
    }
    if (path === '/api/auth/device/project') {
      projectCalls++;
      return json({ token: scopedToken, id: `scoped-${projectCalls}`, permissions: ['project:read', 'coordination:write'], expiresAt: new Date(Date.now() + 300_000).toISOString(), projectId: 'project-1', repositoryId: 'repo-1' });
    }
    if (path.endsWith('/sessions')) return json({ id: 'session-1', capability });
    if (path === '/mcp' && body.method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'coordination_claim', inputSchema: { type: 'object', properties: { intent: { type: 'string' }, coordinationSessionId: { type: 'string' } }, required: ['intent'] } },
      { name: 'coordination_state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'coordination_session_register', inputSchema: {} },
      { name: 'mediation_setup', inputSchema: {} },
    ] } });
    if (path === '/mcp') return json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `claimed ${capability} ${scopedToken} ${globalToken}` }], capability } });
    return json({ id: 'session-1' });
  });
  const bridge = new AgentBridge({ stateDir, cwd: stateDir, fetch: fetcher, binding: async () => ({ remote: 'https://github.com/fixture/repo.git', worktree: 'hashed-worktree' }) });
  return { bridge, fetcher, events, stateDir };
}

describe('automatic agent bridge', () => {
  it('handles session authorization outside the model and cleans up on exit', async () => {
    const { bridge, events } = fixture();
    const initial = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(initial).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect(events).toHaveLength(0);
    const listed = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listing = JSON.stringify(listed);
    expect(listing).toContain('coordination_claim');
    expect(listing).not.toContain('coordination_session_register');
    expect(listing).not.toContain('coordinationSessionId');
    expect(listing).not.toContain('mediation_setup');
    const response = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'fixture work' } } });
    for (const secret of [globalToken, scopedToken, capability]) expect(JSON.stringify(response)).not.toContain(secret);
    const request = events.findLast((event) => event.path === '/mcp');
    expect(request?.authorization).toBe(`Bearer ${scopedToken}`);
    expect(request?.capability).toBe(capability);
    expect(request?.body.params).toEqual({ name: 'coordination_claim', arguments: { intent: 'fixture work', coordinationSessionId: 'session-1' } });
    await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'coordination_state', arguments: {} } });
    expect(events.findLast((event) => event.path === '/mcp')?.body.params).toEqual({ name: 'coordination_state', arguments: {} });
    await bridge.heartbeat();
    await bridge.close();
    await bridge.close();
    expect(events.filter((event) => event.method === 'DELETE')).toHaveLength(1);
    expect(events.filter((event) => event.path.endsWith('/heartbeat'))).toHaveLength(1);
    expect(events.filter((event) => event.path === '/api/auth/device/project')).toHaveLength(1);
  });

  it('keeps a stable private local worktree identity in manual mode across restart', async () => {
    const fixtureState = fixture();
    await fixtureState.bridge.close();
    const options = { stateDir: fixtureState.stateDir, cwd: fixtureState.stateDir, fetch: fixtureState.fetcher, projectId: 'project-1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const bridge = new AgentBridge(options);
      await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await bridge.close();
    }
    const expected = await localWorktreeHash(fixtureState.stateDir);
    const registrations = fixtureState.events.filter((event) => event.path.endsWith('/sessions'));
    expect(registrations).toHaveLength(2);
    expect(registrations.map((event) => event.body.worktree)).toEqual([expected, expected]);
    expect(JSON.stringify(registrations)).not.toContain(fixtureState.stateDir);
  });

  it.each([['gateway:read'], ['gateway:read', 'gateway:manage']])('exposes local Gateway actions with grant %j without a Coordination session', async (...permissions) => {
    const stateDir = directory();
    writePrivateJson(join(stateDir, 'agent.json'), { serverUrl: 'http://localhost:4173', token: globalToken, id: 'device-1', permissions, expiresAt: '2099-01-01T00:00:00.000Z' });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/auth/device/project') {
        const body = JSON.parse(String(init?.body)) as { permissions: string[] };
        return json({ token: scopedToken, id: 'scope-1', permissions: body.permissions, expiresAt: '2099-01-01T00:00:00.000Z', projectId: 'project-1' });
      }
      expect(path).toBe('/api/gateway/connections');
      return json([]);
    });
    const bridge = new AgentBridge({ stateDir, cwd: stateDir, projectId: 'project-1', fetch: fetcher });
    const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed).toMatchObject({ result: { tools: [{ name: 'gateway_manage', inputSchema: { type: 'object' } }] } });
    const result = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gateway_manage', arguments: { action: 'connections.list' } } });
    expect(result).toMatchObject({ result: { content: [{ type: 'text', text: '[]' }] } });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/sessions'))).toBe(false);
    if (!permissions.includes('gateway:manage')) {
      const count = fetcher.mock.calls.length;
      const denied = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gateway_manage', arguments: { action: 'health', connectionId: 'connection-1' } } });
      expect(denied).toMatchObject({ result: { isError: true } });
      expect(fetcher).toHaveBeenCalledTimes(count);
    }
    await bridge.close();
  });

  it('refreshes short project tokens and retires heartbeat timers', async () => {
    vi.useFakeTimers();
    const { bridge, events } = fixture();
    await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await vi.advanceTimersByTimeAsync(270_000);
    expect(events.filter((event) => event.path === '/api/auth/device/project')).toHaveLength(2);
    await bridge.close();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(count);
  });

  it('rejects model-supplied identity and keeps offline work fail-open', async () => {
    const { bridge, events } = fixture();
    await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const count = events.length;
    const denied = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'work', projectId: 'another-project' } } });
    expect(denied).toMatchObject({ result: { isError: true } });
    expect(events).toHaveLength(count);
    await bridge.close();
    const warning = vi.fn();
    const offline = new AgentBridge({ stateDir: join(directory(), 'not-connected'), cwd: directory(), warning });
    for (let id = 1; id < 3; id++) expect(await offline.handle({ jsonrpc: '2.0', id, method: 'tools/list' })).toMatchObject({ result: { tools: [] } });
    expect(warning).toHaveBeenCalledTimes(1);
    await offline.close();
  });

  it('serves newline JSON-RPC and closes its session at EOF', async () => {
    const { bridge, events } = fixture();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    const input = Readable.from(['{invalid}\n', JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n']);
    await serveStdio(bridge, input, output);
    const responses = text.trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ error: { code: -32700 } });
    expect(events.at(-1)?.method).toBe('DELETE');
  });

  it('uses the actual push URL, rejects credential-bearing URLs and ambiguous remotes', async () => {
    const root = directory();
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-b', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/upstream/repo.git');
    git('remote', 'set-url', '--push', 'origin', 'git@github.com:contributor/repo.git');
    expect((await repositoryBinding(root)).remote).toBe('git@github.com:contributor/repo.git');
    git('remote', 'set-url', '--push', 'origin', 'https://secret@github.com/contributor/repo.git');
    await expect(repositoryBinding(root)).rejects.toThrow('github_push_remote_required');
    git('remote', 'add', 'second', 'https://github.com/fixture/other');
    await expect(repositoryBinding(root)).rejects.toThrow('unambiguous_push_remote_required');
  });
});
