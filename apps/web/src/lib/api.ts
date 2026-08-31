import type {
  Approval,
  GatewayRequest,
  GatewaySummary,
  JsonObject,
  LabRun,
  Machine,
  MemoryPack,
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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    const csrf = csrfToken();
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  let payload: unknown = undefined;
  try { payload = await response.json(); } catch { /* an empty response is valid for some mutations */ }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? payload as JsonObject : {};
    const detail = error.error && typeof error.error === 'object' ? error.error as JsonObject : {};
    throw new ApiError(response.status, typeof detail.code === 'string' ? detail.code : 'request_failed', typeof detail.message === 'string' ? detail.message : `Request failed (${response.status})`);
  }
  return payload as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  me: () => request<{ user: User; csrfToken?: string }>('/api/auth/me'),
  login: async (email: string, password: string) => {
    const value = await request<{ user: User; csrfToken?: string }>('/api/auth/login', json({ email, password }));
    if (value.csrfToken) sessionStorage.setItem('dhole_csrf', value.csrfToken);
    return value;
  },
  bootstrap: async (input: JsonObject) => {
    const value = await request<{ user: User; csrfToken?: string }>('/api/auth/bootstrap', json(input));
    if (value.csrfToken) sessionStorage.setItem('dhole_csrf', value.csrfToken);
    return value;
  },
  logout: async () => { await request('/api/auth/logout', json({})); sessionStorage.removeItem('dhole_csrf'); },
  projects: async () => (await request<{ projects: Project[] }>('/api/projects')).projects,
  project: (id: string) => request<{ project: Project; repositories: Repository[] }>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (input: JsonObject) => request<{ project: Project }>('/api/projects', json(input)),
  repositories: (projectId: string) => request<{ repositories: Repository[] }>(`/api/projects/${encodeURIComponent(projectId)}/repositories`),
  createRepository: (projectId: string, input: JsonObject) => request<{ repository: Repository }>(`/api/projects/${encodeURIComponent(projectId)}/repositories`, json(input)),
  users: async () => (await request<{ users: User[] }>('/api/admin/users')).users,
  createUser: (input: JsonObject) => request<{ user: User }>('/api/admin/users', json(input)),
  machines: () => request<Machine[]>('/api/fleet/machines'),
  sessions: async (projectId: string) => (await request<{ sessions: SessionSummary[] }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`)).sessions,
  runtimeRegistrations: async (projectId: string) => (await request<{ registrations: RuntimeRegistration[] }>(`/api/projects/${encodeURIComponent(projectId)}/runtime-registrations`)).registrations,
  createSession: (projectId: string, input: JsonObject) => request<{ session: SessionSummary }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, json(input)),
  session: (sessionId: string, after?: number) => request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot${after ? `?after=${after}` : ''}`),
  queueMessage: (sessionId: string, input: JsonObject) => request<SessionMessage>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, json(input)),
  createRun: (sessionId: string, input: JsonObject) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, json(input)),
  startRun: (runId: string) => request<JsonObject>(`/api/runs/${encodeURIComponent(runId)}/start`, json({})),
  acquireLease: (sessionId: string) => request<{ leaseToken: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/steering/lease`, json({})),
  steer: (sessionId: string, input: JsonObject) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, json(input)),
  cancel: (sessionId: string, turnId?: string) => request<JsonObject>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ''}`, json({})),
  answerApproval: (sessionId: string, approvalId: string, input: JsonObject) => request<Approval>(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/answer`, json(input)),
  gatewaySummary: () => request<GatewaySummary>('/api/gateway/summary'),
  gatewayRequests: (query = '') => request<{ items?: GatewayRequest[]; total?: number }>(`/api/gateway/requests${query ? `?${query}` : ''}`),
  gatewayAccounts: () => request<JsonObject[]>('/api/gateway/accounts'),
  gatewayConnections: () => request<JsonObject[]>('/api/gateway/connections'),
  gatewaySync: (id: string) => request<JsonObject>(`/api/gateway/connections/${encodeURIComponent(id)}/sync`, json({})),
  labBenchmarks: (projectId?: string) => request<JsonObject[]>(`/api/lab/benchmarks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  labRuns: (benchmarkId?: string) => request<LabRun[]>(`/api/lab/runs${benchmarkId ? `?benchmarkId=${encodeURIComponent(benchmarkId)}` : ''}`),
  labComparison: (runId: string) => request<JsonObject>(`/api/lab/runs/${encodeURIComponent(runId)}/comparison`),
  labDecision: (input: JsonObject) => request<JsonObject>('/api/lab/promotions', json(input)),
  memoryPacks: async (projectId: string) => request<MemoryPack[]>(`/api/projects/${encodeURIComponent(projectId)}/memory/packs`),
  memoryPack: (packId: string) => request<MemoryPack>(`/api/memory/packs/${encodeURIComponent(packId)}`),
  memoryGenerations: (packId: string) => request<JsonObject[]>(`/api/memory/packs/${encodeURIComponent(packId)}/generations`),
  memoryProposals: (packId: string) => request<JsonObject[]>(`/api/memory/packs/${encodeURIComponent(packId)}/proposals`),
  memoryProposal: (packId: string, input: JsonObject) => request<JsonObject>(`/api/memory/packs/${encodeURIComponent(packId)}/proposals`, json(input)),
  memoryProposalDecision: (id: string, input: JsonObject) => request<JsonObject>(`/api/memory/proposals/${encodeURIComponent(id)}/decision`, json(input)),
  memoryFold: (packId: string, input: JsonObject) => request<JsonObject>(`/api/memory/packs/${encodeURIComponent(packId)}/fold`, json(input)),
  memoryClear: (packId: string, baseGenerationId?: string) => request<JsonObject>(`/api/memory/packs/${encodeURIComponent(packId)}/clear`, json(baseGenerationId ? { baseGenerationId } : {})),
};

export async function optional<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try { return await work(); } catch { return fallback; }
}
