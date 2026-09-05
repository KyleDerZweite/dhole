import { z } from 'zod';

const optionalText = z.string().nullable().optional();
const optionalNumber = z.number().nullable().optional();

export const ConnectionSchema = z.object({
  id: z.string(), name: z.string(), baseUrl: z.string(), providerId: optionalText,
  enabled: z.boolean(), status: z.string(), revision: z.number().int(), retentionDays: z.number(),
  archivedAt: optionalText, deletedAt: optionalText, lastCheckedAt: optionalText, lastErrorSummary: optionalText,
  managementConfigured: z.boolean(), catalogConfigured: z.boolean(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const RevisionSchema = z.object({
  revision: z.number(), action: z.string(), createdAt: z.string(), actorId: optionalText,
  metadata: z.object({ name: z.string(), baseUrl: z.string(), enabled: z.boolean(), retentionDays: z.number(), archivedAt: optionalText, deletedAt: optionalText }),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const AccountSchema = z.object({
  id: z.string(), authIndex: z.string(), provider: z.string(), label: optionalText,
  status: z.string(), quota: z.record(z.string(), z.unknown()), cooldownUntil: optionalText,
  connectionId: z.string().optional(), disabled: z.boolean().optional(), managementSupported: z.boolean().optional(), observedAt: optionalText,
});
export type Account = z.infer<typeof AccountSchema>;

export const RequestSchema = z.object({
  schemaVersion: z.number().optional(), eventHash: z.string().optional(), connectionId: z.string().optional(), requestId: optionalText,
  id: z.string(), occurredAt: z.string(), provider: z.string(), model: z.string(), requestedModel: optionalText,
  authIndex: optionalText, statusCode: optionalNumber, failed: z.boolean(), failureCategory: optionalText,
  failureSummary: optionalText, durationMs: optionalNumber, ttftMs: optionalNumber,
  inputTokens: z.number(), outputTokens: z.number(), estimatedCostMicrousd: optionalNumber,
  correlationConfidence: optionalText, correlationReason: optionalText, sessionId: optionalText, projectId: optionalText,
  accountId: optionalText, endpoint: optionalText, reasoningTokens: optionalNumber, cachedTokens: optionalNumber, cacheCreationTokens: optionalNumber,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const RequestPageSchema = z.object({ items: z.array(RequestSchema), total: z.number(), offset: z.number(), limit: z.number(), nextOffset: z.number().nullable() });
export type RequestPage = z.infer<typeof RequestPageSchema>;

export const CollectionSchema = z.object({
  connectionId: z.string(), mode: z.literal('push_or_import'), automaticCollection: z.literal(false),
  queueConsumption: z.literal('explicit_only'), status: z.enum(['no_records', 'history_available', 'history_pruned']),
  lastStoredAt: optionalText, totalStored: z.number(), retainedRequests: z.number(),
  oldestRetainedAt: optionalText, newestRetainedAt: optionalText, retentionDays: z.number(), message: z.string(),
});
export type Collection = z.infer<typeof CollectionSchema>;

export const UsageSchema = z.object({
  bucket: z.enum(['hour', 'day']), groupBy: z.enum(['none', 'provider', 'model', 'authIndex']), truncated: z.boolean(),
  items: z.array(z.object({
    bucketStart: z.string(), group: z.string().nullable(), requests: z.number(), failures: z.number(),
    inputTokens: z.number(), outputTokens: z.number(), estimatedCostMicrousd: z.number().nullable(),
    unpricedRequests: z.number(), averageDurationMs: z.number().nullable(), measuredRequests: z.number(),
    averageTtftMs: z.number().nullable(),
  })),
});
export type Usage = z.infer<typeof UsageSchema>;

const ModelSchema = z.object({
  modelId: z.string(), modelKey: z.string(), displayName: z.string(), enabled: z.boolean(), available: z.boolean(),
  declared: z.object({
    owner: z.string().optional(), contextWindow: z.number().optional(), maxOutputTokens: z.number().optional(),
    inputModalities: z.array(z.string()).optional(), outputModalities: z.array(z.string()).optional(),
    reasoningLevels: z.array(z.string()).optional(), defaultReasoningLevel: z.string().optional(),
    parallelToolCalls: z.boolean().optional(), capabilities: z.record(z.string(), z.boolean()).optional(),
  }),
  measuredCapabilities: z.record(z.string(), z.enum(['supported', 'unsupported', 'unknown'])),
  compatibility: z.object({ generic: z.boolean(), opencode: z.boolean(), codex: z.boolean() }),
});
export const CatalogSchema = z.object({
  schemaVersion: z.literal(1), connectionId: z.string(), providerId: z.string(),
  connectionEnabled: z.boolean(), providerEnabled: z.boolean(), status: z.enum(['unobserved', 'current', 'stale', 'error']),
  stale: z.boolean(), lastAttemptAt: optionalText, lastSuccessAt: optionalText,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  snapshot: z.object({
    id: z.string(), schemaVersion: z.literal(1), observedAt: z.string(), contentHash: z.string(),
    source: z.object({ connectionId: z.string(), providerId: z.string(), baseUrl: z.string(), endpoint: z.string(), shape: z.enum(['openai', 'codex']), clientVersion: z.string().nullable() }),
    diff: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }),
  }).nullable(),
  models: z.array(ModelSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;
export const CatalogTokenSchema = z.object({ id: z.string(), name: z.string(), client: z.enum(['generic', 'opencode', 'codex']), createdAt: z.string(), expiresAt: z.string(), lastUsedAt: optionalText, revokedAt: optionalText });
export type CatalogToken = z.infer<typeof CatalogTokenSchema>;

const SettingSchema = z.enum(['request-retry', 'max-retry-credentials', 'max-retry-interval', 'routing/strategy']);
const ConfigValuesSchema = z.object({ 'request-retry': z.number(), 'max-retry-credentials': z.number(), 'max-retry-interval': z.number(), 'routing/strategy': z.enum(['round-robin', 'weighted-round-robin', 'fill-first']) });
export const ConfigSchema = z.object({ values: ConfigValuesSchema, revision: z.string(), observedAt: z.string(), concurrency: z.literal('best-effort') });
export type GatewayConfig = z.infer<typeof ConfigSchema>;
export const ConfigPreviewSchema = z.object({ before: ConfigValuesSchema, after: ConfigValuesSchema, changes: z.array(z.object({ setting: SettingSchema, before: z.union([z.string(), z.number()]), after: z.union([z.string(), z.number()]) })), revision: z.string(), concurrency: z.literal('best-effort') });
export type ConfigPreview = z.infer<typeof ConfigPreviewSchema>;
export type ConfigChange = { expectedRevision: number; expectedConfigRevision: string; setting: z.infer<typeof SettingSchema>; value: number | string };
export const ManagementHistorySchema = z.array(z.object({ id: z.string(), action: z.string(), before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()), outcome: z.string(), actorId: z.string(), createdAt: z.string() }));
export type ManagementHistory = z.infer<typeof ManagementHistorySchema>;
export const OAuthFlowSchema = z.object({ id: z.string(), provider: z.enum(['codex', 'anthropic', 'antigravity']), status: z.enum(['pending', 'submitted', 'complete', 'error', 'expired', 'cancelled']), createdAt: z.string(), expiresAt: z.string(), updatedAt: z.string() });
export type OAuthFlow = z.infer<typeof OAuthFlowSchema>;

export type ConnectionInput = { name: string; baseUrl: string; enabled: boolean; retentionDays: number; managementSecret: string; catalogSecret?: string };
export type ConnectionUpdate = { expectedRevision: number; name?: string; baseUrl?: string; enabled?: boolean; retentionDays?: number };
export type RequestFilters = { connectionId: string; provider?: string; model?: string; authIndex?: string; failed?: string; statusCode?: string; occurredFrom?: string; occurredTo?: string; correlationConfidence?: string };
