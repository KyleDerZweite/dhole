import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMachine, createNativeProject, readAgentState, requestJson, serverOrigin } from './onboarding.js';
import { loadNodeConfig, writePrivateJson } from './config.js';
import { runCli } from './cli.js';
import { z } from 'zod';

const directories: string[] = [];
const stateDir = () => { const directory = mkdtempSync(join(tmpdir(), 'dhole-connect-test-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const token = { token: 'fixture-device-token-value', id: 'device-1', permissions: ['project:read', 'coordination:write', 'fleet:admin'], expiresAt: '2099-01-01T00:00:00.000Z' };
const start = { deviceCode: 'fixture-device-code-value', userCode: 'DEMO-1234', verificationUri: 'http://localhost:4173/connect', expiresIn: 30, interval: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('machine onboarding', () => {
  it('polls with backoff, persists private state, and keeps environment overrides', async () => {
    const directory = stateDir();
    const output: string[] = [];
    const waits: number[] = [];
    let polls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      expect(init?.redirect).toBe('error');
      if (path.endsWith('/status')) return json({ id: token.id, permissions: token.permissions, expiresAt: token.expiresAt, machineId: 'machine-1', machineStatus: 'enrolled' });
      if (path.endsWith('/start')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ permissions: expect.arrayContaining(['projects:create']) });
        return json(start);
      }
      if (path.endsWith('/poll')) {
        polls++;
        if (polls === 1) return json({ error: { code: 'authorization_pending' } }, 400);
        if (polls === 2) return json({ error: { code: 'slow_down' } }, 429);
        return json(token);
      }
      expect(path).toBe('/api/auth/device/enroll');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token.token}`);
      return json({ machineId: 'machine-1', credential: 'fixture-node-credential-value' });
    });
    await connectMachine({ server: 'http://localhost:4173', stateDir: directory, repositories: { repo: directory } }, { fetch: fetcher, sleep: async (ms) => { waits.push(ms); }, output: (line) => output.push(line) });
    expect(waits).toEqual([1000, 1000, 6000]);
    expect(readAgentState(directory).token).toBe(token.token);
    expect(readFileSync(join(directory, 'credential.json'), 'utf8')).toContain('machine-1');
    for (const name of ['agent.json', 'credential.json', 'connection.json']) expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(output.join('\n')).not.toContain(token.token);
    expect(output.join('\n')).not.toContain(start.deviceCode);
    const config = loadNodeConfig({ DHOLE_NODE_STATE_DIR: directory });
    expect(config.serverUrl.href).toBe('ws://localhost:4173/ws/node');
    expect(config.repositories.get('repo')).toBe(directory);
    expect(loadNodeConfig({ DHOLE_NODE_STATE_DIR: directory, DHOLE_NODE_SERVER_URL: 'wss://other.example/ws/node', DHOLE_NODE_REPOSITORIES: '{}' }).repositories.size).toBe(0);
    const requests = fetcher.mock.calls.length;
    await connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, output: () => {} });
    expect(fetcher.mock.calls.length).toBe(requests + 1);
    expect(new URL(String(fetcher.mock.calls.at(-1)?.[0])).pathname).toBe('/api/auth/device/status');
  });

  it.each(['device_code_expired', 'device_code_used', 'device_code_revoked', 'access_denied'])('does not save denied/expired pairing: %s', async (code) => {
    const directory = stateDir();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(start)).mockResolvedValueOnce(json({ error: { code } }, 400));
    await expect(connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, sleep: async () => {}, output: () => {} })).rejects.toThrow(code);
    expect(existsSync(join(directory, 'agent.json'))).toBe(false);
  });

  it('stops pending polling at a bounded deadline even with a frozen clock', async () => {
    const directory = stateDir();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...start, expiresIn: 3 })).mockImplementation(async () => json({ error: { code: 'authorization_pending' } }, 400));
    await expect(connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, now: () => 0, sleep: async () => {}, output: () => {} })).rejects.toThrow('device_code_expired');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('skips node enrollment when the browser grants only agent permissions', async () => {
    const directory = stateDir();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(start)).mockResolvedValueOnce(json({ ...token, permissions: ['project:read', 'coordination:write'] }));
    expect(await connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, sleep: async () => {}, output: () => {} })).toEqual({ enrolled: false, dryRun: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(directory, 'credential.json'))).toBe(false);
  });

  it('reports unavailable Core enrollment while retaining approved agent authorization', async () => {
    const directory = stateDir();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(start)).mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ error: { code: 'module_unavailable' } }, 404));
    await expect(connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, sleep: async () => {}, output: () => {} })).rejects.toThrow('module_unavailable');
    expect(readAgentState(directory).token).toBe(token.token);
    expect(existsSync(join(directory, 'credential.json'))).toBe(false);
  });

  it('requests Gateway permissions only when explicitly selected for pairing', async () => {
    for (const gateway of [false, true]) {
      const directory = stateDir();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(start)).mockResolvedValueOnce(json({ ...token, permissions: ['project:read', 'coordination:write'] }));
      await connectMachine({ server: 'http://localhost:4173', stateDir: directory, agentOnly: true, gateway }, { fetch: fetcher, sleep: async () => {}, output: () => {} });
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { permissions: string[] };
      expect(body.permissions.includes('gateway:manage')).toBe(gateway);
      expect(body.permissions.includes('gateway:read')).toBe(gateway);
      expect(body.permissions).not.toContain('gateway:ingest');
    }
  });

  it('rejects malformed responses and cross-origin verification links', async () => {
    for (const body of [{ ...start, verificationUri: 'https://attacker.example/' }, { ...start, interval: 'soon' }]) {
      const directory = stateDir();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
      await expect(connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, output: () => {} })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps help and dry-run side-effect free', async () => {
    const directory = join(stateDir(), 'not-created');
    const fetcher = vi.fn<typeof fetch>();
    const output = vi.fn();
    await connectMachine({ server: 'http://localhost:4173', stateDir: directory, dryRun: true }, { fetch: fetcher, output });
    await runCli(['--help', '--state-dir', directory], { output, environment: { DHOLE_NODE_SECRETS: 'broken' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
  });

  it('rejects credential-bearing URLs and oversized/unparseable boundary data', async () => {
    for (const url of ['http://remote.example', 'https://user:secret@server.example', 'https://server.example/path', 'https://server.example?token=secret']) expect(() => serverOrigin(url)).toThrow();
    await expect(requestJson('http://localhost:4173', '/fixture', z.object({}), { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')) })).rejects.toThrow('invalid_server_response');
    await expect(requestJson('http://localhost:4173', '/fixture', z.object({}), { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1))) })).rejects.toThrow('server_response_too_large');
  });

  it('scrubs failures while reading the response stream', async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error('fixture-secret-token-in-transport-error')); } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(requestJson('http://localhost:4173', '/fixture', z.object({}), { fetch: fetcher })).rejects.toThrow('server_unavailable');
  });

  it('requires new browser authorization after machine token revocation', async () => {
    const directory = stateDir();
    writePrivateJson(join(directory, 'agent.json'), { ...token, serverUrl: 'http://localhost:4173' });
    writePrivateJson(join(directory, 'credential.json'), { machineId: 'old-machine', credential: 'fixture-old-revoked-credential' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'device_token_invalid' } }, 401))
      .mockResolvedValueOnce(json(start)).mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ machineId: 'replacement-machine', credential: 'fixture-replacement-credential' }));
    await connectMachine({ server: 'http://localhost:4173', stateDir: directory }, { fetch: fetcher, sleep: async () => {}, output: () => {} });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(readFileSync(join(directory, 'credential.json'), 'utf8')).toContain('replacement-machine');
  });

  it('does not reuse credentials with another central server', async () => {
    const directory = stateDir();
    writePrivateJson(join(directory, 'agent.json'), { ...token, serverUrl: 'https://old.example' });
    await expect(connectMachine({ server: 'https://new.example', stateDir: directory }, { output: () => {} })).rejects.toThrow('state_directory_has_another_server');
  });
});

describe('native project creation after machine approval', () => {
  it('creates a local project without GitHub and prints only its IDs', async () => {
    const directory = stateDir();
    writePrivateJson(join(directory, 'agent.json'), { ...token, permissions: [...token.permissions, 'projects:create'], serverUrl: 'http://localhost:4173' });
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ project: { id: 'project-local', name: 'Local project' }, repository: { id: 'repo-local' }, authorizationSource: 'native', repositoryVerification: 'unverified' }));
    const options = { stateDir: directory, name: 'Local project', cwd: directory };
    const result = await createNativeProject(options, { fetch: fetcher, output: (line) => output.push(line) });
    await createNativeProject(options, { fetch: fetcher, output: () => {} });
    expect(result).toEqual({ projectId: 'project-local', repositoryId: 'repo-local' });
    expect(output).toEqual(['{"projectId":"project-local","repositoryId":"repo-local"}']);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/auth/device/projects');
    expect(JSON.parse(String(request?.body))).toEqual({ name: 'Local project', repository: { label: 'Local project' } });
    expect(new Headers(request?.headers).get('Authorization')).toBe(`Bearer ${token.token}`);
    const key = new Headers(request?.headers).get('Idempotency-Key');
    expect(key).toHaveLength(64);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(key);
    expect(String(request?.body)).not.toContain(directory);
    expect(output.join('')).not.toContain(token.token);
  });

  it('accepts unverified Codeberg metadata and preserves explicit retry keys', async () => {
    const directory = stateDir();
    writePrivateJson(join(directory, 'agent.json'), { ...token, permissions: ['projects:create'], serverUrl: 'http://localhost:4173' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ project: { id: 'codeberg-project' }, authorizationSource: 'native', repositoryVerification: 'unverified' }));
    await createNativeProject({ stateDir: directory, name: 'Codeberg', remote: 'https://codeberg.org/example/repo.git', requestId: 'fixture-create-project' }, { fetch: fetcher, output: () => {} });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ repository: { canonicalRemote: 'https://codeberg.org/example/repo.git' } });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('fixture-create-project');
  });

  it('does not create projects without the approved scope or after revocation', async () => {
    const directory = stateDir();
    const fetcher = vi.fn<typeof fetch>();
    writePrivateJson(join(directory, 'agent.json'), { ...token, serverUrl: 'http://localhost:4173' });
    await expect(createNativeProject({ stateDir: directory, name: 'Local' }, { fetch: fetcher })).rejects.toThrow('project_creation_not_authorized');
    expect(fetcher).not.toHaveBeenCalled();
    writePrivateJson(join(directory, 'agent.json'), { ...token, permissions: ['projects:create'], serverUrl: 'http://localhost:4173' });
    fetcher.mockResolvedValue(json({ error: { code: 'device_token_invalid' } }, 401));
    await expect(createNativeProject({ stateDir: directory, name: 'Local' }, { fetch: fetcher })).rejects.toThrow('device_token_invalid');
  });

  it('validates remote metadata before networking and previews without local setup', async () => {
    const directory = join(stateDir(), 'not-created');
    const fetcher = vi.fn<typeof fetch>();
    for (const remote of ['https://user:secret@codeberg.org/example/repo', '/private/repo', 'https://codeberg.org/example/repo?token=secret']) {
      await expect(createNativeProject({ stateDir: directory, name: 'Local', remote }, { fetch: fetcher })).rejects.toThrow();
    }
    await createNativeProject({ stateDir: directory, name: 'Local', dryRun: true }, { fetch: fetcher, output: () => {} });
    await runCli(['create-project', '--name', 'Local', '--state-dir', directory, '--dry-run'], { output: () => {} });
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
  });
});
