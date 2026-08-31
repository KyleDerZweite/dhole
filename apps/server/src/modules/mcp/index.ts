import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { McpProtocolVersion, McpRequestSchema, McpScopeSchema, type McpScope } from '@dhole-control/shared';
import { redactSecrets, redactText, hashToken } from '../../lib/security.js';
import type { DatabaseConnection } from '../../lib/database.js';
import type { DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { checkOverlap, normalizePath, type OverlapClaim, type WorkScope } from '../coordination/overlap.js';
import { createBenchmarkInvocationService } from '../lab/index.js';
import { MemoryProposalInputSchema } from '../memory/types.js';
import { OrchestrationProfileConfigSchema } from '../orchestration/types.js';

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
const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const stringSchema = (description?: string): Record<string, unknown> => ({ type: 'string', ...(description ? { description } : {}) });

/**
 * Public tool catalogue. Keep this list explicit and lexicographically sorted:
 * clients use it for capability negotiation and reproducible tests.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'benchmark_invoke',
    description: 'Run a bounded fixture-backed benchmark comparison for a project benchmark.',
    permission: 'benchmarks:run',
    inputSchema: objectSchema({ benchmarkId: stringSchema(), baselineConfig: { type: 'object' }, candidateConfig: { type: 'object' }, seed: stringSchema() }, ['benchmarkId']),
  },
  {
    name: 'child_cancel',
    description: 'Cancel an authorized child activation.',
    permission: 'children:write',
    inputSchema: objectSchema({ childId: stringSchema(), activationId: stringSchema() }),
  },
  {
    name: 'child_collect',
    description: 'Collect bounded status and durable messages for an authorized child.',
    permission: 'children:write',
    inputSchema: objectSchema({ childId: stringSchema(), activationId: stringSchema(), limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  },
  {
    name: 'child_create',
    description: 'Create a controlled child agent and optional platform lineage edge.',
    permission: 'children:write',
    inputSchema: objectSchema({ runId: stringSchema(), name: stringSchema(), role: stringSchema(), objective: stringSchema(), parentAgentId: stringSchema(), runtimeId: stringSchema() }, ['runId', 'name']),
  },
  {
    name: 'child_message',
    description: 'Queue a bounded message for an authorized child session.',
    permission: 'children:write',
    inputSchema: objectSchema({ childId: stringSchema(), activationId: stringSchema(), message: { type: 'string', minLength: 1, maxLength: 200000 } }, ['message']),
  },
  {
    name: 'child_status',
    description: 'Read the current state and activation history of an authorized child.',
    permission: 'children:write',
    inputSchema: objectSchema({ childId: stringSchema(), activationId: stringSchema() }),
  },
  {
    name: 'child_wait',
    description: 'Read a child state snapshot; stateless HTTP never holds a server-side wait.',
    permission: 'children:write',
    inputSchema: objectSchema({ childId: stringSchema(), activationId: stringSchema(), timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }),
  },
  {
    name: 'coordination_check',
    description: 'Check active claims and actionable overlap warnings in the authorized project.',
    permission: 'project:read',
    inputSchema: objectSchema({ files: { type: 'array', items: stringSchema() }, components: { type: 'array', items: stringSchema() }, task: stringSchema(), intent: stringSchema(), coordinationSessionId: stringSchema() }),
  },
  {
    name: 'coordination_claim',
    description: 'Create or update a scoped coordination claim.',
    permission: 'coordination:write',
    inputSchema: objectSchema({ claimId: stringSchema(), coordinationSessionId: stringSchema(), sessionId: stringSchema(), intent: stringSchema(), task: stringSchema(), files: { type: 'array', items: stringSchema() }, components: { type: 'array', items: stringSchema() }, status: stringSchema(), runId: stringSchema(), summary: stringSchema() }, ['intent']),
  },
  {
    name: 'coordination_release',
    description: 'Release an authorized coordination claim.',
    permission: 'coordination:write',
    inputSchema: objectSchema({ claimId: stringSchema() }, ['claimId']),
  },
  {
    name: 'coordination_session_register',
    description: 'Register a short-lived coordination session for this project.',
    permission: 'coordination:write',
    inputSchema: objectSchema({ agentLabel: stringSchema(), developerLabel: stringSchema(), worktreeHash: stringSchema(), capabilityHash: stringSchema(), expiresInMs: { type: 'integer', minimum: 1000, maximum: 86400000 } }, ['agentLabel']),
  },
  {
    name: 'memory_propose',
    description: 'Propose an immutable memory entry for later human review.',
    permission: 'memory:propose',
    inputSchema: objectSchema({ packId: stringSchema(), title: stringSchema(), body: stringSchema(), sourceType: stringSchema(), sourceReference: stringSchema(), baseGenerationId: stringSchema(), evidence: { type: 'object' } }, ['packId', 'title', 'body', 'sourceType', 'sourceReference']),
  },
  {
    name: 'memory_read',
    description: 'Read the active generation of a project memory pack.',
    permission: 'memory:read',
    inputSchema: objectSchema({ packId: stringSchema(), stableKey: stringSchema(), query: stringSchema(), limit: { type: 'integer', minimum: 1, maximum: 100 } }),
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
    inputSchema: objectSchema({ projectId: stringSchema() }),
  },
  {
    name: 'skill_propose',
    description: 'Propose a new draft version of a project skill.',
    permission: 'skills:propose',
    inputSchema: objectSchema({ skillId: stringSchema(), stableKey: stringSchema(), name: stringSchema(), skillMarkdown: stringSchema(), manifest: { type: 'object' } }, ['skillMarkdown']),
  },
  {
    name: 'skill_read',
    description: 'Read a bounded active skill version for this project.',
    permission: 'skills:read',
    inputSchema: objectSchema({ skillId: stringSchema(), stableKey: stringSchema() }),
  },
];

export const MCP_TOOLS: readonly ToolDefinition[] = Object.freeze(TOOL_DEFINITIONS
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  .map((tool) => Object.freeze(tool)));

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

function boundedInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ToolInputError(`Expected ${key} to be an integer between ${min} and ${max}`);
  return value;
}

function boundedStrings(args: Record<string, unknown>, key: string, maxItems: number, maxLength = 1_024): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > maxLength)) throw new ToolInputError(`Expected ${key} to be a bounded string array`);
  return value as string[];
}

function canonicalWorktreeHash(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^wt_[A-Za-z0-9_-]{43}$/u.test(trimmed)
    ? trimmed
    : `wt_${createHash('sha256').update(trimmed, 'utf8').digest('base64url')}`;
}

/** Normalize a repository-relative MCP path, rejecting traversal rather than
 * silently collapsing `..` components into a different file. */
function normalizeMcpPath(value: string): string {
  const slash = value.replaceAll('\\', '/');
  if (slash.startsWith('/') || /^[A-Za-z]:/u.test(slash) || slash.split('/').some((part) => part === '..')) {
    throw new ToolInputError('Paths must be relative to the repository and must not contain parent traversal');
  }
  const normalized = normalizePath(value);
  if (!normalized) throw new ToolInputError('Paths must not be empty');
  return normalized;
}

// MCP writes proposals directly so the row, lifecycle event, and audit record
// share one transaction; these checks mirror MemoryService.propose exactly.
const MEMORY_URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/iu;

function containsMemoryCredential(value: string): boolean {
  return redactSecrets(value, value.length) !== value || MEMORY_URL_CREDENTIALS.test(value);
}

class ToolInputError extends Error {}
class ToolPermissionError extends Error {}
class ToolNotFoundError extends Error {}
class ToolOutputLimitError extends Error {}

const CLAIM_TERMINAL_STATUSES = new Set(['done', 'abandoned', 'expired', 'released']);
const CLAIM_ALLOWED_STATUSES = new Set(['investigating', 'in-progress', 'testing', 'blocked', ...CLAIM_TERMINAL_STATUSES]);
const MAX_LOGICAL_AGENTS_PER_RUN = 100;
const MAX_CONCURRENT_AGENTS_PER_RUN = 128;
const MAX_DIRECT_CHILDREN_PER_PARENT = 8;
const MAX_AGENT_DEPTH = 4;
const MAX_CLAIMS_PER_PROJECT = 1_000;
const MAX_CLAIMS_PER_RUN = 100;

interface DirectChildCaps {
  maxAgents: number;
  maxConcurrentAgents: number;
  maxChildrenPerParent: number;
  maxDepth: number;
}

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

function authenticate(database: DatabaseConnection, authorization: string | undefined, now: Date): AuthContext {
  if (!authorization || !/^Bearer\s+[^\s]+$/i.test(authorization)) throw new HttpBoundaryError(401, 'unauthorized', 'A project-scoped Bearer token is required');
  const token = authorization.replace(/^Bearer\s+/i, '');
  const tokenHash = hashToken(token);
  const row = database.prepare(`
    SELECT t.id, t.user_id, t.project_id, t.run_id, t.token_hash, t.scopes_json, t.expires_at, t.revoked_at
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id AND u.disabled_at IS NULL
    JOIN projects p ON p.id = t.project_id
    JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = u.id
    WHERE t.token_hash = ?
  `).get(tokenHash) as ApiTokenRow | undefined;
  const expiry = row ? Date.parse(row.expires_at) : Number.NaN;
  if (!row || !tokenMatchesHash(tokenHash, row.token_hash) || row.revoked_at || !Number.isFinite(expiry) || expiry <= now.getTime()) throw new HttpBoundaryError(401, 'unauthorized', 'Bearer token is invalid or expired');
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
    projectId: scope.projectId,
    ...(scope.runId ? { runId: scope.runId } : {}),
    permissions: new Set(scope.permissions),
  };
}

function tokenMatchesHash(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface ApiTokenRow {
  id: string;
  user_id: string | null;
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

function eventActor(auth: AuthContext): { type: 'user'; userId: string } | { type: 'system' } {
  return auth.userId ? { type: 'user', userId: auth.userId } : { type: 'system' };
}

function appendEvent(context: ServerContext, auth: AuthContext, projectId: string, eventKind: Parameters<ServerContext['events']['append']>[0]['eventKind'], aggregateType: string, aggregateId: string, payload: Record<string, unknown>): void {
  context.events.append({ projectId, eventKind, aggregateType, aggregateId, actor: eventActor(auth), source: { kind: 'platform', adapter: 'mcp' }, payload });
}

function eventTransaction<T>(context: ServerContext, operation: () => T): T {
  return context.events.transaction(operation);
}

function directChildCaps(context: ServerContext, runId: string): DirectChildCaps {
  const row = sqlRow<{ execution_id: string; config_json: string | null }>(context.database, `
    SELECT e.id AS execution_id, v.config_json
    FROM orchestration_executions e
    LEFT JOIN orchestration_profile_versions v ON v.id = e.profile_version_id
    WHERE e.run_id = ? ORDER BY e.updated_at DESC LIMIT 1
  `, runId);
  if (!row) return { maxAgents: MAX_LOGICAL_AGENTS_PER_RUN, maxConcurrentAgents: MAX_CONCURRENT_AGENTS_PER_RUN, maxChildrenPerParent: MAX_DIRECT_CHILDREN_PER_PARENT, maxDepth: MAX_AGENT_DEPTH };
  if (!row.config_json) throw new ToolInputError('The run orchestration profile is unavailable');
  let config: unknown;
  try {
    config = JSON.parse(row.config_json) as unknown;
  } catch {
    throw new ToolInputError('The run orchestration profile is invalid');
  }
  const parsed = OrchestrationProfileConfigSchema.safeParse(config);
  if (!parsed.success) throw new ToolInputError('The run orchestration profile is invalid');
  return {
    maxAgents: Math.min(MAX_LOGICAL_AGENTS_PER_RUN, parsed.data.limits.maxWorkItems),
    maxConcurrentAgents: Math.min(MAX_CONCURRENT_AGENTS_PER_RUN, parsed.data.limits.maxConcurrency),
    maxChildrenPerParent: Math.min(MAX_DIRECT_CHILDREN_PER_PARENT, parsed.data.limits.maxChildrenPerParent),
    maxDepth: Math.min(MAX_AGENT_DEPTH, parsed.data.limits.maxDepth),
  };
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
  if (!definition) throw new ToolNotFoundError(`Unknown tool ${name}`);
  assertPermission(auth, definition.permission);
  const args = ensureObject(rawArguments);
  assertArgumentScope(args, auth);
  switch (name) {
    case 'project_state': return projectState(context, auth, args);
    case 'coordination_check': return coordinationCheck(context, auth, args);
    case 'coordination_session_register': return coordinationSessionRegister(context, auth, args);
    case 'coordination_claim': return coordinationClaim(context, auth, args);
    case 'coordination_release': return coordinationRelease(context, auth, args);
    case 'child_create': return childCreate(context, auth, args);
    case 'child_status': return childStatus(context, auth, args);
    case 'child_message': return childMessage(context, auth, args);
    case 'child_cancel': return childCancel(context, auth, args);
    case 'child_wait': return childWait(context, auth, args);
    case 'child_collect': return childCollect(context, auth, args);
    case 'memory_read': return memoryRead(context, auth, args);
    case 'memory_propose': return memoryPropose(context, auth, args);
    case 'skill_read': return skillRead(context, auth, args);
    case 'skill_propose': return skillPropose(context, auth, args);
    case 'benchmark_invoke': return benchmarkInvoke(context, auth, args);
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
  const claims = runId
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

function coordinationCheck(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth);
  const files = boundedStrings(args, 'files', 500).map(normalizeMcpPath);
  const components = boundedStrings(args, 'components', 100, 120).map((component) => component.trim().toLocaleLowerCase()).filter(Boolean);
  const task = optionalString(args, 'task', 500);
  const intent = optionalString(args, 'intent', 2_000) ?? '';
  const requestedSessionId = optionalString(args, 'coordinationSessionId', 160);
  // A caller may suppress its own claim only by proving ownership of the
  // coordination session. Arbitrary ids would hide another agent's overlap.
  const ownSession = requestedSessionId
    ? sqlRow<{ id: string; worktree_hash: string | null }>(context.database, 'SELECT id, worktree_hash FROM coordination_sessions WHERE id = ? AND project_id = ? AND user_id = ? AND ended_at IS NULL AND expires_at > ?', requestedSessionId, projectId, auth.userId ?? '', context.clock.now().toISOString())
    : undefined;
  if (requestedSessionId && !ownSession) throw new ToolPermissionError('Coordination session is outside the token scope');
  const claims = runId
    ? sqlRows<FullClaimRow>(context.database, 'SELECT id, coordination_session_id, run_id, intent, task, worktree_hash, status, summary, updated_at FROM coordination_claims WHERE project_id = ? AND run_id = ? AND status IN (\'investigating\', \'in-progress\', \'testing\', \'blocked\') ORDER BY updated_at, id LIMIT 1000', projectId, runId)
    : sqlRows<FullClaimRow>(context.database, 'SELECT id, coordination_session_id, run_id, intent, task, worktree_hash, status, summary, updated_at FROM coordination_claims WHERE project_id = ? AND status IN (\'investigating\', \'in-progress\', \'testing\', \'blocked\') ORDER BY updated_at, id LIMIT 1000', projectId);
  const overlapClaims: OverlapClaim[] = claims.map((claim) => {
    const claimFiles = sqlRows<{ normalized_path: string }>(context.database, 'SELECT normalized_path FROM coordination_claim_files WHERE claim_id = ? ORDER BY normalized_path LIMIT 500', claim.id).map((row) => normalizePath(row.normalized_path)).filter(Boolean);
    const claimComponents = sqlRows<{ normalized_component: string }>(context.database, 'SELECT normalized_component FROM coordination_claim_components WHERE claim_id = ? ORDER BY normalized_component LIMIT 100', claim.id).map((row) => row.normalized_component.trim().toLocaleLowerCase()).filter(Boolean);
    // Dirty files are part of the effective scope; an omitted claim file should
    // not make an in-progress edit invisible to overlap checks.
    const report = sqlRow<{ dirty_files_json: string }>(context.database, 'SELECT dirty_files_json FROM coordination_repo_reports WHERE session_id = ?', claim.coordination_session_id);
    let dirtyFiles: string[] = [];
    if (report?.dirty_files_json) {
      try {
        const parsed = JSON.parse(report.dirty_files_json) as unknown;
        if (Array.isArray(parsed)) dirtyFiles = parsed.filter((value): value is string => typeof value === 'string').map(normalizePath).filter(Boolean).slice(0, 500);
      } catch { /* malformed legacy reports do not expand scope */ }
    }
    return {
      id: claim.id,
      coordinationSessionId: claim.coordination_session_id,
      status: claim.status,
      scope: {
        files: [...new Set([...claimFiles, ...dirtyFiles])],
        components: claimComponents,
        intent: claim.intent,
        ...(claim.task == null ? {} : { task: claim.task }),
      ...(claim.worktree_hash == null ? {} : { worktree: canonicalWorktreeHash(claim.worktree_hash) }),
      },
      updatedAt: claim.updated_at,
    } satisfies OverlapClaim;
  });
  const proposed: WorkScope = {
    files,
    components,
    task,
    intent,
    ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    ...(ownSession?.worktree_hash ? { worktree: canonicalWorktreeHash(ownSession.worktree_hash) } : {}),
  };
  const conflicts = checkOverlap(overlapClaims, proposed).map((conflict) => ({
    claimId: conflict.claimId,
    severity: conflict.reasons.some((reason) => reason.type === 'files' || reason.type === 'components') ? 'blocking' as const : 'warning' as const,
    reasons: conflict.reasons,
  }));
  return { projectId, claims: claims.map((claim) => ({ id: claim.id, coordinationSessionId: claim.coordination_session_id, runId: claim.run_id, intent: redactText(claim.intent, 512), task: claim.task ? redactText(claim.task, 256) : null, status: claim.status, summary: claim.summary ? redactText(claim.summary, 512) : null, updatedAt: claim.updated_at })), conflicts };
}

interface FullClaimRow { id: string; coordination_session_id: string; run_id: string | null; intent: string; task: string | null; worktree_hash: string | null; status: string; summary: string | null; updated_at: string }

function coordinationSessionRegister(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const now = context.clock.now();
  const id = context.ids.id();
  const agentLabel = redactText(requiredString(args, 'agentLabel', 160), 160);
  const expiresInMs = boundedInt(args, 'expiresInMs', 60 * 60 * 1000, 1_000, 86_400_000);
  const developerLabelValue = optionalString(args, 'developerLabel', 160);
  const developerLabel = developerLabelValue ? redactText(developerLabelValue, 160) : undefined;
  const worktreeHash = canonicalWorktreeHash(optionalString(args, 'worktreeHash', 256));
  const capabilityHash = optionalString(args, 'capabilityHash', 256) ?? createHash('sha256').update('mcp').digest('hex');
  const expiresAt = new Date(now.getTime() + expiresInMs).toISOString();
  return eventTransaction(context, () => {
    context.database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, developer_label, worktree_hash, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, auth.userId ?? null, agentLabel, developerLabel ?? null, worktreeHash ?? null, capabilityHash, now.toISOString(), now.toISOString(), expiresAt);
    appendEvent(context, auth, projectId, 'session.created', 'coordination_session', id, { agent: redactText(agentLabel) });
    return { id, projectId, agentLabel, expiresAt };
  });
}

function coordinationClaim(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth);
  const claimId = optionalString(args, 'claimId', 160);
  const now = context.clock.now().toISOString();
  const existing = claimId
    ? runId
      ? sqlRow<FullClaimRow>(context.database, `SELECT c.id, c.coordination_session_id, c.run_id, c.intent, c.task, c.status, c.summary, c.updated_at
          FROM coordination_claims c JOIN coordination_sessions cs ON cs.id = c.coordination_session_id
          WHERE c.id = ? AND c.project_id = ? AND c.run_id = ? AND cs.user_id = ? AND cs.ended_at IS NULL AND cs.expires_at > ?`, claimId, projectId, runId, auth.userId ?? '', now)
      : sqlRow<FullClaimRow>(context.database, `SELECT c.id, c.coordination_session_id, c.run_id, c.intent, c.task, c.status, c.summary, c.updated_at
          FROM coordination_claims c JOIN coordination_sessions cs ON cs.id = c.coordination_session_id
          WHERE c.id = ? AND c.project_id = ? AND cs.user_id = ? AND cs.ended_at IS NULL AND cs.expires_at > ?`, claimId, projectId, auth.userId ?? '', now)
    : undefined;
  if (existing) {
    const status = optionalString(args, 'status', 40);
    const summaryValue = optionalString(args, 'summary', 2_000);
    const summary = summaryValue ? redactText(summaryValue, 2_000) : undefined;
    if (status && !CLAIM_ALLOWED_STATUSES.has(status)) throw new ToolInputError('Invalid claim status');
    if (CLAIM_TERMINAL_STATUSES.has(existing.status)) throw new ToolInputError('Claim is already settled');
    const nextStatus = status ?? existing.status;
    const eventKind = CLAIM_TERMINAL_STATUSES.has(nextStatus) ? 'claim.settled' : 'claim.updated';
    return eventTransaction(context, () => {
      const update = runId
        ? context.database.prepare('UPDATE coordination_claims SET status = COALESCE(?, status), summary = COALESCE(?, summary), updated_at = ?, completed_at = CASE WHEN ? IN (\'done\', \'abandoned\', \'released\') THEN ? ELSE completed_at END WHERE id = ? AND project_id = ? AND run_id = ? AND status NOT IN (\'done\', \'abandoned\', \'expired\', \'released\')')
        : context.database.prepare('UPDATE coordination_claims SET status = COALESCE(?, status), summary = COALESCE(?, summary), updated_at = ?, completed_at = CASE WHEN ? IN (\'done\', \'abandoned\', \'released\') THEN ? ELSE completed_at END WHERE id = ? AND project_id = ? AND status NOT IN (\'done\', \'abandoned\', \'expired\', \'released\')');
      const result = runId
        ? update.run(status ?? null, summary ?? null, now, status ?? '', now, claimId, projectId, runId)
        : update.run(status ?? null, summary ?? null, now, status ?? '', now, claimId, projectId);
      if (result.changes !== 1) throw new ToolPermissionError('Claim is outside the token scope');
      appendEvent(context, auth, projectId, eventKind, 'coordination_claim', existing.id, { status: nextStatus });
      if (CLAIM_TERMINAL_STATUSES.has(nextStatus)) {
        context.database.prepare(`UPDATE coordination_conflicts SET resolved_at = ?
          WHERE (claim_id = ? OR conflicting_claim_id = ?) AND resolved_at IS NULL`)
          .run(now, existing.id, existing.id);
      }
      return { id: existing.id, status: nextStatus, updatedAt: now };
    });
  }
  // A supplied claim id is an update selector, never a request to create a
  // second claim when the selector is outside this token's run/owner scope.
  if (claimId) throw new ToolPermissionError('Claim is outside the token scope');
  const intent = redactText(requiredString(args, 'intent'), 2_000);
  const coordinationSessionId = optionalString(args, 'coordinationSessionId', 160) ?? optionalString(args, 'sessionId', 160);
  const session = coordinationSessionId
    ? sqlRow<{ id: string; worktree_hash: string | null }>(context.database, 'SELECT id, worktree_hash FROM coordination_sessions WHERE id = ? AND project_id = ? AND user_id = ? AND ended_at IS NULL AND expires_at > ?', coordinationSessionId, projectId, auth.userId ?? '', now)
    : undefined;
  if (coordinationSessionId && !session) throw new ToolPermissionError('Coordination session is outside the token scope');
  let sessionId = session?.id;
  const claimWorktreeHash = canonicalWorktreeHash(optionalString(args, 'worktreeHash', 256)) ?? canonicalWorktreeHash(session?.worktree_hash ?? undefined);
  if (runId && !sqlRow(context.database, 'SELECT id FROM runs WHERE id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)', runId, projectId)) throw new ToolPermissionError('Run is outside the token project');
  const id = context.ids.id();
  const files = [...new Set(boundedStrings(args, 'files', 500).map(normalizeMcpPath))].slice(0, 500);
  const components = [...new Set(boundedStrings(args, 'components', 100, 120).map((component) => component.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 100);
  const status = optionalString(args, 'status', 40) ?? 'investigating';
  if (!['investigating', 'in-progress', 'testing', 'blocked'].includes(status)) throw new ToolInputError('Invalid initial claim status');
  const taskValue = optionalString(args, 'task', 500);
  const task = taskValue ? redactText(taskValue, 500) : undefined;
  const summaryValue = optionalString(args, 'summary', 2_000);
  const summary = summaryValue ? redactText(summaryValue, 2_000) : undefined;
  return eventTransaction(context, () => {
    if (!sessionId) {
      sessionId = context.ids.id();
      const expiresAt = new Date(context.clock.now().getTime() + 60 * 60 * 1000).toISOString();
      context.database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'mcp\', ?, ?, ?, ?)').run(sessionId, projectId, auth.userId ?? null, createHash('sha256').update('mcp').digest('hex'), now, now, expiresAt);
      appendEvent(context, auth, projectId, 'session.created', 'coordination_session', sessionId, { agent: 'mcp' });
    }
    const projectClaimCount = context.database.prepare('SELECT count(*) AS count FROM coordination_claims WHERE project_id = ?').get(projectId) as { count: number };
    if (projectClaimCount.count >= MAX_CLAIMS_PER_PROJECT) throw new ToolInputError(`Project already has the maximum of ${MAX_CLAIMS_PER_PROJECT} claims`);
    if (runId) {
      const runClaimCount = context.database.prepare('SELECT count(*) AS count FROM coordination_claims WHERE project_id = ? AND run_id = ?').get(projectId, runId) as { count: number };
      if (runClaimCount.count >= MAX_CLAIMS_PER_RUN) throw new ToolInputError(`Run already has the maximum of ${MAX_CLAIMS_PER_RUN} claims`);
    }
    const checked = coordinationCheck(context, auth, { files, components, task, intent, coordinationSessionId: sessionId, ...(runId ? { runId } : {}) }) as { conflicts: Array<{ claimId: string; severity: string; reasons: unknown[] }> };
    context.database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, intent, task, worktree_hash, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, sessionId, runId ?? null, intent, task ?? null, claimWorktreeHash ?? null, status, summary ?? null, now, now);
    const insertFile = context.database.prepare('INSERT INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)');
    for (const file of files) insertFile.run(id, file);
    const insertComponent = context.database.prepare('INSERT INTO coordination_claim_components(claim_id, normalized_component) VALUES (?, ?)');
    for (const component of components) insertComponent.run(id, component);
    const insertConflict = context.database.prepare('INSERT INTO coordination_conflicts(id, project_id, claim_id, conflicting_claim_id, severity, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const conflict of checked.conflicts) insertConflict.run(context.ids.id(), projectId, id, conflict.claimId, conflict.severity, JSON.stringify(conflict.reasons), now);
    appendEvent(context, auth, projectId, 'claim.created', 'coordination_claim', id, { status, intent: redactText(intent) });
    if (checked.conflicts.length > 0) appendEvent(context, auth, projectId, 'conflict.detected', 'coordination_claim', id, { count: checked.conflicts.length });
    return { id, projectId, coordinationSessionId: sessionId, runId, status, files, components, intent: redactText(intent), conflicts: checked.conflicts, createdAt: now };
  });
}

function coordinationRelease(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth);
  const claimId = requiredString(args, 'claimId', 160);
  const claim = runId
    ? sqlRow<{ id: string; status: string }>(context.database, `SELECT c.id, c.status FROM coordination_claims c JOIN coordination_sessions cs ON cs.id = c.coordination_session_id WHERE c.id = ? AND c.project_id = ? AND c.run_id = ? AND cs.user_id = ? AND cs.ended_at IS NULL AND cs.expires_at > ?`, claimId, projectId, runId, auth.userId ?? '', context.clock.now().toISOString())
    : sqlRow<{ id: string; status: string }>(context.database, `SELECT c.id, c.status FROM coordination_claims c JOIN coordination_sessions cs ON cs.id = c.coordination_session_id WHERE c.id = ? AND c.project_id = ? AND cs.user_id = ? AND cs.ended_at IS NULL AND cs.expires_at > ?`, claimId, projectId, auth.userId ?? '', context.clock.now().toISOString());
  if (!claim) throw new ToolInputError('Claim was not found');
  if (CLAIM_TERMINAL_STATUSES.has(claim.status)) return { id: claimId, status: claim.status, updatedAt: context.clock.now().toISOString() };
  const now = context.clock.now().toISOString();
  return eventTransaction(context, () => {
    const update = runId
      ? context.database.prepare('UPDATE coordination_claims SET status = \'released\', updated_at = ?, completed_at = ? WHERE id = ? AND project_id = ? AND run_id = ? AND status NOT IN (\'done\', \'abandoned\', \'expired\', \'released\')')
      : context.database.prepare('UPDATE coordination_claims SET status = \'released\', updated_at = ?, completed_at = ? WHERE id = ? AND project_id = ? AND status NOT IN (\'done\', \'abandoned\', \'expired\', \'released\')');
    const result = runId ? update.run(now, now, claimId, projectId, runId) : update.run(now, now, claimId, projectId);
    if (result.changes !== 1) throw new ToolPermissionError('Claim is outside the token scope');
    appendEvent(context, auth, projectId, 'claim.settled', 'coordination_claim', claimId, { status: 'released' });
    return { id: claimId, status: 'released', updatedAt: now };
  });
}

function childRun(context: ServerContext, auth: AuthContext, args: Record<string, unknown>, requireRun = false): { projectId: string; runId: string; childId?: string; activationId?: string } {
  const projectId = scopedProject(args, auth);
  const runId = scopedRun(args, auth, requireRun);
  const childId = optionalString(args, 'childId', 160);
  const activationId = optionalString(args, 'activationId', 160);
  if (runId) {
    const run = sqlRow<{ id: string }>(context.database, 'SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?', runId, projectId);
    if (!run) throw new ToolPermissionError('Run is outside the token project');
    if (childId && !sqlRow(context.database, 'SELECT la.id FROM logical_agents la WHERE la.id = ? AND la.run_id = ?', childId, runId)) throw new ToolPermissionError('Child is outside the token run');
    if (activationId && (!childId || !sqlRow(context.database, 'SELECT aa.id FROM agent_activations aa WHERE aa.id = ? AND aa.logical_agent_id = ?', activationId, childId))) throw new ToolPermissionError('Activation is outside the token run');
    return { projectId, runId, ...(childId ? { childId } : {}), ...(activationId ? { activationId } : {}) };
  }
  const child = childId
    ? sqlRow<{ id: string; run_id: string; activation_id: string | null }>(context.database, 'SELECT la.id, la.run_id, aa.id AS activation_id FROM logical_agents la LEFT JOIN agent_activations aa ON aa.logical_agent_id = la.id WHERE la.id = ? AND la.run_id IN (SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.project_id = ?) ORDER BY aa.ordinal DESC LIMIT 1', childId, projectId)
    : undefined;
  if (!child) throw new ToolInputError('Child or run was not found');
  const resolvedActivationId = activationId ?? child.activation_id ?? undefined;
  return { projectId, runId: child.run_id, childId: child.id, ...(resolvedActivationId ? { activationId: resolvedActivationId } : {}) };
}

function childCreate(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const { projectId, runId } = childRun(context, auth, args, true);
  const name = redactText(requiredString(args, 'name', 160), 160);
  const roleValue = optionalString(args, 'role', 160);
  const role = roleValue ? redactText(roleValue, 160) : undefined;
  const objectiveValue = optionalString(args, 'objective', 2_000);
  const objective = objectiveValue ? redactText(objectiveValue, 2_000) : undefined;
  const parentAgentId = optionalString(args, 'parentAgentId', 160);
  const runtimeId = optionalString(args, 'runtimeId', 160) ?? 'mcp';
  const now = context.clock.now().toISOString();
  const childId = context.ids.id();
  const activationId = context.ids.id();
  return eventTransaction(context, () => {
    const caps = directChildCaps(context, runId);
    const agentCount = context.database.prepare('SELECT count(*) AS count FROM logical_agents WHERE run_id = ?').get(runId) as { count: number };
    if (agentCount.count >= caps.maxAgents) throw new ToolInputError(`Run already has the maximum of ${caps.maxAgents} logical agents`);
    const activeCount = context.database.prepare("SELECT count(*) AS count FROM agent_activations WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?) AND state IN ('queued', 'running', 'waiting_on_children', 'needs_input', 'needs_approval', 'blocked')").get(runId) as { count: number };
    if (activeCount.count >= caps.maxConcurrentAgents) throw new ToolInputError(`Run already has the maximum of ${caps.maxConcurrentAgents} concurrent agents`);
    if (!parentAgentId && caps.maxDepth < 1) throw new ToolInputError(`Agent lineage cannot exceed depth ${caps.maxDepth}`);
    if (parentAgentId) {
      const parent = sqlRow<{ id: string }>(context.database, 'SELECT id FROM logical_agents WHERE id = ? AND run_id = ?', parentAgentId, runId);
      if (!parent) throw new ToolInputError('Parent agent was not found in this run');
      const childCount = context.database.prepare('SELECT count(*) AS count FROM agent_edges WHERE run_id = ? AND parent_logical_agent_id = ?').get(runId, parentAgentId) as { count: number };
      if (childCount.count >= caps.maxChildrenPerParent) throw new ToolInputError(`Parent already has the maximum of ${caps.maxChildrenPerParent} direct children`);
      let depth = 1;
      let current = parentAgentId;
      const visited = new Set<string>();
      while (current) {
        if (visited.has(current)) throw new ToolInputError('Agent lineage contains a cycle');
        visited.add(current);
        const ancestor = sqlRow<{ parent_logical_agent_id: string }>(context.database, 'SELECT parent_logical_agent_id FROM agent_edges WHERE run_id = ? AND child_logical_agent_id = ? ORDER BY created_at, id LIMIT 1', runId, current);
        if (!ancestor) break;
        depth += 1;
        current = ancestor.parent_logical_agent_id;
      }
      if (depth >= caps.maxDepth) throw new ToolInputError(`Agent lineage cannot exceed depth ${caps.maxDepth}`);
    }
    context.database.prepare('INSERT INTO logical_agents(id, run_id, name, role, objective, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(childId, runId, name, role ?? null, objective ?? null, now);
    context.database.prepare('INSERT INTO agent_activations(id, logical_agent_id, runtime_registration_id, ordinal, state, started_at, last_activity_at) VALUES (?, ?, NULL, 1, \'queued\', NULL, ?)').run(activationId, childId, now);
    if (parentAgentId) {
      context.database.prepare('INSERT INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, created_at) VALUES (?, ?, ?, ?, \'platform\', \'full\', ?)').run(context.ids.id(), runId, parentAgentId, childId, now);
    }
    appendEvent(context, auth, projectId, 'child.discovered', 'logical_agent', childId, { runId, name: redactText(name), runtimeId });
    return { childId, activationId, runId, state: 'queued', runtimeId };
  });
}

function childStatus(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const scope = childRun(context, auth, args);
  const childId = scope.childId ?? requiredString(args, 'childId', 160);
  const child = sqlRow<ChildRow>(context.database, 'SELECT la.id, la.run_id, la.name, la.role, la.objective, la.created_at, aa.id AS activation_id, aa.state, aa.started_at, aa.ended_at, aa.last_activity_at FROM logical_agents la LEFT JOIN agent_activations aa ON aa.logical_agent_id = la.id WHERE la.id = ? AND la.run_id = ? ORDER BY aa.ordinal DESC LIMIT 1', childId, scope.runId);
  if (!child) throw new ToolInputError('Child was not found');
  return { childId: child.id, runId: child.run_id, name: redactText(child.name, 160), role: child.role ? redactText(child.role, 160) : null, objective: child.objective ? redactText(child.objective, 2_000) : null, createdAt: child.created_at, activation: child.activation_id ? { id: child.activation_id, state: child.state, startedAt: child.started_at, endedAt: child.ended_at, lastActivityAt: child.last_activity_at } : undefined };
}

interface ChildRow { id: string; run_id: string; name: string; role: string | null; objective: string | null; created_at: string; activation_id: string | null; state: string | null; started_at: string | null; ended_at: string | null; last_activity_at: string | null }

function childMessage(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const scope = childRun(context, auth, args);
  const childId = scope.childId ?? requiredString(args, 'childId', 160);
  const message = redactText(requiredString(args, 'message', 200_000), 200_000);
  const target = sqlRow<{ session_id: string }>(context.database, 'SELECT r.session_id FROM logical_agents la JOIN runs r ON r.id = la.run_id WHERE la.id = ? AND la.run_id = ?', childId, scope.runId);
  if (!target) throw new ToolInputError('Child was not found');
  const id = context.ids.id();
  const now = context.clock.now().toISOString();
  return eventTransaction(context, () => {
    const sequenceRow = context.database.prepare('UPDATE sessions SET next_message_sequence = next_message_sequence + 1, updated_at = ? WHERE id = ? RETURNING next_message_sequence').get(now, target.session_id) as { next_message_sequence: number } | undefined;
    if (!sequenceRow) throw new ToolInputError('Child session was not found');
    context.database.prepare('INSERT INTO messages(id, session_id, run_id, turn_id, sequence, role, author_user_id, body, status, created_at) VALUES (?, ?, ?, NULL, ?, \'human\', ?, ?, \'queued\', ?)').run(id, target.session_id, scope.runId, sequenceRow.next_message_sequence, auth.userId ?? null, message, now);
    appendEvent(context, auth, scope.projectId, 'human.message.queued', 'message', id, { runId: scope.runId, sequence: sequenceRow.next_message_sequence });
    return { messageId: id, runId: scope.runId, sequence: sequenceRow.next_message_sequence, state: 'queued' };
  });
}

function childCancel(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const scope = childRun(context, auth, args);
  const childId = scope.childId ?? requiredString(args, 'childId', 160);
  const activationId = scope.activationId ?? optionalString(args, 'activationId', 160);
  const now = context.clock.now().toISOString();
  return eventTransaction(context, () => {
    const changed = activationId
      ? context.database.prepare('UPDATE agent_activations SET state = \'cancelled\', ended_at = ?, last_activity_at = ? WHERE id = ? AND logical_agent_id = ? AND state NOT IN (\'settled\', \'failed\', \'cancelled\', \'stale\')').run(now, now, activationId, childId)
      : context.database.prepare('UPDATE agent_activations SET state = \'cancelled\', ended_at = ?, last_activity_at = ? WHERE logical_agent_id = ? AND state NOT IN (\'settled\', \'failed\', \'cancelled\', \'stale\')').run(now, now, childId);
    if (changed.changes < 1) throw new ToolInputError('Child activation was not found or already settled');
    appendEvent(context, auth, scope.projectId, 'child.state.changed', 'logical_agent', childId, { state: 'cancelled' });
    return { childId, activationId, state: 'cancelled', updatedAt: now };
  });
}

function childWait(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  boundedInt(args, 'timeoutMs', 0, 0, 30_000);
  return childStatus(context, auth, args);
}

function childCollect(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const scope = childRun(context, auth, args);
  const childId = scope.childId ?? requiredString(args, 'childId', 160);
  const limit = boundedInt(args, 'limit', 100, 1, 100);
  const status = childStatus(context, auth, { ...args, childId });
  // Keep collection scoped to the requested logical agent. Filtering only by
  // run_id leaks sibling output to any child token that can call this tool.
  const messages = sqlRows<MessageRow>(context.database, 'SELECT m.id, m.sequence, m.role, m.body, m.status, m.created_at, m.completed_at FROM messages m WHERE m.run_id = ? AND m.logical_agent_id = ? ORDER BY m.sequence DESC LIMIT ?', scope.runId, childId, limit).map((message) => ({ id: message.id, sequence: message.sequence, role: message.role, body: redactText(message.body, 1_024), status: message.status, createdAt: message.created_at, completedAt: message.completed_at }));
  return { childId, status, messages: messages.reverse() };
}

interface MessageRow { id: string; sequence: number; role: string; body: string; status: string; created_at: string; completed_at: string | null }

function memoryRead(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const packId = optionalString(args, 'packId', 160);
  const stableKey = optionalString(args, 'stableKey', 160);
  const query = optionalString(args, 'query', 500);
  const limit = boundedInt(args, 'limit', 100, 1, 100);
  const pack = packId
    ? sqlRow<MemoryPackRow>(context.database, 'SELECT id, stable_key, name, scope, scope_key, active_generation_id FROM memory_packs WHERE id = ? AND project_id = ?', packId, projectId)
    : stableKey
      ? sqlRow<MemoryPackRow>(context.database, 'SELECT id, stable_key, name, scope, scope_key, active_generation_id FROM memory_packs WHERE stable_key = ? AND project_id = ?', stableKey, projectId)
      : undefined;
  if (!pack) throw new ToolInputError('Memory pack was not found');
  if (!pack.active_generation_id) return { pack, generation: undefined, entries: [] };
  const generation = sqlRow<MemoryGenerationRow>(context.database, 'SELECT id, generation, content_hash, state, created_at, activated_at FROM memory_generations WHERE id = ? AND pack_id = ?', pack.active_generation_id, pack.id);
  if (!generation) return { pack, generation: undefined, entries: [] };
  let entries: MemoryEntryRow[];
  if (query) {
    const safeTerms = query
      .normalize('NFKC')
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 12)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' AND ');
    entries = safeTerms
      ? sqlRows<MemoryEntryRow>(context.database, 'SELECT e.id, e.ordinal, e.title, e.body, e.source_type, e.source_reference, e.created_at FROM memory_entries e JOIN memory_fts f ON f.entry_id = e.id WHERE e.generation_id = ? AND memory_fts MATCH ? ORDER BY e.ordinal LIMIT ?', generation.id, safeTerms, limit)
      : [];
    if (entries.length === 0) {
      const escapedLike = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      entries = sqlRows<MemoryEntryRow>(context.database, "SELECT id, ordinal, title, body, source_type, source_reference, created_at FROM memory_entries WHERE generation_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY ordinal LIMIT ?", generation.id, `%${escapedLike}%`, `%${escapedLike}%`, limit);
    }
  } else entries = sqlRows<MemoryEntryRow>(context.database, 'SELECT id, ordinal, title, body, source_type, source_reference, created_at FROM memory_entries WHERE generation_id = ? ORDER BY ordinal LIMIT ?', generation.id, limit);
  return {
    pack: { id: pack.id, stableKey: pack.stable_key, name: redactText(pack.name, 500), scope: pack.scope, scopeKey: pack.scope_key, activeGenerationId: pack.active_generation_id },
    generation: { id: generation.id, generation: generation.generation, contentHash: generation.content_hash, state: generation.state, createdAt: generation.created_at, activatedAt: generation.activated_at },
    entries: entries.map((entry) => ({ id: entry.id, ordinal: entry.ordinal, title: redactText(entry.title, 500), body: redactText(entry.body, 1_024), sourceType: entry.source_type, sourceReference: redactText(entry.source_reference, 500), createdAt: entry.created_at })),
  };
}

interface MemoryPackRow { id: string; stable_key: string; name: string; scope: string; scope_key: string | null; active_generation_id: string | null }
interface MemoryGenerationRow { id: string; generation: number; content_hash: string; state: string; created_at: string; activated_at: string | null }
interface MemoryEntryRow { id: string; ordinal: number; title: string; body: string; source_type: string; source_reference: string; created_at: string }

function memoryPropose(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const packId = requiredString(args, 'packId', 160);
  const pack = sqlRow<{ id: string }>(context.database, 'SELECT id FROM memory_packs WHERE id = ? AND project_id = ?', packId, projectId);
  if (!pack) throw new ToolInputError('Memory pack was not found');
  const parsedInput = MemoryProposalInputSchema.safeParse({
    title: args.title,
    body: args.body,
    sourceType: args.sourceType,
    sourceReference: args.sourceReference,
    ...(args.baseGenerationId === undefined ? {} : { baseGenerationId: args.baseGenerationId }),
    ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
  });
  if (!parsedInput.success) throw new ToolInputError('Invalid memory proposal input');
  const input = parsedInput.data;
  for (const value of [input.title, input.body, input.sourceType, input.sourceReference]) {
    if (containsMemoryCredential(value)) throw new ToolInputError('Memory content must not contain credentials');
  }
  if (input.baseGenerationId && !sqlRow(context.database, 'SELECT id FROM memory_generations WHERE id = ? AND pack_id = ?', input.baseGenerationId, packId)) {
    throw new ToolInputError('Memory generation not found');
  }
  const id = context.ids.id();
  const now = context.clock.now().toISOString();
  return eventTransaction(context, () => {
    context.database.prepare('INSERT INTO memory_proposals(id, pack_id, base_generation_id, proposed_by_user_id, title, body, source_type, source_reference, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?)').run(id, packId, input.baseGenerationId ?? null, auth.userId ?? null, input.title, input.body, input.sourceType, input.sourceReference, now);
    appendEvent(context, auth, projectId, 'memory.proposed', 'memory_pack', packId, { proposalId: id, baseGenerationId: input.baseGenerationId ?? null });
    context.database.prepare(`INSERT INTO audit_records(
      id, project_id, actor_type, actor_id, action, target_type, target_id,
      outcome, detail_json, occurred_at
    ) VALUES (?, ?, ?, ?, 'memory.propose', 'memory_proposal', ?, 'allowed', ?, ?)`)
      .run(context.ids.id(), projectId, auth.userId ? 'user' : 'system', auth.userId ?? null, id,
        JSON.stringify({ packId, baseGenerationId: input.baseGenerationId ?? null, sourceType: input.sourceType }), now);
    return { proposalId: id, packId, state: 'pending', createdAt: now };
  });
}

function skillRead(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const skillId = optionalString(args, 'skillId', 160);
  const stableKey = optionalString(args, 'stableKey', 160);
  const skill = skillId
    ? sqlRow<SkillRow>(context.database, 'SELECT id, project_id, stable_key, name, active_version_id FROM skills WHERE id = ? AND (project_id = ? OR project_id IS NULL)', skillId, projectId)
    : stableKey
      ? sqlRow<SkillRow>(context.database, 'SELECT id, project_id, stable_key, name, active_version_id FROM skills WHERE stable_key = ? AND (project_id = ? OR project_id IS NULL)', stableKey, projectId)
      : undefined;
  if (!skill) throw new ToolInputError('Skill was not found');
  const version = skill.active_version_id ? sqlRow<SkillVersionRow>(context.database, 'SELECT id, version, lifecycle, skill_markdown, manifest_json, content_hash, created_at FROM skill_versions WHERE id = ? AND skill_id = ?', skill.active_version_id, skill.id) : undefined;
  return { skill: { id: skill.id, projectId: skill.project_id, stableKey: skill.stable_key, name: redactText(skill.name, 240), activeVersionId: skill.active_version_id }, version: version ? { id: version.id, version: version.version, lifecycle: version.lifecycle, skillMarkdown: redactText(version.skill_markdown.slice(0, 200_000), 200_000), manifest: parseJsonRecord(version.manifest_json), contentHash: version.content_hash, createdAt: version.created_at } : undefined };
}

interface SkillRow { id: string; project_id: string | null; stable_key: string; name: string; active_version_id: string | null }
interface SkillVersionRow { id: string; version: number; lifecycle: string; skill_markdown: string; manifest_json: string; content_hash: string; created_at: string }

function skillPropose(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const skillId = optionalString(args, 'skillId', 160);
  const stableKey = optionalString(args, 'stableKey', 160);
  const markdown = requiredString(args, 'skillMarkdown', 200_000);
  // Skill source is durable and executable context. Reject recognizable
  // credentials rather than silently redacting them: callers can then fix the
  // proposal while preserving an auditable, byte-identical source/hash pair.
  if (redactSecrets(markdown, 200_000) !== markdown) throw new ToolInputError('skillMarkdown must not contain credentials');
  const manifest = args.manifest === undefined ? {} : redactRecord(asRecord(args.manifest));
  return eventTransaction(context, () => {
    let skill = skillId ? sqlRow<SkillRow>(context.database, 'SELECT id, project_id, stable_key, name, active_version_id FROM skills WHERE id = ? AND project_id = ?', skillId, projectId) : stableKey ? sqlRow<SkillRow>(context.database, 'SELECT id, project_id, stable_key, name, active_version_id FROM skills WHERE stable_key = ? AND project_id = ?', stableKey, projectId) : undefined;
    const now = context.clock.now().toISOString();
    if (!skill) {
      const id = context.ids.id();
      const key = stableKey ?? `mcp-${id.slice(0, 8)}`;
      const name = optionalString(args, 'name', 240) ?? key;
      context.database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, key, redactText(name), now);
      skill = { id, project_id: projectId, stable_key: key, name, active_version_id: null };
    }
    const prior = sqlRow<{ version: number }>(context.database, 'SELECT COALESCE(MAX(version), 0) AS version FROM skill_versions WHERE skill_id = ?', skill.id);
    const version = (prior?.version ?? 0) + 1;
    const id = context.ids.id();
    const manifestJson = JSON.stringify(manifest);
    const contentHash = createHash('sha256').update(markdown).update(manifestJson).digest('hex');
    context.database.prepare('INSERT INTO skill_versions(id, skill_id, version, lifecycle, skill_markdown, manifest_json, content_hash, proposed_by_user_id, created_at) VALUES (?, ?, ?, \'draft\', ?, ?, ?, ?, ?)').run(id, skill.id, version, markdown, manifestJson, contentHash, auth.userId ?? null, now);
    context.database.prepare(`INSERT INTO audit_records(
      id, project_id, actor_type, actor_id, action, target_type, target_id,
      outcome, detail_json, occurred_at
    ) VALUES (?, ?, ?, ?, 'skill.propose', 'skill_version', ?, 'allowed', ?, ?)`)
      .run(context.ids.id(), projectId, auth.userId ? 'user' : 'system', auth.userId ?? null, id,
        JSON.stringify({ skillId: skill.id, stableKey: redactText(skill.stable_key, 160), version, contentHash }), now);
    return { skillId: skill.id, versionId: id, version, lifecycle: 'draft', contentHash, createdAt: now };
  });
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function benchmarkInvoke(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  const projectId = scopedProject(args, auth);
  const benchmarkId = requiredString(args, 'benchmarkId', 160);
  const benchmark = sqlRow<{ id: string }>(context.database, 'SELECT id FROM benchmarks WHERE id = ? AND (project_id = ? OR project_id IS NULL)', benchmarkId, projectId);
  if (!benchmark) throw new ToolInputError('Benchmark was not found');
  const baseline = args.baselineConfig === undefined ? {} : asRecord(args.baselineConfig);
  const candidate = args.candidateConfig === undefined ? {} : asRecord(args.candidateConfig);
  const seed = args.seed === undefined ? context.ids.id() : requiredString(args, 'seed', 200);
  const environmentHash = createHash('sha256').update(`${projectId}:${benchmarkId}:${seed}`).digest('hex');
  const creator = auth.userId ?? sqlRow<{ created_by: string }>(context.database, 'SELECT created_by FROM projects WHERE id = ?', projectId)?.created_by;
  if (!creator) throw new ToolPermissionError('A user-bound token is required to invoke benchmarks');
  return createBenchmarkInvocationService(context).invokeBenchmark({
    benchmarkId,
    baseline: { reference: 'mcp:baseline', config: redactRecord(baseline) },
    candidate: { reference: 'mcp:candidate', config: redactRecord(candidate) },
    environmentHash,
    seed,
    createdBy: creator,
  });
}

const REDACTED_FIELD = /(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key|cookie)/i;

function redactRecord(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (REDACTED_FIELD.test(key)) output[key] = '[REDACTED]';
    else if (typeof item === 'string') output[key] = redactText(item);
    else if (depth < 4 && Array.isArray(item)) output[key] = item.map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? redactRecord(entry as Record<string, unknown>, depth + 1) : typeof entry === 'string' ? redactText(entry) : entry);
    else if (depth < 4 && item && typeof item === 'object') output[key] = redactRecord(item as Record<string, unknown>, depth + 1);
    else output[key] = item;
  }
  return output;
}

function mediationGuidance(kind: 'setup' | 'init' | 'bug'): unknown {
  const guidance: Record<typeof kind, string> = {
    setup: 'Dhole MCP uses a project-scoped hashed API token. Create it through the authenticated administration API; credentials are never accepted in MCP arguments.',
    init: 'Dhole coordination is initialized by the server migration. Register a coordination session with coordination_session_register; no external Mediation project is created.',
    bug: 'Dhole does not create external issue records from MCP. Record a bug in the project issue tracker and use coordination_claim for an actionable work item.',
  };
  return { compatibility: true, supported: false, guidance: guidance[kind] };
}

function mediationState(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  return { compatibility: true, ...(projectState(context, auth, args) as Record<string, unknown>), coordination: coordinationCheck(context, auth, args) };
}

function mediationClaim(context: ServerContext, auth: AuthContext, args: Record<string, unknown>): unknown {
  if (args.claimId && args.status === 'released') return coordinationRelease(context, auth, args);
  return coordinationClaim(context, auth, args);
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
    auth = authenticate(context.database, requestContext.req.header('authorization'), context.clock.now());
  } catch (error) {
    if (error instanceof HttpBoundaryError) {
      const response = rpcError(requestContext, request.id, { code: -32002, message: error.message }, error.status);
      if (error.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
      return response;
    }
    throw error;
  }
  try {
    if (request.method === 'initialize') {
      const requested = optionalString(asRecord(request.params), 'protocolVersion', 80) ?? request._meta?.protocolVersion;
      if (requested && requested !== McpProtocolVersion) return rpcError(requestContext, request.id, { code: -32001, message: `Unsupported MCP protocol version: ${requested}` }, 400);
      return rpcResult(requestContext, request.id, { protocolVersion: McpProtocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dhole', version: '0.1.0' } });
    }
    if (request.method === 'tools/list') return rpcResult(requestContext, request.id, { tools: MCP_TOOLS });
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
    if (error instanceof ToolPermissionError) return rpcError(requestContext, request.id, { code: -32003, message: 'Tool denied by token scope' });
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
