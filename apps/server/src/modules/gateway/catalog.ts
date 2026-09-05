import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedCredential, AuthenticatedUser, DholeApp, ServerContext } from '../../lib/module.js';
import { hashToken, redactText } from '../../lib/security.js';
import { BoundedRateLimiter, recordAudit } from '../core/index.js';
import { canAccessProject } from '../core/projects.js';
import type { GatewayService } from './index.js';

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_MODELS = 2_048;
export const CATALOG_STALE_AFTER_MS = 60 * 60 * 1_000;
const ClientSchema = z.enum(['generic', 'opencode', 'codex']);
export type CatalogClient = z.infer<typeof ClientSchema>;
const ClientVersionSchema = z.string().trim().min(1).max(80).regex(/^[\w.+-]+$/u);
const RefreshSchema = z.object({ clientVersion: ClientVersionSchema.optional() }).strict();
const PolicySchema = z.object({ enabled: z.boolean() }).strict();
const TokenInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  client: ClientSchema,
  expiresInDays: z.number().int().min(1).max(30).default(7),
}).strict();
const ParentPermissionsSchema = z.union([z.array(z.string()).max(32), z.object({ permissions: z.array(z.string()).max(32) }).transform((value) => value.permissions)]);
const ModelKeySchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
  .refine((value) => redactText(value) === value, 'Invalid model ID');
const LabelSchema = z.string().trim().min(1).max(240);
const IntegerSchema = z.number().int().min(1).max(100_000_000);
const ReasoningSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  streaming: z.boolean().optional(),
  json: z.boolean().optional(),
});
const MetadataSchema = z.object({
  display_name: LabelSchema.optional(),
  name: LabelSchema.optional(),
  owned_by: LabelSchema.optional(),
  context_window: IntegerSchema.optional(),
  max_output_tokens: IntegerSchema.optional(),
  input_modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).max(4).optional(),
  output_modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).max(4).optional(),
  supported_reasoning_levels: z.array(z.object({ effort: ReasoningSchema })).max(7).optional(),
  default_reasoning_level: ReasoningSchema.optional(),
  supports_parallel_tool_calls: z.boolean().optional(),
  capabilities: CapabilitiesSchema.optional(),
});
const StandardModelSchema = MetadataSchema.extend({ id: ModelKeySchema });
const CodexModelSchema = MetadataSchema.extend({ slug: ModelKeySchema.optional(), id: ModelKeySchema.optional() })
  .refine((model) => Boolean(model.slug || model.id), 'A model ID is required')
  .refine((model) => !model.slug || !model.id || model.slug === model.id, 'Conflicting model IDs');
const CatalogInputSchema = z.union([
  z.object({ data: z.array(StandardModelSchema).max(MAX_MODELS), models: z.never().optional() }),
  z.object({ models: z.array(CodexModelSchema).max(MAX_MODELS), data: z.never().optional() }),
]);

export interface CatalogModel {
  modelKey: string;
  displayName: string;
  declared: {
    owner?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputModalities?: string[];
    outputModalities?: string[];
    reasoningLevels?: string[];
    defaultReasoningLevel?: string;
    parallelToolCalls?: boolean;
    capabilities?: z.infer<typeof CapabilitiesSchema>;
  };
  compatibility: { generic: boolean; opencode: boolean; codex: boolean };
}
export interface CatalogDiff { added: string[]; removed: string[]; changed: string[] }
export interface CatalogSource {
  connectionId: string;
  providerId: string;
  baseUrl: string;
  endpoint: string;
  shape: 'openai' | 'codex';
  clientVersion: string | null;
  connectionRevision: number;
  credentialScope: 'catalog' | 'anonymous';
  cpaVersion: string | null;
}
export interface CatalogSnapshot {
  id: string;
  schemaVersion: 1;
  source: CatalogSource;
  observedAt: string;
  contentHash: string;
  models: CatalogModel[];
  diff: CatalogDiff;
}
export interface CatalogModelView extends CatalogModel {
  modelId: string;
  enabled: boolean;
  available: boolean;
  measuredCapabilities: z.infer<typeof MeasuredSchema>;
}
export interface GatewayCatalogView {
  schemaVersion: 1;
  connectionId: string;
  providerId: string;
  connectionEnabled: boolean;
  providerEnabled: boolean;
  sourceMatchesConnection: boolean;
  status: 'unobserved' | 'current' | 'stale' | 'error';
  stale: boolean;
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: { code: string; message: string } | null;
  snapshot: CatalogSnapshot | null;
  models: CatalogModelView[];
}

function safeLabel(value: string): string {
  return redactText(value, 240)
    .replace(/\b(?:token|secret|credential)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/https?:\/\/\S+/giu, '[REDACTED_URL]');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function catalogContentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Only documented model metadata survives this external boundary. */
export function parseCliProxyCatalog(input: unknown): { shape: 'openai' | 'codex'; models: CatalogModel[] } {
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { throw new HttpError(422, 'catalog_invalid', 'Invalid model catalog'); }
  if (!serialized || Buffer.byteLength(serialized) > MAX_CATALOG_BYTES) throw new HttpError(422, 'catalog_invalid', 'Model catalog exceeds the supported size');
  const parsed = CatalogInputSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'catalog_invalid', 'Invalid model catalog');
  const shape = parsed.data.models ? 'codex' : 'openai';
  const records = parsed.data.models ?? parsed.data.data ?? [];
  const seen = new Set<string>();
  const models = records.map((model): CatalogModel => {
    const modelKey = ('slug' in model ? model.slug : undefined) ?? model.id!;
    if (seen.has(modelKey)) throw new HttpError(422, 'catalog_duplicate_model', 'Model catalog contains duplicate IDs');
    seen.add(modelKey);
    return {
      modelKey,
      displayName: safeLabel(model.display_name ?? model.name ?? modelKey),
      declared: {
        ...(model.owned_by ? { owner: safeLabel(model.owned_by) } : {}),
        ...(model.context_window ? { contextWindow: model.context_window } : {}),
        ...(model.max_output_tokens ? { maxOutputTokens: model.max_output_tokens } : {}),
        ...(model.input_modalities ? { inputModalities: [...new Set(model.input_modalities)].sort() } : {}),
        ...(model.output_modalities ? { outputModalities: [...new Set(model.output_modalities)].sort() } : {}),
        ...(model.supported_reasoning_levels ? { reasoningLevels: [...new Set(model.supported_reasoning_levels.map((level) => level.effort))] } : {}),
        ...(model.default_reasoning_level ? { defaultReasoningLevel: model.default_reasoning_level } : {}),
        ...(model.supports_parallel_tool_calls !== undefined ? { parallelToolCalls: model.supports_parallel_tool_calls } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      },
      compatibility: { generic: true, opencode: true, codex: shape === 'codex' },
    };
  }).sort((a, b) => a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0);
  return { shape, models };
}

export function diffCatalogModels(previous: CatalogModel[], current: CatalogModel[]): CatalogDiff {
  const before = new Map(previous.map((model) => [model.modelKey, canonical(model)]));
  const after = new Map(current.map((model) => [model.modelKey, canonical(model)]));
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
  };
}

interface SnapshotRow { id: string; source_json: string; observed_at: string; content_hash: string; models_json: string; diff_json: string }
interface StateRow { snapshot_id: string | null; last_attempt_at: string; last_success_at: string | null; error_code: string | null }
interface ModelRow { id: string; model_key: string; display_name: string; enabled: number; measured_capabilities_json: string }
const MeasuredOutcomeSchema = z.enum(['supported', 'unsupported', 'unknown']).catch('unknown');
const MeasuredSchema = z.object({ tools: MeasuredOutcomeSchema.optional(), vision: MeasuredOutcomeSchema.optional(), reasoning: MeasuredOutcomeSchema.optional(), streaming: MeasuredOutcomeSchema.optional(), json: MeasuredOutcomeSchema.optional() });

function measuredView(encoded: string): z.infer<typeof MeasuredSchema> {
  try { return MeasuredSchema.parse(JSON.parse(encoded) as unknown); }
  catch { return {}; }
}

function snapshotView(row: SnapshotRow): CatalogSnapshot {
  return { id: row.id, schemaVersion: 1, source: JSON.parse(row.source_json) as CatalogSource, observedAt: row.observed_at, contentHash: row.content_hash, models: JSON.parse(row.models_json) as CatalogModel[], diff: JSON.parse(row.diff_json) as CatalogDiff };
}

export class GatewayCatalogService {
  private readonly refreshing = new Set<string>();
  constructor(private readonly context: ServerContext, private readonly gateway: GatewayService) {}

  view(connectionId: string, teamId: string): GatewayCatalogView {
    const connection = this.gateway.getConnection(connectionId, teamId);
    const providerId = this.gateway.getConnectionProviderId(connectionId, teamId);
    const provider = this.context.database.prepare('SELECT enabled FROM providers WHERE id = ? AND team_id = ?').get(providerId, teamId) as { enabled: number };
    const state = this.context.database.prepare('SELECT * FROM gateway_catalog_state WHERE connection_id = ?').get(connectionId) as StateRow | undefined;
    const row = state?.snapshot_id ? this.context.database.prepare('SELECT * FROM gateway_catalog_snapshots WHERE id = ?').get(state.snapshot_id) as SnapshotRow | undefined : undefined;
    const snapshot = row ? snapshotView(row) : null;
    const sourceMatchesConnection = snapshot?.source.connectionRevision === connection.revision;
    const stale = !snapshot || !sourceMatchesConnection || Boolean(state?.error_code) || this.context.clock.now().getTime() - Date.parse(snapshot.observedAt) >= CATALOG_STALE_AFTER_MS;
    const observed = new Map(snapshot?.models.map((model) => [model.modelKey, model]));
    const models = this.context.database.prepare('SELECT id, model_key, display_name, enabled, measured_capabilities_json FROM models WHERE provider_id = ? ORDER BY model_key').all(providerId) as ModelRow[];
    return {
      schemaVersion: 1, connectionId, providerId, connectionEnabled: connection.enabled === 1 && !connection.archived_at && !connection.deleted_at, providerEnabled: provider.enabled === 1, sourceMatchesConnection,
      status: state?.error_code ? 'error' : !snapshot ? 'unobserved' : stale ? 'stale' : 'current', stale, staleAfterMs: CATALOG_STALE_AFTER_MS,
      lastAttemptAt: state?.last_attempt_at ?? null, lastSuccessAt: state?.last_success_at ?? null,
      error: state?.error_code ? { code: state.error_code, message: 'Catalog refresh failed. The last successful observation is retained.' } : null,
      snapshot,
      models: models.map((model) => ({
        ...(observed.get(model.model_key) ?? { modelKey: model.model_key, displayName: safeLabel(model.display_name), declared: {}, compatibility: { generic: false, opencode: false, codex: false } }),
        modelId: model.id, enabled: model.enabled === 1, available: observed.has(model.model_key),
        measuredCapabilities: measuredView(model.measured_capabilities_json),
      })),
    };
  }

  async refresh(connectionId: string, teamId: string, input: z.infer<typeof RefreshSchema>, actorId: string): Promise<GatewayCatalogView> {
    this.gateway.assertConnection(connectionId, teamId);
    if (this.refreshing.has(connectionId)) throw new HttpError(409, 'catalog_refresh_in_progress', 'A catalog refresh is already in progress');
    this.refreshing.add(connectionId);
    try { return await this.refreshOnce(connectionId, teamId, input, actorId); }
    finally { this.refreshing.delete(connectionId); }
  }

  private async refreshOnce(connectionId: string, teamId: string, input: z.infer<typeof RefreshSchema>, actorId: string): Promise<GatewayCatalogView> {
    const options = RefreshSchema.parse(input);
    const connection = this.gateway.getConnection(connectionId, teamId);
    const providerId = this.gateway.getConnectionProviderId(connectionId, teamId);
    let catalog: ReturnType<typeof parseCliProxyCatalog>;
    let upstreamVersion: string | null = null;
    try {
      const response = await this.gateway.fetchCatalog(connectionId, teamId, options.clientVersion);
      if (!response.ok) throw new HttpError(503, 'catalog_upstream_error', 'Catalog request failed');
      catalog = parseCliProxyCatalog(response.body);
      upstreamVersion = response.upstreamVersion ?? null;
    } catch (error) {
      const errorCode = error instanceof HttpError && ['catalog_invalid', 'catalog_duplicate_model', 'catalog_upstream_error', 'gateway_response_too_large', 'gateway_redirect_denied', 'gateway_secret_unavailable', 'gateway_catalog_secret_unavailable', 'gateway_disabled', 'gateway_url_not_allowed'].includes(error.code) ? error.code : 'catalog_unavailable';
      // A concurrent connection edit must not attach an old request's result.
      const current = this.gateway.getConnection(connectionId, teamId);
      if (current.revision !== connection.revision) throw new HttpError(409, 'gateway_connection_changed', 'Gateway connection changed during refresh');
      this.context.database.transaction(() => {
        this.context.database.prepare(`INSERT INTO gateway_catalog_state(connection_id, last_attempt_at, error_code) VALUES (?, ?, ?)
          ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error_code = excluded.error_code`).run(connectionId, this.context.clock.now().toISOString(), errorCode);
        this.audit(actorId, 'gateway.catalog.refresh', connectionId, 'failed');
      })();
      return this.view(connectionId, teamId);
    }
    const now = this.context.clock.now().toISOString();
    this.context.database.transaction(() => {
      const current = this.gateway.getConnection(connectionId, teamId);
      if (current.revision !== connection.revision) throw new HttpError(409, 'gateway_connection_changed', 'Gateway connection changed during refresh');
      const previous = this.view(connectionId, teamId).snapshot;
      const id = this.context.ids.id();
      const source: CatalogSource = { connectionId, providerId, baseUrl: connection.base_url, endpoint: `/v1/models${options.clientVersion ? `?client_version=${encodeURIComponent(options.clientVersion)}` : ''}`, shape: catalog.shape, clientVersion: options.clientVersion ?? null, connectionRevision: connection.revision, credentialScope: connection.catalog_secret_id ? 'catalog' : 'anonymous', cpaVersion: upstreamVersion };
      const hash = catalogContentHash({ source, models: catalog.models });
      const diff = diffCatalogModels(previous?.models ?? [], catalog.models);
      this.context.database.prepare(`INSERT INTO gateway_catalog_snapshots(id, connection_id, provider_id, schema_version, source_json, observed_at, content_hash, models_json, diff_json)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(id, connectionId, providerId, JSON.stringify(source), now, hash, JSON.stringify(catalog.models), JSON.stringify(diff));
      const upsert = this.context.database.prepare(`INSERT INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '{}', ?, 0, ?, ?) ON CONFLICT(provider_id, model_key) DO UPDATE SET display_name = excluded.display_name, declared_capabilities_json = excluded.declared_capabilities_json, catalog_observed_at = excluded.catalog_observed_at, updated_at = excluded.updated_at`);
      for (const model of catalog.models) upsert.run(this.context.ids.id(), providerId, model.modelKey, model.displayName, JSON.stringify(model.declared.capabilities ?? {}), now, now, now);
      this.context.database.prepare(`INSERT INTO gateway_catalog_state(connection_id, snapshot_id, last_attempt_at, last_success_at, error_code) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(connection_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, error_code = NULL`).run(connectionId, id, now, now);
      this.audit(actorId, 'gateway.catalog.refresh', connectionId, 'allowed');
    })();
    return this.view(connectionId, teamId);
  }

  setPolicy(connectionId: string, teamId: string, modelId: string, enabled: boolean, actorId: string): GatewayCatalogView {
    PolicySchema.parse({ enabled });
    const view = this.view(connectionId, teamId);
    if (!view.models.some((model) => model.modelId === modelId)) throw new HttpError(404, 'catalog_model_not_found', 'Catalog model not found');
    this.context.database.transaction(() => {
      this.context.database.prepare('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ? AND provider_id = ?').run(enabled ? 1 : 0, this.context.clock.now().toISOString(), modelId, view.providerId);
      this.audit(actorId, 'gateway.catalog.policy', modelId, 'allowed', { connectionId, enabled });
    })();
    return this.view(connectionId, teamId);
  }

  private parentAuthority(tokenId: string, userId: string, teamId: string): { deviceId: string | null; expiresAt: string } {
    const now = this.context.clock.now().toISOString();
    const parent = this.context.database.prepare(`SELECT a.project_id, a.scopes_json, a.expires_at, a.device_token_id,
      d.expires_at AS device_expires_at, d.permissions_json AS device_permissions_json
      FROM api_tokens a JOIN projects p ON p.id = a.project_id
      JOIN users u ON u.id = a.user_id AND u.disabled_at IS NULL
      JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = p.team_id AND tm.role = 'administrator'
      LEFT JOIN user_device_tokens d ON d.id = a.device_token_id AND d.user_id = u.id AND d.team_id = p.team_id AND d.revoked_at IS NULL AND d.expires_at > ?
      WHERE a.id = ? AND a.user_id = ? AND p.team_id = ? AND a.run_id IS NULL AND a.revoked_at IS NULL AND a.expires_at > ?
        AND (a.device_token_id IS NULL OR d.id IS NOT NULL)`).get(now, tokenId, userId, teamId, now) as {
          project_id: string; scopes_json: string; expires_at: string; device_token_id: string | null; device_expires_at: string | null; device_permissions_json: string | null;
        } | undefined;
    let permitted = false;
    try {
      permitted = Boolean(parent && ParentPermissionsSchema.parse(JSON.parse(parent.scopes_json)).includes('gateway:manage')
        && (!parent.device_token_id || ParentPermissionsSchema.parse(JSON.parse(parent.device_permissions_json!)).includes('gateway:manage')));
    } catch { /* malformed authority grants no access */ }
    if (!parent || !permitted || !canAccessProject(this.context, { id: userId, teamId }, parent.project_id, true)) throw new HttpError(401, 'catalog_parent_invalid', 'Catalog parent authorization is invalid or expired');
    return { deviceId: parent.device_token_id, expiresAt: parent.device_expires_at && parent.device_expires_at < parent.expires_at ? parent.device_expires_at : parent.expires_at };
  }

  createToken(connectionId: string, actor: AuthenticatedUser, input: z.infer<typeof TokenInputSchema>, issuer?: AuthenticatedCredential): { id: string; token: string; client: CatalogClient; expiresAt: string; endpoint: string } {
    const parsed = TokenInputSchema.parse(input);
    this.gateway.assertConnection(connectionId, actor.teamId);
    const id = this.context.ids.id();
    const token = this.context.ids.token(32);
    const now = this.context.clock.now();
    let expiresAt = new Date(now.getTime() + parsed.expiresInDays * 86_400_000).toISOString();
    this.context.database.transaction(() => {
      const active = this.context.database.prepare(`SELECT 1 FROM users u JOIN team_members tm ON tm.user_id = u.id
        WHERE u.id = ? AND u.disabled_at IS NULL AND tm.team_id = ? AND tm.role = 'administrator'`).get(actor.id, actor.teamId);
      if (!active) throw new HttpError(403, 'administrator_required', 'Active administrator access required');
      const parent = issuer ? this.parentAuthority(issuer.tokenId, actor.id, actor.teamId) : undefined;
      if (parent && parent.expiresAt < expiresAt) expiresAt = parent.expiresAt;
      this.context.database.prepare(`INSERT INTO gateway_catalog_tokens(id, connection_id, created_by, name, client, token_hash, created_at, expires_at, authority_kind, parent_api_token_id, parent_device_token_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, connectionId, actor.id, safeLabel(parsed.name), parsed.client, hashToken(token), now.toISOString(), expiresAt, issuer ? 'api' : 'user', issuer?.tokenId ?? null, parent?.deviceId ?? null);
      this.audit(actor.id, 'gateway.catalog.token.create', id, 'allowed', { connectionId, client: parsed.client, authorityKind: issuer ? 'api' : 'user' });
    }).immediate();
    return { id, token, client: parsed.client, expiresAt, endpoint: `/api/gateway/catalog/v1/${encodeURIComponent(connectionId)}/${parsed.client}` };
  }

  listTokens(connectionId: string, teamId: string): Array<Record<string, unknown>> {
    this.gateway.assertConnection(connectionId, teamId);
    return this.context.database.prepare('SELECT id, name, client, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM gateway_catalog_tokens WHERE connection_id = ? ORDER BY created_at DESC').all(connectionId) as Array<Record<string, unknown>>;
  }

  revokeToken(connectionId: string, tokenId: string, actor: AuthenticatedUser): void {
    this.gateway.assertConnection(connectionId, actor.teamId);
    this.context.database.transaction(() => {
      const changed = this.context.database.prepare('UPDATE gateway_catalog_tokens SET revoked_at = ? WHERE id = ? AND connection_id = ? AND revoked_at IS NULL').run(this.context.clock.now().toISOString(), tokenId, connectionId);
      if (!changed.changes) throw new HttpError(404, 'catalog_token_not_found', 'Catalog token not found');
      this.audit(actor.id, 'gateway.catalog.token.revoke', tokenId, 'allowed', { connectionId });
    })();
  }

  authenticate(connectionId: string, client: CatalogClient, authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,160})$/u);
    if (!match?.[1]) throw new HttpError(401, 'catalog_token_invalid', 'Catalog token required');
    const now = this.context.clock.now().toISOString();
    const token = this.context.database.prepare(`SELECT t.id, t.created_by, t.authority_kind, t.parent_api_token_id, t.parent_device_token_id, c.team_id FROM gateway_catalog_tokens t
      JOIN gateway_connections c ON c.id = t.connection_id AND c.deleted_at IS NULL
      JOIN users u ON u.id = t.created_by AND u.disabled_at IS NULL
      JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = u.id AND tm.role = 'administrator'
      WHERE t.token_hash = ? AND t.connection_id = ? AND t.client = ? AND t.expires_at > ? AND t.revoked_at IS NULL
        AND t.authority_kind IN ('user', 'api')`).get(hashToken(match[1]), connectionId, client, now) as {
          id: string; created_by: string; team_id: string; authority_kind: 'user' | 'api'; parent_api_token_id: string | null; parent_device_token_id: string | null;
        } | undefined;
    if (!token) throw new HttpError(401, 'catalog_token_invalid', 'Catalog token is invalid or expired');
    if (token.authority_kind === 'api') {
      const parent = this.parentAuthority(token.parent_api_token_id!, token.created_by, token.team_id);
      if (parent.deviceId !== token.parent_device_token_id) throw new HttpError(401, 'catalog_parent_invalid', 'Catalog parent authorization changed');
    }
    this.context.database.prepare('UPDATE gateway_catalog_tokens SET last_used_at = ? WHERE id = ?').run(now, token.id);
    return token.team_id;
  }

  projection(connectionId: string, teamId: string, client: CatalogClient): Record<string, unknown> {
    const view = this.view(connectionId, teamId);
    const effective = view.models.filter((model) => view.connectionEnabled && view.providerEnabled && view.sourceMatchesConnection && model.available && model.enabled && model.compatibility[client]);
    const common = {
      schemaVersion: 1, client, connectionId, providerId: view.providerId,
      observedAt: view.snapshot?.observedAt ?? null, lastAttemptAt: view.lastAttemptAt, lastSuccessAt: view.lastSuccessAt,
      stale: view.stale, status: view.status, sourceMatchesConnection: view.sourceMatchesConnection, error: view.error, snapshotId: view.snapshot?.id ?? null, contentHash: view.snapshot?.contentHash ?? null,
    };
    if (client === 'generic') return { ...common, object: 'list', data: effective.map((model) => ({ id: model.modelKey, object: 'model', owned_by: model.declared.owner ?? view.providerId })) };
    if (client === 'opencode') return { ...common, models: Object.fromEntries(effective.map((model) => [model.modelKey, {
      id: model.modelKey, name: model.displayName,
      ...(model.declared.contextWindow || model.declared.maxOutputTokens ? { limit: { ...(model.declared.contextWindow ? { context: model.declared.contextWindow } : {}), ...(model.declared.maxOutputTokens ? { output: model.declared.maxOutputTokens } : {}) } } : {}),
      ...(model.declared.inputModalities || model.declared.outputModalities ? { modalities: { ...(model.declared.inputModalities ? { input: model.declared.inputModalities } : {}), ...(model.declared.outputModalities ? { output: model.declared.outputModalities } : {}) } } : {}),
    }])) };
    return { ...common, models: effective.map((model) => ({
      slug: model.modelKey, display_name: model.displayName,
      ...(model.declared.contextWindow ? { context_window: model.declared.contextWindow } : {}),
      ...(model.declared.reasoningLevels ? { supported_reasoning_levels: model.declared.reasoningLevels.map((effort) => ({ effort, description: effort })) } : {}),
      ...(model.declared.defaultReasoningLevel ? { default_reasoning_level: model.declared.defaultReasoningLevel } : {}),
      ...(model.declared.inputModalities ? { input_modalities: model.declared.inputModalities } : {}),
      ...(model.declared.parallelToolCalls !== undefined ? { supports_parallel_tool_calls: model.declared.parallelToolCalls } : {}),
    })) };
  }

  private audit(actorId: string, action: string, targetId: string, outcome: 'allowed' | 'failed', detail?: Record<string, unknown>): void {
    recordAudit(this.context, { actorType: 'user', actorId, action, targetType: 'gateway_catalog', targetId, outcome, ...(detail ? { detail } : {}) });
  }
}

function actor(c: Context<AppEnvironment>, administrator = false, permission = 'gateway:read'): AuthenticatedUser {
  const user = c.get('user');
  const credential = c.get('credential');
  if (!user) throw new HttpError(401, 'authentication_required', 'Authentication required');
  if (credential && !credential.permissions.includes(permission)) throw new HttpError(403, 'token_scope_denied', 'The API token lacks the required permission');
  if (credential?.runId && permission === 'gateway:manage') throw new HttpError(403, 'token_scope_denied', 'Run-scoped credentials cannot administer catalogs');
  if (administrator && user.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator role required');
  return user;
}

export function registerGatewayCatalogRoutes(app: DholeApp, context: ServerContext, gateway: GatewayService): void {
  const catalog = new GatewayCatalogService(context, gateway);
  const limiter = new BoundedRateLimiter();
  app.get('/api/gateway/connections/:id/catalog', (c) => c.json(catalog.view(c.req.param('id'), actor(c).teamId)));
  app.post('/api/gateway/connections/:id/catalog/refresh', async (c) => {
    const user = actor(c, false, 'gateway:manage');
    return c.json(await catalog.refresh(c.req.param('id'), user.teamId, await parseJson(c, RefreshSchema), user.id));
  });
  app.patch('/api/gateway/connections/:id/catalog/models/:modelId', async (c) => {
    const user = actor(c, true, 'gateway:manage');
    const input = await parseJson(c, PolicySchema);
    return c.json(catalog.setPolicy(c.req.param('id'), user.teamId, c.req.param('modelId'), input.enabled, user.id));
  });
  app.get('/api/gateway/connections/:id/catalog/tokens', (c) => c.json({ tokens: catalog.listTokens(c.req.param('id'), actor(c, true, 'gateway:manage').teamId) }));
  app.post('/api/gateway/connections/:id/catalog/tokens', async (c) => {
    const user = actor(c, true, 'gateway:manage');
    const input = await parseJson(c, TokenInputSchema);
    c.get('assertAuthorizationCurrent')?.();
    c.header('Cache-Control', 'no-store');
    return c.json(catalog.createToken(c.req.param('id'), user, input, c.get('credential')), 201);
  });
  app.delete('/api/gateway/connections/:id/catalog/tokens/:tokenId', (c) => {
    catalog.revokeToken(c.req.param('id'), c.req.param('tokenId'), actor(c, true, 'gateway:manage'));
    return c.json({ ok: true });
  });
  app.get('/api/gateway/catalog/v1/:connectionId/:client', (c) => {
    const client = ClientSchema.safeParse(c.req.param('client'));
    if (!client.success) throw new HttpError(404, 'catalog_projection_not_found', 'Catalog projection not found');
    if (!limiter.allow('catalog', 600, 60_000, context.clock.now().getTime()).allowed) throw new HttpError(429, 'rate_limited', 'Too many catalog requests');
    const teamId = catalog.authenticate(c.req.param('connectionId'), client.data, c.req.header('authorization'));
    const body = catalog.projection(c.req.param('connectionId'), teamId, client.data);
    const etag = `"${catalogContentHash(body)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    c.header('Vary', 'Authorization');
    c.header('X-Dhole-Catalog-Stale', String(body.stale));
    if (body.observedAt) c.header('X-Dhole-Catalog-Observed-At', String(body.observedAt));
    if (c.req.header('if-none-match')?.split(',').some((value) => value.trim().replace(/^W\//u, '') === etag || value.trim() === '*')) return c.body(null, 304);
    return c.json(body);
  });
}
