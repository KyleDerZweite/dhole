import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { executeGatewayAction, GatewayActionSchema } from './gateway-client.js';
import { ClientError, ProjectTokenSchema, readAgentState, requestJson, type AgentState } from './onboarding.js';

const execute = promisify(execFile);
const MAX_BYTES = 512 * 1024;
const TOOL_NAMES = new Set(['coordination_check', 'coordination_claim', 'coordination_release', 'coordination_complete', 'coordination_revive', 'coordination_state', 'coordination_agent_event']);
const INTERNAL_ARGUMENTS = new Set(['projectId', 'sessionId', 'coordinationSessionId', 'capability', 'capabilityHash', 'worktree', 'worktreeHash', 'developerLabel', 'machineId']);
const RpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(160), z.number().finite()]).optional(), method: z.string().max(160), params: z.record(z.string(), z.unknown()).optional() });
const ToolSchema = z.object({ name: z.string().max(160), description: z.string().max(8000).optional(), inputSchema: z.record(z.string(), z.unknown()) });
const RpcResponseSchema = z.object({ jsonrpc: z.literal('2.0'), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string().max(8000), data: z.object({ code: z.string().max(120) }).optional() }).optional() });
const SessionSchema = z.object({ id: z.string().min(1).max(160), capability: z.string().min(8).max(256) });
const ObjectSchema = z.record(z.string(), z.unknown());
const CallSchema = z.object({ name: z.string().max(160), arguments: z.record(z.string(), z.unknown()).default({}) });

async function gitAt(cwd: string, args: string[]): Promise<string> {
  try { return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 16_384, windowsHide: true })).stdout.trim(); }
  catch { return ''; }
}

/** Private local identity works without a remote or a GitHub integration. */
export async function localWorktreeHash(cwd: string): Promise<string> {
  const root = await gitAt(cwd, ['rev-parse', '--show-toplevel']);
  return createHash('sha256').update(realpathSync(root || cwd)).digest('hex');
}

/** Inspect only the invocation repository. Never search a home directory. */
export async function repositoryBinding(cwd: string): Promise<{ remote: string; worktree: string }> {
  const git = (args: string[]) => gitAt(cwd, args);
  const root = await git(['rev-parse', '--show-toplevel']);
  if (!root) throw new ClientError('repository_required');
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let remoteName = (branch ? await git(['config', '--get', `branch.${branch}.pushRemote`]) : '')
    || await git(['config', '--get', 'remote.pushDefault'])
    || (branch ? await git(['config', '--get', `branch.${branch}.remote`]) : '');
  if (!remoteName) {
    const remotes = (await git(['remote'])).split('\n').filter(Boolean);
    if (remotes.length !== 1) throw new ClientError('unambiguous_push_remote_required');
    remoteName = remotes[0]!;
  }
  if (remoteName.startsWith('-') || remoteName === '.' || /\s/u.test(remoteName)) throw new ClientError('invalid_push_remote');
  const remotes = (await git(['remote', 'get-url', '--push', '--all', remoteName])).split('\n').filter(Boolean);
  if (remotes.length !== 1) throw new ClientError('unambiguous_push_remote_required');
  const remote = remotes[0]!;
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(remote)) throw new ClientError('github_push_remote_required');
  return { remote, worktree: createHash('sha256').update(realpathSync(root)).digest('hex') };
}

export interface BridgeOptions {
  stateDir: string; cwd: string; projectId?: string; agentLabel?: string; fetch?: typeof fetch;
  binding?: () => Promise<{ remote: string; worktree: string }>; now?: () => number; warning?: (message: string) => void;
}

/** One transport owns one capability. The model only sees coordination work tools. */
export class AgentBridge {
  private agent: AgentState | undefined;
  private project: z.infer<typeof ProjectTokenSchema> | undefined;
  private session: z.infer<typeof SessionSchema> | undefined;
  private binding: { remote: string; worktree: string } | undefined;
  private worktree: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private heartbeatPending: Promise<void> | undefined;
  private closed = false;
  private warned = false;
  private tools: z.infer<typeof ToolSchema>[] | undefined;
  private readonly controller = new AbortController();
  constructor(private readonly options: BridgeOptions) {}

  private transport(token: string, capability?: string): { token: string; capability?: string; fetch?: typeof fetch; signal: AbortSignal } {
    return { token, ...(capability ? { capability } : {}), ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: this.controller.signal };
  }

  private async authorize(): Promise<void> {
    if (this.closed) throw new ClientError('bridge_closed');
    this.agent ??= readAgentState(this.options.stateDir);
    const now = (this.options.now ?? Date.now)();
    if (Date.parse(this.agent.expiresAt) <= now) throw new ClientError('machine_authorization_expired');
    if (this.project && Date.parse(this.project.expiresAt) > now + 60_000) return;
    if (this.options.projectId) this.worktree ??= await localWorktreeHash(this.options.cwd);
    const permissions = ['project:read', 'coordination:write'].filter((permission) => this.agent?.permissions.includes(permission));
    if (!permissions.length) permissions.push(this.agent.permissions.includes('gateway:read') ? 'gateway:read' : 'gateway:manage');
    const body = this.options.projectId
      ? { mode: 'manual', projectId: this.options.projectId, permissions }
      : { mode: 'github', remote: (this.binding ??= await (this.options.binding?.() ?? repositoryBinding(this.options.cwd))).remote, permissions };
    this.worktree ??= this.binding?.worktree;
    const project = await requestJson(this.agent.serverUrl, '/api/auth/device/project', ProjectTokenSchema, { ...this.transport(this.agent.token), body });
    if (this.project && this.project.projectId !== project.projectId) throw new ClientError('repository_binding_changed');
    this.project = project;
  }

  private async establish(): Promise<void> {
    await this.authorize();
    if (this.session) return;
    this.session = await requestJson(this.agent!.serverUrl, `/api/projects/${encodeURIComponent(this.project!.projectId)}/sessions`, SessionSchema, {
      ...this.transport(this.project!.token), body: { agent: this.options.agentLabel ?? 'dhole-mcp', ...(this.worktree ? { worktree: this.worktree } : {}) },
    });
    if (this.closed) return;
    this.timer = setInterval(() => {
      if (this.heartbeatPending || this.closed) return;
      this.heartbeatPending = this.heartbeat().catch(() => { /* Next heartbeat retries quietly. */ }).finally(() => { this.heartbeatPending = undefined; });
    }, 30_000);
    this.timer.unref();
  }

  private async ready(): Promise<void> {
    this.pending ??= this.establish().finally(() => { this.pending = undefined; });
    await this.pending;
  }

  async heartbeat(): Promise<void> {
    if (!this.session || this.closed) return;
    await this.authorize();
    try { await requestJson(this.agent!.serverUrl, `/api/projects/${encodeURIComponent(this.project!.projectId)}/sessions/${encodeURIComponent(this.session.id)}/heartbeat`, ObjectSchema, {
      ...this.transport(this.project!.token, this.session.capability), body: {},
    }); } catch (error) {
      if (error instanceof ClientError && ['server_http_404', 'server_http_410', 'session_expired', 'session_not_found'].includes(error.code)) {
        this.session = undefined;
        if (this.timer) clearInterval(this.timer);
      }
      throw error;
    }
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const response = await requestJson(this.agent!.serverUrl, '/mcp', RpcResponseSchema, {
      ...this.transport(this.project!.token, this.session?.capability), mcp: true, body: { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) },
    });
    if (response.error) {
      if (['session_expired', 'session_not_found'].includes(response.error.data?.code ?? '')) {
        this.session = undefined;
        if (this.timer) clearInterval(this.timer);
      }
      throw new ClientError('coordination_request_rejected');
    }
    return response.result;
  }

  private async catalogue(): Promise<z.infer<typeof ToolSchema>[]> {
    if (this.tools) return this.tools;
    await this.authorize();
    const gateway = this.agent?.permissions.some((permission) => permission === 'gateway:read' || permission === 'gateway:manage') ? [{
      name: 'gateway_manage', description: 'Manage the authorized project Gateway using explicit typed actions. Credentials stay in private local files.',
      inputSchema: { type: 'object', ...z.toJSONSchema(GatewayActionSchema) } as Record<string, unknown>,
    }] : [];
    let remote: z.infer<typeof ToolSchema>[] = [];
    try {
      if (!this.agent?.permissions.includes('coordination:write')) throw new ClientError('coordination_not_authorized');
      await this.ready();
      remote = z.object({ tools: z.array(ToolSchema).max(100) }).parse(await this.rpc('tools/list')).tools;
    } catch (error) { if (!gateway.length) throw error; }
    this.tools = remote.filter((tool) => TOOL_NAMES.has(tool.name)).map((tool) => {
      const input = tool.inputSchema;
      const properties = ObjectSchema.safeParse(input.properties);
      return { ...tool, inputSchema: { ...input,
        ...(properties.success ? { properties: Object.fromEntries(Object.entries(properties.data).filter(([key]) => !INTERNAL_ARGUMENTS.has(key))) } : {}),
        ...(Array.isArray(input.required) ? { required: input.required.filter((key) => typeof key === 'string' && !INTERNAL_ARGUMENTS.has(key)) } : {}),
      } };
    });
    this.tools.push(...gateway);
    return this.tools;
  }

  private redact(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const secret of [this.agent?.token, this.project?.token, this.session?.capability]) if (secret) value = (value as string).split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:token|credential|capability|capabilityHash|authorization)$/iu.test(key)).map(([key, entry]) => [key, this.redact(entry)]));
    return value;
  }

  async handle(value: unknown): Promise<unknown | undefined> {
    const parsed = RpcSchema.safeParse(value);
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const request = parsed.data;
    if (request.id === undefined) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: request.id, result: this.redact(result) });
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'dhole', version: '0.1.0' } });
    if (request.method === 'ping') return reply({});
    if (!['tools/list', 'tools/call'].includes(request.method)) return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    try {
      if (request.method === 'tools/list') return reply({ tools: await this.catalogue() });
      const call = CallSchema.parse(request.params);
      const catalogue = await this.catalogue();
      if (!catalogue.some((tool) => tool.name === call.name)) return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unknown tool' } };
      for (const key of Object.keys(call.arguments)) if (INTERNAL_ARGUMENTS.has(key)) throw new ClientError('reserved_argument');
      if (call.name === 'gateway_manage') {
        return reply({ content: [{ type: 'text', text: JSON.stringify(await executeGatewayAction(call.arguments, {
          stateDir: this.options.stateDir, projectId: this.project!.projectId, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        })) }] });
      }
      await this.ready();
      return reply(await this.rpc('tools/call', { name: call.name, arguments: { ...call.arguments, ...(call.name === 'coordination_state' ? {} : { coordinationSessionId: this.session!.id }) } }));
    } catch {
      if (!this.warned) { this.options.warning?.('Dhole tools are unavailable. Ordinary agent work can continue.'); this.warned = true; }
      return reply(request.method === 'tools/list' ? { tools: [] } : { isError: true, content: [{ type: 'text', text: 'This Dhole action was not confirmed. Continue ordinary work and retry the action later.' }] });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled([this.pending, this.heartbeatPending].filter((promise): promise is Promise<void> => Boolean(promise)));
    if (this.session && this.project && this.agent) {
      try {
        await requestJson(this.agent.serverUrl, `/api/projects/${encodeURIComponent(this.project.projectId)}/sessions/${encodeURIComponent(this.session.id)}`, ObjectSchema, {
          ...this.transport(this.project.token, this.session.capability), method: 'DELETE', signal: AbortSignal.timeout(2000),
        });
      } catch { /* Transport shutdown never prevents normal agent exit. */ }
    }
    this.controller.abort();
  }
}

export async function serveStdio(bridge: AgentBridge, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  let buffered = '';
  const decoder = new StringDecoder('utf8');
  const stop = () => { input.destroy(); void bridge.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for await (const chunk of input) {
      buffered += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n');
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_BYTES) throw new ClientError('request_too_large');
        if (!line.trim()) continue;
        let request: unknown;
        try { request = JSON.parse(line) as unknown; }
        catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue; }
        const reply = await bridge.handle(request);
        if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`);
      }
      if (Buffer.byteLength(buffered) > MAX_BYTES) throw new ClientError('request_too_large');
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await bridge.close();
  }
}
