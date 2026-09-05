import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { hashToken } from '../../lib/security.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { mcpModule } from './index.js';
import { createCoordinationService } from '../coordination/service.js';
import { registerCoordinationRoutes } from '../coordination/routes.js';
import { coreModule } from '../core/index.js';

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

async function registerSession(app: DholeApp, token: string, args: Record<string, unknown> = {}): Promise<{ id: string; capability: string }> {
  const response = await request(app, token, { jsonrpc: '2.0', id: 'register', method: 'tools/call', params: { name: 'coordination_session_register', arguments: { agentLabel: 'mcp-test', ...args } } });
  const body = await response.json();
  expect(body.error).toBeUndefined();
  return body.result.structuredContent;
}

async function coordinationCall(app: DholeApp, token: string, name: string, args: Record<string, unknown>, capability?: string) {
  const response = await request(app, token, { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }, capability ? { 'x-mediation-session': capability } : {});
  return response.json();
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

  it('omits retired tools and keeps Core sessions available independently of optional modules', async () => {
    context.enabledModules = new Set(['core', 'access', 'coordination', 'mcp']);
    const broadToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write', 'children:write', 'memory:read', 'memory:propose', 'skills:read', 'skills:propose', 'benchmarks:run']);
    insertRunPair({ context, token, projectId, otherProjectId, userId, database });
    const prepare = vi.spyOn(database, 'prepare');
    const listed = await request(app, broadToken, { jsonrpc: '2.0', id: 'modules', method: 'tools/list' });
    const names = (await listed.json()).result.tools.map((tool: { name: string }) => tool.name) as string[];
    expect(names).toContain('coordination_complete');
    const disabled = ['benchmark_invoke', 'child_create', 'child_status', 'child_message', 'child_cancel', 'child_wait', 'child_collect', 'memory_read', 'memory_propose', 'skill_read', 'skill_propose'];
    for (const name of disabled) {
      expect(names).not.toContain(name);
      expect((await coordinationCall(app, broadToken, name, {})).error.code).toBe(-32601);
    }
    const state = await coordinationCall(app, broadToken, 'project_state', {});
    expect(state.result.structuredContent.runs).toHaveLength(2);
    expect(state.result.structuredContent.sessions).toHaveLength(2);
    expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/FROM (?:memory_|skills|skill_|benchmarks|benchmark_|orchestration_|logical_agents)/u);
    prepare.mockRestore();
    context.enabledModules = new Set(['core', 'access', 'mcp']);
    expect((await coordinationCall(app, broadToken, 'coordination_state', {})).error.code).toBe(-32601);
    const legacy = await request(app, broadToken, { jsonrpc: '2.0', id: 'disabled-legacy', method: 'mediation_state' });
    expect((await legacy.json()).error.code).toBe(-32601);
  });

  it('rejects derived tokens after their device authorization is revoked or expires', async () => {
    const team = database.prepare('SELECT team_id FROM projects WHERE id = ?').get(projectId) as { team_id: string };
    const deviceId = context.ids.id();
    const now = context.clock.now().toISOString();
    database.prepare('INSERT INTO user_device_tokens(id, user_id, team_id, machine_name, token_hash, permissions_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(deviceId, userId, team.team_id, 'fixture device', hashToken('local-device-fixture'), '["project:read"]', now, '2099-01-01T00:00:00.000Z');
    database.prepare('UPDATE api_tokens SET device_token_id = ? WHERE token_hash = ?').run(deviceId, hashToken(token));
    expect((await request(app, token, { jsonrpc: '2.0', id: 'active-device', method: 'tools/list' })).status).toBe(200);
    database.prepare('UPDATE user_device_tokens SET revoked_at = ? WHERE id = ?').run(now, deviceId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'revoked-device', method: 'tools/list' })).status).toBe(401);
    database.prepare('UPDATE user_device_tokens SET revoked_at = NULL, expires_at = ? WHERE id = ?').run(now, deviceId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'expired-device', method: 'tools/list' })).status).toBe(401);
  });

  it('authenticates native users independently of their optional GitHub link', async () => {
    const now = context.clock.now().toISOString();
    expect((await request(app, token, { jsonrpc: '2.0', id: 'native-identity', method: 'tools/list' })).status).toBe(200);
    database.prepare("INSERT INTO github_identities(user_id, github_user_id, login, status, created_at, updated_at) VALUES (?, 123, 'fixture', 'pending', ?, ?)").run(userId, now, now);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'pending-link', method: 'tools/list' })).status).toBe(200);
    database.prepare("UPDATE github_identities SET status = 'active' WHERE user_id = ?").run(userId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'active-link', method: 'tools/list' })).status).toBe(200);
    database.prepare("UPDATE github_identities SET status = 'disabled' WHERE user_id = ?").run(userId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'disabled-link', method: 'tools/list' })).status).toBe(200);
    database.prepare('DELETE FROM github_identities WHERE user_id = ?').run(userId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'unlinked-identity', method: 'tools/list' })).status).toBe(200);
    database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now, userId);
    expect((await request(app, token, { jsonrpc: '2.0', id: 'disabled-native-user', method: 'tools/list' })).status).toBe(401);
  });

  it('rechecks project access and removes stale write scopes when an editor becomes a viewer', async () => {
    const now = context.clock.now().toISOString();
    const team = database.prepare('SELECT team_id FROM projects WHERE id = ?').get(projectId) as { team_id: string };
    const ownerId = context.ids.id();
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ownerId, 'owner@example.invalid', 'Owner', 'not-a-password', now, now);
    database.prepare("INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(team.team_id, ownerId, now);
    database.prepare("UPDATE projects SET created_by = ?, visibility = 'private' WHERE id = ?").run(ownerId, projectId);
    database.prepare("INSERT INTO project_members(project_id, user_id, role, created_by, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?, ?)")
      .run(projectId, userId, ownerId, now, now);
    const writeToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write', 'children:write', 'memory:read', 'memory:propose', 'skills:read', 'skills:propose', 'benchmarks:run']);
    const session = await registerSession(app, writeToken);
    const claimed = await coordinationCall(app, writeToken, 'coordination_claim', { coordinationSessionId: session.id, intent: 'editor work' }, session.capability);
    expect(claimed.error).toBeUndefined();
    database.prepare("UPDATE project_members SET role = 'viewer' WHERE project_id = ? AND user_id = ?").run(projectId, userId);
    const listed = await request(app, writeToken, { jsonrpc: '2.0', id: 'viewer-catalog', method: 'tools/list' });
    const names = (await listed.json()).result.tools.map((tool: { name: string }) => tool.name) as string[];
    expect(names).toContain('coordination_state');
    for (const name of ['coordination_claim', 'coordination_complete', 'coordination_release', 'coordination_session_heartbeat']) {
      expect(names).not.toContain(name);
      expect((await coordinationCall(app, writeToken, name, {}, session.capability)).error.code).toBe(-32003);
    }
    const legacy = await request(app, writeToken, { jsonrpc: '2.0', id: 'viewer-legacy', method: 'mediation_claim', params: { claimId: claimed.result.structuredContent.id, status: 'released' } }, { 'x-mediation-session': session.capability });
    expect((await legacy.json()).error.code).toBe(-32003);
    expect((await coordinationCall(app, writeToken, 'coordination_state', {})).error).toBeUndefined();
    expect(database.prepare('SELECT status FROM coordination_claims WHERE id = ?').get(claimed.result.structuredContent.id)).toEqual({ status: 'investigating' });
    database.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    expect((await request(app, writeToken, { jsonrpc: '2.0', id: 'removed-project-access', method: 'tools/list' })).status).toBe(401);
    expect((await request(app, writeToken, { jsonrpc: '2.0', id: 'removed-project-read', method: 'tools/call', params: { name: 'project_state', arguments: {} } })).status).toBe(401);
  });

  it('denies project IDOR even when the request argument names another project', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'idor', method: 'tools/call', params: { name: 'project_state', arguments: { projectId: otherProjectId } } });
    expect(response.status).toBe(200);
    expect((await response.json()).error.code).toBe(-32003);
    expect(projectId).not.toBe(otherProjectId);
  });

  it('denies a tool absent from the stored token scopes', async () => {
    const response = await request(app, token, { jsonrpc: '2.0', id: 'scope', method: 'tools/call', params: { name: 'coordination_claim', arguments: {} } });
    expect((await response.json()).error.code).toBe(-32003);
  });

  it('registers authenticated sessions and shares claim scope, findings and completion behavior with HTTP', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const session = await registerSession(app, coordinationToken, { developerLabel: 'untrusted label', worktree: 'checkout-a' });
    const sessionRow = database.prepare('SELECT user_id, developer_label, worktree_hash, capability_hash FROM coordination_sessions WHERE id = ?').get(session.id) as Record<string, string>;
    expect(sessionRow).toMatchObject({ user_id: userId, developer_label: 'MCP', capability_hash: hashToken(session.capability) });
    expect(sessionRow.worktree_hash).toMatch(/^wt_[A-Za-z0-9_-]{43}$/u);
    const created = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: session.id, intent: 'initial work', files: ['before.ts'] }, session.capability);
    expect(created.error).toBeUndefined();
    const claimId = created.result.structuredContent.id as string;

    const service = createCoordinationService(database, context.clock, context.ids, { events: context.events });
    const peer = service.startSession(projectId, { agent: 'http-peer', userId, developer: 'MCP', worktree: 'checkout-b' });
    const blocker = service.createClaim(projectId, { sessionId: peer.id, capability: peer.capability!, userId, intent: 'peer work', files: ['after.ts'] }).claim;
    const http: DholeApp = new Hono();
    coreModule.register(http, context);
    http.use('*', async (c, next) => {
      const team = database.prepare('SELECT team_id FROM projects WHERE id = ?').get(projectId) as { team_id: string };
      c.set('user', { id: userId, email: 'mcp@example.invalid', displayName: 'MCP', role: 'member', teamId: team.team_id });
      await next();
    });
    registerCoordinationRoutes(http, service);
    const httpCheck = await http.request(`/api/projects/${projectId}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: 'scope check', files: ['after.ts'] }) });
    const mcpCheck = await coordinationCall(app, coordinationToken, 'coordination_check', { intent: 'scope check', files: ['after.ts'] });
    expect(mcpCheck.result.structuredContent.conflicts).toEqual((await httpCheck.json()).conflicts);

    const updated = await coordinationCall(app, coordinationToken, 'coordination_claim', {
      claimId, intent: 'updated work', files: ['after.ts'], components: ['MCP'], status: 'blocked', blockedOn: blocker.id,
      finding: 'api_key=fixture-secret-value caused the failure', findingKind: 'root-cause', findingFiles: ['after.ts'], branch: 'fix/mcp', baseRevision: 'abc123',
    }, session.capability);
    expect(updated.result.structuredContent).toMatchObject({ blockedOn: blocker.id, status: 'blocked', scope: { intent: 'updated work', files: ['after.ts'], components: ['mcp'] }, findings: [expect.objectContaining({ kind: 'root-cause' })] });
    expect(JSON.stringify(updated)).not.toContain('fixture-secret-value');
    const stateResponse = await http.request(`/api/projects/${projectId}/state`);
    const state = await stateResponse.json();
    expect(state.claims.find((claim: { id: string }) => claim.id === claimId)).toEqual(updated.result.structuredContent);

    const completed = await coordinationCall(app, coordinationToken, 'coordination_complete', { claimId, summary: 'fixed', commits: ['abc123'], prs: ['https://example.invalid/pr/1'] }, session.capability);
    expect(completed.result.structuredContent).toMatchObject({ status: 'done', commits: ['abc123'], prs: ['https://example.invalid/pr/1'], summary: 'fixed' });
    const repeated = await coordinationCall(app, coordinationToken, 'coordination_complete', { claimId, commits: ['def456'], prs: ['https://example.invalid/pr/2'] }, session.capability);
    expect(repeated.result.structuredContent).toMatchObject({ commits: ['abc123', 'def456'], prs: ['https://example.invalid/pr/1', 'https://example.invalid/pr/2'] });
    const snapshot = await coordinationCall(app, coordinationToken, 'coordination_state', {});
    expect(snapshot.result.structuredContent.completed).toContainEqual(repeated.result.structuredContent);
    const events = database.prepare('SELECT payload_json FROM event_log WHERE project_id = ?').all(projectId);
    expect(JSON.stringify([updated, completed, repeated, snapshot, events])).not.toContain(session.capability);
    expect(JSON.stringify(events)).not.toContain('fixture-secret-value');
  });

  it('requires transport capability, rejects capability arguments, and does not suppress another session overlap', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const session = await registerSession(app, coordinationToken);
    const peer = await registerSession(app, coordinationToken);
    const args = { coordinationSessionId: session.id, intent: 'owned work', files: ['owned.ts'] };
    expect((await coordinationCall(app, coordinationToken, 'coordination_claim', args)).error.code).toBe(-32003);
    expect((await coordinationCall(app, coordinationToken, 'coordination_claim', args, peer.capability)).error.code).toBe(-32003);
    expect((await coordinationCall(app, coordinationToken, 'coordination_claim', { ...args, capability: session.capability }, session.capability)).error.code).toBe(-32602);
    const created = await coordinationCall(app, coordinationToken, 'coordination_claim', args, session.capability);
    expect(created.error).toBeUndefined();
    const ignoredMode = await coordinationCall(app, coordinationToken, 'coordination_claim', { claimId: created.result.structuredContent.id, mode: 'enforced' }, session.capability);
    expect(ignoredMode.error.code).toBe(-32602);
    const spoofed = await coordinationCall(app, coordinationToken, 'coordination_check', { coordinationSessionId: session.id, files: ['owned.ts'] }, peer.capability);
    expect(spoofed.error.code).toBe(-32003);
  });

  it('renews repository reports, adopts unfinished work, and revives released work without changing old history', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const first = await registerSession(app, coordinationToken, { worktree: 'recoverable-checkout' });
    const heartbeat = await coordinationCall(app, coordinationToken, 'coordination_session_heartbeat', { coordinationSessionId: first.id, branch: 'topic', dirtyFiles: ['dirty.ts'] }, first.capability);
    expect(heartbeat.result.structuredContent).toMatchObject({ active: true });
    expect(heartbeat.result.structuredContent.capability).toBeUndefined();
    const report = await coordinationCall(app, coordinationToken, 'coordination_repo_report', { coordinationSessionId: first.id, branch: 'topic', revision: 'abc123', dirtyFiles: ['dirty.ts'] }, first.capability);
    expect(report.result.structuredContent).toMatchObject({ branch: 'topic', revision: 'abc123', dirtyFiles: ['dirty.ts'] });
    const created = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: first.id, intent: 'recover work', files: ['claimed.ts'] }, first.capability);
    const claimId = created.result.structuredContent.id;
    const check = await coordinationCall(app, coordinationToken, 'coordination_check', { files: ['dirty.ts'] });
    expect(check.result.structuredContent.conflicts).toEqual([expect.objectContaining({ claimId })]);
    expect((await coordinationCall(app, coordinationToken, 'coordination_session_end', { coordinationSessionId: first.id }, first.capability)).error).toBeUndefined();
    const second = await registerSession(app, coordinationToken, { worktree: 'recoverable-checkout' });
    const adopted = await coordinationCall(app, coordinationToken, 'coordination_claim', { claimId, status: 'testing' }, second.capability);
    expect(adopted.result.structuredContent).toMatchObject({ coordinationSessionId: second.id, status: 'testing' });
    const released = await coordinationCall(app, coordinationToken, 'coordination_release', { claimId }, second.capability);
    expect(released.result.structuredContent.status).toBe('released');
    const oldRow = database.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(claimId);
    const revived = await coordinationCall(app, coordinationToken, 'coordination_revive', { claimId, files: ['resumed.ts'], finding: 'resumed the work', findingKind: 'decision' }, second.capability);
    expect(revived.result.structuredContent.claim).toMatchObject({ recoveredFromClaimId: claimId, scope: { files: ['resumed.ts'] }, status: 'investigating' });
    expect(revived.result.structuredContent.claim.id).not.toBe(claimId);
    expect(database.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(claimId)).toEqual(oldRow);
    const repeated = await coordinationCall(app, coordinationToken, 'coordination_revive', { claimId }, second.capability);
    expect(repeated.result.structuredContent.claim.id).toBe(revived.result.structuredContent.claim.id);
  });

  it('keeps run-scoped lifecycle identities separate and denies all mutations outside that run', async () => {
    const runs = insertRunPair({ context, token, projectId, otherProjectId, userId, database });
    const projectToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const runToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write'], runs.runId);
    const session = await registerSession(app, projectToken);
    const outside = await coordinationCall(app, projectToken, 'coordination_claim', { coordinationSessionId: session.id, runId: runs.otherRunId, intent: 'other run' }, session.capability);
    const claimId = outside.result.structuredContent.id;
    for (const name of ['coordination_claim', 'coordination_complete', 'coordination_release', 'coordination_revive']) {
      expect((await coordinationCall(app, runToken, name, { claimId }, session.capability)).error.code).toBe(-32003);
    }
    for (const name of ['coordination_session_heartbeat', 'coordination_session_end', 'coordination_repo_report']) {
      expect((await coordinationCall(app, runToken, name, { coordinationSessionId: session.id }, session.capability)).error.code).toBe(-32003);
    }
    const native = { eventId: 'native-event', runId: 'native-run', agentId: 'native-agent', harness: 'fixture', state: 'active', occurredAt: context.clock.now().toISOString() };
    const event = await coordinationCall(app, runToken, 'coordination_agent_event', native);
    expect(event.error).toBeUndefined();
    const retry = await coordinationCall(app, runToken, 'coordination_agent_event', native);
    expect(retry.result.structuredContent.idempotent).toBe(true);
    const state = await coordinationCall(app, runToken, 'coordination_state', {});
    expect(state.result.structuredContent.claims).toEqual([]);
    expect(state.result.structuredContent.agents).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('native-agent');
    expect(JSON.stringify(state)).not.toContain('native-run');
  });

  it('rejects traversal and absolute paths at the MCP boundary', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const check = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'check-traversal', method: 'tools/call', params: { name: 'coordination_check', arguments: { files: ['../secret'] } } });
    expect((await check.json()).error.code).toBe(-32602);
    const claim = await request(app, coordinationToken, { jsonrpc: '2.0', id: 'claim-absolute', method: 'tools/call', params: { name: 'coordination_claim', arguments: { intent: 'unsafe path', files: ['/etc/passwd'] } } });
    expect((await claim.json()).error.code).toBe(-32602);
    expect(database.prepare('SELECT count(*) AS count FROM coordination_claims').get()).toEqual({ count: 0 });
  });

  it('rolls back a claim when its durable event cannot be appended', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const session = await registerSession(app, coordinationToken);
    const append = vi.spyOn(context.events, 'append').mockImplementation(() => { throw new Error('event store unavailable'); });
    let body;
    try {
      body = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: session.id, intent: 'must roll back', files: ['rollback.ts'] }, session.capability);
    } finally {
      append.mockRestore();
    }
    expect(body.error.code).toBe(-32000);
    expect(database.prepare('SELECT count(*) AS count FROM coordination_claims').get()).toEqual({ count: 0 });
  });

  it('records overlap and resolves it when completion settles the claim', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const first = await registerSession(app, coordinationToken);
    const second = await registerSession(app, coordinationToken);
    const a = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: first.id, intent: 'first claim', files: ['shared.ts'] }, first.capability);
    const claimId = a.result.structuredContent.id;
    const b = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: second.id, intent: 'second claim', files: ['shared.ts'] }, second.capability);
    expect(b.result.structuredContent.conflicts).toEqual([expect.objectContaining({ claimId, reasons: [expect.objectContaining({ type: 'files' })] })]);
    expect(database.prepare('SELECT severity, resolved_at FROM coordination_conflicts WHERE project_id = ?').get(projectId)).toEqual({ severity: 'blocking', resolved_at: null });
    const settled = await coordinationCall(app, coordinationToken, 'coordination_complete', { claimId, summary: 'settled' }, first.capability);
    expect(settled.error).toBeUndefined();
    expect(database.prepare('SELECT resolved_at FROM coordination_conflicts WHERE project_id = ?').get(projectId)).toEqual({ resolved_at: expect.any(String) });
  });

  it('canonicalizes worktree identity while retaining overlap warnings for distinct agents in that checkout', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const first = await registerSession(app, coordinationToken, { worktreeHash: 'repo/checkout' });
    const second = await registerSession(app, coordinationToken, { worktreeHash: 'repo/checkout' });
    const a = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: first.id, intent: 'first worktree claim', files: ['shared.ts'] }, first.capability);
    const b = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: second.id, intent: 'second worktree claim', files: ['shared.ts'] }, second.capability);
    expect(b.result.structuredContent.conflicts).toEqual([expect.objectContaining({ claimId: a.result.structuredContent.id })]);
    expect(a.result.structuredContent.scope.worktree).toMatch(/^wt_[A-Za-z0-9_-]{43}$/u);
    expect(b.result.structuredContent.scope.worktree).toBe(a.result.structuredContent.scope.worktree);
  });

  it('retains terminal history without exhausting a project lifetime claim quota', async () => {
    const coordinationToken = issueToken(context, projectId, userId, ['project:read', 'coordination:write']);
    const session = await registerSession(app, coordinationToken);
    const now = context.clock.now().toISOString();
    const insert = database.prepare("INSERT INTO coordination_claims(id, project_id, coordination_session_id, intent, status, created_at, updated_at, completed_at) VALUES (?, ?, ?, 'retained history', 'done', ?, ?, ?)");
    database.transaction(() => { for (let index = 0; index < 1_000; index += 1) insert.run(context.ids.id(), projectId, session.id, now, now, now); })();
    const created = await coordinationCall(app, coordinationToken, 'coordination_claim', { coordinationSessionId: session.id, intent: 'new work' }, session.capability);
    expect(created.error).toBeUndefined();
    expect(database.prepare('SELECT count(*) AS count FROM coordination_claims').get()).toEqual({ count: 1_001 });
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
    expect((await response.json()).error.code).toBe(-32003);
    expect(database.prepare('SELECT status FROM coordination_claims WHERE id = ?').get(claimId)).toEqual({ status: 'investigating' });
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
