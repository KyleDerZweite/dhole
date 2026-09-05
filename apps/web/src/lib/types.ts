export type JsonObject = Record<string, unknown>;

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'administrator' | 'member';
  teamId: string;
  status: 'active' | 'pending' | 'disabled';
  github?: { userId: number; login: string };
  createdAt?: string;
}

export interface Project {
  id: string;
  teamId?: string;
  name: string;
  description?: string;
  eventSequence?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Repository {
  id: string;
  projectId: string;
  label: string;
  canonicalRemote?: string;
  localPathHint?: string;
  defaultBranch?: string;
  createdAt?: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  runtimeRegistrationId?: string;
  modelId?: string;
  workspaceId?: string;
  state: string;
  activeTurnId?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RuntimeRegistration {
  id: string;
  machineId: string;
  kind: string;
  label: string;
  available: boolean;
  capabilities?: JsonObject;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  sequence?: number;
  role: 'human' | 'agent' | 'tool' | 'system' | string;
  authorUserId?: string;
  logicalAgentId?: string;
  body: string;
  status?: string;
  createdAt?: string;
  includeHumanIdentity?: boolean;
}

export interface AgentNode {
  id: string;
  activationId?: string;
  parentId?: string;
  name: string;
  state?: string;
  evidence?: 'platform' | 'provider' | 'hook' | 'heuristic' | string;
  control?: 'full' | 'observe_only' | 'uncertain' | string;
  runtimeId?: string;
  machineId?: string;
  startedAt?: string;
  children?: AgentNode[];
}

export interface Approval {
  id: string;
  kind?: string;
  summary: string;
  detail?: JsonObject;
  state: string;
  version?: number;
  expiresAt?: string;
}

export interface SessionSnapshot {
  session: SessionSummary;
  participants?: JsonObject[];
  runs?: JsonObject[];
  turns?: JsonObject[];
  messages: SessionMessage[];
  approvals?: Approval[];
  tree?: AgentNode[];
  progress?: JsonObject[];
  watermark?: number;
  events?: JsonObject[];
}

export interface GatewayTotals {
  requests?: number;
  failures?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostMicrousd?: number;
  averageDurationMs?: number | null;
}

export interface GatewaySummary {
  totals?: GatewayTotals;
  providers?: Array<JsonObject & { provider?: string; requests?: number; failures?: number }>;
  models?: Array<JsonObject & { model?: string; requests?: number; failures?: number }>;
  accounts?: Array<JsonObject & { id?: string; provider?: string; status?: string; quota?: JsonObject; cooldownUntil?: string | null }>;
  capacity?: { accounts?: number; available?: number; coolingDown?: number; failed?: number };
}

export interface Machine extends JsonObject {
  id?: string;
  name?: string;
  status?: string;
  available_slots?: number;
  availableSlots?: number;
  last_heartbeat_at?: string;
  lastHeartbeatAt?: string;
}

export interface GatewayRequest extends JsonObject {
  id?: string;
  provider?: string;
  model?: string;
  occurredAt?: string;
  failed?: boolean;
  failureCategory?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  estimatedCostMicrousd?: number | null;
  correlationConfidence?: string | null;
}

export interface Route {
  kind: 'account' | 'connect' | 'modules' | 'dashboard' | 'projects' | 'coordination' | 'agents' | 'project' | 'session' | 'agent' | 'gateway' | 'admin' | 'login';
  id?: string;
}

export interface AuthMethods {
  mode: string;
  password: boolean;
  bootstrap: boolean;
  bootstrapTokenRequired: boolean;
  github: boolean;
  githubLink: boolean;
}

export interface ModuleCatalog {
  enabledModules: string[];
  modules: Array<{
    id: string;
    dependencies: string[];
    contributions: {
      navigation: Array<{ id: string; label: string; path: string }>;
      webSockets: string[];
      jobs: string[];
    };
  }>;
}

export interface DeviceRequest {
  machineName: string;
  permissions: string[];
  expiresAt: string;
  status: 'pending' | 'approved';
}

export interface DeviceCredential {
  id: string;
  machineName: string;
  machineId: string | null;
  permissions: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AccountGrant { kind: 'invitation' | 'password-reset'; token: string }

export interface CoordinationState {
  project: string;
  now: string;
  sessions: Array<{ id: string; agent: string; active: boolean }>;
  claims: Array<{ id: string; status: string; coordinationSessionId: string; updatedAt: string; scope: { intent: string; task?: string; files: string[]; components: string[] } }>;
  completed: Array<{ id: string }>;
  conflicts: Array<{ claimId: string; conflictingClaimId: string; severity: string; resolvedAt: string | null }>;
}
