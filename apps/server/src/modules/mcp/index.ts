import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { McpProtocolVersion, McpRequestSchema, McpScopeSchema, type McpScope } from '@dhole-control/shared';
import { redactText, hashToken } from '../../lib/security.js';
import type { DatabaseConnection } from '../../lib/database.js';
import type { DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { projectPermission } from '../core/projects.js';
import { CoordinationError, createCoordinationService, type AgentEventInput, type CreateClaimInput, type PatchClaimInput, type CompleteClaimInput } from '../coordination/service.js';
import { coordinationToolSchemas } from './coordination-input.js';

const BODY_LIMIT = 512 * 1024;
const TOOL_OUTPUT_LIMIT = 512 * 1024;
const TOOL_CONTENT_LIMIT = TOOL_OUTPUT_LIMIT / 2 - 4_096;
const MCP_PATH = '/mcp';

type JsonRpcId = string | number;
type JsonRpcRequest = ReturnType<typeof McpRequestSchema.parse>;
type RpcError = { code: number; message: string; data?: unknown };
type AuthContext = {
  tokenId: string;
  userId?: string;
  ownerDisplayName?: string;
  coordinationCapability?: string;
  projectId: string;
  runId?: string;
  permissions: ReadonlySet<McpScope['permissions'][number]>;
};

type ToolDefinition = {
  name: string;
  description: string;
  permission?: McpScope['permissions'][number];
  inputSchema: Record<string, unknown>;
};

const emptySchema = (): Record<string, unknown> => ({ type: 'object', additionalProperties: true });
const projectStateSchema = z.strictObject({
  projectId: z.string().min(1).max(160).optional(),
  runId: z.string().min(1).max(160).optional(),
});

/**
 * Public tool catalogue. Keep this list explicit and lexicographically sorted:
 * clients use it for capability negotiation and reproducible tests.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'coordination_agent_event',
    description: 'Record an idempotent, authenticated agent lifecycle event.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_check',
    description: 'Check active claims and actionable overlap warnings in the authorized project.',
    permission: 'project:read',
    inputSchema: {},
  },
  {
    name: 'coordination_claim',
    description: 'Create an advisory or enforced claim, or patch an active claim scope, status, blocker, or finding. Session proof is supplied by the client transport.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_complete',
    description: 'Complete a claim as done or abandoned with a summary, commits and PR references. Repeated completion retains accumulated evidence.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_repo_report',
    description: 'Report repository branch, revision and dirty files for an authenticated coordination session.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_release',
    description: 'Release an authorized coordination claim.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_revive',
    description: 'Recover an expired or released claim as a new claim while retaining terminal history.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_session_end',
    description: 'End the authenticated transport session while retaining unfinished claims for adoption.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_session_heartbeat',
    description: 'Renew a coordination session and optionally report branch, revision and dirty files.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_session_register',
    description: 'Register a short-lived coordination session. Protocol clients retain its one-time capability and send it in x-mediation-session; local agent bridges handle setup automatically.',
    permission: 'coordination:write',
    inputSchema: {},
  },
  {
    name: 'coordination_state',
    description: 'Read active and terminal coordination claims, findings, commits, PR references, conflicts and agent activity in the authorized scope.',
    permission: 'project:read',
    inputSchema: {},
  },
  {
    name: 'mediation_bug',
    description: 'Compatibility guidance: Dhole does not create external issue records through MCP.',
    permission: 'coordination:write',
    inputSchema: emptySchema(),
  },
  {
    name: 'mediation_claim',
    description: 'Compatibility alias for coordination_claim and coordination_release.',
    permission: 'coordination:write',
    inputSchema: emptySchema(),
  },
  {
    name: 'mediation_init',
    description: 'Compatibility guidance for migrating a Mediation client to Dhole.',
    permission: 'project:read',
    inputSchema: emptySchema(),
  },
  {
    name: 'mediation_setup',
    description: 'Compatibility guidance for Dhole project-scoped API tokens.',
    permission: 'project:read',
    inputSchema: emptySchema(),
  },
  {
    name: 'mediation_state',
    description: 'Compatibility alias returning Dhole project state and coordination claims.',
    permission: 'project:read',
    inputSchema: emptySchema(),
  },
  {
    name: 'project_state',
    description: 'Read a redacted, project-scoped operational snapshot.',
    permission: 'project:read',
    inputSchema: z.toJSONSchema(projectStateSchema),
  },
];

export const MCP_TOOLS: readonly ToolDefinition[] = Object.freeze(TOOL_DEFINITIONS
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  .map((tool) => Object.freeze({ ...tool, ...(coordinationToolSchemas[tool.name] ? { inputSchema: z.toJSONSchema(coordinationToolSchemas[tool.name]!) } : {}) })));

/**
 * The old Mediation clients get only these narrow compatibility calls. They do
 * not expose a second transport, arbitrary RPC, credentials, or a shell.
 */
export const MCP_LEGACY_COMPATIBILITY = Object.freeze({
  initialize: true,
  directToolMethods: true,
  mediationTools: ['mediation_setup', 'mediation_init', 'mediation_claim', 'mediation_bug', 'mediation_state'] as const,
});

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

function moduleEnabled(context: ServerContext, module: string): boolean {
  return context.enabledModules?.has(module) ?? true;
}

function toolEnabled(context: ServerContext, name: string): boolean {
  return moduleEnabled(context, name.startsWith('coordination_') || name.startsWith('mediation_') ? 'coordination' : 'core');
}

function jsonResponse(context: Context, value: unknown, status: ContentfulStatusCode = 200): Response {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ToolOutputLimitError('MCP response cannot be serialized safely');
  }
  if (serialized === undefined) throw new ToolOutputLimitError('MCP response cannot be serialized safely');
  if (Buffer.byteLength(serialized, 'utf8') >= TOOL_OUTPUT_LIMIT) {
    throw new ToolOutputLimitError('MCP response exceeds 512 KiB');
  }
  return context.json(value, status, { 'content-type': 'application/json', 'MCP-Protocol-Version': McpProtocolVersion });
}

function rpcResult(context: Context, id: JsonRpcId, result: unknown): Response {
  return jsonResponse(context, { jsonrpc: '2.0', id, result });
}

function rpcError(context: Context, id: JsonRpcId | null, error: RpcError, status: ContentfulStatusCode = 200): Response {
  return jsonResponse(context, { jsonrpc: '2.0', id, error }, status);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(args: Record<string, unknown>, key: string, maxLength = 2_000): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw new ToolInputError(`Expected ${key} to be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, maxLength = 2_000): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw new ToolInputError(`Expected ${key} to be a string`);
  return value;
}

class ToolInputError extends Error {}
class ToolPermissionError extends Error {}
class ToolNotFoundError extends Error {}
class ToolOutputLimitError extends Error {}

function deriveAllowedOrigins(context: ServerContext): Set<string> {
  const origins = new Set<string>([context.config.publicOrigin.origin]);
  // Local development commonly alternates localhost and loopback. The host allowlist
  // is already operator-controlled, so accepting those exact hosts does not broaden
  // production origins unexpectedly.
  for (const host of context.config.allowedHosts) {
    origins.add(`${context.config.publicOrigin.protocol}//${host}${context.config.publicOrigin.port ? `:${context.config.publicOrigin.port}` : ''}`);
  }
  return origins;
}

function validOrigin(context: ServerContext, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return deriveAllowedOrigins(context).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function acceptsJson(accept: string | undefined): boolean {
  if (!accept) return false;
  return accept.split(',').some((part) => part.trim().toLowerCase().split(';', 1)[0] === 'application/json' || part.trim() === '*/*');
}

async function parseBody(context: Context): Promise<unknown> {
  const contentLength = Number(context.req.header('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT) throw new HttpBoundaryError(413, 'payload_too_large', 'Request body exceeds 512 KiB');
  const stream = context.req.raw.body;
  if (!stream) return parseJsonBytes(new Uint8Array(0));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > BODY_LIMIT) {
        await reader.cancel('payload_too_large').catch(() => undefined);
        throw new HttpBoundaryError(413, 'payload_too_large', 'Request body exceeds 512 KiB');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw new HttpBoundaryError(400, 'invalid_body', 'Request body could not be read');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJsonBytes(bytes);
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpBoundaryError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

class HttpBoundaryError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 405 | 413, readonly code: string, message: string) {
    super(message);
  }
}

function authenticate(context: ServerContext, authorization: string | undefined, now: Date): AuthContext {
  const database = context.database;
  if (!authorization || !/^Bearer\s+[^\s]+$/i.test(authorization)) throw new HttpBoundaryError(401, 'unauthorized', 'A project-scoped Bearer token is required');
  const token = authorization.replace(/^Bearer\s+/i, '');
  const tokenHash = hashToken(token);
  const row = database.prepare(`
    SELECT t.id, t.user_id, u.display_name, t.project_id, t.run_id, t.token_hash, t.scopes_json, t.expires_at, t.revoked_at
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
    JOIN projects p ON p.id = t.project_id
    WHERE t.token_hash = ? AND (t.device_token_id IS NULL OR EXISTS (
      SELECT 1 FROM user_device_tokens d WHERE d.id = t.device_token_id AND d.user_id = u.id
      AND d.team_id = p.team_id AND d.revoked_at IS NULL AND d.expires_at > ?))
  `).get(tokenHash, now.toISOString()) as ApiTokenRow | undefined;
  const expiry = row ? Date.parse(row.expires_at) : Number.NaN;
  if (!row || !tokenMatchesHash(tokenHash, row.token_hash) || row.revoked_at || !Number.isFinite(expiry) || expiry <= now.getTime()) throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token is invalid or expired');
  // Project policy reloads the user's current native membership and role.
  const currentPermission = projectPermission(context, { id: row.user_id }, row.project_id);
  if (!currentPermission) throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token project access is unavailable');
  let scope: McpScope;
  try {
    const stored = JSON.parse(row.scopes_json) as unknown;
    scope = McpScopeSchema.parse(Array.isArray(stored)
      ? { projectId: row.project_id, ...(row.run_id ? { runId: row.run_id } : {}), permissions: stored }
      : stored);
  } catch {
    throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token scope is invalid');
  }
  if (scope.projectId !== row.project_id || (scope.runId ?? null) !== (row.run_id ?? null)) throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token scope is invalid');
  if (scope.runId && !database.prepare('SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?').get(scope.runId, row.project_id)) throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token scope is invalid');
  database.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return {
    tokenId: row.id,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ownerDisplayName: row.display_name,
    projectId: scope.projectId,
    ...(scope.runId ? { runId: scope.runId } : {}),
    permissions: new Set(scope.permissions.filter((permission) => currentPermission !== 'viewer' || permission.endsWith(':read'))),
  };
}

function tokenMatchesHash(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  display_name: string;
  project_id: string;
  run_id: string | null;
  token_hash: string;
  scopes_json: string;
  expires_at: string;
  revoked_at: string | null;
}

function assertPermission(auth: AuthContext, permission: ToolDefinition['permission']): void {
  if (permission && !auth.permissions.has(permission)) throw new ToolPermissionError(`Token scope does not grant ${permission}`);
}

function scopedProject(args: Record<string, unknown>, auth: AuthContext): string {
  const requested = optionalString(args, 'projectId', 160);
  if (requested && requested !== auth.projectId) throw new ToolPermissionError('Project is outside the token scope');
  return auth.projectId;
}

function scopedRun(args: Record<string, unknown>, auth: AuthContext, required = false): string | undefined {
  const requested = optionalString(args, 'runId', 160);
  if (auth.runId && requested && requested !== auth.runId) throw new ToolPermissionError('Run is outside the token scope');
  if (auth.runId && requested === undefined) return auth.runId;
  if (required && !requested && !auth.runId) throw new ToolInputError('runId is required for this token');
  return requested;
}

/** Validate scope-bearing arguments before any tool-specific SQL executes. */
function assertArgumentScope(args: Record<string, unknown>, auth: AuthContext): void {
  scopedProject(args, auth);
  if (args.runId !== undefined) scopedRun(args, auth);
}

function sqlRows<T>(database: DatabaseConnection, sql: string, ...params: unknown[]): T[] {
  try {
    return database.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function sqlRow<T>(database: DatabaseConnection, sql: string, ...params: unknown[]): T | undefined {
  try {
    return database.prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}

function boundedJson(value: unknown, limit = TOOL_OUTPUT_LIMIT): string {
  const chunks: string[] = [];
  let size = 0;
  const append = (chunk: string): void => {
    size += Buffer.byteLength(chunk, 'utf8');
    if (size > limit) throw new ToolOutputLimitError('Tool result exceeds 512 KiB');
    chunks.push(chunk);
  };
  const encode = (current: unknown, stack: Set<object>): void => {
    if (current === null) {
      append('null');
    } else if (typeof current === 'string') {
      append(JSON.stringify(current));
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      append(JSON.stringify(current));
    } else if (typeof current === 'bigint') {
      throw new ToolOutputLimitError('Tool result contains an unsupported value');
    } else if (Array.isArray(current)) {
      if (stack.has(current)) throw new ToolOutputLimitError('Tool result contains a cycle');
      stack.add(current);
      append('[');
      current.forEach((item, index) => {
        if (index > 0) append(',');
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') append('null');
        else encode(item, stack);
      });
      append(']');
      stack.delete(current);
    } else if (typeof current === 'object') {
      if (stack.has(current)) throw new ToolOutputLimitError('Tool result contains a cycle');
      stack.add(current);
      append('{');
      let first = true;
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!first) append(',');
        first = false;
        append(JSON.stringify(key));
        append(':');
        encode(item, stack);
      }
      append('}');
      stack.delete(current);
    } else {
      append('null');
    }
  };
  encode(value, new Set<object>());
  return chunks.join('');
}

function toolText(value: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: unknown } {
  const text = boundedJson(value, TOOL_CONTENT_LIMIT);
  let structuredContent: unknown;
  try {
    structuredContent = JSON.parse(text) as unknown;
  } catch {
    throw new ToolOutputLimitError('Tool result cannot be represented safely');
  }
  return { content: [{ type: 'text', text }], structuredContent };
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError('Tool arguments must be an object');
  return value as Record<string, unknown>;
}

async function callTool(context: ServerContext, auth: AuthContext, name: string, rawArguments: unknown): Promise<unknown> {
  const definition = TOOL_BY_NAME.get(name);
  if (!definition || !toolEnabled(context, name)) throw new ToolNotFoundError('Unknown or disabled tool');
  assertPermission(auth, definition.permission);
  let args = ensureObject(rawArguments);
  if (name === 'coordination_agent_event') scopedProject(args, auth);
  else assertArgumentScope(args, auth);
  const schema = name === 'project_state' ? projectStateSchema : coordinationToolSchemas[name];
  if (schema) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new ToolInputError(`Invalid ${name} arguments`);
    args = parsed.data as Record<string, unknown>;
  }
  switch (name) {
    case 'project_state': return projectState(context, auth, args);
    case 'coordination_check': return coordinationCheck(context, auth, args);
    case 'coordination_session_register': return coordinationSessionRegister(context, auth, args);
    case 'coordination_claim': return coordinationClaim(context, auth, args);
    case 'coordination_release': return coordinationRelease(context, auth, args);
    case 'coordination_complete': return coordinationComplete(context, auth, args);
    case 'coordination_revive': return coordinationRevive(context, auth, args);
    case 'coordination_state': return coordinationService(context).getState(scopedProject(args, auth), scopedRun(args, auth));
    case 'coordination_session_heartbeat': return coordinationSessionHeartbeat(context, auth, args);
    case 'coordination_session_end': return coordinationSessionEnd(context, auth, args);
    case 'coordination_repo_report': return coordinationRepoReport(context, auth, args);
    case 'coordination_agent_event': return coordinationAgentEvent(context, auth, args);
    case 'mediation_setup': return mediationGuidance('setup');
    case 'mediation_init': return mediationGuidance('init');
    case 'mediation_bug': return mediationGuidance('bug');
    case 'mediation_state': return mediationState(context, auth, args);
    case 'mediation_claim': return mediationClaim(context, auth, args);
    default: throw new ToolNotFoundError(`Unknown tool ${name}`);
  }
}

function projectState(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth);
  const project = sqlRow<ProjectRow>(context.database, 'SELECT id, name, description, event_sequence, created_at, updated_at FROM projects WHERE id = ?', projectId);
  if (!project) throw new ToolInputError('Project was not found');
  const runs = runId
    ? sqlRows<RunRow>(context.database, 'SELECT id, session_id, root_objective, state, created_at, started_at, completed_at, updated_at FROM runs WHERE id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?) ORDER BY created_at DESC LIMIT 100', runId, projectId)
    : sqlRows<RunRow>(context.database, 'SELECT id, session_id, root_objective, state, created_at, started_at, completed_at, updated_at FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?) ORDER BY created_at DESC LIMIT 100', projectId);
  const sessions = runId
    ? sqlRows<SessionRow>(context.database, 'SELECT id, title, state, active_turn_id, created_at, updated_at FROM sessions WHERE project_id = ? AND id IN (SELECT session_id FROM runs WHERE id = ?) ORDER BY created_at DESC LIMIT 100', projectId, runId)
    : sqlRows<SessionRow>(context.database, 'SELECT id, title, state, active_turn_id, created_at, updated_at FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', projectId);
  const claims = !moduleEnabled(context, 'coordination') ? [] : runId
    ? sqlRows<ClaimRow>(context.database, 'SELECT id, run_id, intent, status, updated_at FROM coordination_claims WHERE project_id = ? AND run_id = ? ORDER BY updated_at DESC LIMIT 100', projectId, runId)
    : sqlRows<ClaimRow>(context.database, 'SELECT id, run_id, intent, status, updated_at FROM coordination_claims WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100', projectId);
  return {
    project: { id: project.id, name: redactText(project.name, 160), description: redactText(project.description, 4_096), eventSequence: project.event_sequence, createdAt: project.created_at, updatedAt: project.updated_at },
    runs: runs.map((run) => ({ id: run.id, sessionId: run.session_id, rootObjective: redactText(run.root_objective, 2_000), state: run.state, createdAt: run.created_at, startedAt: run.started_at, completedAt: run.completed_at, updatedAt: run.updated_at })),
    sessions: sessions.map((session) => ({ id: session.id, title: redactText(session.title, 240), state: session.state, activeTurnId: session.active_turn_id, createdAt: session.created_at, updatedAt: session.updated_at })),
    claims: claims.map((claim) => ({ id: claim.id, runId: claim.run_id, intent: redactText(claim.intent, 2_000), status: claim.status, updatedAt: claim.updated_at })),
  };
}

interface ProjectRow { id: string; name: string; description: string; event_sequence: number; created_at: string; updated_at: string }
interface RunRow { id: string; session_id: string; root_objective: string; state: string; created_at: string; started_at: string | null; completed_at: string | null; updated_at: string }
interface SessionRow { id: string; title: string; state: string; active_turn_id: string | null; created_at: string; updated_at: string }
interface ClaimRow { id: string; run_id: string | null; intent: string; status: string; updated_at: string }

function coordinationService(context: ServerContext) {
  return createCoordinationService(context.database, context.clock, context.ids, { events: context.events, maxStateItems: 1_000 });
}

function sessionId(args: Record<string, unknown>): string {
  const primary = optionalString(args, 'coordinationSessionId', 160);
  const alias = optionalString(args, 'sessionId', 160);
  if (primary && alias && primary !== alias) throw new ToolInputError('Session selectors must match');
  return primary ?? alias ?? requiredString(args, 'coordinationSessionId', 160);
}

function coordinationProof(auth: AuthContext) {
  return { ...(auth.coordinationCapability ? { capability: auth.coordinationCapability } : {}), ...(auth.userId ? { userId: auth.userId } : {}) };
}

function coordinationCheck(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth);
  const service = coordinationService(context);
  const requestedSession = args.coordinationSessionId !== undefined || args.sessionId !== undefined ? sessionId(args) : undefined;
  const conflicts = service.check(projectId, {
    files: args.files as string[] | undefined ?? [], components: args.components as string[] | undefined ?? [],
    task: args.task as string | null | undefined, intent: args.intent as string | undefined ?? '',
    worktree: args.worktree as string | null | undefined,
    ...(requestedSession ? { sessionId: requestedSession } : {}),
  }, runId, auth.coordinationCapability, auth.userId);
  return { projectId, claims: service.getState(projectId, runId).claims.map((claim) => ({
    id: claim.id, coordinationSessionId: claim.coordinationSessionId, runId: claim.runId ?? null,
    intent: redactText(claim.scope.intent, 512), task: claim.scope.task ? redactText(claim.scope.task, 256) : null,
    status: claim.status, summary: 'summary' in claim && typeof claim.summary === 'string' ? redactText(claim.summary, 512) : null, updatedAt: claim.updatedAt,
  })), conflicts };
}

function coordinationSessionRegister(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const session = coordinationService(context).startSession(scopedProject(args, auth), {
    agentLabel: requiredString(args, 'agentLabel', 120),
    ...(auth.userId ? { userId: auth.userId } : {}),
    ...(auth.ownerDisplayName ? { developerLabel: auth.ownerDisplayName } : {}),
    worktree: (args.worktree ?? args.worktreeHash ?? null) as string | null,
  });
  return { ...session, agentLabel: session.agent };
}

function coordinationClaim(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const service = coordinationService(context);
  const claimId = optionalString(args, 'claimId', 160);
  const input = { ...args, ...(args.worktreeHash !== undefined ? { worktree: args.worktreeHash } : {}), ...coordinationProof(auth) };
  if (args.finding === undefined && (args.findingFiles !== undefined || args.findingKind !== undefined)) throw new ToolInputError('Finding metadata requires finding text');
  if (claimId) {
    if (args.mode !== undefined || args.enforce !== undefined || args.workItemId !== undefined) throw new ToolInputError('Claim reservation mode and work item can be set only when creating a claim');
    return service.updateClaim(projectId, claimId, input as PatchClaimInput, auth.runId);
  }
  if (args.finding !== undefined) throw new ToolInputError('Append findings by patching an existing claim');
  const result = service.createClaim(projectId, {
    ...input, sessionId: sessionId(args), intent: requiredString(args, 'intent'),
    ...(scopedRun(args, auth) ? { runId: scopedRun(args, auth) } : {}),
  } as CreateClaimInput, auth.runId);
  // Keep the original MCP claim selector while exposing the full HTTP claim shape.
  return { ...result.claim, files: result.claim.scope.files, components: result.claim.scope.components, conflicts: result.conflicts };
}

function coordinationComplete(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return coordinationService(context).completeClaim(scopedProject(args, auth), requiredString(args, 'claimId', 160), {
    ...args, ...coordinationProof(auth),
  } as CompleteClaimInput, auth.runId);
}

function coordinationRelease(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return coordinationService(context).releaseClaim(scopedProject(args, auth), requiredString(args, 'claimId', 160), auth.coordinationCapability, auth.runId, auth.userId);
}

function coordinationRevive(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return coordinationService(context).reviveClaim(scopedProject(args, auth), requiredString(args, 'claimId', 160), {
    ...args, ...(args.worktreeHash !== undefined ? { worktree: args.worktreeHash } : {}), ...coordinationProof(auth),
  } as PatchClaimInput, auth.runId);
}

function coordinationSessionHeartbeat(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const { capability: _capability, ...session } = coordinationService(context).heartbeat(scopedProject(args, auth), sessionId(args), {
    ...args, ...coordinationProof(auth),
  }, auth.runId);
  return session;
}

function coordinationSessionEnd(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const result = coordinationService(context).endSession(scopedProject(args, auth), sessionId(args), auth.coordinationCapability, undefined, auth.runId, auth.userId);
  const { capability: _capability, ...session } = result.session;
  return { ...result, session };
}

function coordinationRepoReport(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return coordinationService(context).reportRepo(scopedProject(args, auth), sessionId(args), { ...args, ...coordinationProof(auth) }, auth.runId);
}

function coordinationAgentEvent(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const input = { ...args, ...coordinationProof(auth),
    ...(args.coordinationSessionId !== undefined || args.sessionId !== undefined ? { sessionId: sessionId(args) } : {}),
  } as unknown as AgentEventInput;
  return coordinationService(context).recordAgentEvent(scopedProject(args, auth), input, auth.runId);
}

function mediationGuidance(kind: 'setup' | 'init' | 'bug'): unknown {
  const guidance: Record<typeof kind, string> = {
    setup: 'Connect the local Dhole agent bridge through device authorization. It resolves the repository, retains credentials outside model context, and maintains the coordination session. Native protocol clients can use a project-scoped API token.',
    init: 'Dhole coordination is initialized by the server migration. The local agent bridge registers and renews sessions automatically. Native protocol clients use coordination_session_register and retain its one-time capability in the x-mediation-session header.',
    bug: 'Dhole does not create external issue records from MCP. Record a bug in the project issue tracker and use coordination_claim for an actionable work item.',
  };
  return { compatibility: true, supported: false, guidance: guidance[kind] };
}

function mediationState(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return { compatibility: true, ...(projectState(context, auth, args) as Record<string, unknown>), coordination: coordinationService(context).getState(scopedProject(args, auth), scopedRun(args, auth)) };
}

function mediationClaim(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): Promise<unknown> {
  const name = args.claimId && args.status === 'released' ? 'coordination_release'
    : args.claimId && (args.status === 'done' || args.status === 'abandoned') ? 'coordination_complete' : 'coordination_claim';
  const { status, ...rest } = args;
  return callTool(context, auth, name, name === 'coordination_release' ? rest : { ...rest, ...(status !== undefined ? { status } : {}) });
}

async function handleMcp(context: ServerContext, requestContext: Context): Promise<Response> {
  const method = requestContext.req.method.toUpperCase();
  if (method !== 'POST') throw new HttpBoundaryError(405, 'method_not_allowed', 'MCP uses POST for stateless JSON-RPC');
  if (!validOrigin(context, requestContext.req.header('origin'))) throw new HttpBoundaryError(403, 'invalid_origin', 'Origin is not allowed');
  if (!acceptsJson(requestContext.req.header('accept'))) throw new HttpBoundaryError(400, 'invalid_accept', 'Accept must include application/json');
  const contentTypeRaw = requestContext.req.header('content-type');
  const contentType = contentTypeRaw ? (contentTypeRaw.split(';', 1)[0] ?? '').trim().toLowerCase() : '';
  if (contentType !== 'application/json') throw new HttpBoundaryError(400, 'invalid_content_type', 'Content-Type must be application/json');
  const body = await parseBody(requestContext);
  const parsed = McpRequestSchema.safeParse(body);
  if (!parsed.success) return rpcError(requestContext, null, { code: -32600, message: 'Invalid Request' }, 400);
  const request = parsed.data as JsonRpcRequest;
  const protocolHeader = requestContext.req.header('MCP-Protocol-Version');
  if (protocolHeader && protocolHeader !== McpProtocolVersion) return rpcError(requestContext, request.id, { code: -32001, message: `Unsupported MCP protocol version: ${protocolHeader}` }, 400);
  if (!protocolHeader && request.method !== 'initialize') return rpcError(requestContext, request.id, { code: -32001, message: 'MCP-Protocol-Version header is required' }, 400);
  let auth: AuthContext;
  try {
    auth = authenticate(context, requestContext.req.header('authorization'), context.clock.now());
  } catch (error) {
    if (error instanceof HttpBoundaryError) {
      const response = rpcError(requestContext, request.id, { code: -32002, message: error.message }, error.status);
      if (error.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
      return response;
    }
    throw error;
  }
  try {
    const capability = requestContext.req.header('x-mediation-session') ?? requestContext.req.header('x-session-capability') ?? requestContext.req.header('x-mediation-session-capability');
    if (capability !== undefined) {
      const parsedCapability = z.string().min(8).max(256).safeParse(capability);
      if (!parsedCapability.success) throw new ToolInputError('Invalid coordination session header');
      auth.coordinationCapability = parsedCapability.data;
    }
    if (request.method === 'initialize') {
      const requested = optionalString(asRecord(request.params), 'protocolVersion', 80) ?? request._meta?.protocolVersion;
      if (requested && requested !== McpProtocolVersion) return rpcError(requestContext, request.id, { code: -32001, message: `Unsupported MCP protocol version: ${requested}` }, 400);
      return rpcResult(requestContext, request.id, { protocolVersion: McpProtocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dhole', version: '0.1.0' } });
    }
    if (request.method === 'tools/list') return rpcResult(requestContext, request.id, { tools: MCP_TOOLS.filter((tool) => toolEnabled(context, tool.name) && (!tool.permission || auth.permissions.has(tool.permission))) });
    if (request.method === 'tools/call') {
      const params = asRecord(request.params);
      const name = requiredString(params, 'name', 120);
      const result = await callTool(context, auth, name, params.arguments);
      return rpcResult(requestContext, request.id, toolText(result));
    }
    // A small direct-method compatibility path keeps older Mediation clients useful
    // while modern clients use tools/call. It is intentionally limited to catalogue
    // names and cannot become a generic RPC or shell endpoint.
    if (MCP_LEGACY_COMPATIBILITY.mediationTools.includes(request.method as (typeof MCP_LEGACY_COMPATIBILITY.mediationTools)[number])) {
      return rpcResult(requestContext, request.id, toolText(await callTool(context, auth, request.method, request.params)));
    }
    return rpcError(requestContext, request.id, { code: -32601, message: 'Method not found' });
  } catch (error) {
    if (error instanceof CoordinationError) return rpcError(requestContext, request.id, {
      code: error.statusCode === 401 || error.statusCode === 403 ? -32003 : error.statusCode === 409 ? -32009 : -32602,
      message: error.message, data: { code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) },
    });
    if (error instanceof ToolPermissionError) return rpcError(requestContext, request.id, { code: -32003, message: 'Tool denied by token scope or current project access' });
    if (error instanceof ToolInputError) return rpcError(requestContext, request.id, { code: -32602, message: error.message });
    if (error instanceof ToolNotFoundError) return rpcError(requestContext, request.id, { code: -32601, message: error.message });
    if (error instanceof ToolOutputLimitError) return rpcError(requestContext, request.id, { code: -32004, message: 'Tool result exceeds 512 KiB' });
    return rpcError(requestContext, request.id, { code: -32000, message: 'Tool execution failed' });
  }
}

export const mcpModule: DholeModule = {
  id: 'mcp',
  register(app: DholeApp, context: ServerContext): void {
    app.all(MCP_PATH, async (requestContext) => {
      try {
        return await handleMcp(context, requestContext);
      } catch (error) {
        if (error instanceof HttpBoundaryError) {
          const response = jsonResponse(requestContext, { error: error.code, message: error.message }, error.status);
          if (error.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
          return response;
        }
        return jsonResponse(requestContext, { error: 'internal_error', message: 'Request could not be handled' }, 500);
      }
    });
  },
};

export { handleMcp };
