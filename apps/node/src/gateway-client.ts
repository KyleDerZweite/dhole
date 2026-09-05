import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './config.js';
import { ClientError, ProjectTokenSchema, readAgentState, requestJson } from './onboarding.js';

const Id = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u).refine((value) => value !== '.' && value !== '..');
const Text = z.string().max(16_384);
const Count = z.number().int().nonnegative();
const OptionalText = Text.nullish();
const Revision = z.number().int().positive();
const PrivateFile = z.string().min(1).max(4096).refine(isAbsolute);
const Name = z.string().trim().min(1).max(120);
const BaseUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
const Client = z.enum(['generic', 'opencode', 'codex']);
const OpenCodeProvider = z.string().regex(/^dhole-[a-z0-9][a-z0-9-]{0,79}$/u);
const OpenCodeDestination = z.object({ schemaVersion: z.literal(1), provider: OpenCodeProvider, connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,240}$/u), endpoint: z.url().max(2048) }).refine((value) => {
  const url = new URL(value.endpoint);
  return !url.username && !url.password && !url.search && !url.hash
    && url.pathname === `/api/gateway/catalog/v1/${value.connectionId}/opencode`
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
});
const Provider = z.enum(['codex', 'anthropic', 'antigravity']);
const Strategy = z.enum(['round-robin', 'weighted-round-robin', 'fill-first']);
const Setting = z.enum(['request-retry', 'max-retry-credentials', 'max-retry-interval', 'routing/strategy']);
const Change = z.object({
  expectedRevision: Revision, expectedConfigRevision: z.string().regex(/^[a-f0-9]{64}$/u), setting: Setting,
  value: z.union([z.number().int().min(0).max(3600), Strategy]),
}).strict().refine((value) => value.setting === 'routing/strategy' ? typeof value.value === 'string'
  : typeof value.value === 'number' && value.value <= (value.setting === 'max-retry-interval' ? 3600 : 100));
const Filters = z.object({
  provider: z.string().min(1).max(128).optional(), model: z.string().min(1).max(256).optional(),
  authIndex: z.string().min(1).max(128).optional(), failed: z.boolean().optional(), statusCode: z.number().int().min(100).max(599).optional(),
  occurredFrom: z.iso.datetime({ offset: true }).optional(), occurredTo: z.iso.datetime({ offset: true }).optional(),
  correlationConfidence: z.enum(['exact', 'high', 'medium', 'low', 'none']).optional(),
}).strict();
const Connected = z.object({ connectionId: Id });

/** Only file references enter agent arguments. No credential or arbitrary endpoint fields are accepted. */
export const GatewayActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connections.list') }).strict(),
  z.object({ action: z.literal('connections.create'), name: Name, baseUrl: BaseUrl, secretFile: PrivateFile, enabled: z.boolean().default(true), retentionDays: z.number().int().min(1).max(3650).default(30) }).strict(),
  Connected.extend({ action: z.literal('connections.update'), expectedRevision: Revision, name: Name.optional(), baseUrl: BaseUrl.optional(), enabled: z.boolean().optional(), retentionDays: z.number().int().min(1).max(3650).optional() }).strict(),
  Connected.extend({ action: z.literal('connections.rotate'), expectedRevision: Revision, secretFile: PrivateFile }).strict(),
  Connected.extend({ action: z.literal('health') }).strict(),
  Connected.extend({ action: z.literal('sync') }).strict(),
  Connected.extend({ action: z.literal('catalog.read') }).strict(),
  Connected.extend({ action: z.literal('catalog.refresh'), clientVersion: z.string().min(1).max(80).regex(/^[\w.+-]+$/u).optional() }).strict(),
  Connected.extend({ action: z.literal('models.policy'), modelId: Id, enabled: z.boolean() }).strict(),
  Connected.extend({ action: z.literal('accounts.list') }).strict(),
  Connected.extend({ action: z.literal('accounts.refresh') }).strict(),
  Connected.extend({ action: z.literal('accounts.status'), accountId: Id, expectedRevision: Revision, expectedDisabled: z.boolean(), disabled: z.boolean() }).strict(),
  Connected.extend({ action: z.literal('config.read') }).strict(),
  Connected.extend({ action: z.literal('config.preview'), change: Change }).strict(),
  Connected.extend({ action: z.literal('config.apply'), change: Change }).strict(),
  Connected.extend({ action: z.literal('collection') }).strict(),
  Connected.extend({ action: z.literal('usage'), filters: Filters.optional(), bucket: z.enum(['hour', 'day']).default('day'), groupBy: z.enum(['none', 'provider', 'model', 'authIndex']).default('none'), limit: z.number().int().min(1).max(1000).default(100) }).strict(),
  Connected.extend({ action: z.literal('requests'), filters: Filters.optional(), offset: Count.default(0), limit: z.number().int().min(1).max(100).default(25) }).strict(),
  Connected.extend({ action: z.literal('oauth.start'), expectedRevision: Revision, provider: Provider }).strict(),
  Connected.extend({ action: z.literal('oauth.status'), flowId: Id }).strict(),
  Connected.extend({ action: z.literal('oauth.callback'), flowId: Id, redirectFile: PrivateFile }).strict(),
  Connected.extend({ action: z.literal('oauth.cancel'), flowId: Id }).strict(),
  Connected.extend({ action: z.literal('tokens.list') }).strict(),
  Connected.extend({ action: z.literal('tokens.issue'), name: Name, client: Client, expiresInDays: z.number().int().min(1).max(30).default(7), openCodeProvider: OpenCodeProvider.default('dhole-cpa') }).strict(),
  Connected.extend({ action: z.literal('tokens.revoke'), tokenId: Id }).strict(),
]);
export type GatewayAction = z.infer<typeof GatewayActionSchema>;

// Responses deliberately select public fields. Provider metadata and raw upstream errors stay on the server.
const Connection = z.object({ id: Id, name: Text, baseUrl: BaseUrl, providerId: OptionalText, enabled: z.boolean(), status: Text, revision: Revision, retentionDays: Count, archivedAt: OptionalText, deletedAt: OptionalText, lastCheckedAt: OptionalText, managementConfigured: z.boolean(), catalogConfigured: z.boolean() });
const Account = z.object({ id: Id, authIndex: Text, provider: Text, label: OptionalText, status: Text, cooldownUntil: OptionalText, connectionId: Id.optional(), disabled: z.boolean().optional(), managementSupported: z.boolean().optional(), observedAt: OptionalText });
const Accounts = z.object({ accounts: z.array(Account), observedAt: Text });
const Values = z.object({ 'request-retry': Count, 'max-retry-credentials': Count, 'max-retry-interval': Count, 'routing/strategy': Strategy });
const Config = z.object({ values: Values, revision: z.string().regex(/^[a-f0-9]{64}$/u), observedAt: Text, concurrency: z.literal('best-effort') });
const Preview = z.object({ before: Values, after: Values, changes: z.array(z.object({ setting: Setting, before: z.union([Text, z.number()]), after: z.union([Text, z.number()]) })), revision: Text, concurrency: z.literal('best-effort') });
const Catalog = z.object({
  schemaVersion: z.literal(1), connectionId: Id, providerId: Id, connectionEnabled: z.boolean(), providerEnabled: z.boolean(), sourceMatchesConnection: z.boolean(),
  status: z.enum(['unobserved', 'current', 'stale', 'error']), stale: z.boolean(), lastAttemptAt: OptionalText, lastSuccessAt: OptionalText,
  error: z.object({ code: Text }).nullable(),
  models: z.array(z.object({
    modelId: Id, modelKey: Text, displayName: Text, enabled: z.boolean(), available: z.boolean(),
    declared: z.object({ owner: Text.optional(), contextWindow: Count.optional(), maxOutputTokens: Count.optional(), inputModalities: z.array(Text).optional(), outputModalities: z.array(Text).optional(), reasoningLevels: z.array(Text).optional(), defaultReasoningLevel: Text.optional(), parallelToolCalls: z.boolean().optional(), capabilities: z.object({ tools: z.boolean().optional(), vision: z.boolean().optional(), reasoning: z.boolean().optional(), streaming: z.boolean().optional(), json: z.boolean().optional() }).optional() }),
    measuredCapabilities: z.object({ tools: z.enum(['supported', 'unsupported', 'unknown']).optional(), vision: z.enum(['supported', 'unsupported', 'unknown']).optional(), reasoning: z.enum(['supported', 'unsupported', 'unknown']).optional(), streaming: z.enum(['supported', 'unsupported', 'unknown']).optional(), json: z.enum(['supported', 'unsupported', 'unknown']).optional() }),
    compatibility: z.object({ generic: z.boolean(), opencode: z.boolean(), codex: z.boolean() }),
  })),
});
const Collection = z.object({ connectionId: Id, mode: z.literal('push_or_import'), automaticCollection: z.literal(false), queueConsumption: z.literal('explicit_only'), status: z.enum(['no_records', 'history_available', 'history_pruned']), lastStoredAt: OptionalText, totalStored: Count, retainedRequests: Count, oldestRetainedAt: OptionalText, newestRetainedAt: OptionalText, retentionDays: Count });
const Usage = z.object({ bucket: z.enum(['hour', 'day']), groupBy: z.enum(['none', 'provider', 'model', 'authIndex']), truncated: z.boolean(), items: z.array(z.object({ bucketStart: Text, group: Text.nullable(), requests: Count, failures: Count, inputTokens: Count, outputTokens: Count, estimatedCostMicrousd: z.number().nullable(), unpricedRequests: Count, averageDurationMs: z.number().nullable(), measuredRequests: Count, averageTtftMs: z.number().nullable() })) });
const Requests = z.object({ items: z.array(z.object({ id: Id, occurredAt: Text, provider: Text, model: Text, requestedModel: OptionalText, authIndex: OptionalText, statusCode: z.number().nullish(), failed: z.boolean(), failureCategory: OptionalText, durationMs: z.number().nullish(), ttftMs: z.number().nullish(), inputTokens: Count, outputTokens: Count, estimatedCostMicrousd: z.number().nullish(), correlationConfidence: OptionalText, sessionId: OptionalText, projectId: OptionalText })), total: Count, offset: Count, limit: Count, nextOffset: Count.nullable() });
const Flow = z.object({ id: Id, provider: Provider, status: z.enum(['pending', 'submitted', 'complete', 'error', 'expired', 'cancelled']), createdAt: Text, expiresAt: Text, updatedAt: Text });
const Token = z.object({ id: Id, name: Text, client: Client, createdAt: Text, expiresAt: Text, lastUsedAt: OptionalText, revokedAt: OptionalText });
const Secrets = z.object({ managementSecret: z.string().min(1).max(16_384).optional(), catalogSecret: z.string().min(1).max(16_384).optional() }).strict().refine((value) => value.managementSecret !== undefined || value.catalogSecret !== undefined);
const Redirect = z.object({ redirectUrl: z.string().min(1).max(16_384) }).strict();

function privateJson<T>(path: string, schema: z.ZodType<T>): T {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > 64 * 1024) throw new Error();
    return schema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown);
  } catch { throw new ClientError('gateway_private_file_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function publicResult(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map((item) => publicResult(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicResult(item, secrets)]));
  return value;
}

export interface GatewayClientOptions { stateDir: string; projectId: string; fetch?: typeof fetch; now?: () => number }

/** Device and derived bearer credentials remain inside this client, including when an upstream response is invalid. */
export async function executeGatewayAction(input: unknown, options: GatewayClientOptions): Promise<unknown> {
  const parsed = GatewayActionSchema.safeParse(input);
  const projectId = Id.max(160).safeParse(options.projectId);
  if (!parsed.success || !projectId.success) throw new ClientError('invalid_gateway_action');
  const action = parsed.data;
  const agent = readAgentState(options.stateDir);
  const now = (options.now ?? Date.now)();
  if (Date.parse(agent.expiresAt) <= now) throw new ClientError('machine_authorization_expired');
  const readActions: GatewayAction['action'][] = ['connections.list', 'catalog.read', 'accounts.list', 'config.read', 'collection', 'usage', 'requests'];
  const permission = readActions.includes(action.action) ? 'gateway:read' : 'gateway:manage';
  if (!agent.permissions.includes(permission)) throw new ClientError('gateway_not_authorized');
  let openCodeDestination: z.infer<typeof OpenCodeDestination> | undefined;
  if (action.action === 'tokens.issue' && action.client === 'opencode') {
    const destination = OpenCodeDestination.safeParse({ schemaVersion: 1, provider: action.openCodeProvider, connectionId: action.connectionId, endpoint: new URL(`/api/gateway/catalog/v1/${encodeURIComponent(action.connectionId)}/opencode`, agent.serverUrl).href });
    if (!destination.success) throw new ClientError('gateway_opencode_settings_invalid');
    openCodeDestination = destination.data;
  }
  const transport = options.fetch ? { fetch: options.fetch } : {};
  const secretValues = [agent.token];
  let credentials: z.infer<typeof Secrets> | undefined;
  let callback: z.infer<typeof Redirect> | undefined;
  if ('secretFile' in action) {
    credentials = privateJson(action.secretFile, Secrets);
    if (action.action === 'connections.create' && !credentials.managementSecret) throw new ClientError('gateway_management_secret_required');
    secretValues.push(...Object.values(credentials).filter((value): value is string => value !== undefined));
  }
  if (action.action === 'oauth.callback') {
    callback = privateJson(action.redirectFile, Redirect);
    secretValues.push(callback.redirectUrl);
    try { const code = new URL(callback.redirectUrl).searchParams.get('code'); if (code) secretValues.push(code); }
    catch { throw new ClientError('gateway_private_file_invalid'); }
  }
  const project = await requestJson(agent.serverUrl, '/api/auth/device/project', ProjectTokenSchema, {
    ...transport, token: agent.token, body: { mode: 'manual', projectId: projectId.data, permissions: [permission] },
  });
  if (project.projectId !== projectId.data || project.permissions.length !== 1 || project.permissions[0] !== permission || Date.parse(project.expiresAt) <= now) throw new ClientError('invalid_server_response');
  secretValues.push(project.token);
  const root = '/api/gateway';
  const path = 'connectionId' in action ? `${root}/connections/${encodeURIComponent(action.connectionId)}` : `${root}/connections`;
  const request = async <T>(url: string, schema: z.ZodType<T>, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => requestJson(agent.serverUrl, url, schema, { ...transport, token: project.token, method, ...(body === undefined ? {} : { body }) });
  const query = (values: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined).map(([key, value]) => [key, String(value)])).toString();
  const save = (kind: string, value: unknown): string => {
    const file = join(options.stateDir, 'gateway', `${kind}-${randomUUID()}.json`);
    try { writePrivateJson(file, value); } catch { throw new ClientError('gateway_private_save_failed'); }
    return file;
  };
  let result: unknown;
  switch (action.action) {
    case 'connections.list': result = await request(path, z.array(Connection)); break;
    case 'connections.create': result = await request(path, Connection, { name: action.name, baseUrl: action.baseUrl, enabled: action.enabled, retentionDays: action.retentionDays, ...credentials }); break;
    case 'connections.update': { const { action: _, connectionId: __, ...body } = action; result = await request(path, Connection, body, 'PATCH'); break; }
    case 'connections.rotate': result = await request(`${path}/secrets`, Connection, { expectedRevision: action.expectedRevision, ...credentials }); break;
    case 'health': result = await request(`${path}/health`, z.object({ ok: z.boolean(), status: z.number().int() }), {}); break;
    case 'sync': result = await request(`${path}/sync`, z.object({ received: Count, inserted: Count, duplicates: Count }), {}); break;
    case 'catalog.read': result = await request(`${path}/catalog`, Catalog); break;
    case 'catalog.refresh': result = await request(`${path}/catalog/refresh`, Catalog, action.clientVersion ? { clientVersion: action.clientVersion } : {}); break;
    case 'models.policy': result = await request(`${path}/catalog/models/${encodeURIComponent(action.modelId)}`, Catalog, { enabled: action.enabled }, 'PATCH'); break;
    case 'accounts.list': result = await request(`${root}/accounts?${query({ connectionId: action.connectionId })}`, z.array(Account)); break;
    case 'accounts.refresh': result = await request(`${path}/accounts/refresh`, Accounts, {}); break;
    case 'accounts.status': result = await request(`${path}/accounts/${encodeURIComponent(action.accountId)}/status`, Accounts, { expectedRevision: action.expectedRevision, expectedDisabled: action.expectedDisabled, disabled: action.disabled }); break;
    case 'config.read': result = await request(`${path}/config`, Config); break;
    case 'config.preview': result = await request(`${path}/config/preview`, Preview, action.change); break;
    case 'config.apply': result = await request(`${path}/config/apply`, Config, action.change); break;
    case 'collection': result = await request(`${path}/collection`, Collection); break;
    case 'usage': result = await request(`${root}/usage?${query({ ...action.filters, connectionId: action.connectionId, bucket: action.bucket, groupBy: action.groupBy, limit: action.limit })}`, Usage); break;
    case 'requests': result = await request(`${root}/requests?${query({ ...action.filters, connectionId: action.connectionId, offset: action.offset, limit: action.limit })}`, Requests); break;
    case 'oauth.start': {
      const flow = await request(`${path}/oauth`, Flow.extend({ authorizationUrl: z.url().max(16_384).refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }), callbackMode: z.literal('paste-redirect-url') }), { expectedRevision: action.expectedRevision, provider: action.provider });
      const { authorizationUrl, ...metadata } = flow;
      result = { ...metadata, authorizationFile: save('oauth', { ...flow, serverUrl: agent.serverUrl, connectionId: action.connectionId }), message: 'Open the authorization URL in the private file, then submit a private JSON redirectFile containing redirectUrl.' };
      secretValues.push(authorizationUrl);
      break;
    }
    case 'oauth.status': result = await request(`${path}/oauth/${encodeURIComponent(action.flowId)}`, Flow); break;
    case 'oauth.callback': result = await request(`${path}/oauth/${encodeURIComponent(action.flowId)}/callback`, Flow, callback); break;
    case 'oauth.cancel': result = await request(`${path}/oauth/${encodeURIComponent(action.flowId)}`, Flow, {}, 'DELETE'); break;
    case 'tokens.list': result = await request(`${path}/catalog/tokens`, z.object({ tokens: z.array(Token) })); break;
    case 'tokens.issue': {
      const issued = await request(`${path}/catalog/tokens`, z.object({ id: Id, token: z.string().regex(/^[A-Za-z0-9_-]{32,160}$/u), client: Client, expiresAt: z.iso.datetime(), endpoint: Text }), { name: action.name, client: action.client, expiresInDays: action.expiresInDays });
      if (issued.client !== action.client || issued.endpoint !== `${root}/catalog/v1/${encodeURIComponent(action.connectionId)}/${action.client}`) throw new ClientError('invalid_server_response');
      const { token, ...metadata } = issued;
      const privateToken = openCodeDestination
        ? { ...openCodeDestination, token }
        : { ...issued, serverUrl: agent.serverUrl, connectionId: action.connectionId };
      result = { ...metadata, credentialFile: save('catalog-token', privateToken) };
      secretValues.push(token);
      break;
    }
    case 'tokens.revoke': result = await request(`${path}/catalog/tokens/${encodeURIComponent(action.tokenId)}`, z.object({ ok: z.boolean() }), {}, 'DELETE'); break;
  }
  return publicResult(result, secretValues);
}
