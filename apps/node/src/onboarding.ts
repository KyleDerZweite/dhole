import { existsSync, readFileSync, realpathSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { McpProtocolVersion } from '@dhole-control/shared';
import { readConnectionState, readCredentialState, writeCredentialState, writePrivateJson } from './config.js';

const TokenSchema = z.object({
  token: z.string().min(16).max(2048), id: z.string().min(1).max(160),
  permissions: z.array(z.string().min(1).max(80)).max(40), expiresAt: z.iso.datetime(),
});
export const AgentStateSchema = TokenSchema.extend({ serverUrl: z.string().max(2048) });
export type AgentState = z.infer<typeof AgentStateSchema>;
export const ProjectTokenSchema = TokenSchema.extend({ projectId: z.string().min(1).max(160), repositoryId: z.string().min(1).max(160).optional() });
const StartSchema = z.object({
  deviceCode: z.string().min(16).max(512), userCode: z.string().min(4).max(40),
  verificationUri: z.url(), verificationUriComplete: z.url().optional(),
  expiresIn: z.number().int().min(1).max(900), interval: z.number().int().min(1).max(60),
});
const DeviceStatusSchema = z.object({
  id: z.string().min(1).max(160), permissions: z.array(z.string().min(1).max(80)).max(40), expiresAt: z.iso.datetime(),
  machineId: z.string().min(1).max(160).nullable(), machineStatus: z.enum(['enrolled', 'connected', 'disconnected', 'stale', 'revoked']).nullable(),
});
const EnrollmentSchema = z.object({ machineId: z.string().min(1).max(160), credential: z.string().min(16).max(512) });
const ErrorSchema = z.object({ error: z.object({ code: z.string().max(120) }) });

export class ClientError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ClientError'; }
}

/** Only the configured central origin may receive credentials. */
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ClientError('invalid_server_url');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) throw new ClientError('https_required');
  return url.origin;
}

/** Bounded JSON transport; errors never include response bodies or credentials. */
export async function requestJson<T>(server: string, path: string, schema: z.ZodType<T>, options: {
  body?: unknown; token?: string; capability?: string; method?: string; fetch?: typeof fetch; signal?: AbortSignal; idempotencyKey?: string; mcp?: boolean;
} = {}): Promise<T> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL(path, serverOrigin(server)), {
      method: options.method ?? 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.capability ? { 'x-mediation-session': options.capability } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...(options.mcp ? { Origin: serverOrigin(server), 'MCP-Protocol-Version': McpProtocolVersion } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch { throw new ClientError(options.signal?.aborted ? 'cancelled' : 'server_unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new ClientError('invalid_server_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 512 * 1024) { await reader.cancel(); throw new ClientError('server_response_too_large'); }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError('server_unavailable');
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new ClientError('invalid_server_response'); }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(value);
    const known = new Set(['authorization_pending', 'slow_down', 'device_code_expired', 'device_code_used', 'device_token_invalid', 'access_denied', 'device_code_denied', 'device_code_revoked', 'session_expired', 'session_not_found', 'device_scope_denied', 'project_name_in_use', 'idempotency_conflict', 'module_unavailable']);
    throw new ClientError(error.success && known.has(error.data.error.code) ? error.data.error.code : `server_http_${response.status}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new ClientError('invalid_server_response');
  return result.data;
}

export function readAgentState(stateDir: string): AgentState {
  try {
    const state = AgentStateSchema.parse(JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8')) as unknown);
    state.serverUrl = serverOrigin(state.serverUrl);
    return state;
  } catch { throw new ClientError('machine_not_connected'); }
}

export interface ConnectOptions {
  server: string; stateDir: string; machineName?: string; repositories?: Record<string, string>;
  agentOnly?: boolean; gateway?: boolean; dryRun?: boolean; signal?: AbortSignal;
}
export interface ConnectDependencies {
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; output?: (line: string) => void;
}

export async function connectMachine(options: ConnectOptions, dependencies: ConnectDependencies = {}): Promise<{ enrolled: boolean; dryRun: boolean }> {
  const server = serverOrigin(options.server);
  const stateDir = resolve(options.stateDir);
  const existing = readConnectionState(stateDir);
  const repositories = { ...(existing?.repositories ?? {}), ...options.repositories };
  for (const [id, root] of Object.entries(repositories)) {
    if (!id || id.length > 160 || !isAbsolute(root)) throw new ClientError('invalid_repository_allowlist');
    const canonical = realpathSync(root);
    if (!statSync(canonical).isDirectory()) throw new ClientError('invalid_repository_allowlist');
    repositories[id] = canonical;
  }
  const output = dependencies.output ?? ((line) => process.stdout.write(`${line}\n`));
  if (options.dryRun) {
    output(`Would pair with ${server}, save private credentials in ${stateDir}, and allow ${Object.keys(repositories).length} explicit repositories. No changes made.`);
    return { enrolled: false, dryRun: true };
  }
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async (ms, signal) => { await delay(ms, undefined, signal ? { signal } : {}); });
  let agent: AgentState | undefined;
  if (existsSync(join(stateDir, 'agent.json'))) {
    agent = readAgentState(stateDir);
    if (agent.serverUrl !== server) throw new ClientError('state_directory_has_another_server');
    if (Date.parse(agent.expiresAt) <= now()) agent = undefined;
  }
  const transport = { ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const machineName = z.string().trim().min(1).max(160).parse(options.machineName ?? hostname());
  if (agent) {
    try {
      const status = await requestJson(server, '/api/auth/device/status', DeviceStatusSchema, { ...transport, token: agent.token, method: 'GET' });
      agent = !options.agentOnly && status.machineStatus === 'revoked' ? undefined : { ...agent, permissions: status.permissions, expiresAt: status.expiresAt };
    } catch (error) {
      if (error instanceof ClientError && error.code === 'device_token_invalid') agent = undefined;
      else throw error;
    }
  }
  if (agent && options.gateway && !['gateway:read', 'gateway:manage'].every((permission) => agent?.permissions.includes(permission))) {
    throw new ClientError('gateway_permission_requires_new_browser_approval');
  }
  const freshAuthorization = !agent;
  if (!agent) {
    const start = await requestJson(server, '/api/auth/device/start', StartSchema, {
      ...transport, body: { machineName, permissions: ['project:read', 'coordination:write', 'projects:create', ...(options.gateway ? ['gateway:read', 'gateway:manage'] : []), ...(options.agentOnly ? [] : ['fleet:admin'])] },
    });
    for (const value of [start.verificationUri, start.verificationUriComplete].filter((value): value is string => Boolean(value))) {
      const url = new URL(value);
      if (url.origin !== server || url.username || url.password) throw new ClientError('invalid_verification_url');
    }
    output(`Open ${start.verificationUriComplete ?? start.verificationUri} in your browser. Confirm code ${start.userCode}.`);
    const deadline = now() + start.expiresIn * 1000;
    let interval = start.interval * 1000;
    let waited = 0;
    while (!agent && now() < deadline && waited < start.expiresIn * 1000) {
      if (options.signal?.aborted) throw new ClientError('cancelled');
      const wait = Math.min(interval, deadline - now(), start.expiresIn * 1000 - waited);
      try { await sleep(wait, options.signal); } catch { throw new ClientError('cancelled'); }
      waited += wait;
      if (now() >= deadline || waited >= start.expiresIn * 1000) break;
      try {
        const token = await requestJson(server, '/api/auth/device/poll', TokenSchema, { ...transport, body: { deviceCode: start.deviceCode } });
        agent = { ...token, serverUrl: server };
      } catch (error) {
        if (!(error instanceof ClientError)) throw error;
        if (error.code === 'slow_down') interval = Math.min(60_000, interval + 5_000);
        else if (error.code === 'server_unavailable') interval = Math.min(60_000, interval * 2);
        else if (error.code !== 'authorization_pending') throw error;
      }
    }
    if (!agent) throw new ClientError('device_code_expired');
  }
  writePrivateJson(join(stateDir, 'agent.json'), agent);
  if (freshAuthorization) rmSync(join(stateDir, 'credential.json'), { force: true });
  let enrolled = false;
  if (!options.agentOnly && agent.permissions.includes('fleet:admin')) {
    if (!readCredentialState(join(stateDir, 'credential.json'))) {
      const result = await requestJson(server, '/api/auth/device/enroll', EnrollmentSchema, { ...transport, token: agent.token, body: { machineName } });
      writeCredentialState(join(stateDir, 'credential.json'), result);
    }
    enrolled = true;
  }
  const websocket = new URL('/ws/node', server);
  websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:';
  writePrivateJson(join(stateDir, 'connection.json'), { serverUrl: websocket.toString(), repositories });
  output(`Machine connected${enrolled ? ' and node enrolled' : ' for agent coordination'}. Repository access remains limited to explicit allowlists.`);
  return { enrolled, dryRun: false };
}

const NativeProjectResultSchema = z.object({
  project: z.object({ id: z.string().min(1).max(160) }), repository: z.object({ id: z.string().min(1).max(160) }).optional(),
  authorizationSource: z.literal('native'), repositoryVerification: z.literal('unverified'),
});
const NativeRemoteSchema = z.string().trim().min(1).max(2048).refine((value) => {
  if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/u.test(value)) return !value.includes('/../');
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname) && url.pathname !== '/'
      && !url.password && !url.search && !url.hash && (url.protocol === 'ssh:' ? url.username === 'git' : !url.username);
  } catch { return false; }
});

/** Native membership is sufficient. Remote metadata never proves repository ownership. */
export async function createNativeProject(options: {
  stateDir: string; name: string; remote?: string; requestId?: string; cwd?: string; dryRun?: boolean;
}, dependencies: Pick<ConnectDependencies, 'fetch' | 'now' | 'output'> = {}): Promise<{ projectId: string; repositoryId?: string } | undefined> {
  const name = z.string().trim().min(1).max(160).parse(options.name);
  const canonicalRemote = options.remote === undefined ? undefined : NativeRemoteSchema.parse(options.remote);
  const body = { name, repository: { label: name, ...(canonicalRemote ? { canonicalRemote } : {}) } };
  const requestId = z.string().trim().min(1).max(160).parse(options.requestId ?? createHash('sha256')
    .update(JSON.stringify({ directory: resolve(options.cwd ?? process.cwd()), ...body })).digest('hex'));
  const output = dependencies.output ?? ((line) => process.stdout.write(`${line}\n`));
  if (options.dryRun) {
    output(`Would create a private native project and repository named ${JSON.stringify(name)}${canonicalRemote ? ' with the supplied unverified remote' : ' without a remote'}. No changes made.`);
    return undefined;
  }
  const agent = readAgentState(options.stateDir);
  if (Date.parse(agent.expiresAt) <= (dependencies.now ?? Date.now)()) throw new ClientError('machine_authorization_expired');
  if (!agent.permissions.includes('projects:create')) throw new ClientError('project_creation_not_authorized');
  const result = await requestJson(agent.serverUrl, '/api/auth/device/projects', NativeProjectResultSchema, {
    token: agent.token, body, idempotencyKey: requestId, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  const ids = { projectId: result.project.id, ...(result.repository ? { repositoryId: result.repository.id } : {}) };
  output(JSON.stringify(ids));
  return ids;
}
