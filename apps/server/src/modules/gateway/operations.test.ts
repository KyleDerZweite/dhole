import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { secureIds } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { GatewayService } from './index.js';
import { GatewayOperations, registerGatewayOperationsRoutes, startGatewayRetention } from './operations.js';

function setup() {
  const now = '2026-09-05T12:00:00.000Z';
  const clock = { now: () => new Date(now) };
  const database = openDatabase(':memory:', clock);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173', DHOLE_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 4).toString('base64') }), DHOLE_MASTER_KEY_ID: 'v1', DHOLE_GATEWAY_ALLOWED_HOSTS: '127.0.0.1' });
  const context: ServerContext = { config, database, clock, ids: secureIds, events: new EventStore(database, clock, secureIds) };
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', now, now);
  const service = new GatewayService(context);
  const connections = ['team-1', 'team-2'].map((teamId) => {
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, teamId, now);
    return service.createConnection(teamId, { name: 'local', baseUrl: 'http://127.0.0.1:8787', managementSecret: 'management-secret', enabled: true, retentionDays: 30 }, 'user-1').id;
  });
  const connectionId = connections[0]!;
  const otherConnectionId = connections[1]!;
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', now, now);
  const operations = new GatewayOperations(context, service);
  const app = new Hono<AppEnvironment>();
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: String(error) }, 500));
  app.use('*', async (c, next) => {
    if (c.req.header('x-test-role') !== 'anonymous') c.set('user', { id: 'user-1', email: 'user@example.invalid', displayName: 'User', teamId: 'team-1', role: c.req.header('x-test-role') === 'member' ? 'member' : 'administrator' });
    if (c.req.header('x-test-permission')) c.set('credential', { tokenId: 'token-1', projectId: 'project-1', permissions: [c.req.header('x-test-permission')!], ...(c.req.header('x-test-run') ? { runId: 'run-1' } : {}) });
    await next();
  });
  registerGatewayOperationsRoutes(app, context, service);
  return { context, service, connectionId, otherConnectionId, operations, app };
}

describe('gateway usage operations', () => {
  it('groups UTC hours/days and preserves absent cost and latency measurements', () => {
    const { service, connectionId, operations } = setup();
    service.ingest(connectionId, [
      { request_id: 'a', occurred_at: '2026-09-01T09:30:00+02:00', provider: 'p', model: 'one', auth_index: '0', duration_ms: 100, ttft_ms: 10, usage: { input_tokens: 10, output_tokens: 5 }, estimated_cost_microusd: 0 },
      { request_id: 'b', occurred_at: '2026-09-01T07:45:00Z', provider: 'p', model: 'one', auth_index: '0', status_code: 500, duration_ms: 300, usage: { input_tokens: 20 }, estimated_cost_microusd: 6 },
      { request_id: 'c', occurred_at: '2026-09-01T08:45:00Z', provider: 'p', model: 'two', auth_index: '1', usage: { input_tokens: 1 } },
    ]);
    const hours = operations.usage('team-1', { bucket: 'hour', groupBy: 'authIndex' });
    expect(hours.items).toHaveLength(2);
    expect(hours.items[0]).toMatchObject({ bucketStart: '2026-09-01T07:00:00.000Z', group: '0', requests: 2, failures: 1, inputTokens: 30, outputTokens: 5, estimatedCostMicrousd: 6, unpricedRequests: 0, averageDurationMs: 200, maxDurationMs: 300, measuredRequests: 2, averageTtftMs: 10 });
    expect(hours.items[1]).toMatchObject({ group: '1', estimatedCostMicrousd: null, unpricedRequests: 1, averageDurationMs: null, measuredRequests: 0, averageTtftMs: null });
    const days = operations.usage('team-1', { bucket: 'day', groupBy: 'provider' });
    expect(days.items).toHaveLength(1);
    expect(days.items[0]).toMatchObject({ group: 'p', requests: 3, estimatedCostMicrousd: 6, unpricedRequests: 1, averageDurationMs: 200 });
    expect(operations.usage('team-1', { groupBy: 'model', limit: 1 }).truncated).toBe(true);
    expect(operations.usage('absent-team').items).toEqual([]);
    service.createPriceOverride('team-1', { connectionId, modelPattern: 'priced-only', effectiveFrom: '2026-01-01T00:00:00Z', promptMicrousdPerMillion: 10 }, 'user-1');
    service.ingest(connectionId, { request_id: 'unmatched-rate', occurred_at: '2026-09-02T00:00:00Z', model: 'unpriced' });
    expect(operations.usage('team-1', { model: 'unpriced' }).items[0]).toMatchObject({ estimatedCostMicrousd: null, unpricedRequests: 1 });
  });

  it('applies combined filters and isolates team history', () => {
    const { service, connectionId, otherConnectionId, operations } = setup();
    const record = { request_id: 'a', occurred_at: '2026-09-01T07:30:00Z', provider: 'p', model: 'one', auth_index: '0', status_code: 429, project_id: 'project-1' };
    service.ingest(connectionId, [record, { ...record, request_id: 'b', model: 'two' }, { ...record, request_id: 'c', status_code: 200 }]);
    service.ingest(otherConnectionId, record);
    const filters = { connectionId, provider: 'p', model: 'one', authIndex: '0', failed: 'true', statusCode: '429', occurredFrom: '2026-09-01T07:00:00Z', occurredTo: '2026-09-01T08:00:00Z', correlationConfidence: 'low' };
    expect(operations.usage('team-1', filters).items[0]?.requests).toBe(1);
    expect(operations.exportRequests('team-1', filters).items).toHaveLength(1);
    expect(operations.usage('team-1').items[0]?.requests).toBe(3);
    expect(() => operations.usage('team-1', { connectionId: otherConnectionId })).toThrow('Gateway connection not found');
    expect(() => operations.exportRequests('team-1', { connectionId: otherConnectionId })).toThrow('Gateway connection not found');
    expect(() => operations.collection(otherConnectionId, 'team-1')).toThrow('Gateway connection not found');
    expect(() => operations.prune(otherConnectionId, 'team-1', 'user-1', {})).toThrow('Gateway connection not found');
  });

  it('paginates exports by receipt sequence without adding concurrent imports to the snapshot', () => {
    const { service, connectionId, operations } = setup();
    for (const id of ['a', 'b', 'c']) service.ingest(connectionId, { request_id: id, occurred_at: '2026-09-01T00:00:00Z', model: 'm' });
    const first = operations.exportRequests('team-1', { limit: 1 });
    service.ingest(connectionId, { request_id: 'concurrent', occurred_at: '2026-08-01T00:00:00Z', model: 'm' });
    const second = operations.exportRequests('team-1', { limit: 1, cursor: first.nextCursor });
    const third = operations.exportRequests('team-1', { limit: 1, cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map((item) => item.requestId)).toEqual(['a', 'b', 'c']);
    expect(third.nextCursor).toBeNull();
    expect(() => operations.exportRequests('team-2', { cursor: first.nextCursor })).toThrow('does not match');
    expect(() => operations.exportRequests('team-1', { cursor: first.nextCursor, model: 'other' })).toThrow('does not match');
    expect(() => operations.exportRequests('team-1', { cursor: 'invalid' })).toThrow('Invalid gateway export cursor');
  });

  it('exports sanitized JSONL and signals the next page in its header', async () => {
    const { app, service, connectionId } = setup();
    service.ingest(connectionId, [
      { request_id: 'a', occurred_at: '2026-09-01T00:00:00Z', provider: 'p', model: 'm', request_body: 'private prompt', authorization: 'Bearer stolen-key', metadata: { api_key: 'key-secret', email: 'person@example.com' } },
      { request_id: 'b', occurred_at: '2026-09-01T00:00:00Z', provider: 'p', model: 'm' },
    ]);
    const response = await app.request('/api/gateway/requests/export?limit=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-next-cursor')).toBeTruthy();
    const body = await response.text();
    expect(JSON.parse(body) as unknown).toMatchObject({ requestId: 'a', connectionId });
    for (const secret of ['private prompt', 'stolen-key', 'key-secret', 'person@example.com', 'management-secret']) expect(body).not.toContain(secret);
    const next = await app.request(`/api/gateway/requests/export?format=json&limit=1&cursor=${response.headers.get('x-next-cursor')!}`);
    expect(await next.json()).toMatchObject({ items: [{ requestId: 'b' }], nextCursor: null });
  });

  it('bounds export bytes and resumes after the last emitted record', () => {
    const { service, connectionId, operations } = setup();
    const metadata = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, 'x'.repeat(2_000)]));
    for (let index = 0; index < 12; index += 1) service.ingest(connectionId, { request_id: `large-${index}`, metadata });
    const first = operations.exportRequests('team-1', { limit: 500 });
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(first.items.map((item) => JSON.stringify(item)).join('\n') + '\n')).toBeLessThanOrEqual(2 * 1024 * 1024);
    const second = operations.exportRequests('team-1', { limit: 500, cursor: first.nextCursor });
    expect(first.items.length + second.items.length).toBe(12);
    expect(second.nextCursor).toBeNull();
  });

  it('prunes a bounded batch while retaining deduplication, events, and audit history', () => {
    const { service, context, connectionId, operations } = setup();
    const old = [
      { request_id: 'old-a', occurred_at: '2026-01-01T00:00:00Z', project_id: 'project-1', provider: 'p', model: 'm' },
      { request_id: 'old-b', occurred_at: '2026-01-02T00:00:00Z', project_id: 'project-1', provider: 'p', model: 'm' },
    ];
    service.ingest(connectionId, [...old, { request_id: 'new', occurred_at: '2026-09-05T00:00:00Z' }]);
    const events = context.database.prepare('SELECT * FROM event_log ORDER BY project_sequence').all();
    const audits = context.database.prepare('SELECT * FROM audit_records ORDER BY rowid').all();
    expect(operations.prune(connectionId, 'team-1', 'user-1', { limit: 1, dryRun: true })).toMatchObject({ dryRun: true, wouldDelete: 1, deleted: 0, remainingEligible: 2 });
    expect(operations.prune(connectionId, 'team-1', 'user-1', { limit: 1 })).toMatchObject({ cutoff: '2026-08-06T12:00:00.000Z', dryRun: false, deleted: 1, remainingEligible: 1, hasMore: true });
    expect(operations.prune(connectionId, 'team-1', 'user-1', { limit: 1 })).toMatchObject({ deleted: 1, hasMore: false });
    expect(service.ingest(connectionId, old)).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(service.listRequests({ connectionId }).total).toBe(1);
    expect(context.database.prepare('SELECT * FROM event_log ORDER BY project_sequence').all()).toEqual(events);
    expect(context.database.prepare('SELECT * FROM audit_records ORDER BY rowid').all().slice(0, audits.length)).toEqual(audits);
    expect(context.database.prepare("SELECT count(*) AS count FROM audit_records WHERE action = 'gateway.retention.prune'").get()).toEqual({ count: 2 });
    expect(operations.collection(connectionId, 'team-1')).toMatchObject({ retainedRequests: 1, totalStored: 3, lastStoredAt: '2026-09-05T12:00:00.000Z' });
  });

  it('rolls back pruning if the immutable audit cannot be appended', () => {
    const { service, context, connectionId, operations } = setup();
    service.ingest(connectionId, { request_id: 'old', occurred_at: '2026-01-01T00:00:00Z' });
    context.database.exec("CREATE TRIGGER fail_prune_audit BEFORE INSERT ON audit_records WHEN NEW.action = 'gateway.retention.prune' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect(() => operations.prune(connectionId, 'team-1', 'user-1', {})).toThrow('audit unavailable');
    expect(service.listRequests({ connectionId }).total).toBe(1);
  });

  it('automatically prunes fair bounded batches hourly without changing event history', () => {
    const { service, context, connectionId, otherConnectionId } = setup();
    service.ingest(connectionId, Array.from({ length: 1_001 }, (_, index) => ({ request_id: `old-${index}`, occurred_at: '2026-01-01T00:00:00Z' })));
    service.ingest(otherConnectionId, { request_id: 'other-old', occurred_at: '2026-01-01T00:00:00Z' });
    const events = context.database.prepare('SELECT * FROM event_log').all();
    const lifecycle = startGatewayRetention(context);
    lifecycle.maintenance();
    expect(service.listRequests({ connectionId }).total).toBe(1);
    expect(service.listRequests({ connectionId: otherConnectionId }).total).toBe(0);
    lifecycle.maintenance();
    expect(service.listRequests({ connectionId }).total).toBe(1);
    context.clock.now = () => new Date('2026-09-05T13:00:00.000Z');
    lifecycle.maintenance();
    expect(service.listRequests({ connectionId }).total).toBe(0);
    expect(context.database.prepare('SELECT * FROM event_log').all()).toEqual(events);
    expect(context.database.prepare("SELECT count(*) AS count FROM audit_records WHERE action = 'gateway.retention.prune' AND actor_type = 'system'").get()).toEqual({ count: 3 });
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_request_receipts').get()).toEqual({ count: 1_002 });
  });

  it('continues other connections after a retention transaction fails', () => {
    const { service, context, connectionId, otherConnectionId } = setup();
    for (const id of [connectionId, otherConnectionId]) service.ingest(id, { request_id: 'old', occurred_at: '2026-01-01T00:00:00Z' });
    context.database.exec("CREATE TRIGGER fail_one_retention_audit BEFORE INSERT ON audit_records WHEN NEW.action = 'gateway.retention.prune' AND NEW.target_id IN (SELECT id FROM gateway_connections WHERE team_id = 'team-1') BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect(() => startGatewayRetention(context).maintenance()).toThrow('Gateway retention failed');
    expect(service.listRequests({ connectionId }).total).toBe(1);
    expect(service.listRequests({ connectionId: otherConnectionId }).total).toBe(0);
  });

  it('reports absent collection without presenting it as measured zero traffic', () => {
    const { connectionId, operations } = setup();
    expect(operations.collection(connectionId, 'team-1')).toMatchObject({ status: 'no_records', mode: 'push_or_import', automaticCollection: false, queueConsumption: 'explicit_only', lastStoredAt: null, totalStored: 0, retainedRequests: 0, oldestRetainedAt: null, newestRetainedAt: null });
    expect(operations.collection(connectionId, 'team-1').message).toContain('health check does not collect requests');
  });

  it('rejects malformed filters and unauthorized retention actions', async () => {
    const { app, connectionId } = setup();
    for (const query of ['bucket=week', 'groupBy=arbitrary', 'limit=0', 'limit=1001', 'failed=perhaps', 'statusCode=1.5', 'occurredFrom=invalid', 'occurredFrom=2026-09-02T00:00:00Z&occurredTo=2026-09-01T00:00:00Z']) {
      expect((await app.request(`/api/gateway/usage?${query}`)).status).toBe(422);
    }
    expect((await app.request('/api/gateway/usage', { headers: { 'x-test-role': 'anonymous' } })).status).toBe(401);
    expect((await app.request('/api/gateway/usage', { headers: { 'x-test-permission': 'project:read' } })).status).toBe(403);
    expect((await app.request('/api/gateway/usage', { headers: { 'x-test-permission': 'gateway:read', 'x-test-run': 'true' } })).status).toBe(403);
    expect((await app.request('/api/gateway/usage', { headers: { 'x-test-permission': 'gateway:read' } })).status).toBe(200);
    for (const extra of [{ 'x-test-role': 'member' }, { 'x-test-permission': 'gateway:read' }]) {
      expect((await app.request(`/api/gateway/connections/${connectionId}/prune`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: '{}' })).status).toBe(403);
    }
    expect((await app.request(`/api/gateway/connections/${connectionId}/prune`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"limit":10001}' })).status).toBe(422);
    expect((await app.request(`/api/gateway/connections/${connectionId}/prune`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-permission': 'gateway:manage' }, body: '{"dryRun":true}' })).status).toBe(200);
  });
});
