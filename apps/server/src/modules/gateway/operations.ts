import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, DholeApp, ServerContext } from '../../lib/module.js';
import { recordAudit } from '../core/index.js';
import { redactGatewayMetadata, requestView, type DbRequestRow, type GatewayRequestView, type GatewayService } from './index.js';

const FilterSchema = z.object({
  connectionId: z.string().min(1).max(160).optional(),
  provider: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256).optional(),
  authIndex: z.string().min(1).max(128).optional(),
  failed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  occurredFrom: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  occurredTo: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  correlationConfidence: z.enum(['exact', 'high', 'medium', 'low', 'none']).optional(),
});
const UsageQuerySchema = FilterSchema.extend({
  bucket: z.enum(['hour', 'day']).default('day'),
  groupBy: z.enum(['none', 'provider', 'model', 'authIndex']).default('none'),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
});
const ExportQuerySchema = FilterSchema.extend({
  format: z.enum(['json', 'jsonl']).default('jsonl'),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const CursorSchema = z.object({
  version: z.literal(1),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
}).refine((value) => value.after <= value.through);
const PruneSchema = z.object({ limit: z.number().int().min(1).max(10_000).default(1_000), dryRun: z.boolean().default(false) }).strict();
const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const RETENTION_BATCH_LIMIT = 1_000;
const RETENTION_CONNECTION_LIMIT = 10;

type Filters = z.infer<typeof FilterSchema>;
export interface GatewayUsageBucket {
  bucketStart: string;
  group: string | null;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  estimatedCostMicrousd: number | null;
  unpricedRequests: number;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  measuredRequests: number;
  averageTtftMs: number | null;
}

function query<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(422, 'invalid_filter', 'Invalid gateway query parameters');
  return result.data;
}

function requestFilter(filters: Filters, teamId: string): { clause: string; values: Array<string | number> } {
  if (filters.occurredFrom && filters.occurredTo && filters.occurredFrom > filters.occurredTo) {
    throw new HttpError(422, 'invalid_filter', 'occurredFrom must not follow occurredTo');
  }
  const where = ['c.team_id = ?'];
  const values: Array<string | number> = [teamId];
  for (const [field, column] of Object.entries({ connectionId: 'connection_id', provider: 'provider', model: 'model', authIndex: 'auth_index', statusCode: 'status_code', correlationConfidence: 'correlation_confidence' }) as Array<[keyof Filters, string]>) {
    const value = filters[field];
    if (typeof value === 'string' || typeof value === 'number') { where.push(`r.${column} = ?`); values.push(value); }
  }
  if (filters.failed !== undefined) { where.push('r.failed = ?'); values.push(filters.failed ? 1 : 0); }
  if (filters.occurredFrom) { where.push('r.occurred_at >= ?'); values.push(filters.occurredFrom); }
  if (filters.occurredTo) { where.push('r.occurred_at <= ?'); values.push(filters.occurredTo); }
  return { clause: where.join(' AND '), values };
}

function actor(c: Context<AppEnvironment>, admin = false) {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'authentication_required', 'Authentication required');
  const credential = c.get('credential');
  if (admin && user.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'An administrator is required');
  if (credential && (credential.runId || !credential.permissions.includes(admin ? 'gateway:manage' : 'gateway:read'))) {
    throw new HttpError(403, 'token_scope_denied', 'The API token lacks the required gateway permission');
  }
  return user;
}

function pruneDetails(context: ServerContext, connection: { id: string; retention_days: number }, limit: number, dryRun: boolean, actorId?: string) {
  const cutoff = new Date(context.clock.now().getTime() - connection.retention_days * 86_400_000).toISOString();
  return context.database.transaction(() => {
    const eligible = actorId || dryRun
      ? (context.database.prepare('SELECT count(*) AS count FROM gateway_requests WHERE connection_id = ? AND occurred_at < ?').get(connection.id, cutoff) as { count: number }).count
      : null;
    if (dryRun) return { cutoff, dryRun: true, wouldDelete: Math.min(eligible ?? 0, limit), deleted: 0, remainingEligible: eligible, hasMore: (eligible ?? 0) > 0 };
    const deleted = context.database.prepare(`DELETE FROM gateway_requests WHERE id IN (
      SELECT id FROM gateway_requests WHERE connection_id = ? AND occurred_at < ? ORDER BY occurred_at, id LIMIT ?
    )`).run(connection.id, cutoff, limit).changes;
    const remainingEligible = eligible === null ? null : eligible - deleted;
    const hasMore = remainingEligible === null
      ? Boolean(context.database.prepare('SELECT 1 FROM gateway_requests WHERE connection_id = ? AND occurred_at < ? LIMIT 1').get(connection.id, cutoff))
      : remainingEligible > 0;
    if (deleted || actorId) recordAudit(context, { actorType: actorId ? 'user' : 'system', ...(actorId ? { actorId } : {}), action: 'gateway.retention.prune', targetType: 'gateway_connection', targetId: connection.id, outcome: 'allowed', detail: { cutoff, deleted, hasMore, ...(remainingEligible === null ? {} : { remainingEligible }) } });
    return { cutoff, dryRun: false, wouldDelete: deleted, deleted, remainingEligible, hasMore };
  })();
}

export function startGatewayRetention(context: ServerContext): { maintenance(): void } {
  let nextRunAt = 0;
  let afterId = '';
  return {
    maintenance() {
      if (context.clock.now().getTime() < nextRunAt) return;
      const connections = context.database.prepare('SELECT id, retention_days FROM gateway_connections WHERE id > ? ORDER BY id LIMIT ?').all(afterId, RETENTION_CONNECTION_LIMIT) as Array<{ id: string; retention_days: number }>;
      let failed = false;
      for (const connection of connections) {
        try { pruneDetails(context, connection, RETENTION_BATCH_LIMIT, false); }
        catch { failed = true; }
        afterId = connection.id;
      }
      if (connections.length < RETENTION_CONNECTION_LIMIT) {
        nextRunAt = context.clock.now().getTime() + RETENTION_INTERVAL_MS;
        afterId = '';
      }
      if (failed) throw new HttpError(503, 'gateway_retention_failed', 'Gateway retention failed for one or more connections');
    },
  };
}

export class GatewayOperations {
  constructor(private readonly context: ServerContext, private readonly service: GatewayService) {}

  usage(teamId: string, input: unknown = {}) {
    const options = query(UsageQuerySchema, input);
    if (options.connectionId) this.service.assertConnection(options.connectionId, teamId);
    const filter = requestFilter(options, teamId);
    const bucket = options.bucket === 'hour' ? '%Y-%m-%dT%H:00:00.000Z' : '%Y-%m-%dT00:00:00.000Z';
    const group = { none: 'NULL', provider: 'r.provider', model: 'r.model', authIndex: 'r.auth_index' }[options.groupBy];
    const rows = this.context.database.prepare(`
      SELECT strftime('${bucket}', r.occurred_at) AS bucketStart, ${group} AS "group",
        count(*) AS requests, sum(r.failed) AS failures,
        sum(r.input_tokens) AS inputTokens, sum(r.output_tokens) AS outputTokens,
        sum(r.reasoning_tokens) AS reasoningTokens, sum(r.cached_tokens) AS cachedTokens,
        sum(r.cache_creation_tokens) AS cacheCreationTokens,
        sum(r.estimated_cost_microusd) AS estimatedCostMicrousd,
        sum(r.estimated_cost_microusd IS NULL) AS unpricedRequests,
        avg(r.duration_ms) AS averageDurationMs, max(r.duration_ms) AS maxDurationMs,
        count(r.duration_ms) AS measuredRequests, avg(r.ttft_ms) AS averageTtftMs
      FROM gateway_requests r JOIN gateway_connections c ON c.id = r.connection_id
      WHERE ${filter.clause}
      GROUP BY bucketStart, "group" ORDER BY bucketStart DESC, "group" LIMIT ?
    `).all(...filter.values, options.limit + 1) as GatewayUsageBucket[];
    return { bucket: options.bucket, groupBy: options.groupBy, items: rows.slice(0, options.limit).reverse(), truncated: rows.length > options.limit };
  }

  exportRequests(teamId: string, input: unknown = {}) {
    const options = query(ExportQuerySchema, input);
    if (options.connectionId) this.service.assertConnection(options.connectionId, teamId);
    const filters = FilterSchema.parse(input);
    const filter = requestFilter(filters, teamId);
    const scope = createHash('sha256').update(JSON.stringify({ teamId, filters })).digest('hex');
    let after = 0;
    let through: number;
    if (options.cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as unknown; }
      catch { throw new HttpError(422, 'invalid_cursor', 'Invalid gateway export cursor'); }
      const cursor = CursorSchema.safeParse(decoded);
      if (!cursor.success || cursor.data.scope !== scope) throw new HttpError(422, 'invalid_cursor', 'Gateway export cursor does not match the filters');
      after = cursor.data.after;
      through = cursor.data.through;
    } else {
      through = (this.context.database.prepare(`SELECT coalesce(max(g.sequence), 0) AS sequence FROM gateway_request_receipts g
        JOIN gateway_connections c ON c.id = g.connection_id WHERE c.team_id = ?`).get(teamId) as { sequence: number }).sequence;
    }
    const rows = this.context.database.prepare(`
      SELECT r.*, g.sequence FROM gateway_requests r
      JOIN gateway_connections c ON c.id = r.connection_id
      JOIN gateway_request_receipts g ON g.connection_id = r.connection_id AND g.event_hash = r.event_hash
      WHERE ${filter.clause} AND g.sequence > ? AND g.sequence <= ? ORDER BY g.sequence LIMIT ?
    `).all(...filter.values, after, through, options.limit + 1) as Array<DbRequestRow & { connection_id: string; sequence: number }>;
    const items: Array<GatewayRequestView & { connectionId: string }> = [];
    let bytes = 0;
    for (const row of rows.slice(0, options.limit)) {
      const view = requestView(row);
      const item: GatewayRequestView & { connectionId: string } = { ...view, connectionId: row.connection_id, metadata: redactGatewayMetadata(view.metadata) };
      for (const [key, value] of Object.entries(item)) if (typeof value === 'string') item[key] = redactGatewayMetadata({ value }).value;
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes + itemBytes > 2 * 1024 * 1024) {
        if (!items.length) throw new HttpError(413, 'gateway_export_record_too_large', 'A gateway record exceeds the export page size');
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    const last = rows[items.length - 1];
    const nextCursor = rows.length > items.length && last
      ? Buffer.from(JSON.stringify({ version: 1, after: last.sequence, through, scope })).toString('base64url')
      : null;
    return { items, nextCursor, format: options.format };
  }

  collection(connectionId: string, teamId: string) {
    const connection = this.service.getConnection(connectionId, teamId);
    const receipt = this.context.database.prepare('SELECT max(ingested_at) AS lastStoredAt, count(*) AS totalStored FROM gateway_request_receipts WHERE connection_id = ?').get(connectionId) as { lastStoredAt: string | null; totalStored: number };
    const history = this.context.database.prepare('SELECT count(*) AS retainedRequests, min(occurred_at) AS oldestRetainedAt, max(occurred_at) AS newestRetainedAt FROM gateway_requests WHERE connection_id = ?').get(connectionId) as { retainedRequests: number; oldestRetainedAt: string | null; newestRetainedAt: string | null };
    return {
      connectionId, mode: 'push_or_import' as const, automaticCollection: false, queueConsumption: 'explicit_only' as const,
      status: !receipt.totalStored ? 'no_records' as const : history.retainedRequests ? 'history_available' as const : 'history_pruned' as const,
      ...receipt, ...history, retentionDays: connection.retention_days,
      automaticRetention: true, retentionIntervalSeconds: RETENTION_INTERVAL_MS / 1_000, retentionBatchLimit: RETENTION_BATCH_LIMIT,
      message: receipt.totalStored
        ? `${history.retainedRequests ? 'Stored usage is available.' : 'All stored request details have been pruned.'} No background collector runs; freshness depends on pushed or imported records. Queue consumption requires an explicit operator action.`
        : 'No usage has been stored. No background collector runs. Push or import records to collect usage; a health check does not collect requests.',
    };
  }

  prune(connectionId: string, teamId: string, actorId: string, input: unknown) {
    const options = query(PruneSchema, input);
    const connection = this.service.getConnection(connectionId, teamId);
    return pruneDetails(this.context, connection, options.limit, options.dryRun, actorId);
  }
}

export function registerGatewayOperationsRoutes(app: DholeApp, context: ServerContext, service: GatewayService): void {
  const operations = new GatewayOperations(context, service);
  app.get('/api/gateway/usage', (c) => c.json(operations.usage(actor(c).teamId, c.req.query())));
  app.get('/api/gateway/requests/export', (c) => {
    const result = operations.exportRequests(actor(c).teamId, c.req.query());
    c.header('Cache-Control', 'no-store');
    if (result.format === 'json') return c.json({ items: result.items, nextCursor: result.nextCursor });
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="gateway-requests.jsonl"');
    if (result.nextCursor) c.header('X-Next-Cursor', result.nextCursor);
    return c.body(result.items.map((item) => JSON.stringify(item)).join('\n') + (result.items.length ? '\n' : ''));
  });
  app.get('/api/gateway/connections/:id/collection', (c) => c.json(operations.collection(c.req.param('id'), actor(c).teamId)));
  app.post('/api/gateway/connections/:id/prune', async (c) => {
    const user = actor(c, true);
    const input = await parseJson(c, PruneSchema);
    return c.json(operations.prune(c.req.param('id'), user.teamId, user.id, input));
  });
}
