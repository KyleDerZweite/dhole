import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { redactText, decryptSecret, encryptSecret } from '../../lib/security.js';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AuthenticatedUser, DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { recordAudit } from '../core/index.js';

/** A deliberately small, permissive boundary for the formats emitted by CLIProxyAPI. */
export const CliProxyRecordSchema = z.record(z.string(), z.unknown());

export const GatewayConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(1).max(2_048),
  managementSecret: z.string().min(1).max(16_384),
  enabled: z.boolean().optional().default(true),
  retentionDays: z.number().int().min(1).max(3_650).optional().default(30),
});

export const GatewayPriceOverrideSchema = z.object({
  connectionId: z.string().min(1).optional(),
  modelPattern: z.string().trim().min(1).max(256),
  effectiveFrom: z.string().datetime({ offset: true }),
  promptMicrousdPerMillion: z.number().int().min(0).nullable().optional(),
  completionMicrousdPerMillion: z.number().int().min(0).nullable().optional(),
  cacheReadMicrousdPerMillion: z.number().int().min(0).nullable().optional(),
  cacheCreateMicrousdPerMillion: z.number().int().min(0).nullable().optional(),
  contextThresholdTokens: z.number().int().min(0).nullable().optional(),
  serviceTier: z.string().trim().min(1).max(80).nullable().optional(),
});

export type GatewayConnectionInput = z.infer<typeof GatewayConnectionInputSchema>;
export type GatewayPriceOverrideInput = z.infer<typeof GatewayPriceOverrideSchema>;

export interface NormalizedGatewayRequest {
  requestId?: string | undefined;
  occurredAt: string;
  provider: string;
  model: string;
  requestedModel?: string | undefined;
  authIndex?: string | undefined;
  account?: {
    id?: string | undefined;
    label?: string | undefined;
    source?: string | undefined;
    status?: string | undefined;
    statusMessage?: string | undefined;
    quota?: Record<string, unknown> | undefined;
    cooldownUntil?: string | undefined;
  };
  endpoint?: string | undefined;
  statusCode?: number | undefined;
  failed: boolean;
  failureCategory?: string | undefined;
  failureSummary?: string | undefined;
  durationMs?: number | undefined;
  ttftMs?: number | undefined;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  estimatedCostMicrousd?: number | undefined;
  sessionId?: string | undefined;
  projectId?: string | undefined;
  serviceTier?: string | undefined;
  contextTokens?: number | undefined;
  traceReference?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  accountUpdates: number;
  requestHashes: string[];
}

export interface GatewayFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface GatewayServiceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GatewayRequestFilters {
  connectionId?: string;
  provider?: string;
  model?: string;
  authIndex?: string;
  failed?: boolean;
  statusCode?: number;
  occurredFrom?: string;
  occurredTo?: string;
  correlationConfidence?: 'exact' | 'high' | 'medium' | 'low' | 'none';
  limit?: number;
  offset?: number;
}

export interface GatewayRequestView extends Record<string, unknown> {
  id: string;
  eventHash: string;
  schemaVersion: number;
  requestId: string | null;
  occurredAt: string;
  provider: string;
  model: string;
  requestedModel: string | null;
  accountId: string | null;
  authIndex: string | null;
  endpoint: string | null;
  statusCode: number | null;
  failed: boolean;
  failureCategory: string | null;
  failureSummary: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  estimatedCostMicrousd: number | null;
  sessionId: string | null;
  projectId: string | null;
  correlationConfidence: string | null;
  correlationReason: string | null;
  metadata: Record<string, unknown>;
}

export interface GatewaySummary {
  totals: {
    requests: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    estimatedCostMicrousd: number;
    averageDurationMs: number | null;
  };
  providers: Array<{ provider: string; requests: number; failures: number; estimatedCostMicrousd: number }>;
  models: Array<{ model: string; requests: number; failures: number; estimatedCostMicrousd: number }>;
  accounts: Array<{
    id: string;
    authIndex: string;
    provider: string;
    label: string | null;
    status: string;
    quota: Record<string, unknown>;
    cooldownUntil: string | null;
  }>;
  capacity: { accounts: number; available: number; coolingDown: number; failed: number };
}

export interface PriceOverride {
  id: string;
  connectionId: string;
  modelPattern: string;
  effectiveFrom: string;
  promptMicrousdPerMillion: number | null;
  completionMicrousdPerMillion: number | null;
  cacheReadMicrousdPerMillion: number | null;
  cacheCreateMicrousdPerMillion: number | null;
  contextThresholdTokens: number | null;
  serviceTier: string | null;
}

interface DbConnectionRow {
  id: string;
  team_id: string;
  name: string;
  base_url: string;
  secret_id: string | null;
  enabled: number;
  status: string;
  last_checked_at: string | null;
  last_error_summary: string | null;
  retention_days: number;
  created_at: string;
  updated_at: string;
}

interface DbRequestRow {
  id: string;
  event_hash: string;
  schema_version: number;
  request_id: string | null;
  occurred_at: string;
  provider: string;
  model: string;
  requested_model: string | null;
  account_id: string | null;
  auth_index: string | null;
  endpoint: string | null;
  status_code: number | null;
  failed: number;
  failure_category: string | null;
  failure_summary: string | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_microusd: number | null;
  session_id: string | null;
  project_id: string | null;
  correlation_confidence: string | null;
  correlation_reason: string | null;
  redacted_metadata_json: string;
}

interface DbAccountRow {
  id: string;
  auth_index: string;
  provider: string;
  label: string | null;
  status: string;
  quota_json: string;
  cooldown_until: string | null;
}

interface DbPriceRow {
  id: string;
  connection_id: string;
  model_pattern: string;
  effective_from: string;
  prompt_microusd_per_million: number | null;
  completion_microusd_per_million: number | null;
  cache_read_microusd_per_million: number | null;
  cache_create_microusd_per_million: number | null;
  context_threshold_tokens: number | null;
  service_tier: string | null;
}

const MAX_LIST_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MANAGEMENT_RESPONSE_BYTES = 512 * 1024;
const REDACT_KEY = /(?:authorization|cookie|token|secret|password|api[-_]?key|bearer|credential|body|prompt|completion|content)/i;
const REDACT_COOKIE = /\b(?:cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi;
const REDACT_KEY_VALUE = /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password)\s*[:=]\s*[^\s,;]+/gi;
const REDACT_URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu;
const REDACT_SUMMARY_KEY_VALUE = /\b((?:token|secret|credential|api[-_]?key))\s*[:=]\s*[^\s,;]+/gi;

function nowIso(context: ServerContext): string {
  return context.clock.now().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return undefined;
}

function text(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const result = redactText(String(value), max).replace(REDACT_COOKIE, '[REDACTED]').replace(REDACT_KEY_VALUE, '[REDACTED]').trim();
  return result || undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Math.max(0, Math.round(Number(value)));
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', '1', 'yes'].includes(value.trim().toLowerCase())) return true;
  if (typeof value === 'string' && ['false', '0', 'no'].includes(value.trim().toLowerCase())) return false;
  return undefined;
}

function iso(value: unknown, fallback: string): string {
  const date = typeof value === 'number' ? new Date(value < 10_000_000_000 ? value * 1_000 : value) : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value, 2_048).replace(REDACT_COOKIE, '[REDACTED]').replace(REDACT_KEY_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (REDACT_KEY.test(key)) output[key] = '[REDACTED]';
    else output[key] = redactValue(entry, depth + 1);
  }
  return output;
}

export function redactGatewayMetadata(value: unknown): Record<string, unknown> {
  return asRecord(redactValue(value));
}

/** Exact host allowlisting prevents the gateway from becoming an SSRF primitive. */
export function validateGatewayUrl(raw: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, 'invalid_gateway_url', 'Gateway URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const allowed = [...allowedHosts].map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!allowed.includes(host) && !allowed.includes(url.host.toLowerCase()))) {
    throw new HttpError(422, 'gateway_url_not_allowed', 'Gateway URL is not allowed');
  }
  if (url.search || url.hash) throw new HttpError(422, 'gateway_url_not_allowed', 'Gateway URL must not contain query or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function publicGatewayBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function redactGatewaySummary(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return redactText(value.replace(REDACT_URL_CREDENTIALS, '$1'), 1_024).replace(REDACT_SUMMARY_KEY_VALUE, '$1=[REDACTED]');
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_MANAGEMENT_RESPONSE_BYTES) {
    throw new HttpError(503, 'gateway_response_too_large', 'Gateway response exceeds 512 KiB');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let textBody = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_MANAGEMENT_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new HttpError(503, 'gateway_response_too_large', 'Gateway response exceeds 512 KiB');
      }
      textBody += decoder.decode(chunk.value, { stream: true });
    }
    return textBody + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function gatewayEventHash(record: NormalizedGatewayRequest): string {
  const stable = { ...record, metadata: redactGatewayMetadata(record.metadata) };
  return createHash('sha256').update(canonical(stable), 'utf8').digest('hex');
}

function normalizeQuota(value: unknown): Record<string, unknown> {
  return redactGatewayMetadata(value);
}

export function normalizeCliProxyRecord(rawValue: unknown, fallbackOccurredAt: string): NormalizedGatewayRequest {
  const raw = asRecord(rawValue);
  const usage = asRecord(first(raw, 'usage', 'token_usage', 'tokens'));
  const modelObject = asRecord(first(raw, 'model_info', 'model'));
  const account = asRecord(first(raw, 'account', 'auth', 'credential'));
  const statusCode = integer(first(raw, 'status_code', 'statusCode', 'http_status', 'httpStatus'));
  const errorValue = first(raw, 'error', 'failure', 'error_message', 'failure_message');
  const inputTokens = integer(first(usage, 'input_tokens', 'prompt_tokens', 'input', 'prompt')) ?? integer(first(raw, 'input_tokens', 'prompt_tokens')) ?? 0;
  const outputTokens = integer(first(usage, 'output_tokens', 'completion_tokens', 'output', 'completion')) ?? integer(first(raw, 'output_tokens', 'completion_tokens')) ?? 0;
  const reasoningTokens = integer(first(usage, 'reasoning_tokens', 'reasoning')) ?? integer(first(raw, 'reasoning_tokens')) ?? 0;
  const cachedTokens = integer(first(usage, 'cached_tokens', 'cache_read_tokens', 'prompt_cache_hit_tokens')) ?? integer(first(raw, 'cached_tokens', 'cache_read_tokens')) ?? 0;
  const cacheCreationTokens = integer(first(usage, 'cache_creation_tokens', 'cache_write_tokens')) ?? integer(first(raw, 'cache_creation_tokens', 'cache_write_tokens')) ?? 0;
  const durationMs = numberValue(first(raw, 'duration_ms', 'durationMs', 'latency_ms', 'duration'));
  const costMicrousd = numberValue(first(raw, 'estimated_cost_microusd', 'cost_microusd'));
  const costUsd = numberValue(first(raw, 'estimated_cost_usd', 'cost_usd', 'cost'));
  const provider = text(first(raw, 'provider', 'provider_name', 'upstream_provider', 'vendor'), 128) ?? text(first(modelObject, 'provider', 'provider_name'), 128) ?? 'unknown';
  const model = text(first(raw, 'model_name', 'model_key', 'served_model'), 256) ?? text(typeof first(raw, 'model') === 'string' ? first(raw, 'model') : first(modelObject, 'name', 'id', 'model'), 256) ?? 'unknown-model';
  const requestedModel = text(first(raw, 'requested_model', 'requestedModel', 'original_model'), 256);
  const authIndex = text(first(raw, 'auth_index', 'authIndex', 'account_index', 'accountIndex', 'credential_index'), 128) ?? text(first(account, 'auth_index', 'index', 'id'), 128);
  const failed = (booleanValue(first(raw, 'failed', 'is_failed')) ?? false) || (statusCode !== undefined && statusCode >= 400) || errorValue !== undefined;
  const metadata = { ...raw };
  for (const key of ['body', 'request_body', 'response_body', 'prompt', 'messages', 'completion', 'usage', 'token_usage', 'tokens', 'account', 'auth', 'credential']) delete metadata[key];
  const result: NormalizedGatewayRequest = {
    ...(text(first(raw, 'request_id', 'requestId', 'id', 'trace_id'), 256) ? { requestId: text(first(raw, 'request_id', 'requestId', 'id', 'trace_id'), 256) } : {}),
    occurredAt: iso(first(raw, 'occurred_at', 'occurredAt', 'timestamp', 'created_at', 'time'), fallbackOccurredAt),
    provider,
    model,
    ...(requestedModel ? { requestedModel } : {}),
    ...(authIndex ? { authIndex } : {}),
    ...(text(first(raw, 'endpoint', 'path', 'route', 'url'), 512) ? { endpoint: text(first(raw, 'endpoint', 'path', 'route', 'url'), 512) } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    failed,
    ...(failed && text(errorValue, 1_024) ? { failureSummary: text(errorValue, 1_024) } : {}),
    ...(failed && text(first(raw, 'failure_category', 'failureCategory', 'error_type', 'category'), 128) ? { failureCategory: text(first(raw, 'failure_category', 'failureCategory', 'error_type', 'category'), 128) } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}),
    ...(numberValue(first(raw, 'ttft_ms', 'ttftMs', 'time_to_first_token_ms')) !== undefined ? { ttftMs: Math.max(0, Math.round(numberValue(first(raw, 'ttft_ms', 'ttftMs', 'time_to_first_token_ms'))!)) } : {}),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheCreationTokens,
    ...(costMicrousd !== undefined ? { estimatedCostMicrousd: Math.max(0, Math.round(costMicrousd)) } : costUsd !== undefined ? { estimatedCostMicrousd: Math.max(0, Math.round(costUsd * 1_000_000)) } : {}),
    ...(text(first(raw, 'session_id', 'sessionId', 'native_session_id'), 256) ? { sessionId: text(first(raw, 'session_id', 'sessionId', 'native_session_id'), 256) } : {}),
    ...(text(first(raw, 'project_id', 'projectId'), 256) ? { projectId: text(first(raw, 'project_id', 'projectId'), 256) } : {}),
    ...(text(first(raw, 'service_tier', 'serviceTier', 'tier'), 80) ? { serviceTier: text(first(raw, 'service_tier', 'serviceTier', 'tier'), 80) } : {}),
    ...(integer(first(raw, 'context_tokens', 'contextTokens', 'prompt_tokens_total')) !== undefined ? { contextTokens: integer(first(raw, 'context_tokens', 'contextTokens', 'prompt_tokens_total')) } : {}),
    ...(text(first(raw, 'trace_reference', 'traceReference', 'trace_id'), 256) ? { traceReference: text(first(raw, 'trace_reference', 'traceReference', 'trace_id'), 256) } : {}),
    ...(Object.keys(account).length > 0 || authIndex ? {
      account: {
        ...(text(first(account, 'id', 'account_id', 'accountId'), 256) ? { id: text(first(account, 'id', 'account_id', 'accountId'), 256) } : {}),
        ...(text(first(account, 'label', 'name'), 256) ? { label: text(first(account, 'label', 'name'), 256) } : {}),
        ...(text(first(account, 'source', 'email', 'masked_source'), 256) ? { source: text(first(account, 'source', 'email', 'masked_source'), 256) } : {}),
        ...(text(first(account, 'status'), 80) ? { status: text(first(account, 'status'), 80) } : {}),
        ...(text(first(account, 'status_message', 'message'), 512) ? { statusMessage: text(first(account, 'status_message', 'message'), 512) } : {}),
        ...(first(account, 'quota', 'quotas', 'limits') !== undefined ? { quota: normalizeQuota(first(account, 'quota', 'quotas', 'limits')) } : {}),
        ...(text(first(account, 'cooldown_until', 'cooldownUntil', 'cooldown'), 80) ? { cooldownUntil: iso(first(account, 'cooldown_until', 'cooldownUntil', 'cooldown'), fallbackOccurredAt) } : {}),
      },
    } : {}),
    metadata: redactGatewayMetadata(metadata),
  };
  return result;
}

export function parseCliProxyRecords(input: unknown): unknown[] {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      return parseCliProxyRecords(JSON.parse(trimmed));
    } catch {
      return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch { throw new HttpError(422, 'invalid_fixture', `Invalid JSONL record at line ${index + 1}`); }
      });
    }
  }
  if (Array.isArray(input)) return input;
  const object = asRecord(input);
  for (const key of ['records', 'requests', 'usage', 'items', 'data']) {
    if (object[key] !== undefined) return parseCliProxyRecords(object[key]);
  }
  return Object.keys(object).length ? [object] : [];
}

function matchesModel(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(model);
}

export function selectPriceOverride(model: string, occurredAt: string, serviceTier: string | undefined, contextTokens: number | undefined, overrides: readonly PriceOverride[]): PriceOverride | undefined {
  return overrides
    .filter((override) => matchesModel(override.modelPattern, model) && override.effectiveFrom <= occurredAt)
    .filter((override) => override.serviceTier === null || override.serviceTier === undefined || override.serviceTier === serviceTier)
    .filter((override) => override.contextThresholdTokens === null || override.contextThresholdTokens === undefined || (contextTokens ?? 0) > override.contextThresholdTokens)
    .sort((a, b) => {
      const exact = Number(matchesModel(a.modelPattern, model) && !a.modelPattern.includes('*')) - Number(matchesModel(b.modelPattern, model) && !b.modelPattern.includes('*'));
      if (exact) return exact;
      const time = a.effectiveFrom.localeCompare(b.effectiveFrom);
      if (time) return time;
      return Number(a.contextThresholdTokens ?? -1) - Number(b.contextThresholdTokens ?? -1);
    })
    .at(-1);
}

export function calculateGatewayCostMicrousd(record: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; model: string; occurredAt: string; serviceTier?: string | undefined; contextTokens?: number | undefined; estimatedCostMicrousd?: number | undefined }, overrides: readonly PriceOverride[], defaults: Omit<PriceOverride, 'id' | 'connectionId' | 'modelPattern' | 'effectiveFrom' | 'contextThresholdTokens' | 'serviceTier'> = {
  promptMicrousdPerMillion: 0,
  completionMicrousdPerMillion: 0,
  cacheReadMicrousdPerMillion: 0,
  cacheCreateMicrousdPerMillion: 0,
}): number {
  const override = selectPriceOverride(record.model, record.occurredAt, record.serviceTier, record.contextTokens, overrides);
  const prompt = override?.promptMicrousdPerMillion ?? defaults.promptMicrousdPerMillion ?? 0;
  const completion = override?.completionMicrousdPerMillion ?? defaults.completionMicrousdPerMillion ?? 0;
  const cacheRead = override?.cacheReadMicrousdPerMillion ?? defaults.cacheReadMicrousdPerMillion ?? 0;
  const cacheCreate = override?.cacheCreateMicrousdPerMillion ?? defaults.cacheCreateMicrousdPerMillion ?? 0;
  const hasRates = override !== undefined || Object.values(defaults).some((value) => value !== null && value !== undefined && value !== 0);
  if (!hasRates && record.estimatedCostMicrousd !== undefined) return record.estimatedCostMicrousd;
  return Math.max(0, Math.round(
    (record.inputTokens * prompt + record.outputTokens * completion + record.cachedTokens * cacheRead + record.cacheCreationTokens * cacheCreate) / 1_000_000,
  ));
}

export class GatewayService {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(private readonly context: ServerContext, options: GatewayServiceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  }

  private connection(id: string, teamId?: string): DbConnectionRow {
    const row = this.context.database.prepare('SELECT * FROM gateway_connections WHERE id = ?').get(id) as DbConnectionRow | undefined;
    if (!row || (teamId && row.team_id !== teamId)) throw new HttpError(404, 'gateway_connection_not_found', 'Gateway connection not found');
    return row;
  }

  assertConnection(id: string, teamId?: string): void {
    this.connection(id, teamId);
  }

  private secret(connection: DbConnectionRow): string {
    if (!connection.secret_id) throw new HttpError(503, 'gateway_secret_unavailable', 'Gateway management secret is unavailable');
    const row = this.context.database.prepare('SELECT * FROM provider_secrets WHERE id = ?').get(connection.secret_id) as { key_id: string; nonce: string; ciphertext: string; auth_tag: string } | undefined;
    if (!row) throw new HttpError(503, 'gateway_secret_unavailable', 'Gateway management secret is unavailable');
    try {
      return decryptSecret(this.context.config, { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag }, `gateway:${connection.id}:management`);
    } catch {
      throw new HttpError(503, 'gateway_secret_unavailable', 'Gateway management secret is unavailable');
    }
  }

  createConnection(teamId: string, input: GatewayConnectionInput, actorId: string): { id: string; name: string; baseUrl: string; status: string; enabled: boolean } {
    const url = validateGatewayUrl(input.baseUrl, this.context.config.gatewayAllowedHosts);
    const id = this.context.ids.id();
    const providerId = `${id}:provider`;
    const secretId = this.context.ids.id();
    const now = nowIso(this.context);
    let encrypted;
    try { encrypted = encryptSecret(this.context.config, input.managementSecret, `gateway:${id}:management`); } catch { throw new HttpError(503, 'encryption_unavailable', 'Gateway management secret cannot be encrypted'); }
    try {
      this.context.database.transaction(() => {
        this.context.database.prepare('INSERT INTO providers(id, team_id, kind, name, base_url, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(providerId, teamId, 'cliproxy', `${input.name} gateway`, url.toString(), '{}', now, now);
        this.context.database.prepare('INSERT INTO provider_secrets(id, provider_id, label, key_id, nonce, ciphertext, auth_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(secretId, providerId, 'management', encrypted.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now);
        this.context.database.prepare('INSERT INTO gateway_connections(id, team_id, name, base_url, secret_id, enabled, status, retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, teamId, input.name, url.toString(), secretId, input.enabled ? 1 : 0, 'unknown', input.retentionDays, now, now);
        this.audit(actorId, 'gateway.connection.create', 'gateway_connection', id);
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new HttpError(409, 'gateway_connection_exists', 'Gateway connection name already exists');
      throw error;
    }
    return { id, name: input.name, baseUrl: url.toString(), status: 'unknown', enabled: input.enabled };
  }

  listConnections(teamId: string): Array<Record<string, unknown>> {
    return (this.context.database.prepare('SELECT id, name, base_url AS baseUrl, enabled, status, last_checked_at AS lastCheckedAt, last_error_summary AS lastErrorSummary, retention_days AS retentionDays, created_at AS createdAt, updated_at AS updatedAt FROM gateway_connections WHERE team_id = ? ORDER BY name').all(teamId) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: publicGatewayBaseUrl(row.baseUrl),
      enabled: row.enabled === 1,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt,
      lastErrorSummary: redactGatewaySummary(row.lastErrorSummary),
      retentionDays: row.retentionDays,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async health(id: string, teamId?: string, actorId?: string): Promise<GatewayFetchResult> {
    const connection = this.connection(id, teamId);
    const now = nowIso(this.context);
    let result: GatewayFetchResult;
    try {
      result = await this.fetchManagement(connection, 'v0/management/config');
    } catch (error) {
      this.context.database.transaction(() => {
        this.context.database.prepare('UPDATE gateway_connections SET status = ?, last_checked_at = ?, last_error_summary = ?, updated_at = ? WHERE id = ?').run('unavailable', now, error instanceof HttpError ? error.message : 'Gateway request failed', now, id);
        this.audit(actorId, 'gateway.connection.health', 'gateway_connection', id, 'failed');
      })();
      throw error;
    }
    this.context.database.transaction(() => {
      this.context.database.prepare('UPDATE gateway_connections SET status = ?, last_checked_at = ?, last_error_summary = ?, updated_at = ? WHERE id = ?').run(result.ok ? 'healthy' : 'degraded', now, result.ok ? null : `HTTP ${result.status}`, now, id);
      this.audit(actorId, 'gateway.connection.health', 'gateway_connection', id, result.ok ? 'allowed' : 'failed');
    })();
    return result;
  }

  async sync(id: string, teamId?: string, options: { includeUsageQueue?: boolean } = {}, actorId?: string): Promise<IngestResult & { health: GatewayFetchResult }> {
    const connection = this.connection(id, teamId);
    const now = nowIso(this.context);
    let health: GatewayFetchResult;
    let result: IngestResult = { received: 0, inserted: 0, duplicates: 0, accountUpdates: 0, requestHashes: [] };
    let queueBody: unknown;
    let ingestQueue = false;
    try {
      health = await this.fetchManagement(connection, 'v0/management/config');
      if (!health.ok) throw new HttpError(503, 'gateway_unavailable', 'Gateway health check failed');
      // Current CLIProxyAPI has no non-destructive aggregate usage export.
      // Normal ingestion therefore uses pushed/imported records. Queue reads are
      // destructive and run only after an explicit request.
      if (options.includeUsageQueue) {
        // Explicit only: some CLIProxyAPI versions consume this queue while reading it.
        const queue = await this.fetchManagement(connection, 'v0/management/usage-queue?count=1000');
        if (queue.ok) {
          queueBody = queue.body;
          ingestQueue = true;
        }
      }
    } catch (error) {
      this.context.database.transaction(() => {
        this.context.database.prepare('UPDATE gateway_connections SET status = ?, last_checked_at = ?, last_error_summary = ?, updated_at = ? WHERE id = ?').run('unavailable', now, error instanceof HttpError ? error.message : 'Gateway sync failed', now, id);
        this.audit(actorId, 'gateway.connection.sync', 'gateway_connection', id, 'failed');
      })();
      throw error;
    }

    let ingestQueueStarted = false;
    try {
      const persist = () => {
        if (ingestQueue) {
          ingestQueueStarted = true;
          const queueResult = this.ingest(id, queueBody);
          ingestQueueStarted = false;
          result = {
            received: result.received + queueResult.received,
            inserted: result.inserted + queueResult.inserted,
            duplicates: result.duplicates + queueResult.duplicates,
            accountUpdates: result.accountUpdates + queueResult.accountUpdates,
            requestHashes: [...result.requestHashes, ...queueResult.requestHashes],
          };
        }
        this.context.database.prepare('UPDATE gateway_connections SET status = ?, last_checked_at = ?, last_error_summary = NULL, updated_at = ? WHERE id = ?').run('healthy', now, now, id);
        this.audit(actorId, 'gateway.connection.sync', 'gateway_connection', id);
      };
      if (this.context.events) this.context.events.transaction(persist);
      else this.context.database.transaction(persist)();
    } catch (error) {
      if (ingestQueueStarted) {
        this.context.database.transaction(() => {
          this.context.database.prepare('UPDATE gateway_connections SET status = ?, last_checked_at = ?, last_error_summary = ?, updated_at = ? WHERE id = ?').run('unavailable', now, error instanceof HttpError ? error.message : 'Gateway sync failed', now, id);
          this.audit(actorId, 'gateway.connection.sync', 'gateway_connection', id, 'failed');
        })();
      }
      throw error;
    }
    return { ...result, health };
  }

  private async fetchManagement(connection: DbConnectionRow, path: string): Promise<GatewayFetchResult> {
    let base: URL;
    try { base = validateGatewayUrl(connection.base_url, this.context.config.gatewayAllowedHosts); } catch { throw new HttpError(503, 'gateway_url_not_allowed', 'Stored gateway URL is no longer allowed'); }
    const controller = new AbortController();
    const timeoutError = new Error('gateway timeout');
    timeoutError.name = 'GatewayTimeout';
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.#fetch(joinUrl(base.toString(), path), {
          method: 'GET',
          headers: { authorization: `Bearer ${this.secret(connection)}`, accept: 'application/json' },
          signal: controller.signal,
          redirect: 'manual',
        }),
        new Promise<never>((_, reject) => { timeoutTimer = setTimeout(() => reject(timeoutError), this.#timeoutMs); }),
      ]);
      if (response.status >= 300 && response.status < 400) throw new HttpError(503, 'gateway_redirect_denied', 'Gateway redirects are not followed');
      const textBody = await readBoundedResponse(response);
      let body: unknown = textBody;
      try { body = textBody ? JSON.parse(textBody) as unknown : null; } catch { body = textBody; }
      return { ok: response.ok, status: response.status, body: redactValue(body) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error && (error.name === 'AbortError' || error.name === 'GatewayTimeout') ? 'Gateway request timed out' : 'Gateway request failed';
      throw new HttpError(503, 'gateway_unavailable', message);
    } finally { clearTimeout(timer); if (timeoutTimer) clearTimeout(timeoutTimer); }
  }

  ingest(connectionId: string, input: unknown): IngestResult {
    const connection = this.connection(connectionId);
    const records = parseCliProxyRecords(input);
    const now = nowIso(this.context);
    let inserted = 0;
    let duplicates = 0;
    let accountUpdates = 0;
    const hashes: string[] = [];
    const operation = () => {
      const insert = this.context.database.prepare(`INSERT OR IGNORE INTO gateway_requests(
        id, connection_id, event_hash, schema_version, request_id, occurred_at, provider, model, requested_model, account_id, auth_index, endpoint,
        status_code, failed, failure_category, failure_summary, duration_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
        cache_creation_tokens, estimated_cost_microusd, session_id, project_id, correlation_confidence, correlation_reason, trace_reference, redacted_metadata_json, ingested_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const raw of records) {
        // A stable sentinel keeps records without provider timestamps idempotent across sync runs.
        const record = normalizeCliProxyRecord(raw, '1970-01-01T00:00:00.000Z');
        const hash = gatewayEventHash(record);
        hashes.push(hash);
        let accountId: string | undefined;
        if (record.authIndex || record.account) {
          const account = record.account ?? {};
          const existing = this.context.database.prepare('SELECT id FROM gateway_accounts WHERE connection_id = ? AND auth_index = ?').get(connectionId, record.authIndex ?? account.id ?? 'unknown') as { id: string } | undefined;
          accountId = existing?.id ?? this.context.ids.id();
          const accountKey = record.authIndex ?? account.id ?? 'unknown';
          this.context.database.prepare(`INSERT INTO gateway_accounts(id, connection_id, auth_index, provider, label, masked_source, status, status_message, quota_json, cooldown_until, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(connection_id, auth_index) DO UPDATE SET provider=excluded.provider, label=excluded.label, masked_source=excluded.masked_source,
            status=excluded.status, status_message=excluded.status_message, quota_json=excluded.quota_json, cooldown_until=excluded.cooldown_until, observed_at=excluded.observed_at`).run(
            accountId, connectionId, accountKey, record.provider, account.label ?? null, account.source ?? null, account.status ?? 'unknown', account.statusMessage ?? null,
            JSON.stringify(account.quota ?? {}), account.cooldownUntil ?? null, now,
          );
          accountUpdates += 1;
        }
        const correlation = this.correlate(record, connection.team_id);
        const cost = this.costFor(connectionId, record);
        const result = insert.run(
          this.context.ids.id(), connectionId, hash, record.requestId ?? null, record.occurredAt, record.provider, record.model, record.requestedModel ?? null,
          accountId ?? null, record.authIndex ?? null, record.endpoint ?? null, record.statusCode ?? null, record.failed ? 1 : 0, record.failureCategory ?? null,
          record.failureSummary ?? null, record.durationMs ?? null, record.ttftMs ?? null, record.inputTokens, record.outputTokens, record.reasoningTokens,
          record.cachedTokens, record.cacheCreationTokens, cost, correlation.sessionId ?? null, correlation.projectId ?? null, correlation.confidence,
          correlation.reason, record.traceReference ?? null, JSON.stringify(record.metadata), now,
        );
        if (result.changes === 0) duplicates += 1;
        else {
          inserted += 1;
          if (correlation.projectId) {
            this.context.events.append({ projectId: correlation.projectId, eventKind: 'progress.changed', aggregateType: 'gateway_request', aggregateId: hash, actor: { type: 'system' }, source: { kind: 'import', adapter: 'cliproxy' }, idempotencyKey: `gateway:${connectionId}:${hash}`, payload: { provider: record.provider, model: record.model, failed: record.failed, inputTokens: record.inputTokens, outputTokens: record.outputTokens, estimatedCostMicrousd: cost } });
          }
        }
      }
    };
    try {
      if (this.context.database.inTransaction) operation();
      else if (this.context.events) this.context.events.transaction(operation);
      else this.context.database.transaction(operation)();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, 'gateway_ingest_failed', 'Gateway records could not be ingested');
    }
    return { received: records.length, inserted, duplicates, accountUpdates, requestHashes: hashes };
  }

  private costFor(connectionId: string, record: NormalizedGatewayRequest): number | null {
    const overrides = this.listPriceOverrides(connectionId);
    if (!overrides.length && record.estimatedCostMicrousd === undefined) return null;
    return calculateGatewayCostMicrousd(record, overrides, { promptMicrousdPerMillion: 0, completionMicrousdPerMillion: 0, cacheReadMicrousdPerMillion: 0, cacheCreateMicrousdPerMillion: 0 });
  }

  private correlate(record: NormalizedGatewayRequest, teamId: string): { sessionId?: string; projectId?: string; confidence: 'exact' | 'high' | 'medium' | 'low' | 'none'; reason: string } {
    const db = this.context.database;
    if (record.sessionId) {
      const session = db.prepare('SELECT s.id, s.project_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.team_id = ?').get(record.sessionId, teamId) as { id: string; project_id: string } | undefined;
      if (session) {
        // The persisted session relationship is authoritative; never pair a
        // trusted session with an untrusted, conflicting project hint.
        return {
          sessionId: session.id,
          projectId: session.project_id,
          confidence: 'exact',
          reason: record.projectId && record.projectId !== session.project_id ? 'native session id; conflicting project reference ignored' : 'native session id',
        };
      }
    }
    if (record.requestId) {
      const turn = db.prepare('SELECT t.session_id, s.project_id FROM session_turns t JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.id = s.project_id WHERE t.runtime_turn_id = ? AND p.team_id = ?').get(record.requestId, teamId) as { session_id: string; project_id: string } | undefined;
      if (turn) {
        return { sessionId: turn.session_id, projectId: turn.project_id, confidence: 'high', reason: 'runtime turn id' };
      }
    }
    if (record.projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ? AND team_id = ?').get(record.projectId, teamId) as { id: string } | undefined;
      if (project) {
        const at = Date.parse(record.occurredAt);
        const session = db.prepare(`SELECT id, project_id FROM sessions WHERE project_id = ? AND abs(strftime('%s', updated_at) - strftime('%s', ?)) <= 300 ORDER BY updated_at DESC LIMIT 1`).get(record.projectId, record.occurredAt) as { id: string; project_id: string } | undefined;
        if (session) return { sessionId: session.id, projectId: project.id, confidence: 'medium', reason: 'project and near-time match' };
        void at;
        return { projectId: project.id, confidence: 'low', reason: 'project reference only' };
      }
    }
    return { confidence: 'none', reason: 'no trusted session or project reference' };
  }

  listRequests(filters: GatewayRequestFilters = {}, teamId?: string): { items: GatewayRequestView[]; total: number; offset: number; limit: number; nextOffset: number | null } {
    const where: string[] = [];
    const values: unknown[] = [];
    if (teamId) {
      const ids = this.teamConnectionIds(teamId);
      if (!ids.length) return { items: [], total: 0, offset: Math.max(filters.offset ?? 0, 0), limit: Math.min(Math.max(filters.limit ?? 50, 1), MAX_LIST_LIMIT), nextOffset: null };
      where.push(`connection_id IN (${ids.map(() => '?').join(',')})`);
      values.push(...ids);
    }
    if (filters.connectionId) { where.push('connection_id = ?'); values.push(filters.connectionId); }
    if (filters.provider) { where.push('provider = ?'); values.push(filters.provider); }
    if (filters.model) { where.push('model = ?'); values.push(filters.model); }
    if (filters.authIndex) { where.push('auth_index = ?'); values.push(filters.authIndex); }
    if (filters.failed !== undefined) { where.push('failed = ?'); values.push(filters.failed ? 1 : 0); }
    if (filters.statusCode !== undefined) { where.push('status_code = ?'); values.push(filters.statusCode); }
    if (filters.occurredFrom) { where.push('occurred_at >= ?'); values.push(filters.occurredFrom); }
    if (filters.occurredTo) { where.push('occurred_at <= ?'); values.push(filters.occurredTo); }
    if (filters.correlationConfidence) { where.push('correlation_confidence = ?'); values.push(filters.correlationConfidence); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    if (filters.statusCode !== undefined && !Number.isInteger(filters.statusCode)) throw new HttpError(422, 'invalid_filter', 'statusCode must be an integer');
    const total = (this.context.database.prepare(`SELECT count(*) AS count FROM gateway_requests ${clause}`).get(...values) as { count: number }).count;
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), MAX_LIST_LIMIT);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = this.context.database.prepare(`SELECT * FROM gateway_requests ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as DbRequestRow[];
    return { items: rows.map(requestView), total, offset, limit, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  private teamConnectionIds(teamId: string): string[] {
    return (this.context.database.prepare('SELECT id FROM gateway_connections WHERE team_id = ?').all(teamId) as Array<{ id: string }>).map((row) => row.id);
  }

  listAccounts(connectionId?: string, teamId?: string): Array<Record<string, unknown>> {
    const ids = teamId ? this.teamConnectionIds(teamId) : undefined;
    if (ids && !ids.length) return [];
    const selected = connectionId ? [connectionId] : ids;
    const rows = (selected ? this.context.database.prepare(`SELECT * FROM gateway_accounts WHERE connection_id IN (${selected.map(() => '?').join(',')}) ORDER BY provider, auth_index`).all(...selected) : this.context.database.prepare('SELECT * FROM gateway_accounts ORDER BY provider, auth_index').all()) as DbAccountRow[];
    return rows.map((row) => ({ id: row.id, authIndex: row.auth_index, provider: row.provider, label: row.label, status: row.status, quota: parseObject(row.quota_json), cooldownUntil: row.cooldown_until }));
  }

  summary(connectionId?: string, teamId?: string): GatewaySummary {
    const ids = teamId ? this.teamConnectionIds(teamId) : undefined;
    if (ids && !ids.length) return { totals: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, estimatedCostMicrousd: 0, averageDurationMs: null }, providers: [], models: [], accounts: [], capacity: { accounts: 0, available: 0, coolingDown: 0, failed: 0 } };
    const selected = connectionId ? [connectionId] : ids;
    const where = selected ? `WHERE connection_id IN (${selected.map(() => '?').join(',')})` : '';
    const args = selected ?? [];
    const totals = this.context.database.prepare(`SELECT count(*) requests, coalesce(sum(failed),0) failures, coalesce(sum(input_tokens),0) inputTokens, coalesce(sum(output_tokens),0) outputTokens, coalesce(sum(reasoning_tokens),0) reasoningTokens, coalesce(sum(cached_tokens),0) cachedTokens, coalesce(sum(cache_creation_tokens),0) cacheCreationTokens, coalesce(sum(estimated_cost_microusd),0) estimatedCostMicrousd, avg(duration_ms) averageDurationMs FROM gateway_requests ${where}`).get(...args) as Record<string, number | null>;
    const providers = this.context.database.prepare(`SELECT provider, count(*) requests, coalesce(sum(failed),0) failures, coalesce(sum(estimated_cost_microusd),0) estimatedCostMicrousd FROM gateway_requests ${where} GROUP BY provider ORDER BY requests DESC`).all(...args) as Array<{ provider: string; requests: number; failures: number; estimatedCostMicrousd: number }>;
    const models = this.context.database.prepare(`SELECT model, count(*) requests, coalesce(sum(failed),0) failures, coalesce(sum(estimated_cost_microusd),0) estimatedCostMicrousd FROM gateway_requests ${where} GROUP BY model ORDER BY requests DESC`).all(...args) as Array<{ model: string; requests: number; failures: number; estimatedCostMicrousd: number }>;
    const accountRows = (selected ? this.context.database.prepare(`SELECT * FROM gateway_accounts WHERE connection_id IN (${selected.map(() => '?').join(',')})`).all(...selected) : this.context.database.prepare('SELECT * FROM gateway_accounts').all()) as DbAccountRow[];
    const accounts = accountRows.map((row) => ({ id: row.id, authIndex: row.auth_index, provider: row.provider, label: row.label, status: row.status, quota: parseObject(row.quota_json), cooldownUntil: row.cooldown_until }));
    return {
      totals: { requests: Number(totals.requests ?? 0), failures: Number(totals.failures ?? 0), inputTokens: Number(totals.inputTokens ?? 0), outputTokens: Number(totals.outputTokens ?? 0), reasoningTokens: Number(totals.reasoningTokens ?? 0), cachedTokens: Number(totals.cachedTokens ?? 0), cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0), estimatedCostMicrousd: Number(totals.estimatedCostMicrousd ?? 0), averageDurationMs: totals.averageDurationMs === null ? null : Number(totals.averageDurationMs) },
      providers,
      models,
      accounts,
      capacity: { accounts: accounts.length, available: accounts.filter((account) => ['healthy', 'available', 'ready', 'ok'].includes(account.status.toLowerCase())).length, coolingDown: accounts.filter((account) => account.cooldownUntil !== null && account.cooldownUntil > nowIso(this.context)).length, failed: accounts.filter((account) => ['failed', 'error', 'unavailable'].includes(account.status.toLowerCase())).length },
    };
  }

  createPriceOverride(teamId: string, input: GatewayPriceOverrideInput, actorId: string): PriceOverride {
    if (!input.connectionId) throw new HttpError(422, 'connection_required', 'A gateway connection is required');
    this.connection(input.connectionId, teamId);
    const id = this.context.ids.id();
    const now = nowIso(this.context);
    this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO gateway_price_overrides(id, connection_id, model_pattern, effective_from, prompt_microusd_per_million, completion_microusd_per_million, cache_read_microusd_per_million, cache_create_microusd_per_million, context_threshold_tokens, service_tier, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`).run(id, input.connectionId, input.modelPattern, input.effectiveFrom, input.promptMicrousdPerMillion ?? null, input.completionMicrousdPerMillion ?? null, input.cacheReadMicrousdPerMillion ?? null, input.cacheCreateMicrousdPerMillion ?? null, input.contextThresholdTokens ?? null, input.serviceTier ?? null, actorId, now);
      this.audit(actorId, 'gateway.price_override.create', 'gateway_price_override', id);
    })();
    return { id, connectionId: input.connectionId, modelPattern: input.modelPattern, effectiveFrom: input.effectiveFrom, promptMicrousdPerMillion: input.promptMicrousdPerMillion ?? null, completionMicrousdPerMillion: input.completionMicrousdPerMillion ?? null, cacheReadMicrousdPerMillion: input.cacheReadMicrousdPerMillion ?? null, cacheCreateMicrousdPerMillion: input.cacheCreateMicrousdPerMillion ?? null, contextThresholdTokens: input.contextThresholdTokens ?? null, serviceTier: input.serviceTier ?? null };
  }

  private audit(actorId: string | undefined, action: string, targetType: string, targetId: string, outcome: 'allowed' | 'failed' = 'allowed'): void {
    recordAudit(this.context, { actorType: actorId ? 'user' : 'system', ...(actorId ? { actorId } : {}), action, targetType, targetId, outcome });
  }

  listPriceOverrides(connectionId?: string, teamId?: string): PriceOverride[] {
    const ids = teamId ? this.teamConnectionIds(teamId) : undefined;
    if (ids && !ids.length) return [];
    const selected = connectionId ? [connectionId] : ids;
    const rows = (selected ? this.context.database.prepare(`SELECT * FROM gateway_price_overrides WHERE connection_id IN (${selected.map(() => '?').join(',')}) ORDER BY effective_from`).all(...selected) : this.context.database.prepare('SELECT * FROM gateway_price_overrides ORDER BY effective_from').all()) as DbPriceRow[];
    return rows.map((row) => ({ id: row.id, connectionId: row.connection_id, modelPattern: row.model_pattern, effectiveFrom: row.effective_from, promptMicrousdPerMillion: row.prompt_microusd_per_million, completionMicrousdPerMillion: row.completion_microusd_per_million, cacheReadMicrousdPerMillion: row.cache_read_microusd_per_million, cacheCreateMicrousdPerMillion: row.cache_create_microusd_per_million, contextThresholdTokens: row.context_threshold_tokens, serviceTier: row.service_tier }));
  }
}

function parseObject(value: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
}

function requestView(row: DbRequestRow): GatewayRequestView {
  return { id: row.id, eventHash: row.event_hash, schemaVersion: row.schema_version, requestId: row.request_id, occurredAt: row.occurred_at, provider: row.provider, model: row.model, requestedModel: row.requested_model, accountId: row.account_id, authIndex: row.auth_index, endpoint: row.endpoint, statusCode: row.status_code, failed: row.failed === 1, failureCategory: row.failure_category, failureSummary: row.failure_summary, durationMs: row.duration_ms, ttftMs: row.ttft_ms, inputTokens: row.input_tokens, outputTokens: row.output_tokens, reasoningTokens: row.reasoning_tokens, cachedTokens: row.cached_tokens, cacheCreationTokens: row.cache_creation_tokens, estimatedCostMicrousd: row.estimated_cost_microusd, sessionId: row.session_id, projectId: row.project_id, correlationConfidence: row.correlation_confidence, correlationReason: row.correlation_reason, metadata: parseObject(row.redacted_metadata_json) };
}

function user(c: Context): AuthenticatedUser {
  const value = c.get('user' as never) as AuthenticatedUser | undefined;
  if (!value) throw new HttpError(401, 'authentication_required', 'Authentication required');
  return value;
}

function admin(c: Context): AuthenticatedUser {
  const value = user(c);
  if (value.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator role required');
  return value;
}

async function route<T>(c: Context, action: () => Promise<T> | T, status = 200): Promise<Response> {
  try { return c.json(await action(), status as 200 | 201); } catch (error) {
    if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}

export const CLIProxyFixtureRecords = [
  { request_id: 'fixture-1', occurred_at: '2026-01-01T00:00:00.000Z', provider: 'fixture-provider', model: 'fixture-model', auth_index: '0', status_code: 200, duration_ms: 120, usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 2 }, metadata: { authorization: 'Bearer fixture-secret', email: 'fixture@example.com' } },
  { request_id: 'fixture-2', occurred_at: '2026-01-01T00:01:00.000Z', provider: 'fixture-provider', model: 'fixture-model', auth_index: '0', status_code: 429, error: 'rate limited', usage: { input_tokens: 3, output_tokens: 1 } },
] as const;

export const gatewayModule: DholeModule = {
  id: 'gateway',
  register(app: DholeApp, context: ServerContext): void {
    const service = new GatewayService(context);
    app.post('/api/gateway/connections', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, GatewayConnectionInputSchema); return service.createConnection(actor.teamId, input, actor.id); }, 201));
    app.get('/api/gateway/connections', (c) => route(c, () => { const actor = user(c); return service.listConnections(actor.teamId); }));
    app.post('/api/gateway/connections/:id/health', (c) => route(c, async () => { const actor = user(c); return service.health(c.req.param('id'), actor.teamId, actor.id); }));
    app.post('/api/gateway/connections/:id/sync', (c) => route(c, async () => { const actor = user(c); const includeUsageQueue = c.req.query('includeUsageQueue') === 'true'; return service.sync(c.req.param('id'), actor.teamId, { includeUsageQueue }, actor.id); }));
    app.post('/api/gateway/connections/:id/ingest', (c) => route(c, async () => { const actor = admin(c); const body = await parseJson(c, z.unknown()); service.assertConnection(c.req.param('id'), actor.teamId); return service.ingest(c.req.param('id'), body); }, 201));
    app.get('/api/gateway/requests', (c) => route(c, () => {
      const actor = user(c);
      const query = c.req.query();
      const filters: GatewayRequestFilters = {};
      if (query.connectionId) filters.connectionId = query.connectionId;
      if (query.provider) filters.provider = query.provider;
      if (query.model) filters.model = query.model;
      if (query.authIndex) filters.authIndex = query.authIndex;
      if (query.failed !== undefined) filters.failed = query.failed === 'true';
      if (query.statusCode) filters.statusCode = Number(query.statusCode);
      if (query.occurredFrom) filters.occurredFrom = query.occurredFrom;
      if (query.occurredTo) filters.occurredTo = query.occurredTo;
      if (query.correlationConfidence) filters.correlationConfidence = query.correlationConfidence as Exclude<GatewayRequestFilters['correlationConfidence'], undefined>;
      if (query.limit) filters.limit = Number(query.limit);
      if (query.offset) filters.offset = Number(query.offset);
      if (filters.connectionId) service.assertConnection(filters.connectionId, actor.teamId);
      return service.listRequests(filters, actor.teamId);
    }));
    app.get('/api/gateway/accounts', (c) => route(c, () => { const actor = user(c); const connectionId = c.req.query('connectionId'); if (connectionId) service.assertConnection(connectionId, actor.teamId); return service.listAccounts(connectionId, actor.teamId); }));
    app.get('/api/gateway/summary', (c) => route(c, () => { const actor = user(c); const connectionId = c.req.query('connectionId'); if (connectionId) service.assertConnection(connectionId, actor.teamId); return service.summary(connectionId, actor.teamId); }));
    app.post('/api/gateway/prices', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, GatewayPriceOverrideSchema); return service.createPriceOverride(actor.teamId, input, actor.id); }, 201));
    app.get('/api/gateway/prices', (c) => route(c, () => { const actor = user(c); const connectionId = c.req.query('connectionId'); if (connectionId) service.assertConnection(connectionId, actor.teamId); return service.listPriceOverrides(connectionId, actor.teamId); }));
    app.get('/api/gateway/fixture', (c) => route(c, () => { if (!(context.config.demo || context.config.environment !== 'production')) throw new HttpError(404, 'not_found', 'Not found'); return { protocol: 'cliproxy.fixture', schemaVersion: 1, health: { ok: true, status: 200 }, records: CLIProxyFixtureRecords.map((record) => redactValue(record)) }; }));
    app.get('/api/gateway/fixture/v0/management/config', (c) => route(c, () => { if (!(context.config.demo || context.config.environment !== 'production')) throw new HttpError(404, 'not_found', 'Not found'); return { usageStatisticsEnabled: true, fixture: true }; }));
    app.get('/api/gateway/fixture/v0/management/usage-queue', (c) => route(c, () => { if (!(context.config.demo || context.config.environment !== 'production')) throw new HttpError(404, 'not_found', 'Not found'); return CLIProxyFixtureRecords.map((record) => redactValue(record)); }));
  },
};

export function createGatewayService(context: ServerContext, options?: GatewayServiceOptions): GatewayService {
  return new GatewayService(context, options);
}

export const gatewayServices = { GatewayService, createGatewayService, validateGatewayUrl, normalizeCliProxyRecord, parseCliProxyRecords, gatewayEventHash, calculateGatewayCostMicrousd, selectPriceOverride, redactGatewayMetadata };
