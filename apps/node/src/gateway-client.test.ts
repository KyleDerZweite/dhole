import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writePrivateJson } from './config.js';
import { executeGatewayAction, GatewayActionSchema } from './gateway-client.js';

const directories: string[] = [];
const device = { serverUrl: 'http://localhost:4173', token: 'fixture-private-device-token', id: 'device-1', permissions: ['gateway:read', 'gateway:manage'], expiresAt: '2099-01-01T00:00:00.000Z' };
const project = { token: 'fixture-private-project-token', id: 'token-1', projectId: 'project-1', permissions: ['gateway:read'], expiresAt: device.expiresAt };
const connection = { id: 'connection-1', name: 'Fixture CPA', baseUrl: 'http://localhost:8317', providerId: 'provider-1', enabled: true, status: 'unknown', revision: 1, retentionDays: 30, managementConfigured: true, catalogConfigured: false };
const account = { id: 'account-1', connectionId: connection.id, authIndex: '0', provider: 'codex', status: 'active', disabled: false, managementSupported: true };
const values = { 'request-retry': 3, 'max-retry-credentials': 0, 'max-retry-interval': 60, 'routing/strategy': 'round-robin' };
const config = { values, revision: 'a'.repeat(64), observedAt: '2026-09-05T00:00:00.000Z', concurrency: 'best-effort' };
const change = { expectedRevision: 1, expectedConfigRevision: config.revision, setting: 'request-retry', value: 4 };
const catalog = { schemaVersion: 1, connectionId: connection.id, providerId: 'provider-1', connectionEnabled: true, providerEnabled: true, sourceMatchesConnection: false, status: 'unobserved', stale: true, error: null, models: [] };
const flow = { id: 'flow-1', provider: 'codex', status: 'pending', createdAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T00:05:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(permissions = device.permissions) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dhole-gateway-client-'));
  directories.push(stateDir);
  writePrivateJson(join(stateDir, 'agent.json'), { ...device, permissions });
  return { stateDir, projectId: project.projectId };
}
function transport(response: unknown, permission = 'gateway:manage', status = 200) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(new URL(String(url)).origin).toBe(device.serverUrl);
    expect(init?.redirect).toBe('error');
    if (path === '/api/auth/device/project') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${device.token}`);
      expect(JSON.parse(String(init?.body))).toEqual({ mode: 'manual', projectId: project.projectId, permissions: [permission] });
      return json({ ...project, permissions: [permission] });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${project.token}`);
    return json(response, status);
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('typed Gateway agent client', () => {
  it('derives read-only authority and strips raw data and private credentials from output', async () => {
    const options = setup(['gateway:read']);
    const fetcher = transport([{ ...connection, name: project.token, managementSecret: 'fixture-upstream-secret', extra: { authorization: device.token } }], 'gateway:read');
    const result = await executeGatewayAction({ action: 'connections.list' }, { ...options, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ ...connection, name: '[REDACTED]' }]);
    expect(JSON.stringify(result)).not.toMatch(/fixture-(?:private|upstream)/u);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).pathname).toBe('/api/gateway/connections');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(readFileSync(join(options.stateDir, 'agent.json'), 'utf8')).not.toContain(project.token);
  });

  it('reads credentials only from a private local file for create and rotation', async () => {
    const options = setup();
    const secretFile = join(options.stateDir, 'credentials.json');
    const secrets = { managementSecret: 'fixture-private-management-secret', catalogSecret: 'fixture-private-catalog-secret' };
    writePrivateJson(secretFile, secrets);
    for (const action of ['connections.create', 'connections.rotate'] as const) {
      const fetcher = transport({ ...connection, name: secrets.managementSecret, managementSecret: secrets.managementSecret });
      const input = action === 'connections.create'
        ? { action, name: connection.name, baseUrl: connection.baseUrl, secretFile }
        : { action, connectionId: connection.id, expectedRevision: 1, secretFile };
      const result = await executeGatewayAction(input, { ...options, fetch: fetcher });
      const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
      expect(body).toMatchObject(secrets);
      expect(body).not.toHaveProperty('secretFile');
      expect(JSON.stringify(result)).not.toContain(secrets.managementSecret);
      expect(JSON.stringify(result)).not.toContain(secrets.catalogSecret);
    }
    expect(readFileSync(secretFile, 'utf8')).toBe(JSON.stringify(secrets));
  });

  const routes: Array<{ action: Record<string, unknown>; response: unknown; method: string; path: string; body?: unknown; permission?: string }> = [
    { action: { action: 'connections.update', expectedRevision: 1, enabled: false }, response: connection, method: 'PATCH', path: '', body: { expectedRevision: 1, enabled: false } },
    { action: { action: 'health' }, response: { ok: true, status: 200 }, method: 'POST', path: '/health', body: {} },
    { action: { action: 'sync' }, response: { received: 2, inserted: 1, duplicates: 1 }, method: 'POST', path: '/sync', body: {} },
    { action: { action: 'catalog.read' }, response: catalog, method: 'GET', path: '/catalog', permission: 'gateway:read' },
    { action: { action: 'catalog.refresh', clientVersion: '1.2.3' }, response: catalog, method: 'POST', path: '/catalog/refresh', body: { clientVersion: '1.2.3' } },
    { action: { action: 'models.policy', modelId: 'model-1', enabled: false }, response: catalog, method: 'PATCH', path: '/catalog/models/model-1', body: { enabled: false } },
    { action: { action: 'accounts.list' }, response: [account], method: 'GET', path: '/api/gateway/accounts?connectionId=connection-1', permission: 'gateway:read' },
    { action: { action: 'accounts.refresh' }, response: { accounts: [account], observedAt: config.observedAt }, method: 'POST', path: '/accounts/refresh', body: {} },
    { action: { action: 'accounts.status', accountId: 'account-1', expectedRevision: 1, expectedDisabled: false, disabled: true }, response: { accounts: [account], observedAt: config.observedAt }, method: 'POST', path: '/accounts/account-1/status', body: { expectedRevision: 1, expectedDisabled: false, disabled: true } },
    { action: { action: 'config.read' }, response: config, method: 'GET', path: '/config', permission: 'gateway:read' },
    { action: { action: 'config.preview', change }, response: { before: values, after: { ...values, 'request-retry': 4 }, changes: [{ setting: 'request-retry', before: 3, after: 4 }], revision: config.revision, concurrency: 'best-effort' }, method: 'POST', path: '/config/preview', body: change },
    { action: { action: 'config.apply', change }, response: config, method: 'POST', path: '/config/apply', body: change },
    { action: { action: 'collection' }, response: { connectionId: connection.id, mode: 'push_or_import', automaticCollection: false, queueConsumption: 'explicit_only', status: 'no_records', totalStored: 0, retainedRequests: 0, retentionDays: 30 }, method: 'GET', path: '/collection', permission: 'gateway:read' },
    { action: { action: 'usage' }, response: { bucket: 'day', groupBy: 'none', truncated: false, items: [] }, method: 'GET', path: '/api/gateway/usage?connectionId=connection-1&bucket=day&groupBy=none&limit=100', permission: 'gateway:read' },
    { action: { action: 'requests', filters: { failed: false, model: 'provider/model' } }, response: { items: [], total: 0, offset: 0, limit: 25, nextOffset: null }, method: 'GET', path: '/api/gateway/requests?model=provider%2Fmodel&failed=false&connectionId=connection-1&offset=0&limit=25', permission: 'gateway:read' },
    { action: { action: 'oauth.status', flowId: flow.id }, response: flow, method: 'GET', path: '/oauth/flow-1' },
    { action: { action: 'oauth.cancel', flowId: flow.id }, response: flow, method: 'DELETE', path: '/oauth/flow-1', body: {} },
    { action: { action: 'tokens.list' }, response: { tokens: [] }, method: 'GET', path: '/catalog/tokens' },
    { action: { action: 'tokens.revoke', tokenId: 'catalog-token-1' }, response: { ok: true }, method: 'DELETE', path: '/catalog/tokens/catalog-token-1', body: {} },
  ];
  it.each(routes)('validates and routes $action.action with the required scope', async ({ action, response, method, path, body, permission }) => {
    const fetcher = transport(response, permission);
    const result = await executeGatewayAction({ ...action, connectionId: connection.id }, { ...setup(), fetch: fetcher });
    expect(result).toEqual(response);
    const [url, init] = fetcher.mock.calls[1]!;
    const actual = new URL(String(url));
    expect(actual.pathname + actual.search).toBe(path.startsWith('/api/') ? path : `/api/gateway/connections/${connection.id}${path}`);
    expect(init?.method).toBe(method);
    expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
  });

  it('saves issued catalog credentials privately and returns only a file reference and metadata', async () => {
    const options = setup();
    const issued = { id: 'catalog-token-1', token: 'fixture-private-issued-token-value-123456', client: 'codex', expiresAt: device.expiresAt, endpoint: '/api/gateway/catalog/v1/connection-1/codex' };
    const result = await executeGatewayAction({ action: 'tokens.issue', connectionId: connection.id, name: 'Agent catalog', client: 'codex' }, { ...options, fetch: transport(issued) }) as Record<string, unknown>;
    const credentialFile = String(result.credentialFile);
    expect(JSON.stringify(result)).not.toContain(issued.token);
    expect(result).not.toHaveProperty('token');
    expect(result.endpoint).toBe(issued.endpoint);
    expect(JSON.parse(readFileSync(credentialFile, 'utf8'))).toMatchObject({ ...issued, serverUrl: device.serverUrl, connectionId: connection.id });
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(options.stateDir, 'gateway')).mode & 0o777).toBe(0o700);
  });

  it('keeps OAuth authorization URLs and callback codes out of model inputs and results', async () => {
    const options = setup();
    const authorizationUrl = 'https://auth.openai.com/oauth/authorize?state=fixture-private-oauth-state';
    const result = await executeGatewayAction({ action: 'oauth.start', connectionId: connection.id, expectedRevision: 1, provider: 'codex' }, { ...options, fetch: transport({ ...flow, authorizationUrl, callbackMode: 'paste-redirect-url' }) }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(authorizationUrl);
    expect(result).not.toHaveProperty('authorizationUrl');
    expect(JSON.parse(readFileSync(String(result.authorizationFile), 'utf8'))).toMatchObject({ authorizationUrl });
    const redirectFile = join(options.stateDir, 'callback.json');
    const redirectUrl = 'http://localhost:1455/auth/callback?state=fixture-private-oauth-state&code=fixture-private-code';
    writePrivateJson(redirectFile, { redirectUrl });
    const fetcher = transport({ ...flow, status: 'submitted', redirectUrl, code: 'fixture-private-code' });
    expect(await executeGatewayAction({ action: 'oauth.callback', connectionId: connection.id, flowId: flow.id, redirectFile }, { ...options, fetch: fetcher })).toEqual({ ...flow, status: 'submitted' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ redirectUrl });
  });

  it('issues an OpenCode token file that the real plugin reads without exposing the token', async () => {
    const options = setup();
    const issued = { id: 'catalog-token-1', token: 'fixture-private-issued-token-value-123456', client: 'opencode', expiresAt: device.expiresAt, endpoint: '/api/gateway/catalog/v1/connection-1/opencode' };
    writePrivateJson(join(options.stateDir, 'agent.json'), { ...device, serverUrl: 'https://dhole.example' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...project, permissions: ['gateway:manage'] })).mockResolvedValueOnce(json(issued));
    const result = await executeGatewayAction({ action: 'tokens.issue', connectionId: connection.id, name: 'OpenCode catalog', client: 'opencode', openCodeProvider: 'dhole-work' }, { ...options, fetch: fetcher }) as Record<string, unknown>;
    expect(JSON.parse(readFileSync(String(result.credentialFile), 'utf8'))).toEqual({ schemaVersion: 1, provider: 'dhole-work', connectionId: connection.id, endpoint: `https://dhole.example${issued.endpoint}`, token: issued.token });
    expect(JSON.stringify(result)).not.toContain(issued.token);
    mkdirSync(join(options.stateDir, 'node_modules'));
    symlinkSync(dirname(createRequire(import.meta.url).resolve('zod/package.json')), join(options.stateDir, 'node_modules/zod'), 'dir');
    const pluginPath = join(options.stateDir, 'catalog.mjs');
    copyFileSync(new URL('../../../clients/opencode/catalog.mjs', import.meta.url), pluginPath);
    const plugin = await import(pathToFileURL(pluginPath).href) as { default: () => Promise<{ config: (value: unknown) => Promise<void> }> };
    const models = { 'fixture-model': { id: 'fixture-model', name: 'Fixture model' } };
    const catalogFetch = vi.fn<typeof fetch>().mockResolvedValue(json({ schemaVersion: 1, client: 'opencode', connectionId: connection.id, providerId: connection.providerId, observedAt: config.observedAt, lastAttemptAt: config.observedAt, lastSuccessAt: config.observedAt, stale: false, status: 'current', sourceMatchesConnection: true, snapshotId: 'snapshot-1', contentHash: config.revision, error: null, models }));
    vi.stubEnv('DHOLE_OPENCODE_CATALOG_CONFIG', String(result.credentialFile));
    vi.stubGlobal('fetch', catalogFetch);
    const openCode = { provider: { 'dhole-work': { npm: '@ai-sdk/openai-compatible', models: {} } } };
    await (await plugin.default()).config(openCode);
    expect(openCode.provider['dhole-work'].models).toEqual(models);
    expect(catalogFetch).toHaveBeenCalledExactlyOnceWith(`https://dhole.example${issued.endpoint}`, expect.objectContaining({ headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json' }, redirect: 'error' }));
    expect(JSON.stringify(openCode)).not.toContain(issued.token);
  });

  it.each([
    { action: 'request', url: 'https://elsewhere.invalid' },
    { action: 'connections.list', projectId: 'other-project' },
    { action: 'connections.create', name: 'CPA', baseUrl: 'https://user:fixture-secret@cpa.invalid', secretFile: '/private.json' },
    { action: 'connections.create', name: 'CPA', baseUrl: 'https://cpa.invalid', managementSecret: 'fixture-secret', secretFile: '/private.json' },
    { action: 'oauth.callback', connectionId: connection.id, flowId: flow.id, redirectUrl: 'http://localhost/?code=fixture-secret' },
    { action: 'health', connectionId: '..' },
    { action: 'sync', connectionId: connection.id, includeUsageQueue: true },
    { action: 'config.apply', connectionId: connection.id, change: { ...change, value: 101 } },
    { action: 'config.apply', connectionId: connection.id, change: { ...change, setting: 'routing/strategy', value: 3 } },
  ])('rejects unsupported or unsafe arguments before any request: $action', async (input) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(GatewayActionSchema.safeParse(input).success).toBe(false);
    await expect(executeGatewayAction(input, { ...setup(), fetch: fetcher })).rejects.toThrow('invalid_gateway_action');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses missing scope, expired authorization, and invalid project token responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(executeGatewayAction({ action: 'health', connectionId: connection.id }, { ...setup(['gateway:read']), fetch: fetcher })).rejects.toThrow('gateway_not_authorized');
    await expect(executeGatewayAction({ action: 'connections.list' }, { ...setup(), now: () => Date.parse(device.expiresAt), fetch: fetcher })).rejects.toThrow('machine_authorization_expired');
    expect(fetcher).not.toHaveBeenCalled();
    for (const changed of [{ projectId: 'other-project' }, { permissions: ['gateway:read', 'gateway:manage'] }, { expiresAt: '2000-01-01T00:00:00.000Z' }]) {
      const bad = vi.fn<typeof fetch>().mockResolvedValue(json({ ...project, ...changed }));
      await expect(executeGatewayAction({ action: 'connections.list' }, { ...setup(), fetch: bad })).rejects.toThrow('invalid_server_response');
      expect(bad).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects incompatible OpenCode destinations before issuing a token', async () => {
    const options = setup();
    const fetcher = vi.fn<typeof fetch>();
    const action = { action: 'tokens.issue', connectionId: connection.id, name: 'OpenCode catalog', client: 'opencode' };
    await expect(executeGatewayAction(action, { ...options, fetch: fetcher })).rejects.toThrow('gateway_opencode_settings_invalid');
    writePrivateJson(join(options.stateDir, 'agent.json'), { ...device, serverUrl: 'https://dhole.example' });
    await expect(executeGatewayAction({ ...action, connectionId: 'connection/invalid' }, { ...options, fetch: fetcher })).rejects.toThrow('gateway_opencode_settings_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects readable-by-others, symlinked, oversized, and malformed secret files without echoing them', async () => {
    const options = setup();
    const file = join(options.stateDir, 'secret.json');
    const link = join(options.stateDir, 'link.json');
    writePrivateJson(file, { managementSecret: 'fixture-private-management-secret' });
    symlinkSync(file, link);
    const fetcher = vi.fn<typeof fetch>();
    const invoke = (secretFile: string) => executeGatewayAction({ action: 'connections.create', name: connection.name, baseUrl: connection.baseUrl, secretFile }, { ...options, fetch: fetcher });
    await expect(invoke(link)).rejects.toThrow('gateway_private_file_invalid');
    chmodSync(file, 0o644);
    await expect(invoke(file)).rejects.toThrow('gateway_private_file_invalid');
    chmodSync(file, 0o600);
    writeFileSync(file, 'fixture-private-management-secret'.repeat(3000));
    await expect(invoke(file)).rejects.toThrow('gateway_private_file_invalid');
    writeFileSync(file, '{fixture-private-management-secret');
    await expect(invoke(file)).rejects.toThrow('gateway_private_file_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects FIFO secret paths without waiting for a writer', async () => {
    const options = setup();
    const secretFile = join(options.stateDir, 'fifo');
    execFileSync('mkfifo', [secretFile]);
    const fetcher = vi.fn<typeof fetch>();
    await expect(executeGatewayAction({ action: 'connections.create', name: connection.name, baseUrl: connection.baseUrl, secretFile }, { ...options, fetch: fetcher })).rejects.toThrow('gateway_private_file_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sanitizes server errors, invalid responses, and incorrect issued token destinations', async () => {
    for (const [response, status, expected] of [
      [{ error: { code: 'fixture-private-error-token', message: 'fixture-private-management-secret' } }, 409, 'server_http_409'],
      [{ managementSecret: 'fixture-private-management-secret' }, 200, 'invalid_server_response'],
    ] as const) {
      await expect(executeGatewayAction({ action: 'health', connectionId: connection.id }, { ...setup(), fetch: transport(response, 'gateway:manage', status) })).rejects.toThrow(expected);
    }
    const options = setup();
    await expect(executeGatewayAction({ action: 'tokens.issue', connectionId: connection.id, name: 'Catalog', client: 'codex' }, {
      ...options, fetch: transport({ id: 'catalog-token-1', token: 'fixture-private-issued-token-value-123456', client: 'codex', expiresAt: device.expiresAt, endpoint: 'https://elsewhere.invalid' }),
    })).rejects.toThrow('invalid_server_response');
    expect(existsSync(join(options.stateDir, 'gateway'))).toBe(false);
  });
});
