import { z } from 'zod';
import { ApiError } from './api';
import {
  AccountSchema, CatalogSchema, CatalogTokenSchema, CollectionSchema, ConfigPreviewSchema, ConfigSchema, ConnectionSchema, ManagementHistorySchema, OAuthFlowSchema, RequestPageSchema, RequestSchema, RevisionSchema, UsageSchema,
  type ConfigChange, type ConnectionInput, type ConnectionUpdate, type OAuthFlow, type RequestFilters,
} from './gateway-types';

const root = '/api/gateway';
const connectionPath = (id: string) => `${root}/connections/${encodeURIComponent(id)}`;
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export function gatewayQuery(filters: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(name, String(value));
  return query.toString();
}

async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = 'POST'): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    const cookie = typeof document === 'undefined' ? undefined : document.cookie.split('; ').find((item) => item.startsWith('dhole_csrf='))?.slice('dhole_csrf='.length);
    const csrf = cookie ? decodeURIComponent(cookie) : typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('dhole_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(path, { method: body === undefined ? 'GET' : method, headers, credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(payload);
    throw new ApiError(response.status, error.success ? error.data.error.code : 'request_failed', error.success ? error.data.error.message : `Gateway request failed (${response.status})`);
  }
  const result = schema.safeParse(payload);
  if (!result.success) throw new ApiError(502, 'invalid_gateway_response', 'Gateway returned an invalid response. Refresh or check server diagnostics.');
  return result.data;
}

function requireHttps(): void {
  if (typeof location !== 'undefined' && location.protocol !== 'https:') throw new ApiError(400, 'https_required', 'Open Dhole over HTTPS before submitting a credential.');
}

export const gatewayApi = {
  connections: () => request(`${root}/connections`, z.array(ConnectionSchema)),
  create: (input: ConnectionInput) => { requireHttps(); return request(`${root}/connections`, ConnectionSchema, input); },
  update: (id: string, input: ConnectionUpdate) => request(connectionPath(id), ConnectionSchema, input, 'PATCH'),
  archive: (id: string, expectedRevision: number) => request(`${connectionPath(id)}/archive`, ConnectionSchema, { expectedRevision }),
  remove: (id: string, expectedRevision: number) => request(connectionPath(id), ConnectionSchema, { expectedRevision }, 'DELETE'),
  rotate: (id: string, input: { expectedRevision: number; managementSecret?: string; catalogSecret?: string }) => { requireHttps(); return request(`${connectionPath(id)}/secrets`, ConnectionSchema, input); },
  revisions: (id: string) => request(`${connectionPath(id)}/revisions`, z.array(RevisionSchema)),
  rollback: (id: string, expectedRevision: number, targetRevision: number) => request(`${connectionPath(id)}/rollback`, ConnectionSchema, { expectedRevision, targetRevision }),
  health: (id: string) => request(`${connectionPath(id)}/health`, z.object({ ok: z.boolean(), status: z.number() }), {}),
  sync: (id: string) => request(`${connectionPath(id)}/sync`, z.object({ inserted: z.number(), duplicates: z.number(), received: z.number() }), {}),
  accounts: (id: string) => request(`${root}/accounts?${gatewayQuery({ connectionId: id })}`, z.array(AccountSchema)),
  refreshAccounts: (id: string) => request(`${connectionPath(id)}/accounts/refresh`, z.object({ accounts: z.array(AccountSchema), observedAt: z.string() }), {}),
  accountStatus: (id: string, accountId: string, input: { expectedRevision: number; expectedDisabled: boolean; disabled: boolean }) => request(`${connectionPath(id)}/accounts/${encodeURIComponent(accountId)}/status`, z.object({ accounts: z.array(AccountSchema), observedAt: z.string() }), input),
  config: (id: string) => request(`${connectionPath(id)}/config`, ConfigSchema),
  previewConfig: (id: string, input: ConfigChange) => request(`${connectionPath(id)}/config/preview`, ConfigPreviewSchema, input),
  applyConfig: (id: string, input: ConfigChange) => request(`${connectionPath(id)}/config/apply`, ConfigSchema, input),
  managementHistory: (id: string) => request(`${connectionPath(id)}/management-history`, ManagementHistorySchema),
  startOAuth: (id: string, expectedRevision: number, provider: OAuthFlow['provider']) => { requireHttps(); return request(`${connectionPath(id)}/oauth`, OAuthFlowSchema.extend({ authorizationUrl: z.url().refine((value) => value.startsWith('https://')), callbackMode: z.literal('paste-redirect-url') }), { expectedRevision, provider }); },
  oauth: (id: string, flowId: string) => request(`${connectionPath(id)}/oauth/${encodeURIComponent(flowId)}`, OAuthFlowSchema),
  oauthCallback: (id: string, flowId: string, redirectUrl: string) => { requireHttps(); return request(`${connectionPath(id)}/oauth/${encodeURIComponent(flowId)}/callback`, OAuthFlowSchema, { redirectUrl }); },
  cancelOAuth: (id: string, flowId: string) => request(`${connectionPath(id)}/oauth/${encodeURIComponent(flowId)}`, OAuthFlowSchema, {}, 'DELETE'),
  collection: (id: string) => request(`${connectionPath(id)}/collection`, CollectionSchema),
  requests: (filters: RequestFilters, offset = 0) => request(`${root}/requests?${gatewayQuery({ ...filters, offset, limit: 25 })}`, RequestPageSchema),
  usage: (filters: RequestFilters, bucket: 'hour' | 'day', groupBy: 'none' | 'provider' | 'model' | 'authIndex') => request(`${root}/usage?${gatewayQuery({ ...filters, bucket, groupBy })}`, UsageSchema),
  export: (filters: RequestFilters, cursor?: string) => request(`${root}/requests/export?${gatewayQuery({ ...filters, cursor, format: 'json', limit: 500 })}`, z.object({ items: z.array(RequestSchema), nextCursor: z.string().nullable() })),
  prune: (id: string) => request(`${connectionPath(id)}/prune`, z.object({ cutoff: z.string(), deleted: z.number(), remainingEligible: z.number(), hasMore: z.boolean() }), { limit: 1000 }),
  catalog: (id: string) => request(`${connectionPath(id)}/catalog`, CatalogSchema),
  refreshCatalog: (id: string, clientVersion?: string) => request(`${connectionPath(id)}/catalog/refresh`, CatalogSchema, clientVersion ? { clientVersion } : {}),
  modelPolicy: (id: string, modelId: string, enabled: boolean) => request(`${connectionPath(id)}/catalog/models/${encodeURIComponent(modelId)}`, CatalogSchema, { enabled }, 'PATCH'),
  tokens: (id: string) => request(`${connectionPath(id)}/catalog/tokens`, z.object({ tokens: z.array(CatalogTokenSchema) })),
  issueToken: (id: string, input: { name: string; client: 'generic' | 'opencode' | 'codex'; expiresInDays: number }) => { requireHttps(); return request(`${connectionPath(id)}/catalog/tokens`, z.object({ id: z.string(), token: z.string(), client: z.string(), expiresAt: z.string(), endpoint: z.string() }), input); },
  revokeToken: (id: string, tokenId: string) => request(`${connectionPath(id)}/catalog/tokens/${encodeURIComponent(tokenId)}`, z.object({ ok: z.boolean() }), {}, 'DELETE'),
};
