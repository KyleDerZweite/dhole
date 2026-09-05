import { z } from 'zod';
import type {
  Approval,
  CoordinationState,
  AuthMethods,
  DeviceCredential,
  DeviceRequest,
  ModuleCatalog,
  GatewayRequest,
  GatewaySummary,
  JsonObject,
  Machine,
  Project,
  Repository,
  SessionMessage,
  SessionSnapshot,
  SessionSummary,
  RuntimeRegistration,
  User,
} from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = document.cookie.split('; ').find((item) => item.startsWith('dhole_csrf='))?.split('=').slice(1).join('=');
  return value ? decodeURIComponent(value) : sessionStorage.getItem('dhole_csrf') ?? undefined;
}

async function request<T>(path: string, options: RequestInit = {}, schema?: z.ZodType): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.credentials !== 'omit' && options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    const csrf = csrfToken();
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  let payload: unknown = undefined;
  try { payload = await response.json(); } catch { /* an empty response is valid for some mutations */ }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? payload as JsonObject : {};
    const detail = error.error && typeof error.error === 'object' ? error.error as JsonObject : {};
    throw new ApiError(response.status, typeof detail.code === 'string' ? detail.code : 'request_failed', typeof detail.message === 'string' ? detail.message : `Request failed (${response.status})`);
  }
  if (schema) {
    const result = schema.safeParse(payload);
    if (!result.success) throw new ApiError(502, 'invalid_response', 'The server returned an invalid response.');
    return result.data as T;
  }
  return payload as T;
}

const UserSchema = z.object({ id: z.string(), email: z.string(), displayName: z.string(), role: z.enum(['administrator', 'member']), status: z.enum(['active', 'pending', 'disabled']), teamId: z.string(), createdAt: z.string().optional(), github: z.object({ userId: z.number().int().positive(), login: z.string() }).optional() });
const AuthResponseSchema = z.object({ user: UserSchema, csrfToken: z.string().optional() });
const AuthMethodsSchema = z.object({ mode: z.string(), password: z.boolean(), bootstrap: z.boolean(), bootstrapTokenRequired: z.boolean(), github: z.boolean(), githubLink: z.boolean() });
const ModuleCatalogSchema = z.object({
  enabledModules: z.array(z.string()).max(64),
  modules: z.array(z.object({ id: z.string(), dependencies: z.array(z.string()), contributions: z.object({
    navigation: z.array(z.object({ id: z.string(), label: z.string(), path: z.string().regex(/^\/(?!\/)[a-zA-Z0-9/_-]*$/u) })),
    webSockets: z.array(z.string()), jobs: z.array(z.string()),
  }) })).max(64),
});
const DeviceRequestSchema = z.object({ machineName: z.string(), permissions: z.array(z.string()), expiresAt: z.iso.datetime(), status: z.enum(['pending', 'approved']) });
const DevicesSchema = z.object({ devices: z.array(z.object({ id: z.string(), machineName: z.string(), machineId: z.string().nullable(), permissions: z.array(z.string()), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable() })) });
const OkSchema = z.object({ ok: z.literal(true) });
const SessionSummarySchema = z.object({ id: z.string(), projectId: z.string(), title: z.string(), state: z.string() }).passthrough();
const LeaseSchema = z.object({ token: z.string().min(1), expiresAt: z.iso.datetime() });

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  invitation: (token: string) => request<{ invitation: { emailHint: string; teamName: string; role: User['role']; expiresAt: string } }>(`/api/auth/invitation?token=${encodeURIComponent(token)}`, { credentials: 'omit' }, z.object({ invitation: z.object({ emailHint: z.string(), teamName: z.string(), role: z.enum(['member', 'administrator']), expiresAt: z.iso.datetime() }) })),
  acceptInvitation: (token: string, displayName: string, password: string) => request<{ ok: true }>('/api/auth/invitation/accept', { ...json({ token, displayName, password }), credentials: 'omit' }, OkSchema),
  passwordReset: (token: string) => request<{ reset: { emailHint: string; expiresAt: string } }>(`/api/auth/password/reset?token=${encodeURIComponent(token)}`, { credentials: 'omit' }, z.object({ reset: z.object({ emailHint: z.string(), expiresAt: z.iso.datetime() }) })),
  acceptPasswordReset: (token: string, newPassword: string) => request<{ ok: true }>('/api/auth/password/reset', { ...json({ token, newPassword }), credentials: 'omit' }, OkSchema),
  inviteUser: (email: string, role: User['role']) => request<{ invitation: { id: string; email: string; role: User['role']; expiresAt: string; setupUrl: string } }>('/api/admin/invitations', json({ email, role }), z.object({ invitation: z.object({ id: z.string(), email: z.string(), role: z.enum(['member', 'administrator']), expiresAt: z.iso.datetime(), setupUrl: z.url() }) })),
  resetUserPassword: (id: string) => request<{ reset: { id: string; expiresAt: string; setupUrl: string } }>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, json({}), z.object({ reset: z.object({ id: z.string(), expiresAt: z.iso.datetime(), setupUrl: z.url() }) })),
  authMethods: () => request<AuthMethods>('/api/auth/methods', {}, AuthMethodsSchema),
  modules: () => request<ModuleCatalog>('/api/modules', {}, ModuleCatalogSchema),
  deviceRequest: (code: string) => request<DeviceRequest>(`/api/auth/device/requests/${encodeURIComponent(code)}`, {}, DeviceRequestSchema),
  approveDevice: (userCode: string, permissions: string[]) => request<{ ok: true }>('/api/auth/device/approve', json({ userCode, permissions }), OkSchema),
  devices: async () => (await request<{ devices: DeviceCredential[] }>('/api/auth/devices', {}, DevicesSchema)).devices,
  revokeDevice: (id: string) => request<{ ok: true }>(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, OkSchema),
  updateUser: (id: string, input: { status?: User['status']; role?: User['role'] }) => request<{ ok: true }>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }, OkSchema),
  me: () => request<{ user: User; csrfToken?: string }>('/api/auth/me', {}, AuthResponseSchema),
  login: async (email: string, password: string) => {
    const value = await request<{ user: User; csrfToken?: string }>('/api/auth/login', json({ email, password }), AuthResponseSchema);
    if (value.csrfToken) sessionStorage.setItem('dhole_csrf', value.csrfToken);
    return value;
  },
  bootstrap: async (input: JsonObject, bootstrapToken?: string) => {
    const value = await request<{ user: User; csrfToken?: string }>('/api/auth/bootstrap', { ...json(input), ...(bootstrapToken ? { headers: { 'x-dhole-bootstrap-token': bootstrapToken } } : {}) }, AuthResponseSchema);
    if (value.csrfToken) sessionStorage.setItem('dhole_csrf', value.csrfToken);
    return value;
  },
  linkGitHub: (currentPassword: string) => request<{ authorizeUrl: string }>('/api/auth/github/link', json({ currentPassword }), z.object({ authorizeUrl: z.url().refine((value) => { const url = new URL(value); return url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize'; }) })),
  changePassword: async (currentPassword: string, newPassword: string) => {
    const value = await request<{ user: User; csrfToken?: string }>('/api/auth/password', json({ currentPassword, newPassword }), AuthResponseSchema);
    if (value.csrfToken) sessionStorage.setItem('dhole_csrf', value.csrfToken);
    return value;
  },
  logout: async () => { await request('/api/auth/logout', json({})); sessionStorage.removeItem('dhole_csrf'); },
  projects: async () => (await request<{ projects: Project[] }>('/api/projects')).projects,
  project: (id: string) => request<{ project: Project; repositories: Repository[] }>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (input: JsonObject) => request<{ project: Project }>('/api/projects', json(input)),
  repositories: (projectId: string) => request<{ repositories: Repository[] }>(`/api/projects/${encodeURIComponent(projectId)}/repositories`),
  createRepository: (projectId: string, input: JsonObject) => request<{ repository: Repository }>(`/api/projects/${encodeURIComponent(projectId)}/repositories`, json(input)),
  users: async () => (await request<{ users: User[] }>('/api/admin/users', {}, z.object({ users: z.array(UserSchema) }))).users,
  createUser: (input: JsonObject) => request<{ user: User }>('/api/admin/users', json(input), z.object({ user: UserSchema })),
  machines: () => request<Machine[]>('/api/machines'),
  sessions: async (projectId: string) => (await request<{ sessions: SessionSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`)).sessions,
  runtimeRegistrations: async (projectId: string) => (await request<{ registrations: RuntimeRegistration[] }>(`/api/projects/${encodeURIComponent(projectId)}/runtime-registrations`)).registrations,
  createSession: (projectId: string, input: JsonObject) => request<SessionSummary>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, json(input), SessionSummarySchema),
  session: (sessionId: string, after?: number) => request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot${after ? `?after=${after}` : ''}`),
  queueMessage: (sessionId: string, input: JsonObject) => request<SessionMessage>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, json(input)),
  createRun: (sessionId: string, input: JsonObject) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, json(input)),
  startRun: (runId: string) => request<JsonObject>(`/api/runs/${encodeURIComponent(runId)}/start`, json({})),
  acquireLease: (sessionId: string) => request<{ token: string; expiresAt: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/steering/lease`, json({}), LeaseSchema),
  steer: (sessionId: string, input: JsonObject) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, json(input)),
  cancel: (sessionId: string, turnId?: string) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ''}`, json({})),
  answerApproval: (sessionId: string, approvalId: string, input: JsonObject) => request<Approval>(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/answer`, json(input)),
  gatewaySummary: () => request<GatewaySummary>('/api/gateway/summary'),
  gatewayRequests: (query = '') => request<{ items?: GatewayRequest[]; total?: number }>(`/api/gateway/requests${query ? `?${query}` : ''}`),
  gatewayAccounts: () => request<JsonObject[]>('/api/gateway/accounts'),
  gatewayConnections: () => request<JsonObject[]>('/api/gateway/connections'),
  gatewaySync: (id: string) => request<JsonObject>(`/api/gateway/connections/${encodeURIComponent(id)}/sync`, json({})),
  coordination: (projectId: string) => request<CoordinationState>(`/api/projects/${encodeURIComponent(projectId)}/state`, {}, z.object({
    project: z.string(), now: z.string(),
    sessions: z.array(z.object({ id: z.string(), agent: z.string(), active: z.boolean() })),
    claims: z.array(z.object({ id: z.string(), status: z.string(), coordinationSessionId: z.string(), updatedAt: z.string(), scope: z.object({ intent: z.string(), task: z.string().optional(), files: z.array(z.string()), components: z.array(z.string()) }) })),
    completed: z.array(z.object({ id: z.string() })),
    conflicts: z.array(z.object({ claimId: z.string(), conflictingClaimId: z.string(), severity: z.string(), resolvedAt: z.string().nullable() })),
  })),
};


export async function loadOverview(enabledModules: readonly string[]) {
  const projects = await api.projects();
  const sessions = (await Promise.all(projects.map((project) => api.sessions(project.id)))).flat();
  const [snapshots, machines, runtimes, gatewaySummary] = await Promise.all([
    Promise.all(sessions.slice(0, 30).map((session) => api.session(session.id))),
    api.machines(),
    Promise.all(projects.map((project) => api.runtimeRegistrations(project.id))).then((groups) => [...new Map(groups.flat().map((runtime) => [runtime.id, runtime])).values()]),
    enabledModules.includes('gateway') ? api.gatewaySummary() : Promise.resolve(null),
  ]);
  return { projects, sessions, snapshots, machines, runtimes, gatewaySummary, snapshotsLimited: sessions.length > snapshots.length };
}
