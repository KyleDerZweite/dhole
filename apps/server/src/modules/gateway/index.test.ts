import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import { loadConfig } from '../../lib/config.js';
import type { ServerContext } from '../../lib/module.js';
import {
  GatewayService,
  calculateGatewayCostMicrousd,
  gatewayEventHash,
  normalizeCliProxyRecord,
  parseCliProxyRecords,
  redactGatewayMetadata,
  selectPriceOverride,
  validateGatewayUrl,
} from './index.js';

function setup(): { service: GatewayService; context: ServerContext; connectionId: string } {
  const database = openDatabase(':memory:', systemClock);
  const config = loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173', DHOLE_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 4).toString('base64') }), DHOLE_MASTER_KEY_ID: 'v1', DHOLE_GATEWAY_ALLOWED_HOSTS: '127.0.0.1' });
  const context: ServerContext = { config, database, clock: systemClock, ids: secureIds, events: new EventStore(database, systemClock, secureIds) };
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', new Date().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', new Date().toISOString(), new Date().toISOString());
  const service = new GatewayService(context);
  const connectionId = service.createConnection('team-1', { name: 'local', baseUrl: 'http://127.0.0.1:8787', managementSecret: 'secret' , enabled: true, retentionDays: 30 }, 'user-1').id;
  return { service, context, connectionId };
}

describe('gateway fixture ingestion and boundaries', () => {
  it('audits connection creation without persisting management secrets', () => {
    const { context, connectionId } = setup();
    const audit = context.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records WHERE action = 'gateway.connection.create' AND target_id = ?").get(connectionId) as Record<string, string>;
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: 'user-1', action: 'gateway.connection.create', target_type: 'gateway_connection', target_id: connectionId, detail_json: '{}' });
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  it('audits health and sync state changes with the authenticated actor', async () => {
    const { context, connectionId } = setup();
    const healthy = new GatewayService(context, { fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
    await healthy.health(connectionId, 'team-1', 'user-1');
    await healthy.sync(connectionId, 'team-1', {}, 'user-1');

    const audit = context.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE target_id = ? ORDER BY rowid").all(connectionId) as Array<Record<string, string>>;
    expect(audit.map((row) => row.action)).toEqual(['gateway.connection.create', 'gateway.connection.health', 'gateway.connection.sync']);
    expect(audit.slice(1).every((row) => row.actor_type === 'user' && row.actor_id === 'user-1' && row.outcome === 'allowed' && row.detail_json === '{}')).toBe(true);
  });

  it('rolls back a connection when its audit record cannot be appended', () => {
    const { service, context } = setup();
    context.database.exec(`CREATE TRIGGER fail_gateway_connection_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'gateway.connection.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => service.createConnection('team-1', { name: 'must rollback', baseUrl: 'http://127.0.0.1:8788', managementSecret: 'other-secret', enabled: true, retentionDays: 30 }, 'user-1')).toThrow('audit unavailable');
    expect(context.database.prepare("SELECT count(*) AS count FROM gateway_connections WHERE name = 'must rollback'").get()).toEqual({ count: 0 });
  });

  it('rolls back a price override when its audit record cannot be appended', () => {
    const { service, context, connectionId } = setup();
    context.database.exec(`CREATE TRIGGER fail_gateway_price_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'gateway.price_override.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => service.createPriceOverride('team-1', { connectionId, modelPattern: 'm', effectiveFrom: '2026-01-01T00:00:00.000Z', promptMicrousdPerMillion: 1_000_000 }, 'user-1')).toThrow('audit unavailable');
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_price_overrides WHERE connection_id = ?').get(connectionId)).toEqual({ count: 0 });
  });

  it('rolls back synchronized queue records when the sync audit cannot be appended', async () => {
    const { context, connectionId } = setup();
    context.database.exec(`CREATE TRIGGER fail_gateway_sync_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'gateway.connection.sync' AND NEW.outcome = 'allowed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const service = new GatewayService(context, { fetchImpl: async (input) => new Response(input.toString().includes('usage-queue') ? JSON.stringify([{ request_id: 'sync-rollback', provider: 'p', model: 'm' }]) : '{}', { status: 200 }) });

    await expect(service.sync(connectionId, 'team-1', { includeUsageQueue: true, acceptDataLoss: true }, 'user-1')).rejects.toThrow('audit unavailable');
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_requests').get()).toEqual({ count: 0 });
    expect(context.database.prepare('SELECT status FROM gateway_connections WHERE id = ?').get(connectionId)).toEqual({ status: 'unknown' });
  });

  it('rolls back health status when the health audit cannot be appended', async () => {
    const { context, connectionId } = setup();
    context.database.exec(`CREATE TRIGGER fail_gateway_health_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'gateway.connection.health' AND NEW.outcome = 'allowed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const service = new GatewayService(context, { fetchImpl: async () => new Response('{}', { status: 200 }) });

    await expect(service.health(connectionId, 'team-1', 'user-1')).rejects.toThrow('audit unavailable');
    expect(context.database.prepare('SELECT status FROM gateway_connections WHERE id = ?').get(connectionId)).toEqual({ status: 'unknown' });
  });

  it('parses JSONL, normalizes and redacts, then deduplicates by hash', () => {
    const { service, connectionId } = setup();
    const input = '{"request_id":"r1","provider":"p","model":"m","status_code":200,"usage":{"input_tokens":2},"authorization":"Bearer secret","email":"person@example.com"}';
    expect(parseCliProxyRecords(input)).toHaveLength(1);
    const first = service.ingest(connectionId, input);
    const second = service.ingest(connectionId, input);
    expect(first.inserted).toBe(1);
    expect(second.duplicates).toBe(1);
    const row = service.listRequests({ connectionId }).items[0]!;
    expect(JSON.stringify(row)).not.toContain('Bearer secret');
    expect(JSON.stringify(row)).not.toContain('person@example.com');
  });

  it('supports filters and offset pagination', () => {
    const { service, connectionId } = setup();
    service.ingest(connectionId, [
      { request_id: 'a', provider: 'p', model: 'one', status_code: 200 },
      { request_id: 'b', provider: 'p', model: 'two', status_code: 500 },
    ]);
    expect(service.listRequests({ connectionId, failed: true }).total).toBe(1);
    expect(service.listRequests({ connectionId, limit: 1 }).nextOffset).toBe(1);
  });

  it('normalizes account quota and records approximate project correlation', () => {
    const { service, context, connectionId } = setup();
    const occurredAt = '2026-01-01T00:00:00.000Z';
    context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', occurredAt, occurredAt);
    context.database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-1', 'project-1', 'Session', 'idle', 'user-1', occurredAt, occurredAt);
    service.ingest(connectionId, { request_id: 'quota-1', occurred_at: occurredAt, provider: 'p', model: 'm', project_id: 'project-1', account: { id: 'acct', quota: { remaining: 0 }, status: 'cooldown', cooldown_until: '2099-01-01T00:00:00.000Z' } });
    const request = service.listRequests({ connectionId }).items[0]!;
    expect(request.correlationConfidence).toBe('medium');
    const summary = service.summary(connectionId);
    expect(summary.accounts[0]?.quota).toEqual({ remaining: 0 });
    expect(summary.capacity.coolingDown).toBe(1);
  });

  it('keeps native session correlation in the session project when metadata conflicts', () => {
    const { service, context, connectionId } = setup();
    const occurredAt = '2026-01-01T00:00:00.000Z';
    for (const [id, name] of [['project-a', 'Project A'], ['project-b', 'Project B']] as const) {
      context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'team-1', name, 'user-1', occurredAt, occurredAt);
    }
    context.database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', 'project-a', 'Session A', 'idle', 'user-1', occurredAt, occurredAt);

    service.ingest(connectionId, { request_id: 'native-mismatch', session_id: 'session-a', project_id: 'project-b', occurred_at: occurredAt, provider: 'p', model: 'm' });
    service.ingest(connectionId, { request_id: 'native-match', session_id: 'session-a', project_id: 'project-a', occurred_at: occurredAt, provider: 'p', model: 'm' });

    const requests = service.listRequests({ connectionId }).items;
    const mismatch = requests.find((request) => request.requestId === 'native-mismatch');
    const match = requests.find((request) => request.requestId === 'native-match');
    expect(mismatch).toMatchObject({ sessionId: 'session-a', projectId: 'project-a', correlationConfidence: 'exact' });
    expect(mismatch?.correlationReason).toBe('native session id; conflicting project reference ignored');
    expect(match).toMatchObject({ sessionId: 'session-a', projectId: 'project-a', correlationConfidence: 'exact', correlationReason: 'native session id' });
    expect(context.database.prepare('SELECT project_id FROM event_log WHERE aggregate_id = ?').all(mismatch?.eventHash)).toEqual([{ project_id: 'project-a' }]);
  });

  it('rolls back request and account writes when progress event append fails', () => {
    const { service, context, connectionId } = setup();
    const occurredAt = '2026-01-01T00:00:00.000Z';
    context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', occurredAt, occurredAt);
    const append = vi.spyOn(context.events, 'append').mockImplementation(() => { throw new Error('forced event append failure'); });

    expect(() => service.ingest(connectionId, {
      request_id: 'append-failure', occurred_at: occurredAt, provider: 'p', model: 'm', project_id: 'project-1',
      account: { id: 'acct', status: 'healthy', quota: { remaining: 10 } },
    })).toThrow('Gateway records could not be ingested');
    expect(append).toHaveBeenCalledTimes(1);
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_requests').get()).toEqual({ count: 0 });
    expect(context.database.prepare('SELECT count(*) AS count FROM gateway_accounts').get()).toEqual({ count: 0 });
    append.mockRestore();
  });

  it('does not correlate records to projects or sessions from another team', () => {
    const { service, context, connectionId } = setup();
    const occurredAt = '2026-01-01T00:00:00.000Z';
    context.database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-2', 'Other Team', occurredAt);
    context.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-2', 'team-2', 'Other Project', 'user-1', occurredAt, occurredAt);
    context.database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-2', 'project-2', 'Other Session', 'idle', 'user-1', occurredAt, occurredAt);

    service.ingest(connectionId, [
      { request_id: 'foreign-project', occurred_at: occurredAt, provider: 'p', model: 'm', project_id: 'project-2' },
      { request_id: 'foreign-session', occurred_at: occurredAt, provider: 'p', model: 'm', session_id: 'session-2', project_id: 'project-2' },
    ]);

    const requests = service.listRequests({ connectionId }).items;
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.sessionId === null && request.projectId === null && request.correlationConfidence === 'none')).toBe(true);
    expect(context.database.prepare('SELECT count(*) AS count FROM event_log').get()).toEqual({ count: 0 });
  });

  it('sanitizes legacy connection URLs and error summaries before listing', () => {
    const { service, context } = setup();
    const now = '2026-01-01T00:00:00.000Z';
    context.database.prepare(`INSERT INTO gateway_connections(id, team_id, name, base_url, enabled, status, last_error_summary, retention_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      'legacy-connection', 'team-1', 'Legacy', 'https://alice:password@example.invalid/gateway?token=url-secret#fragment', 'unavailable',
      'upstream https://bob:secret@example.invalid/v1?token=summary-secret Bearer bearer-secret', 30, now, now,
    );

    const legacy = service.listConnections('team-1').find((connection) => connection.id === 'legacy-connection');
    expect(legacy).toMatchObject({ baseUrl: 'https://example.invalid/gateway', lastErrorSummary: 'upstream https://example.invalid/v1?token=[REDACTED] [REDACTED]' });
    expect(JSON.stringify(legacy)).not.toContain('password');
    expect(JSON.stringify(legacy)).not.toContain('url-secret');
    expect(JSON.stringify(legacy)).not.toContain('summary-secret');
    expect(JSON.stringify(legacy)).not.toContain('bearer-secret');
  });

  it('rejects oversized gateway management responses before parsing', async () => {
    const { context, connectionId } = setup();
    const contentLengthService = new GatewayService(context, { fetchImpl: async () => new Response('ok', { status: 200, headers: { 'content-length': String(512 * 1024 + 1) } }) });
    await expect(contentLengthService.health(connectionId)).rejects.toMatchObject({ status: 503, code: 'gateway_response_too_large' });

    const oversized = 'x'.repeat(512 * 1024 + 1);
    const streamingService = new GatewayService(context, { fetchImpl: async () => new Response(oversized, { status: 200 }) });
    await expect(streamingService.health(connectionId)).rejects.toMatchObject({ status: 503, code: 'gateway_response_too_large' });
  });

  it('keeps explicit zero pricing and uses a strict context threshold', () => {
    const base = { id: 'x', connectionId: 'c', modelPattern: 'm', effectiveFrom: '2026-01-01T00:00:00.000Z', promptMicrousdPerMillion: 0, completionMicrousdPerMillion: 2_000_000, cacheReadMicrousdPerMillion: null, cacheCreateMicrousdPerMillion: null, contextThresholdTokens: 10, serviceTier: null } as const;
    expect(selectPriceOverride('m', '2026-01-01T00:00:00.000Z', undefined, 10, [base])).toBeUndefined();
    expect(calculateGatewayCostMicrousd({ model: 'm', occurredAt: '2026-01-01T00:00:00.000Z', contextTokens: 11, serviceTier: undefined, inputTokens: 10, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0 }, [base])).toBe(2);
  });

  it('keeps every consumed queue record and requires explicit acknowledgement of upstream data loss', async () => {
    const { context, connectionId } = setup();
    const records = Array.from({ length: 101 }, (_, index) => ({ request_id: `queue-${index}`, provider: 'p', model: 'm', usage: { input_tokens: 1 } }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('usage-queue') ? records : {})));
    const service = new GatewayService(context, { fetchImpl });
    await expect(service.sync(connectionId, 'team-1', { includeUsageQueue: true })).rejects.toMatchObject({ code: 'gateway_queue_data_loss_consent_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await service.sync(connectionId, 'team-1', { includeUsageQueue: true, acceptDataLoss: true }, 'user-1');
    expect(result).toMatchObject({ received: 101, inserted: 101 });
    expect(service.summary(connectionId).totals.inputTokens).toBe(101);
  });

  it('validates record objects and preserves single-record usage, timestamps, and unknown prices', () => {
    const { service, connectionId } = setup();
    expect(() => service.ingest(connectionId, [null])).toThrow('record objects');
    expect(() => service.ingest(connectionId, [42])).toThrow('record objects');
    service.createPriceOverride('team-1', { connectionId, modelPattern: 'm', effectiveFrom: '2026-09-05T14:00:00+02:00', promptMicrousdPerMillion: 1_000_000 }, 'user-1');
    service.ingest(connectionId, { request_id: 'offset', occurred_at: '2026-09-05T13:00:00.000Z', provider: 'p', model: 'm', usage: { input_tokens: 20 } });
    service.ingest(connectionId, { request_id: 'unknown', occurred_at: '2026-09-05T13:00:00.000Z', provider: 'p', model: 'other', usage: { input_tokens: 20 } });
    expect(service.listRequests({ connectionId }).items.find((entry) => entry.requestId === 'offset')).toMatchObject({ model: 'm', inputTokens: 20, estimatedCostMicrousd: 20 });
    expect(service.listRequests({ connectionId }).items.find((entry) => entry.requestId === 'unknown')?.estimatedCostMicrousd).toBeNull();
    expect(redactGatewayMetadata({ 'https://upstream.invalid|opaqueCredential': { count: 2 }, remaining: 3 })).toEqual({ remaining: 3 });
  });

  it('rejects disallowed hosts and exposes no raw secret in metadata', () => {
    expect(() => validateGatewayUrl('http://169.254.169.254', new Set(['127.0.0.1']))).toThrow();
    const normalized = normalizeCliProxyRecord({ provider: 'p', model: 'm', metadata: { cookie: 'sid=secret', email: 'person@example.com' } }, '2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(redactGatewayMetadata(normalized.metadata))).not.toContain('person@example.com');
    expect(gatewayEventHash(normalized)).toHaveLength(64);
  });
});
