import { createHash } from 'node:crypto';
import { z } from 'zod';
import { encryptSecret, decryptSecret } from '../../lib/security.js';
import { HttpError, parseJson } from '../../lib/http.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { recordAudit } from '../core/index.js';
import { admin, route, user, type GatewayService } from './index.js';

export const GatewayConnectionUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(), baseUrl: z.string().trim().min(1).max(2_048).optional(), enabled: z.boolean().optional(), retentionDays: z.number().int().min(1).max(3_650).optional(), managementSecret: z.string().min(1).max(16_384).optional(), catalogSecret: z.string().min(1).max(16_384).optional(),
}).strict();
export type GatewayConnectionUpdate = z.infer<typeof GatewayConnectionUpdateSchema>;
export const GatewaySettingKeySchema = z.enum(['request-retry', 'max-retry-credentials', 'max-retry-interval', 'routing/strategy']);
export type GatewaySettingKey = z.infer<typeof GatewaySettingKeySchema>;

const OAuthProviderSchema = z.enum(['codex', 'anthropic', 'antigravity']);
const OAuthStartSchema = z.object({ expectedRevision: z.number().int().positive(), provider: OAuthProviderSchema }).strict();
const OAuthCallbackSchema = z.object({ redirectUrl: z.string().min(1).max(16_384) }).strict();
const OAuthStateSchema = z.string().regex(/^[a-f0-9]{32}$/);
const OAuthStartResponseSchema = z.object({ status: z.literal('ok'), url: z.string().max(16_384), state: OAuthStateSchema });
const OAuthEnvelopeSchema = z.object({ keyId: z.string(), nonce: z.string(), ciphertext: z.string(), authTag: z.string() });
const OAuthProviders = {
  codex: { authorize: 'https://auth.openai.com/oauth/authorize', callback: 'http://localhost:1455/auth/callback' },
  anthropic: { authorize: 'https://claude.ai/oauth/authorize', callback: 'http://localhost:54545/callback' },
  antigravity: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', callback: 'http://localhost:51121/oauth-callback' },
} as const;
interface OAuthFlowRow {
  id: string; connection_id: string; connection_revision: number; actor_id: string; provider: z.infer<typeof OAuthProviderSchema>; encrypted_state_json: string | null; status: 'pending' | 'submitted' | 'complete' | 'cancelled' | 'error' | 'expired'; created_at: string; expires_at: string; updated_at: string;
}
function oauthUrl(value: string, expected: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(422, 'gateway_oauth_url_invalid', 'OAuth URL is invalid'); }
  if (url.origin + url.pathname !== expected || url.username || url.password || url.hash) throw new HttpError(422, 'gateway_oauth_url_invalid', 'OAuth URL does not match the selected provider');
  return url;
}

const RevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const EditSchema = GatewayConnectionUpdateSchema.omit({ managementSecret: true, catalogSecret: true });
const RotateSchema = GatewayConnectionUpdateSchema.pick({ expectedRevision: true, managementSecret: true, catalogSecret: true }).refine((value) => value.managementSecret !== undefined || value.catalogSecret !== undefined, 'Supply a replacement credential');
const RollbackSchema = RevisionSchema.extend({ targetRevision: z.number().int().positive() });
const SettingValueSchema = z.union([z.number().int().min(0).max(3_600), z.enum(['round-robin', 'weighted-round-robin', 'fill-first'])]);
const ConfigChangeSchema = z.object({ expectedRevision: z.number().int().positive(), expectedConfigRevision: z.string().regex(/^[a-f0-9]{64}$/), setting: GatewaySettingKeySchema, value: SettingValueSchema }).strict().superRefine((value, ctx) => {
  if (value.setting === 'routing/strategy' ? typeof value.value !== 'string' : typeof value.value !== 'number' || value.value > (value.setting === 'max-retry-interval' ? 3_600 : 100)) ctx.addIssue({ code: 'custom', message: 'Setting value is outside the supported range' });
});
type ConfigChange = z.infer<typeof ConfigChangeSchema>;
const StatusSchema = RevisionSchema.extend({ expectedDisabled: z.boolean(), disabled: z.boolean() });
const CpaAccountSchema = z.object({
  auth_index: z.string().trim().regex(/^[A-Za-z0-9:_-]{1,128}$/), name: z.string().min(1).max(1_024), provider: z.string().max(80).optional(), type: z.string().max(80).optional(),
  status: z.enum(['unknown', 'active', 'pending', 'refreshing', 'error', 'disabled']).optional(), disabled: z.boolean().default(false), unavailable: z.boolean().default(false), runtime_only: z.boolean().default(true), source: z.string().max(40).optional(),
});
const CpaAccountsSchema = z.object({ files: z.array(CpaAccountSchema).max(2_000) });
const CpaSuccessSchema = z.object({ status: z.literal('ok') });
const KnownProviders = new Set(['codex', 'claude', 'anthropic', 'gemini', 'antigravity', 'qwen', 'kimi', 'xai', 'openai', 'openai-compatible', 'vertex', 'vertex-ai']);

function parseUpstream<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(503, 'gateway_management_invalid_response', 'Gateway returned an unsupported management response');
  return parsed.data;
}

export class GatewayManagementService {
  readonly #busy = new Set<string>();
  constructor(private readonly context: ServerContext, private readonly gateway: GatewayService) {}

  private assertRevision(id: string, teamId: string, revision: number): void {
    const connection = this.gateway.getConnection(id, teamId);
    if (connection.deleted_at || connection.archived_at || !connection.enabled) throw new HttpError(409, 'gateway_connection_disabled', 'Gateway connection is disabled or archived');
    if (connection.revision !== revision) throw new HttpError(409, 'gateway_revision_conflict', 'Connection changed; reload before applying edits');
  }

  private audit(id: string, actorId: string, action: string, outcome: 'allowed' | 'failed' = 'allowed'): void {
    recordAudit(this.context, { actorType: 'user', actorId, action: `gateway.management.${action}`, targetType: 'gateway_connection', targetId: id, outcome });
  }

  private history(id: string, actorId: string, action: string, before: unknown, after: unknown, outcome: 'allowed' | 'failed'): void {
    this.context.database.transaction(() => {
      this.context.database.prepare('INSERT INTO gateway_management_revisions(id, connection_id, action, before_json, after_json, outcome, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.context.ids.id(), id, action, JSON.stringify(before), JSON.stringify(after), outcome, actorId, this.context.clock.now().toISOString());
      this.audit(id, actorId, action, outcome);
    })();
  }

  historyList(id: string, teamId: string): Array<Record<string, unknown>> {
    this.gateway.getConnection(id, teamId);
    return (this.context.database.prepare('SELECT * FROM gateway_management_revisions WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(id) as Array<{ id: string; action: string; before_json: string; after_json: string; outcome: string; actor_id: string; created_at: string }>).map((row) => ({ id: row.id, action: row.action, before: JSON.parse(row.before_json) as unknown, after: JSON.parse(row.after_json) as unknown, outcome: row.outcome, actorId: row.actor_id, createdAt: row.created_at }));
  }

  async config(id: string, teamId: string) {
    const keys = GatewaySettingKeySchema.options;
    const observations = await Promise.all(keys.map(async (setting) => {
      const result = await this.gateway.readManagementSetting(id, teamId, setting);
      if (!result.ok) throw new HttpError(503, 'gateway_management_unavailable', 'Gateway setting is unavailable');
      const key = setting === 'routing/strategy' ? 'strategy' : setting;
      const record = parseUpstream(z.record(z.string(), z.unknown()), result.body);
      const value = parseUpstream<number | string>(setting === 'routing/strategy' ? z.enum(['round-robin', 'weighted-round-robin', 'fill-first']) : z.number().int().min(0).max(3_600), record[key]);
      return [setting, value] as const;
    }));
    const values = Object.fromEntries(observations) as Record<GatewaySettingKey, number | string>;
    return { values, revision: createHash('sha256').update(JSON.stringify(values)).digest('hex'), observedAt: this.context.clock.now().toISOString(), concurrency: 'best-effort' as const };
  }

  async previewConfig(id: string, teamId: string, raw: ConfigChange) {
    const input = ConfigChangeSchema.parse(raw);
    this.assertRevision(id, teamId, input.expectedRevision);
    const current = await this.config(id, teamId);
    if (current.revision !== input.expectedConfigRevision) throw new HttpError(409, 'gateway_config_conflict', 'CPA settings changed; reload before applying edits');
    return { before: current.values, after: { ...current.values, [input.setting]: input.value }, changes: [{ setting: input.setting, before: current.values[input.setting], after: input.value }], revision: current.revision, concurrency: 'best-effort' as const };
  }

  async applyConfig(id: string, teamId: string, raw: ConfigChange, actorId: string) {
    const input = ConfigChangeSchema.parse(raw);
    if (this.#busy.has(id)) throw new HttpError(409, 'gateway_management_busy', 'A management change is already in progress');
    this.#busy.add(id);
    try {
      const preview = await this.previewConfig(id, teamId, input);
      this.assertRevision(id, teamId, input.expectedRevision);
      this.audit(id, actorId, 'config.apply.request');
      try {
        const result = await this.gateway.writeManagementSetting(id, teamId, input.setting, input.value);
        if (!result.ok) throw new HttpError(503, 'gateway_management_rejected', 'CPA rejected the setting change');
        parseUpstream(CpaSuccessSchema, result.body);
      } catch (error) {
        this.history(id, actorId, 'config.apply', preview.before, preview.after, 'failed');
        throw error;
      }
      this.history(id, actorId, 'config.apply', preview.before, preview.after, 'allowed');
      return this.config(id, teamId);
    } finally { this.#busy.delete(id); }
  }

  private flow(id: string, teamId: string, flowId: string, actorId: string): OAuthFlowRow {
    this.gateway.getConnection(id, teamId);
    const flow = this.context.database.prepare('SELECT * FROM gateway_oauth_flows WHERE id = ? AND connection_id = ? AND actor_id = ?').get(flowId, id, actorId) as OAuthFlowRow | undefined;
    if (!flow) throw new HttpError(404, 'gateway_oauth_not_found', 'OAuth flow not found');
    if (['pending', 'submitted'].includes(flow.status) && flow.expires_at <= this.context.clock.now().toISOString()) {
      this.finishFlow(flow, 'expired');
      return { ...flow, status: 'expired', encrypted_state_json: null };
    }
    return flow;
  }

  private flowView(flow: OAuthFlowRow) {
    return { id: flow.id, provider: flow.provider, status: flow.status, createdAt: flow.created_at, expiresAt: flow.expires_at, updatedAt: flow.updated_at };
  }

  private flowState(flow: OAuthFlowRow): string {
    if (!flow.encrypted_state_json) throw new HttpError(409, 'gateway_oauth_finished', 'OAuth flow is no longer pending');
    try {
      return OAuthStateSchema.parse(decryptSecret(this.context.config, OAuthEnvelopeSchema.parse(JSON.parse(flow.encrypted_state_json)), `gateway:${flow.connection_id}:oauth:${flow.id}`));
    } catch { throw new HttpError(503, 'gateway_oauth_state_unavailable', 'OAuth flow state is unavailable'); }
  }

  private finishFlow(flow: OAuthFlowRow, status: OAuthFlowRow['status']): void {
    this.context.database.transaction(() => {
      const changed = this.context.database.prepare("UPDATE gateway_oauth_flows SET status = ?, encrypted_state_json = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'submitted')").run(status, this.context.clock.now().toISOString(), flow.id);
      if (changed.changes) this.audit(flow.connection_id, flow.actor_id, `oauth.${status}`, status === 'error' ? 'failed' : 'allowed');
    })();
  }

  async startOAuth(id: string, teamId: string, input: z.infer<typeof OAuthStartSchema>, actorId: string) {
    this.assertRevision(id, teamId, input.expectedRevision);
    if (this.#busy.has(id)) throw new HttpError(409, 'gateway_management_busy', 'A management change is already in progress');
    const now = this.context.clock.now().toISOString();
    const active = this.context.database.prepare("SELECT count(*) AS count FROM gateway_oauth_flows WHERE connection_id = ? AND status IN ('pending', 'submitted') AND expires_at > ?").get(id, now) as { count: number };
    if (active.count >= 5) throw new HttpError(429, 'gateway_oauth_limit', 'Complete or cancel an existing OAuth flow first');
    this.#busy.add(id);
    try {
      this.audit(id, actorId, 'oauth.start.request');
      const response = await this.gateway.startOAuth(id, teamId, input.provider);
      if (!response.ok) throw new HttpError(503, 'gateway_oauth_unavailable', 'CPA could not start the OAuth flow');
      const started = parseUpstream(OAuthStartResponseSchema, response.body);
      const specification = OAuthProviders[input.provider];
      const authorizationUrl = oauthUrl(started.url, specification.authorize);
      const allowedParameters = new Set(['client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'prompt', 'access_type', 'code', 'id_token_add_organizations', 'codex_cli_simplified_flow']);
      if ([...authorizationUrl.searchParams.keys()].some((key) => !allowedParameters.has(key) || authorizationUrl.searchParams.getAll(key).length !== 1)) throw new HttpError(503, 'gateway_oauth_invalid_response', 'CPA returned unsupported OAuth authorization parameters');
      if (authorizationUrl.searchParams.getAll('state').length !== 1 || authorizationUrl.searchParams.get('state') !== started.state || authorizationUrl.searchParams.getAll('redirect_uri').length !== 1 || authorizationUrl.searchParams.get('redirect_uri') !== specification.callback) throw new HttpError(503, 'gateway_oauth_invalid_response', 'CPA returned an unsupported OAuth authorization URL');
      this.assertRevision(id, teamId, input.expectedRevision);
      const flowId = this.context.ids.id();
      let encrypted;
      try { encrypted = encryptSecret(this.context.config, started.state, `gateway:${id}:oauth:${flowId}`); } catch { throw new HttpError(503, 'gateway_oauth_state_unavailable', 'OAuth flow state cannot be encrypted'); }
      const expiresAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
      this.context.database.transaction(() => {
        this.context.database.prepare("INSERT INTO gateway_oauth_flows(id, connection_id, connection_revision, actor_id, provider, encrypted_state_json, status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)").run(flowId, id, input.expectedRevision, actorId, input.provider, JSON.stringify(encrypted), now, expiresAt, now);
        this.audit(id, actorId, 'oauth.start');
      })();
      return { ...this.flowView(this.flow(id, teamId, flowId, actorId)), authorizationUrl: authorizationUrl.toString(), callbackMode: 'paste-redirect-url' as const };
    } finally { this.#busy.delete(id); }
  }

  async pollOAuth(id: string, teamId: string, flowId: string, actorId: string) {
    const flow = this.flow(id, teamId, flowId, actorId);
    if (!['pending', 'submitted'].includes(flow.status)) return this.flowView(flow);
    this.assertRevision(id, teamId, flow.connection_revision);
    const response = await this.gateway.pollOAuth(id, teamId, this.flowState(flow));
    if (!response.ok) throw new HttpError(503, 'gateway_oauth_unavailable', 'CPA OAuth status is unavailable');
    const result = parseUpstream(z.object({ status: z.enum(['wait', 'ok', 'error']) }), response.body);
    if (result.status !== 'wait') this.finishFlow(flow, result.status === 'ok' ? 'complete' : 'error');
    return this.flowView(this.flow(id, teamId, flowId, actorId));
  }

  async submitOAuth(id: string, teamId: string, flowId: string, redirectUrl: string, actorId: string) {
    const flow = this.flow(id, teamId, flowId, actorId);
    if (flow.status !== 'pending') throw new HttpError(409, 'gateway_oauth_callback_already_submitted', 'OAuth flow is not waiting for a callback');
    this.assertRevision(id, teamId, flow.connection_revision);
    if (this.#busy.has(id)) throw new HttpError(409, 'gateway_management_busy', 'A management change is already in progress');
    const state = this.flowState(flow);
    const callback = oauthUrl(redirectUrl, OAuthProviders[flow.provider].callback);
    if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state || callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code')?.trim() || callback.searchParams.has('error')) throw new HttpError(422, 'gateway_oauth_callback_invalid', 'Callback must contain the matching state and one authorization code');
    this.#busy.add(id);
    try {
      this.context.database.transaction(() => {
        this.context.database.prepare("UPDATE gateway_oauth_flows SET status = 'submitted', updated_at = ? WHERE id = ? AND status = 'pending'").run(this.context.clock.now().toISOString(), flow.id);
        this.audit(id, actorId, 'oauth.callback.request');
      })();
      try {
        const response = await this.gateway.submitOAuth(id, teamId, flow.provider, state, callback.searchParams.get('code')!);
        if (!response.ok) throw new HttpError(503, 'gateway_oauth_rejected', 'CPA did not accept the OAuth callback');
        parseUpstream(CpaSuccessSchema, response.body);
      } catch (error) {
        this.audit(id, actorId, 'oauth.callback', 'failed');
        throw error;
      }
      this.audit(id, actorId, 'oauth.callback');
      return this.flowView(this.flow(id, teamId, flowId, actorId));
    } finally { this.#busy.delete(id); }
  }

  async cancelOAuth(id: string, teamId: string, flowId: string, actorId: string) {
    const flow = this.flow(id, teamId, flowId, actorId);
    if (!['pending', 'submitted'].includes(flow.status)) return this.flowView(flow);
    this.assertRevision(id, teamId, flow.connection_revision);
    this.audit(id, actorId, 'oauth.cancel.request');
    const response = await this.gateway.cancelOAuth(id, teamId, this.flowState(flow));
    if (!response.ok) throw new HttpError(503, 'gateway_oauth_unavailable', 'CPA could not cancel the OAuth flow');
    const result = parseUpstream(z.object({ status: z.literal('ok'), cancelled: z.boolean() }), response.body);
    if (!result.cancelled) return this.pollOAuth(id, teamId, flowId, actorId);
    this.finishFlow(flow, 'cancelled');
    return this.flowView(this.flow(id, teamId, flowId, actorId));
  }

  private async upstreamAccounts(id: string, teamId: string) {
    const result = await this.gateway.readManagement(id, teamId, 'accounts');
    if (!result.ok) throw new HttpError(503, 'gateway_management_unavailable', 'Gateway account observations are unavailable');
    const accounts = parseUpstream(CpaAccountsSchema, result.body).files;
    if (new Set(accounts.map((account) => account.auth_index)).size !== accounts.length) throw new HttpError(503, 'gateway_management_invalid_response', 'Gateway returned duplicate account identities');
    return accounts;
  }

  async refreshAccounts(id: string, teamId: string, actorId: string) {
    const accounts = await this.upstreamAccounts(id, teamId);
    const observedAt = this.context.clock.now().toISOString();
    this.context.database.transaction(() => {
      this.context.database.prepare('UPDATE gateway_accounts SET management_supported = 0 WHERE connection_id = ?').run(id);
      for (const account of accounts) {
        const provider = account.provider ?? account.type ?? 'unknown';
        const status = account.disabled ? 'disabled' : account.unavailable ? 'unavailable' : account.status ?? 'unknown';
        this.context.database.prepare(`INSERT INTO gateway_accounts(id, connection_id, auth_index, provider, status, observed_at, management_supported, disabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connection_id, auth_index) DO UPDATE SET provider=excluded.provider, status=excluded.status, observed_at=excluded.observed_at, management_supported=excluded.management_supported, disabled=excluded.disabled`)
          .run(this.context.ids.id(), id, account.auth_index, KnownProviders.has(provider) ? provider : 'unknown', status, observedAt, !account.runtime_only && account.source === 'file' ? 1 : 0, account.disabled ? 1 : 0);
      }
      this.audit(id, actorId, 'accounts.refresh');
    })();
    return { accounts: this.gateway.listAccounts(id, teamId), observedAt };
  }

  async setAccountStatus(id: string, teamId: string, accountId: string, input: z.infer<typeof StatusSchema>, actorId: string) {
    this.assertRevision(id, teamId, input.expectedRevision);
    if (this.#busy.has(id)) throw new HttpError(409, 'gateway_management_busy', 'A management change is already in progress');
    const row = this.context.database.prepare('SELECT auth_index FROM gateway_accounts WHERE id = ? AND connection_id = ?').get(accountId, id) as { auth_index: string } | undefined;
    if (!row) throw new HttpError(404, 'gateway_account_not_found', 'Gateway account not found');
    this.#busy.add(id);
    try {
      const account = (await this.upstreamAccounts(id, teamId)).find((entry) => entry.auth_index === row.auth_index);
      if (!account || account.runtime_only || account.source !== 'file') throw new HttpError(409, 'gateway_account_action_unsupported', 'Status changes require an observed file-backed CPA account');
      if (account.disabled !== input.expectedDisabled) throw new HttpError(409, 'gateway_account_conflict', 'Account changed; refresh before applying edits');
      this.assertRevision(id, teamId, input.expectedRevision);
      this.audit(id, actorId, 'account.status.request');
      const before = { accountId, disabled: input.expectedDisabled };
      const after = { accountId, disabled: input.disabled };
      try {
        const result = await this.gateway.setAccountDisabled(id, teamId, account.name, account.auth_index, input.disabled);
        if (!result.ok) throw new HttpError(503, 'gateway_management_rejected', 'CPA rejected the account status change');
        parseUpstream(CpaSuccessSchema, result.body);
      } catch (error) {
        this.history(id, actorId, 'account.status', before, after, 'failed');
        throw error;
      }
      this.history(id, actorId, 'account.status', before, after, 'allowed');
      return this.refreshAccounts(id, teamId, actorId);
    } finally { this.#busy.delete(id); }
  }
}

export function registerGatewayManagementRoutes(app: DholeApp, context: ServerContext, gateway: GatewayService): void {
  const management = new GatewayManagementService(context, gateway);
  app.use('/api/gateway/connections/:id/oauth*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
  app.post('/api/gateway/connections/:id/oauth', (c) => route(c, async () => { const actor = admin(c); return management.startOAuth(c.req.param('id'), actor.teamId, await parseJson(c, OAuthStartSchema), actor.id); }, 201));
  app.get('/api/gateway/connections/:id/oauth/:flowId', (c) => route(c, () => { const actor = admin(c); return management.pollOAuth(c.req.param('id'), actor.teamId, c.req.param('flowId'), actor.id); }));
  app.post('/api/gateway/connections/:id/oauth/:flowId/callback', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, OAuthCallbackSchema, 20_000); return management.submitOAuth(c.req.param('id'), actor.teamId, c.req.param('flowId'), input.redirectUrl, actor.id); }));
  app.delete('/api/gateway/connections/:id/oauth/:flowId', (c) => route(c, () => { const actor = admin(c); return management.cancelOAuth(c.req.param('id'), actor.teamId, c.req.param('flowId'), actor.id); }));
  app.patch('/api/gateway/connections/:id', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, EditSchema); await gateway.checkConnectionChange(c.req.param('id'), actor.teamId, input); return gateway.updateConnection(c.req.param('id'), actor.teamId, input, actor.id); }));
  app.post('/api/gateway/connections/:id/secrets', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, RotateSchema); await gateway.checkConnectionChange(c.req.param('id'), actor.teamId, input); return gateway.updateConnection(c.req.param('id'), actor.teamId, input, actor.id, 'rotate'); }));
  app.post('/api/gateway/connections/:id/archive', (c) => route(c, async () => { const actor = admin(c); return gateway.updateConnection(c.req.param('id'), actor.teamId, await parseJson(c, RevisionSchema), actor.id, 'archive'); }));
  app.delete('/api/gateway/connections/:id', (c) => route(c, async () => { const actor = admin(c); return gateway.updateConnection(c.req.param('id'), actor.teamId, await parseJson(c, RevisionSchema), actor.id, 'delete'); }));
  app.post('/api/gateway/connections/:id/rollback', (c) => route(c, async () => { const actor = admin(c); const input = await parseJson(c, RollbackSchema); await gateway.checkConnectionRollback(c.req.param('id'), actor.teamId, input.expectedRevision, input.targetRevision); return gateway.updateConnection(c.req.param('id'), actor.teamId, { expectedRevision: input.expectedRevision }, actor.id, 'rollback', input.targetRevision); }));
  app.get('/api/gateway/connections/:id/revisions', (c) => route(c, () => { const actor = user(c); return gateway.connectionRevisions(c.req.param('id'), actor.teamId); }));
  app.get('/api/gateway/connections/:id/config', (c) => route(c, () => { const actor = user(c); return management.config(c.req.param('id'), actor.teamId); }));
  app.post('/api/gateway/connections/:id/config/preview', (c) => route(c, async () => { const actor = admin(c); return management.previewConfig(c.req.param('id'), actor.teamId, await parseJson(c, ConfigChangeSchema)); }));
  app.post('/api/gateway/connections/:id/config/apply', (c) => route(c, async () => { const actor = admin(c); return management.applyConfig(c.req.param('id'), actor.teamId, await parseJson(c, ConfigChangeSchema), actor.id); }));
  app.get('/api/gateway/connections/:id/management-history', (c) => route(c, () => { const actor = user(c); return management.historyList(c.req.param('id'), actor.teamId); }));
  app.post('/api/gateway/connections/:id/accounts/refresh', (c) => route(c, () => { const actor = user(c); return management.refreshAccounts(c.req.param('id'), actor.teamId, actor.id); }));
  app.post('/api/gateway/connections/:id/accounts/:accountId/status', (c) => route(c, async () => { const actor = admin(c); return management.setAccountStatus(c.req.param('id'), actor.teamId, c.req.param('accountId'), await parseJson(c, StatusSchema), actor.id); }));
}
