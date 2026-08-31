import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { hashToken } from '../../lib/security.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { createBenchmarkInvocationService } from '../lab/index.js';
import { createSkillBenchmarkFixture } from '../lab/types.js';
import { mcpModule } from './index.js';

type McpFixture = { context: ServerContext; token: string; projectId: string; otherProjectId: string; userId: string; database: DatabaseConnection };

function contextWithToken(): McpFixture {
  const database = openDatabase(':memory:', systemClock);
  const ids = secureIds;
  const teamId = ids.id();
  const userId = ids.id();
  const projectId = ids.id();
  const otherProjectId = ids.id();
  const now = systemClock.now().toISOString();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run(teamId, 'test', now);
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, 'mcp@example.invalid', 'MCP', 'not-a-password', now, now);
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, \'member\', ?)').run(teamId, userId, now);
  for (const id of [projectId, otherProjectId]) database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, teamId, id === projectId ? 'one' : 'two', userId, now, now);
  const context: ServerContext = { config: { environment: 'test', host: '127.0.0.1', port: 4173, databasePath: ':memory:', publicOrigin: new URL('http://127.0.0.1:4173'), allowedHosts: new Set(['127.0.0.1', 'localhost']), demo: false, masterKeys: new Map(), gatewayAllowedHosts: new Set(['127.0.0.1', 'localhost']) }, database, clock: systemClock, ids, events: new EventStore(database, systemClock, ids) };
  const token = issueToken(context, projectId, userId, ['project:read']);
  return { context, token, projectId, otherProjectId, userId, database };
}

function issueToken(context: ServerContext, projectId: string, userId: string, permissions: string[], runId?: string): string {
  const token = context.ids.token(32);
  const now = context.clock.now();
  context.database.prepare('INSERT INTO api_tokens(id, user_id, project_id, run_id, token_hash, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    context.ids.id(), userId, projectId, runId ?? null, hashToken(token), JSON.stringify({ projectId, ...(runId ? { runId } : {}), permissions }), now.toISOString(), new Date(now.getTime() + 60_000).toISOString(),
  );
  return token;
}

function insertRunPair(fixture: McpFixture): { runId: string; otherRunId: string } {
  const { context, projectId, userId, database } = fixture;
  const now = context.clock.now().toISOString();
  const firstSessionId = context.ids.id();
  const secondSessionId = context.ids.id();
  database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'idle\', ?, ?, ?)').run(firstSessionId, projectId, 'first', userId, now, now);
  database.prepare('INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'idle\', ?, ?, ?)').run(secondSessionId, projectId, 'second', userId, now, now);
  const runId = context.ids.id();
  const otherRunId = context.ids.id();
  database.prepare('INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'queued\', ?, ?, ?)').run(runId, firstSessionId, 'first objective', userId, now, now);
  database.prepare('INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES (?, ?, ?, \'queued\', ?, ?, ?)').run(otherRunId, secondSessionId, 'second objective', userId, now, now);
  return { runId, otherRunId };
}

async function request(app: DholeApp, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:4173', accept: 'application/json', 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', ...headers }, body: JSON.stringify(body) });
}

describe('MCP stateless Streamable HTTP boundary', () => {
  let app: DholeApp;
  let token: string;
  let projectId: string;
  let otherProjectId: string;
  let context: ServerContext;
  let database: DatabaseConnection;
  let userId: string;

  beforeEach(() => {
    const fixture = contextWithToken();
    app = new Hono();
    mcpModule.register(app, fixture.context);
    context = fixture.context;
    database = fixture.database;
    userId = fixture.userId;
    token = fixture.token;
    projectId = fixture.projectId;
    otherProjectId = fixture.otherProjectId;
  });

  it('rejects an unsupported protocol version', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'v', method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-03-26' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32001);
  });

  it('requires a valid hashed bearer token', async () => {
    const response = await request(app, 'not-the-token', { jsonrpc: '2.0', id: 'auth', method: 'tools/list' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('requires a valid origin', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'origin', method: 'tools/list' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('returns a deterministic tool list without a shell capability', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'list', method: 'tools/list' });
    expect(response.status).toBe(200);
    const tools = (await response.json()).result.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([...tools].map((tool) => tool.name).sort());
    expect(tools.some((tool) => tool.name.includes('shell'))).toBe(false);
  });

  it('invokes a bounded benchmark synchronously through the Lab service', async () => {
    const benchmark = createBenchmarkInvocationService(context).createBenchmark({ ...createSkillBenchmarkFixture(), projectId });
    const benchmarkToken = issueToken(context, projectId, userId, ['benchmarks:run']);
    const response = await request(app, benchmarkToken, {
      jsonrpc: '2.0',
      id: 'benchmark',
      method: 'tools/call',
      params: {
        name: 'benchmark_invoke',
        arguments: { benchmarkId: benchmark.id, baselineConfig: { apiToken: 'secret' }, candidateConfig: {}, seed: 'mcp-seed' },
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { structuredContent?: { run: { benchmarkId: string; state: string; seed: string }; definitions: { id: string }; ordering: { balanced: string[] } } }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.structuredContent).toMatchObject({
      run: { benchmarkId: benchmark.id, state: 'completed', seed: 'mcp-seed' },
      definitions: { id: benchmark.id },
      ordering: { balanced: expect.any(Array) },
    });
    const runId = body.result?.structuredContent?.run && (body.result.structuredContent.run as { id?: string }).id;
    expect(runId).toEqual(expect.any(String));
    expect(database.prepare('SELECT state FROM benchmark_runs WHERE id = ?').get(runId)).toEqual({ state: 'completed' });
    expect(database.prepare("SELECT event_kind, aggregate_id FROM event_log WHERE event_kind = 'benchmark.completed' AND aggregate_id = ?").get(runId)).toEqual({ event_kind: 'benchmark.completed', aggregate_id: runId });
    expect(JSON.stringify(body.result?.structuredContent?.run)).not.toContain('secret');
  });

  it('reports benchmark event failures and leaves the run failed', async () => {
    const benchmark = createBenchmarkInvocationService(context).createBenchmark({ ...createSkillBenchmarkFixture(), projectId });
    const benchmarkToken = issueToken(context, projectId, userId, ['benchmarks:run']);
    const append = vi.spyOn(context.events!, 'append').mockImplementation(() => { throw new Error('event store unavailable'); });
    let response: Response;
    try {
      response = await request(app, benchmarkToken, {
        jsonrpc: '2.0',
        id: 'benchmark-event-failure',
        method: 'tools/call',
        params: { name: 'benchmark_invoke', arguments: { benchmarkId: benchmark.id, baselineConfig: {}, candidateConfig: {} } },
      });
    } finally {
      append.mockRestore();
    }
    expect((await response.json()).error.code).toBe(-32000);
    const run = database.prepare('SELECT id, state FROM benchmark_runs ORDER BY created_at DESC LIMIT 1').get() as { id: string; state: string };
    expect(run.state).toBe('failed');
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_case_runs WHERE run_id = ?').get(run.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'benchmark.completed'").get()).toEqual({ count: 0 });
  });

  it('denies project IDOR even when the request argument names another project', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'idor', method: 'tools/call', params: { name: 'project_state', arguments: { projectId: otherProjectId } } });
    expect(response.status).toBe(200);
    expect((await response.json()).error.code).toBe(-32003);
    expect(projectId).not.toBe(otherProjectId);
  });

  it('denies a tool absent from the stored token scopes', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'scope', method: 'tools/call', params: { name: 'memory_read', arguments: {} } });
    expect((await response.json()).error.code).toBe(-32003);
  });

  it('registers a coordination session, creates a claim, and exposes it in project state', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const registerResponse = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'register', method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel: 'mcp-test', developerLabel: 'integration', worktreeHash: 'worktree-hash', capabilityHash: 'capability-hash', expiresInMs: 60_000 } } });
    expect(registerResponse.status).toBe(200);
    const registerBody = await registerResponse.json() as { result?: { structuredContent?: { id: string; projectId: string; agentLabel: string; expiresAt: string } }; error?: unknown };
    expect(registerBody.error).toBeUndefined();
    expect(registerBody.result?.structuredContent).toMatchObject({ projectId, agentLabel: 'mcp-test' });
    const coordinationSessionId = registerBody.result?.structuredContent?.id;
    expect(coordinationSessionId).toEqual(expect.any(String));
    const sessionRow = database.prepare('SELECT project_id, user_id, agent_label, developer_label, worktree_hash, capability_hash FROM coordination_sessions WHERE id = ?').get(coordinationSessionId) as { project_id: string; user_id: string; agent_label: string; developer_label: string; worktree_hash: string; capability_hash: string };
    expect(sessionRow).toMatchObject({ project_id: projectId, user_id: userId, agent_label: 'mcp-test', developer_label: 'integration', capability_hash: 'capability-hash' });
    expect(sessionRow.worktree_hash).toMatch(/^wt_[A-Za-z0-9_-]{43}$/u);

    const claimResponse = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId, intent: 'verify MCP claim', task: 'MCP integration', files: ['apps/server/src/modules/mcp/index.test.ts'], components: ['mcp'], summary: 'test claim' } } });
    expect(claimResponse.status).toBe(200);
    const claimBody = await claimResponse.json() as { result?: { structuredContent?: { id: string; projectId: string; coordinationSessionId: string; status: string; files: string[]; components: string[] } }; error?: unknown };
    expect(claimBody.error).toBeUndefined();
    expect(claimBody.result?.structuredContent).toMatchObject({ projectId, coordinationSessionId, status: 'investigating', files: ['apps/server/src/modules/mcp/index.test.ts'], components: ['mcp'] });
    const claimId = claimBody.result?.structuredContent?.id;
    expect(claimId).toEqual(expect.any(String));
    expect(database.prepare('SELECT project_id, coordination_session_id, intent, task, status, summary FROM coordination_claims WHERE id = ?').get(claimId)).toEqual({ project_id: projectId, coordination_session_id: coordinationSessionId, intent: 'verify MCP claim', task: 'MCP integration', status: 'investigating', summary: 'test claim' });

    const stateResponse = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'state', method: 'tools/call', params: { name: 'project_state', arguments: {} } });
    expect(stateResponse.status).toBe(200);
    const stateBody = await stateResponse.json() as { result?: { structuredContent?: { project: { id: string }; claims: Array<{ id: string; intent: string; status: string }> } }; error?: unknown };
    expect(stateBody.error).toBeUndefined();
    expect(stateBody.result?.structuredContent).toMatchObject({ project: { id: projectId }, claims: [expect.objectContaining({ id: claimId, intent: 'verify MCP claim', status: 'investigating' })] });
  });

  it('rejects traversal and absolute paths at the MCP boundary', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const check = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'check-traversal', method: 'tools/call', params: { name: 'coordination_check', arguments: { files: ['../secret'] } } });
    expect((await check.json()).error.code).toBe(-32602);
    const claim = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-absolute', method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'unsafe path', files: ['/etc/passwd'] } } });
    expect((await claim.json()).error.code).toBe(-32602);
    expect(database.prepare('SELECT count(*) AS count FROM coordination_claims').get()).toEqual({ count: 0 });
  });

  it('rejects credential-bearing memory proposal content before persistence', async () => {
    const memoryToken = issueToken(context, projectId, userId, ['memory:propose']);
    const packId = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, \'mcp-memory\', \'MCP memory\', \'project\', ?)').run(packId, projectId, now);
    const values = [
      { title: 'api_key=memory-secret', body: 'safe', sourceType: 'decision', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'Authorization: Bearer memory-secret', sourceType: 'decision', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'safe', sourceType: 'password=hunter2', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'safe', sourceType: 'decision', sourceReference: 'https://user:pass@example.test/adr/1' },
    ] as const;
    for (const value of values) {
      const response = await request(app, memoryToken, { jsonrpc: '2.0', id: 'memory-secret', method: 'tools/call', params: { name: 'memory_propose', arguments: { packId, ...value } } });
      expect((await response.json()).error.code).toBe(-32602);
    }
    expect(database.prepare('SELECT count(*) AS count FROM memory_proposals WHERE pack_id = ?').get(packId)).toEqual({ count: 0 });
  });

  it('records secret-free memory proposal audit evidence atomically', async () => {
    const memoryToken = issueToken(context, projectId, userId, ['memory:propose']);
    const packId = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, \'mcp-memory-audit\', \'MCP memory audit\', \'project\', ?)').run(packId, projectId, now);
    const response = await request(app, memoryToken, { jsonrpc: '2.0', id: 'memory-audit', method: 'tools/call', params: { name: 'memory_propose', arguments: { packId, title: 'Use SQLite', body: 'Keep durable decisions local', sourceType: 'decision', sourceReference: 'adr/1', baseGenerationId: undefined } } });
    const body = await response.json() as { result?: { structuredContent?: { proposalId: string; packId: string; state: string } }; error?: unknown };
    expect(body.error).toBeUndefined();
    const result = body.result?.structuredContent;
    expect(result).toMatchObject({ packId, state: 'pending', proposalId: expect.any(String) });
    const audit = database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE action = 'memory.propose' AND target_id = ?").get(result?.proposalId) as { actor_type: string; actor_id: string; action: string; target_type: string; target_id: string; outcome: string; detail_json: string };
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: userId, action: 'memory.propose', target_type: 'memory_proposal', target_id: result?.proposalId, outcome: 'allowed' });
    expect(JSON.parse(audit.detail_json)).toEqual({ packId, baseGenerationId: null, sourceType: 'decision' });
    expect(audit.detail_json).not.toContain('Keep durable decisions local');
    expect(database.prepare("SELECT aggregate_type, aggregate_id, payload_json FROM event_log WHERE event_kind = 'memory.proposed' AND aggregate_id = ?").get(packId)).toMatchObject({ aggregate_type: 'memory_pack', aggregate_id: packId });
  });

  it('rolls back a memory proposal and event when its audit insert fails', async () => {
    const memoryToken = issueToken(context, projectId, userId, ['memory:propose']);
    const packId = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, \'mcp-memory-rollback\', \'MCP memory rollback\', \'project\', ?)').run(packId, projectId, now);
    database.exec(`CREATE TRIGGER fail_mcp_memory_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'memory.propose' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const response = await request(app, memoryToken, { jsonrpc: '2.0', id: 'memory-rollback', method: 'tools/call', params: { name: 'memory_propose', arguments: { packId, title: 'Rollback', body: 'Must not persist', sourceType: 'decision', sourceReference: 'adr/rollback' } } });
    expect((await response.json()).error.code).toBe(-32000);
    expect(database.prepare('SELECT count(*) AS count FROM memory_proposals WHERE pack_id = ?').get(packId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'memory.proposed' AND aggregate_id = ?").get(packId)).toEqual({ count: 0 });
  });

  it('rolls back a claim when its durable event cannot be appended', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const registerResponse = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'register-before-failure', method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel: 'mcp-test' } } });
    const registerBody = await registerResponse.json() as { result: { structuredContent: { id: string } } };
    const coordinationSessionId = registerBody.result.structuredContent.id;
    const events = context.events as unknown as { append: (...args: unknown[]) => unknown };
    const append = events.append;
    events.append = () => { throw new Error('event store unavailable'); };
    let response: Response;
    try {
      response = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-event-failure', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId, intent: 'must roll back', files: ['rollback.ts'] } } });
    } finally {
      events.append = append;
    }
    expect((await response.json()).error.code).toBe(-32000);
    expect(database.prepare('SELECT count(*) AS count FROM coordination_claims').get()).toEqual({ count: 0 });
  });

  it('records an overlap conflict for claims from different sessions', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const register = async (id: string, agentLabel: string): Promise<string> => {
      const response = await request(app, coordinationToken, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel } } });
      const body = await response.json() as { result: { structuredContent: { id: string } } };
      return body.result.structuredContent.id;
    };
    const firstSessionId = await register('register-overlap-a', 'overlap-a');
    const first = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-overlap-a', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: firstSessionId, intent: 'first claim', files: ['shared.ts'] } } });
    const firstBody = await first.json() as { result: { structuredContent: { id: string } } };
    const firstClaimId = firstBody.result.structuredContent.id;
    const secondSessionId = await register('register-overlap-b', 'overlap-b');
    const second = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-overlap-b', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: secondSessionId, intent: 'second claim', files: ['shared.ts'] } } });
    const secondBody = await second.json() as {
      result: { structuredContent: { id: string; conflicts: Array<{ claimId: string; severity: string; reasons: Array<{ type: string }> }> } };
    };
    expect(secondBody.result.structuredContent.conflicts).toEqual([expect.objectContaining({ claimId: firstClaimId, severity: 'blocking', reasons: [expect.objectContaining({ type: 'files' })] })]);
    expect(database.prepare('SELECT claim_id, conflicting_claim_id, severity FROM coordination_conflicts WHERE project_id = ?').get(projectId)).toEqual({ claim_id: secondBody.result.structuredContent.id, conflicting_claim_id: firstClaimId, severity: 'blocking' });
  });

  it('resolves MCP conflict rows when a terminal claim update settles the claim', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const register = async (id: string, agentLabel: string): Promise<string> => {
      const response = await request(app, coordinationToken, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel } } });
      const body = await response.json() as { result: { structuredContent: { id: string } } };
      return body.result.structuredContent.id;
    };
    const firstSessionId = await register('register-settle-a', 'settle-a');
    const first = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-settle-a', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: firstSessionId, intent: 'first claim', files: ['settle.ts'] } } });
    const firstBody = await first.json() as { result: { structuredContent: { id: string } } };
    const firstClaimId = firstBody.result.structuredContent.id;
    const secondSessionId = await register('register-settle-b', 'settle-b');
    await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-settle-b', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: secondSessionId, intent: 'second claim', files: ['settle.ts'] } } });
    const conflict = database.prepare('SELECT resolved_at FROM coordination_conflicts WHERE project_id = ? AND conflicting_claim_id = ?').get(projectId, firstClaimId) as { resolved_at: string | null } | undefined;
    expect(conflict?.resolved_at).toBeNull();
    const settle = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-settle-terminal', method: 'tools/call', params: { name: 'coordination_claim', arguments: { claimId: firstClaimId, status: 'done', summary: 'settled' } } });
    expect((await settle.json()).error).toBeUndefined();
    const resolved = database.prepare('SELECT resolved_at FROM coordination_conflicts WHERE project_id = ? AND conflicting_claim_id = ?').get(projectId, firstClaimId) as { resolved_at: string | null } | undefined;
    expect(resolved?.resolved_at).toEqual(expect.any(String));
  });

  it('rejects credential-bearing skill markdown before persistence', async () => {
    const skillsToken = issueToken(context, projectId, userId, ['skills:propose']);
    const unsafe = await request(app, skillsToken, { jsonrpc: '2.0', id: 'skill-unsafe', method: 'tools/call', params: { name: 'skill_propose', arguments: { stableKey: 'unsafe-mcp-skill', skillMarkdown: '---\nname: unsafe\n---\napi_key=super-secret-value' } } });
    expect((await unsafe.json()).error.code).toBe(-32602);
    expect(database.prepare("SELECT count(*) AS count FROM skills WHERE project_id = ? AND stable_key = 'unsafe-mcp-skill'").get(projectId)).toEqual({ count: 0 });
  });

  it('stores skill markdown byte-identically, hashes it, and writes audit evidence atomically', async () => {
    const skillsToken = issueToken(context, projectId, userId, ['skills:propose']);
    const markdown = '---\nname: mcp-audited\ndescription: fixture\n---\nUse the supplied context exactly.\n';
    const manifest = { description: 'fixture', allowedTools: ['Read'] };
    const response = await request(app, skillsToken, { jsonrpc: '2.0', id: 'skill-audit', method: 'tools/call', params: { name: 'skill_propose', arguments: { stableKey: 'mcp-audited', skillMarkdown: markdown, manifest } } });
    const body = await response.json() as { result?: { structuredContent?: { skillId: string; versionId: string; version: number; contentHash: string } }; error?: unknown };
    expect(body.error).toBeUndefined();
    const result = body.result?.structuredContent;
    expect(result).toMatchObject({ version: 1, contentHash: createHash('sha256').update(markdown).update(JSON.stringify(manifest)).digest('hex') });
    const stored = database.prepare('SELECT skill_id, version, skill_markdown, manifest_json, content_hash, proposed_by_user_id FROM skill_versions WHERE id = ?').get(result?.versionId) as { skill_id: string; version: number; skill_markdown: string; manifest_json: string; content_hash: string; proposed_by_user_id: string };
    expect(stored).toMatchObject({ version: 1, skill_markdown: markdown, manifest_json: JSON.stringify(manifest), content_hash: result?.contentHash, proposed_by_user_id: userId });
    const audit = database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE action = 'skill.propose' AND target_id = ?").get(result?.versionId) as { actor_type: string; actor_id: string; action: string; target_type: string; target_id: string; outcome: string; detail_json: string };
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: userId, action: 'skill.propose', target_type: 'skill_version', target_id: result?.versionId, outcome: 'allowed' });
    expect(JSON.parse(audit.detail_json)).toMatchObject({ skillId: result?.skillId, stableKey: 'mcp-audited', version: 1, contentHash: result?.contentHash });
  });

  it('rolls back a skill and version when its immutable audit insert fails', async () => {
    const skillsToken = issueToken(context, projectId, userId, ['skills:propose']);
    database.exec(`CREATE TRIGGER fail_mcp_skill_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'skill.propose' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const markdown = '---\nname: mcp-rollback\ndescription: fixture\n---\nrollback';
    const response = await request(app, skillsToken, { jsonrpc: '2.0', id: 'skill-rollback', method: 'tools/call', params: { name: 'skill_propose', arguments: { stableKey: 'mcp-rollback', skillMarkdown: markdown } } });
    expect((await response.json()).error.code).toBe(-32000);
    expect(database.prepare("SELECT count(*) AS count FROM skills WHERE project_id = ? AND stable_key = 'mcp-rollback'").get(projectId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM skill_versions WHERE skill_markdown = ?").get(markdown)).toEqual({ count: 0 });
  });

  it('canonicalizes worktree identity and suppresses same-worktree overlap warnings', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const register = async (id: string, agentLabel: string): Promise<string> => {
      const response = await request(app, coordinationToken, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel, worktreeHash: 'repo/checkout' } } });
      const body = await response.json() as { result: { structuredContent: { id: string } } };
      return body.result.structuredContent.id;
    };
    const firstSessionId = await register('register-worktree-a', 'worktree-a');
    const secondSessionId = await register('register-worktree-b', 'worktree-b');
    const first = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-worktree-a', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: firstSessionId, intent: 'first worktree claim', files: ['shared.ts'] } } });
    const firstBody = await first.json() as { result: { structuredContent: { id: string } } };
    const second = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-worktree-b', method: 'tools/call', params: { name: 'coordination_claim', arguments: { coordinationSessionId: secondSessionId, intent: 'second worktree claim', files: ['shared.ts'] } } });
    const secondBody = await second.json() as { result: { structuredContent: { id: string; conflicts: unknown[] } } };
    expect(secondBody.result.structuredContent.conflicts).toEqual([]);
    const sessionRow = database.prepare('SELECT worktree_hash FROM coordination_sessions WHERE id = ?').get(firstSessionId) as { worktree_hash: string };
    expect(sessionRow.worktree_hash).toMatch(/^wt_[A-Za-z0-9_-]{43}$/u);
    expect(sessionRow.worktree_hash).not.toBe('repo/checkout');
    expect(database.prepare('SELECT worktree_hash FROM coordination_claims WHERE id = ?').get(firstBody.result.structuredContent.id)).toEqual(sessionRow);
    expect(database.prepare('SELECT worktree_hash FROM coordination_claims WHERE id = ?').get(secondBody.result.structuredContent.id)).toEqual(sessionRow);
  });

  it('caps total claims per project and per run', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const { runId } = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const coordinationSessionId = context.ids.id();
    database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'claim-cap\', \'capability\', ?, ?, ?)').run(coordinationSessionId, projectId, userId, now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    const insert = database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, intent, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'existing\', \'investigating\', ?, ?)');
    database.transaction(() => { for (let index = 0; index < 100; index += 1) insert.run(context.ids.id(), projectId, coordinationSessionId, runId, now, now); })();
    const runToken = issueToken(context, projectId, userId, ['coordination:write'], runId);
    const runResponse = await request(app, runToken, { jsonrpc: '2.0', id: 'run-claim-cap', method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'run cap' } } });
    expect((await runResponse.json()).error.code).toBe(-32602);

    database.transaction(() => { for (let index = 100; index < 1_000; index += 1) insert.run(context.ids.id(), projectId, coordinationSessionId, null, now, now); })();
    const projectToken = issueToken(context, projectId, userId, ['coordination:write']);
    const projectResponse = await request(app, projectToken, { jsonrpc: '2.0', id: 'project-claim-cap', method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'project cap' } } });
    expect((await projectResponse.json()).error.code).toBe(-32602);
  });

  it('limits a run-scoped token to its run and denies another run', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const runs = insertRunPair(fixture);
    const runToken = issueToken(context, projectId, userId, ['project:read'], runs.runId);
    const ownResponse = await request(app, runToken, { jsonrpc: '2.0', id: 'own-run', method: 'tools/call', params: { name: 'project_state', arguments: {} } });
    expect(ownResponse.status).toBe(200);
    const ownBody = await ownResponse.json() as { result?: { structuredContent?: { runs: Array<{ id: string }>; sessions: Array<{ id: string }> } }; error?: unknown };
    expect(ownBody.error).toBeUndefined();
    expect(ownBody.result?.structuredContent?.runs.map((run) => run.id)).toEqual([runs.runId]);
    expect(ownBody.result?.structuredContent?.sessions.map((session) => session.id)).toEqual(expect.arrayContaining([expect.any(String)]));

    const otherResponse = await request(app, runToken, { jsonrpc: '2.0', id: 'other-run', method: 'tools/call', params: { name: 'project_state', arguments: { runId: runs.otherRunId } } });
    expect(otherResponse.status).toBe(200);
    expect((await otherResponse.json()).error.code).toBe(-32003);
  });

  it('does not release a claim from another run through a run-scoped token', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const runs = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const coordinationSessionId = context.ids.id();
    const claimId = context.ids.id();
    database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'other-run\', \'capability\', ?, ?, ?)').run(coordinationSessionId, projectId, userId, now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, run_id, intent, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'other run claim\', \'investigating\', ?, ?)').run(claimId, projectId, coordinationSessionId, runs.otherRunId, now, now);
    const runToken = issueToken(context, projectId, userId, ['coordination:write'], runs.runId);
    const response = await request(app, runToken, { jsonrpc: '2.0', id: 'release-other-run', method: 'tools/call', params: { name: 'coordination_release', arguments: { claimId } } });
    expect((await response.json()).error.code).toBe(-32602);
    expect(database.prepare('SELECT status FROM coordination_claims WHERE id = ?').get(claimId)).toEqual({ status: 'investigating' });
  });

  it('does not cancel a terminal child activation', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const { runId } = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const childId = context.ids.id();
    const activationId = context.ids.id();
    database.prepare('INSERT INTO logical_agents(id, run_id, name, created_at) VALUES (?, ?, \'terminal child\', ?)').run(childId, runId, now);
    database.prepare('INSERT INTO agent_activations(id, logical_agent_id, ordinal, state, ended_at, last_activity_at) VALUES (?, ?, 1, \'settled\', ?, ?)').run(activationId, childId, now, now);
    const childToken = issueToken(context, projectId, userId, ['children:write'], runId);
    const response = await request(app, childToken, { jsonrpc: '2.0', id: 'cancel-terminal', method: 'tools/call', params: { name: 'child_cancel', arguments: { childId, activationId } } });
    expect((await response.json()).error.code).toBe(-32602);
    expect(database.prepare('SELECT state FROM agent_activations WHERE id = ?').get(activationId)).toEqual({ state: 'settled' });
  });

  it('collects only messages attributed to the requested child', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const { runId } = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const sessionId = (database.prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as { session_id: string }).session_id;
    const childId = context.ids.id();
    const siblingId = context.ids.id();
    database.prepare('INSERT INTO logical_agents(id, run_id, name, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run(childId, runId, 'child', now, siblingId, runId, 'sibling', now);
    const insertMessage = database.prepare('INSERT INTO messages(id, session_id, run_id, sequence, role, logical_agent_id, body, status, created_at, completed_at) VALUES (?, ?, ?, ?, \'agent\', ?, ?, \'completed\', ?, ?)');
    insertMessage.run(context.ids.id(), sessionId, runId, 1, childId, 'child output', now, now);
    insertMessage.run(context.ids.id(), sessionId, runId, 2, siblingId, 'sibling secret output', now, now);
    const childToken = issueToken(context, projectId, userId, ['children:write'], runId);
    const response = await request(app, childToken, { jsonrpc: '2.0', id: 'collect-child', method: 'tools/call', params: { name: 'child_collect', arguments: { childId, limit: 10 } } });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { structuredContent?: { messages: Array<{ body: string }> } }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.structuredContent?.messages.map((message) => message.body)).toEqual(['child output']);
  });

  it('caps direct child creation by run count, parent fan-out, and lineage depth', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const { runId, otherRunId } = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const insertAgent = database.prepare('INSERT INTO logical_agents(id, run_id, name, created_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 100; index += 1) insertAgent.run(context.ids.id(), runId, `agent-${index}`, now);
    const childToken = issueToken(context, projectId, userId, ['children:write'], runId);
    const runCapResponse = await request(app, childToken, { jsonrpc: '2.0', id: 'agent-run-cap', method: 'tools/call', params: { name: 'child_create', arguments: { name: 'overflow' } } });
    expect((await runCapResponse.json()).error.code).toBe(-32602);

    const parentId = context.ids.id();
    insertAgent.run(parentId, otherRunId, 'parent', now);
    const insertEdge = database.prepare('INSERT INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, created_at) VALUES (?, ?, ?, ?, \'platform\', \'full\', ?)');
    for (let index = 0; index < 8; index += 1) {
      const childId = context.ids.id();
      insertAgent.run(childId, otherRunId, `fanout-${index}`, now);
      insertEdge.run(context.ids.id(), otherRunId, parentId, childId, now);
    }
    const otherToken = issueToken(context, projectId, userId, ['children:write'], otherRunId);
    const fanoutResponse = await request(app, otherToken, { jsonrpc: '2.0', id: 'agent-fanout-cap', method: 'tools/call', params: { name: 'child_create', arguments: { name: 'fanout-overflow', parentAgentId: parentId } } });
    expect((await fanoutResponse.json()).error.code).toBe(-32602);

    let ancestor = parentId;
    for (let index = 1; index < 4; index += 1) {
      const childId = context.ids.id();
      insertAgent.run(childId, otherRunId, `depth-${index}`, now);
      insertEdge.run(context.ids.id(), otherRunId, ancestor, childId, now);
      ancestor = childId;
    }
    const depthResponse = await request(app, otherToken, { jsonrpc: '2.0', id: 'agent-depth-cap', method: 'tools/call', params: { name: 'child_create', arguments: { name: 'depth-overflow', parentAgentId: ancestor } } });
    expect((await depthResponse.json()).error.code).toBe(-32602);
  });

  it('honors lower limits from a run orchestration profile and fails closed on malformed config', async () => {
    const fixture: McpFixture = { context, token, projectId, otherProjectId, userId, database };
    const { otherRunId } = insertRunPair(fixture);
    const now = context.clock.now().toISOString();
    const profileId = context.ids.id();
    const versionId = context.ids.id();
    const executionId = context.ids.id();
    database.prepare('INSERT INTO orchestration_profiles(id, project_id, stable_key, name, active_version, created_at) VALUES (?, ?, \'mcp-profile\', \'MCP profile\', 1, ?)').run(profileId, projectId, now);
    database.prepare('INSERT INTO orchestration_profile_versions(id, profile_id, version, config_json, content_hash, lifecycle, created_by, created_at) VALUES (?, ?, 1, ?, \'profile-hash\', \'active\', ?, ?)').run(versionId, profileId, JSON.stringify({ limits: { maxConcurrency: 128, maxDepth: 4, maxChildrenPerParent: 0, maxWorkItems: 100 } }), userId, now);
    database.prepare('INSERT INTO orchestration_executions(id, run_id, profile_version_id, state, max_concurrency, created_at, updated_at) VALUES (?, ?, ?, \'running\', 128, ?, ?)').run(executionId, otherRunId, versionId, now, now);
    const parentId = context.ids.id();
    database.prepare('INSERT INTO logical_agents(id, run_id, name, created_at) VALUES (?, ?, \'profile parent\', ?)').run(parentId, otherRunId, now);
    const childToken = issueToken(context, projectId, userId, ['children:write'], otherRunId);
    const childLimit = await request(app, childToken, { jsonrpc: '2.0', id: 'profile-child-limit', method: 'tools/call', params: { name: 'child_create', arguments: { parentAgentId: parentId, name: 'blocked by profile' } } });
    expect((await childLimit.json()).error.code).toBe(-32602);
    expect(database.prepare('SELECT count(*) AS count FROM logical_agents WHERE run_id = ?').get(otherRunId)).toEqual({ count: 1 });

    database.prepare('UPDATE orchestration_profile_versions SET config_json = ? WHERE id = ?').run(JSON.stringify({ limits: { maxConcurrency: 128, maxDepth: 1, maxChildrenPerParent: 8, maxWorkItems: 100 } }), versionId);
    const depthLimit = await request(app, childToken, { jsonrpc: '2.0', id: 'profile-depth-limit', method: 'tools/call', params: { name: 'child_create', arguments: { parentAgentId: parentId, name: 'blocked by depth' } } });
    expect((await depthLimit.json()).error.code).toBe(-32602);

    database.prepare('INSERT INTO agent_activations(id, logical_agent_id, ordinal, state, last_activity_at) VALUES (?, ?, 1, \'queued\', ?)').run(context.ids.id(), parentId, now);
    database.prepare('UPDATE orchestration_profile_versions SET config_json = ? WHERE id = ?').run(JSON.stringify({ limits: { maxConcurrency: 1, maxDepth: 4, maxChildrenPerParent: 8, maxWorkItems: 100 } }), versionId);
    const concurrencyLimit = await request(app, childToken, { jsonrpc: '2.0', id: 'profile-concurrency-limit', method: 'tools/call', params: { name: 'child_create', arguments: { parentAgentId: parentId, name: 'blocked by concurrency' } } });
    expect((await concurrencyLimit.json()).error.code).toBe(-32602);

    database.prepare('UPDATE orchestration_profile_versions SET config_json = ? WHERE id = ?').run('{invalid-json', versionId);
    const malformed = await request(app, childToken, { jsonrpc: '2.0', id: 'profile-invalid', method: 'tools/call', params: { name: 'child_create', arguments: { name: 'blocked by invalid profile' } } });
    expect((await malformed.json()).error.code).toBe(-32602);
  });

  it('rejects a token after its user is disabled', async () => {
    database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(context.clock.now().toISOString(), userId);
    const response = await request(app, token, { jsonrpc: '2.0', id: 'disabled', method: 'tools/list' });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe(-32002);
  });

  it('rejects a token after its user leaves the project team', async () => {
    database.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
    const response = await request(app, token, { jsonrpc: '2.0', id: 'removed-member', method: 'tools/list' });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe(-32002);
  });

  it('rejects bodies larger than 512 KiB', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'large', method: 'tools/list', params: { padding: 'x'.repeat(513 * 1024) } });
    expect(response.status).toBe(413);
  });

  it('cancels a chunked request stream after crossing the body limit', async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:4173', accept: 'application/json', 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it('keeps complete tool responses below the output limit with structured content', async () => {
    const now = context.clock.now().toISOString();
    const coordinationSessionId = context.ids.id();
    database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'bounded\', \'capability\', ?, ?, ?)').run(coordinationSessionId, projectId, userId, now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    const insert = database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, intent, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'investigating\', ?, ?)');
    database.transaction(() => { for (let index = 0; index < 320; index += 1) insert.run(context.ids.id(), projectId, coordinationSessionId, 'x'.repeat(500), now, now); })();
    const response = await request(app, token, { jsonrpc: '2.0', id: 'bounded-result', method: 'tools/call', params: { name: 'coordination_check', arguments: {} } });
    const bytes = await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(bytes.byteLength).toBeLessThan(512 * 1024);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { result?: { content?: Array<{ text: string }>; structuredContent?: { claims: unknown[] } }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.text.length).toBeGreaterThan(200_000);
    expect(body.result?.structuredContent?.claims).toHaveLength(320);
  });

  it('fails closed before emitting an oversized escaped JSON-RPC response', async () => {
    const now = context.clock.now().toISOString();
    const coordinationSessionId = context.ids.id();
    const adversarialIntent = ['\\', '"', '\u0001', '\n', '\t'].join('').repeat(50);
    database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'escaped\', \'capability\', ?, ?, ?)').run(coordinationSessionId, projectId, userId, now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    const insert = database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, intent, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'investigating\', ?, ?)');
    database.transaction(() => { for (let index = 0; index < 260; index += 1) insert.run(context.ids.id(), projectId, coordinationSessionId, adversarialIntent, now, now); })();
    const response = await request(app, token, { jsonrpc: '2.0', id: 'escaped-bound', method: 'tools/call', params: { name: 'coordination_check', arguments: {} } });
    const bytes = await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(bytes.byteLength).toBeLessThan(512 * 1024);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ error: { code: -32004 } });
  });

  it('returns an explicit error for an oversized serialized tool result', async () => {
    const now = context.clock.now().toISOString();
    const coordinationSessionId = context.ids.id();
    database.prepare('INSERT INTO coordination_sessions(id, project_id, user_id, agent_label, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, \'oversized\', \'capability\', ?, ?, ?)').run(coordinationSessionId, projectId, userId, now, now, new Date(context.clock.now().getTime() + 60_000).toISOString());
    const insert = database.prepare('INSERT INTO coordination_claims(id, project_id, coordination_session_id, intent, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'investigating\', ?, ?)');
    database.transaction(() => { for (let index = 0; index < 1_000; index += 1) insert.run(context.ids.id(), projectId, coordinationSessionId, 'x'.repeat(2_000), now, now); })();
    const response = await request(app, token, { jsonrpc: '2.0', id: 'oversized-result', method: 'tools/call', params: { name: 'coordination_check', arguments: {} } });
    expect(response.status).toBe(200);
    expect((await response.json()).error.code).toBe(-32004);
  });

  it('keeps the legacy initialize path available without a version header', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2026-07-28' } }, { 'MCP-Protocol-Version': '' });
    expect(response.status).toBe(200);
    expect((await response.json()).result.protocolVersion).toBe('2026-07-28');
  });
});
