import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayApi, gatewayQuery } from './gateway-api';

const connection = {
  id: 'connection-1', name: 'Local fixture', baseUrl: 'http://127.0.0.1:8317', providerId: 'provider-1',
  enabled: true, status: 'unknown', revision: 2, retentionDays: 30,
  managementConfigured: true, catalogConfigured: false,
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('Gateway browser boundary', () => {
  it('keeps errors and malformed data distinct from empty observations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'gateway_unavailable', message: 'Gateway unavailable' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gatewayApi.accounts('connection-1')).rejects.toMatchObject({ status: 503, code: 'gateway_unavailable' });
    await expect(gatewayApi.requests({ connectionId: 'connection-1' })).rejects.toMatchObject({ code: 'invalid_gateway_response' });
    await expect(gatewayApi.accounts('connection-1')).resolves.toEqual([]);
  });

  it('sends a revision-checked mutation only to Dhole with CSRF and strips unexpected response fields', async () => {
    vi.stubGlobal('document', { cookie: 'other=value; dhole_csrf=csrf%2Bfixture' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...connection, unexpectedPrivateField: 'must-not-reach-state' })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await gatewayApi.update('id/with space', { expectedRevision: 1, enabled: false });
    expect(result).not.toHaveProperty('unexpectedPrivateField');
    const [path, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe('/api/gateway/connections/id%2Fwith%20space');
    expect(options.method).toBe('PATCH');
    expect(options.credentials).toBe('include');
    expect(options.cache).toBe('no-store');
    expect(new Headers(options.headers).get('x-csrf-token')).toBe('csrf+fixture');
    expect(JSON.parse(String(options.body))).toEqual({ expectedRevision: 1, enabled: false });
  });

  it('rejects credential submissions over HTTP before a network request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { protocol: 'http:' });
    expect(() => gatewayApi.rotate('connection-1', { expectedRevision: 2, managementSecret: 'synthetic-test-input' })).toThrow('HTTPS');
    expect(() => gatewayApi.issueToken('connection-1', { name: 'Client', client: 'opencode', expiresInDays: 7 })).toThrow('HTTPS');
    expect(() => gatewayApi.oauthCallback('connection-1', 'flow-1', 'http://localhost/callback?code=synthetic-test-code')).toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves last-known catalog metadata and disabled policy after refresh failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, connectionId: 'connection-1', providerId: 'provider-1', connectionEnabled: true, providerEnabled: true,
      status: 'error', stale: true, lastAttemptAt: '2026-09-05T12:00:00Z', lastSuccessAt: '2026-09-04T12:00:00Z',
      error: { code: 'catalog_unavailable', message: 'Catalog request failed' },
      snapshot: { id: 'snapshot-1', schemaVersion: 1, observedAt: '2026-09-04T12:00:00Z', contentHash: 'abc',
        source: { connectionId: 'connection-1', providerId: 'provider-1', baseUrl: 'http://127.0.0.1:8317', endpoint: '/v1/models', shape: 'openai', clientVersion: null },
        diff: { added: ['test-model'], removed: [], changed: [] } },
      models: [{ modelId: 'model-1', modelKey: 'test-model', displayName: 'Test model', declared: { capabilities: { tools: true } },
        measuredCapabilities: { tools: 'unknown' }, compatibility: { generic: true, opencode: true, codex: false }, enabled: false, available: true }],
    }))));
    const catalog = await gatewayApi.refreshCatalog('connection-1');
    expect(catalog.stale).toBe(true);
    expect(catalog.snapshot?.diff.added).toEqual(['test-model']);
    expect(catalog.models[0]).toMatchObject({ enabled: false, declared: { capabilities: { tools: true } }, measuredCapabilities: { tools: 'unknown' } });
  });

  it('encodes filters and preserves explicit success and pagination values', () => {
    const query = new URLSearchParams(gatewayQuery({ connectionId: 'a/b', model: 'model+large', failed: 'false', offset: 0, provider: '', missing: undefined }));
    expect(Object.fromEntries(query)).toEqual({ connectionId: 'a/b', model: 'model+large', failed: 'false', offset: '0' });
  });

  it('rejects an unsafe consent link before it can become a browser navigation', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'flow-1', provider: 'codex', status: 'pending', createdAt: '2026-09-05T12:00:00Z', expiresAt: '2026-09-05T12:05:00Z', updatedAt: '2026-09-05T12:00:00Z',
      authorizationUrl: 'javascript:alert(1)', callbackMode: 'paste-redirect-url',
    }))));
    await expect(gatewayApi.startOAuth('connection-1', 2, 'codex')).rejects.toMatchObject({ code: 'invalid_gateway_response' });
  });
});
