import type { ServerContext } from '../lib/module.js';
import { catalogContentHash, parseCliProxyCatalog, type CatalogSource } from '../modules/gateway/catalog.js';
import { FAKE_CLIPROXY_FIXTURE, FAKE_CLIPROXY_JSONL, FAKE_RUNTIME_FIXTURE, FAKE_RUNTIME_SCENARIO } from './fixtures.js';

/** Demo credentials are intentionally public and must only be used locally. */
export const DEMO_ADMIN_EMAIL = 'admin@demo.dhole.local';
export const DEMO_ADMIN_PASSWORD = 'DholeDemoAdmin!2026';
export const DEMO_MEMBER_EMAIL = 'member@demo.dhole.local';
export const DEMO_MEMBER_PASSWORD = 'DholeDemoMember!2026';

/** Credentials suitable for copying into the demo README (never production). */
export const DEMO_CREDENTIALS = Object.freeze({
  administrator: Object.freeze({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD }),
  member: Object.freeze({ email: DEMO_MEMBER_EMAIL, password: DEMO_MEMBER_PASSWORD }),
});

/** Stable IDs make rerunning the seed safe and make screenshots reproducible. */
export const DEMO_IDS = Object.freeze({
  team: 'demo-team',
  admin: 'demo-user-admin',
  member: 'demo-user-member',
  project: 'demo-project',
  repository: 'demo-repository',
  machine: 'demo-machine',
  workspace: 'demo-workspace',
  providerOpenAI: 'demo-provider-openai',
  providerAnthropic: 'demo-provider-anthropic',
  providerKimi: 'demo-provider-kimi',
  modelOpenAI: 'demo-model-gpt-4o-mini',
  modelAnthropic: 'demo-model-claude-sonnet',
  modelKimi: 'demo-model-kimi-k2',
  runtimeFake: 'demo-runtime-fake',
  runtimeCodex: 'demo-runtime-codex',
  runtimeClaude: 'demo-runtime-claude',
  runtimeKimi: 'demo-runtime-kimi',
  session: 'demo-session',
  run: 'demo-run-root',
  turn: 'demo-turn-root',
  approval: 'demo-approval',
  agentRoot: 'demo-agent-root',
  agentControlled: 'demo-agent-controlled',
  agentObserved: 'demo-agent-observed',
  agentHeuristic: 'demo-agent-heuristic',
  activationRoot: 'demo-activation-root',
  activationControlled: 'demo-activation-controlled',
  activationObserved: 'demo-activation-observed',
  activationHeuristic: 'demo-activation-heuristic',
  coordinationSessionA: 'demo-coordination-a',
  coordinationSessionB: 'demo-coordination-b',
  claimA: 'demo-claim-a',
  claimB: 'demo-claim-b',
  conflict: 'demo-conflict',
  gateway: 'demo-gateway',
  gatewayAccountA: 'demo-gateway-account-a',
  gatewayAccountB: 'demo-gateway-account-b',

});

export interface DemoSeedCounts {
  teams: number;
  users: number;
  teamMembers: number;
  projects: number;
  repositories: number;
  machines: number;
  runtimes: number;
  providers: number;
  models: number;
  sessions: number;
  participants: number;
  runs: number;
  agents: number;
  activations: number;
  edges: number;
  approvals: number;
  coordinationClaims: number;
  conflicts: number;
  gatewayAccounts: number;
  gatewayRequests: number;
}

export interface DemoSeedResult {
  seeded: boolean;
  ids: typeof DEMO_IDS;
  counts: DemoSeedCounts;
}

const PASSWORD_HASHES = Object.freeze({
  // scrypt N=32768, r=8, p=3; salts are fixture-only and contain no secrets.
  admin: 'scrypt$32768$8$3$ZGVtby1hZG1pbi1zYWx0$Mxp8EoNKfvDKbXuPeVWGZ5kaZE7j5adhdmg9ZCsNeVQ',
  member: 'scrypt$32768$8$3$ZGVtby1tZW1iZXItc2FsdA$SOqto--FJEP0lsZNj02X1JtrkrL9RuqQ6XhXqjkF3pg',
});

const CAPABILITIES = Object.freeze({
  sessionCreation: true,
  sessionResume: true,
  nextTurnMessage: true,
  activeTurnSteering: true,
  cancellation: true,
  approvalResponses: true,
  historyReplay: true,
  structuredToolEvents: true,
  nativeSubagentObservation: true,
  imageInput: true,
  structuredOutput: true,
  repositoryEditing: true,
  terminalTools: true,
});

const iso = (context: ServerContext, offsetMs = 0): string => new Date(context.clock.now().getTime() + offsetMs).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

function insertIgnore(context: ServerContext, sql: string, ...values: unknown[]): void {
  context.database.prepare(sql).run(...values);
}

function appendEvent(
  context: ServerContext,
  projectId: string,
  key: string,
  eventKind: Parameters<ServerContext['events']['append']>[0]['eventKind'],
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  actor: Parameters<ServerContext['events']['append']>[0]['actor'] = { type: 'system' },
  source: Parameters<ServerContext['events']['append']>[0]['source'] = { kind: 'import', adapter: 'demo-seed' },
): void {
  const existing = context.database.prepare('SELECT event_id FROM event_log WHERE project_id = ? AND idempotency_key = ?').get(projectId, key) as { event_id: string } | undefined;
  if (existing) return;
  context.events.append({ projectId, eventKind, aggregateType, aggregateId, payload, actor, source, idempotencyKey: key });
}

function counts(context: ServerContext): DemoSeedCounts {
  const count = (table: string, where = 'id LIKE ?', value = 'demo-%'): number => {
    const row = context.database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`).get(value) as { count: number };
    return row.count;
  };
  return {
    teams: count('teams'), users: count('users'), teamMembers: count('team_members', 'team_id LIKE ?', 'demo-%'),
    projects: count('projects'), repositories: count('repositories'), machines: count('machines'),
    runtimes: count('runtime_registrations'), providers: count('providers'), models: count('models'),
    sessions: count('sessions'), participants: count('session_participants', 'session_id LIKE ?', 'demo-%'), runs: count('runs'),
    agents: count('logical_agents'), activations: count('agent_activations'), edges: count('agent_edges'), approvals: count('approvals'),
    coordinationClaims: count('coordination_claims'), conflicts: count('coordination_conflicts'),
    gatewayAccounts: count('gateway_accounts'), gatewayRequests: count('gateway_requests'),
  };
}

/**
 * Seed a complete, offline project graph.  The operation is safe to call more
 * than once: all IDs are stable, inserts are conflict-tolerant, and events use
 * an idempotency key.  Production is always rejected; development/test callers
 * must opt in with DHOLE_DEMO (except test environments).
 */
export function seedDemo(context: ServerContext): DemoSeedResult {
  if (context.config.environment === 'production') throw new Error('Demo seed is disabled in production');
  if (!context.config.demo && context.config.environment !== 'test') throw new Error('Demo seed requires DHOLE_DEMO=1');
  const existed = Boolean(context.database.prepare('SELECT id FROM teams WHERE id = ?').get(DEMO_IDS.team));
  context.events.transaction(() => {
    const now = iso(context);
    const later = iso(context, 24 * 60 * 60 * 1_000);

    insertIgnore(context, 'INSERT OR IGNORE INTO teams(id, name, created_at) VALUES (?, ?, ?)', DEMO_IDS.team, 'Dhole Demo Team', now);
    insertIgnore(context, 'INSERT OR IGNORE INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', DEMO_IDS.admin, DEMO_ADMIN_EMAIL, 'Demo Administrator', PASSWORD_HASHES.admin, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', DEMO_IDS.member, DEMO_MEMBER_EMAIL, 'Demo Collaborator', PASSWORD_HASHES.member, now, now);
    insertIgnore(context, "INSERT OR IGNORE INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, 'administrator', ?)", DEMO_IDS.team, DEMO_IDS.admin, now);
    insertIgnore(context, "INSERT OR IGNORE INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", DEMO_IDS.team, DEMO_IDS.member, now);

    insertIgnore(context, 'INSERT OR IGNORE INTO projects(id, team_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.project, DEMO_IDS.team, 'Dhole Offline Demo', 'A deterministic project graph populated entirely from local fixtures.', DEMO_IDS.admin, now, now);
    insertIgnore(context, "INSERT OR IGNORE INTO project_members(project_id, user_id, role, created_by, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?, ?)", DEMO_IDS.project, DEMO_IDS.member, DEMO_IDS.admin, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO repositories(id, project_id, label, canonical_remote, local_path_hint, default_branch, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.repository, DEMO_IDS.project, 'dhole-demo', 'https://example.invalid/dhole/demo.git', './fixtures/dhole-demo', 'main', DEMO_IDS.admin, now, now);

    const providers = [
      [DEMO_IDS.providerOpenAI, 'openai-compatible', 'OpenAI Fixture Gateway', 'http://fixture.invalid/openai'],
      [DEMO_IDS.providerAnthropic, 'anthropic', 'Anthropic Fixture Gateway', 'http://fixture.invalid/anthropic'],
      [DEMO_IDS.providerKimi, 'kimi', 'Kimi Fixture Gateway', 'http://fixture.invalid/kimi'],
    ] as const;
    for (const [id, kind, name, baseUrl] of providers) insertIgnore(context, 'INSERT OR IGNORE INTO providers(id, team_id, kind, name, base_url, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)', id, DEMO_IDS.team, kind, name, baseUrl, json({ fixture: true }), now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', DEMO_IDS.modelOpenAI, DEMO_IDS.providerOpenAI, 'gpt-4o-mini', 'GPT-4o Mini (fixture)', json({ text: true, tools: true }), json({ text: true, tools: true }), now, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', DEMO_IDS.modelAnthropic, DEMO_IDS.providerAnthropic, 'claude-3-5-sonnet', 'Claude Sonnet (fixture)', json({ text: true, tools: true, vision: true }), json({ text: true, tools: true }), now, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', DEMO_IDS.modelKimi, DEMO_IDS.providerKimi, 'kimi-k2', 'Kimi K2 (fixture)', json({ text: true, tools: true }), json({ text: true, tools: true }), now, now, now);

    insertIgnore(context, "INSERT OR IGNORE INTO machines(id, team_id, name, status, daemon_version, available_slots, last_connected_at, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?)", DEMO_IDS.machine, DEMO_IDS.team, 'Demo Node (offline fixture)', 'fixture-node-1', 4, now, now, now, now);
    const runtimes = [
      [DEMO_IDS.runtimeFake, 'fake', 'Deterministic Fake Runtime', 'fixture.v1', true, 'fake-1'],
      [DEMO_IDS.runtimeCodex, 'codex', 'Codex (fixture)', 'fixture.codex.v1', true, 'fixture-codex-1'],
      [DEMO_IDS.runtimeClaude, 'claude-code', 'Claude Code (fixture)', 'fixture.claude.v1', true, 'fixture-claude-1'],
      [DEMO_IDS.runtimeKimi, 'kimi-code', 'Kimi Code (fixture)', 'fixture.kimi.v1', true, 'fixture-kimi-1'],
    ] as const;
    for (const [id, kind, label, protocol, available, version] of runtimes) insertIgnore(context, 'INSERT OR IGNORE INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, executable_reference, observed_version, available, unavailable_reason, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, DEMO_IDS.machine, kind, label, protocol, json(CAPABILITIES), 'fixture', version, available ? 1 : 0, null, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO machine_repository_allowlists(machine_id, repository_id, canonical_root, created_at) VALUES (?, ?, ?, ?)', DEMO_IDS.machine, DEMO_IDS.repository, '/tmp/dhole-demo', now);
    insertIgnore(context, "INSERT OR IGNORE INTO workspaces(id, machine_id, repository_id, kind, path_reference, branch, head_revision, status, created_at, updated_at) VALUES (?, ?, ?, 'primary', ?, ?, ?, 'available', ?, ?)", DEMO_IDS.workspace, DEMO_IDS.machine, DEMO_IDS.repository, '/tmp/dhole-demo', 'main', 'fixture-revision-001', now, now);

    insertIgnore(context, 'INSERT OR IGNORE INTO sessions(id, project_id, title, runtime_registration_id, model_id, workspace_id, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.session, DEMO_IDS.project, 'Offline collaborative demo', DEMO_IDS.runtimeFake, DEMO_IDS.modelOpenAI, DEMO_IDS.workspace, 'needs_approval', DEMO_IDS.admin, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO session_participants(session_id, user_id, joined_at) VALUES (?, ?, ?)', DEMO_IDS.session, DEMO_IDS.admin, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO session_participants(session_id, user_id, joined_at) VALUES (?, ?, ?)', DEMO_IDS.session, DEMO_IDS.member, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO runs(id, session_id, root_objective, issue_reference, state, created_by, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.run, DEMO_IDS.session, 'Prepare a safe, reviewable offline demo patch.', 'demo/001', 'running', DEMO_IDS.admin, now, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO session_turns(id, session_id, run_id, runtime_turn_id, state, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.turn, DEMO_IDS.session, DEMO_IDS.run, 'fake-demo-turn-1', 'running', now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO messages(id, session_id, run_id, turn_id, sequence, role, author_user_id, body, status, include_human_identity, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'demo-message-human', DEMO_IDS.session, DEMO_IDS.run, DEMO_IDS.turn, 1, 'human', DEMO_IDS.admin, 'Inspect the repository and propose a safe patch plan.', 'completed', 1, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO messages(id, session_id, run_id, turn_id, sequence, role, logical_agent_id, body, status, include_human_identity, created_at, delivered_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'demo-message-agent', DEMO_IDS.session, DEMO_IDS.run, DEMO_IDS.turn, 2, 'agent', DEMO_IDS.agentRoot, 'Fake response: repository inspected; plan is ready.', 'completed', 0, now, now, now);
    insertIgnore(context, 'UPDATE sessions SET next_message_sequence = 2, active_turn_id = ? WHERE id = ?', DEMO_IDS.turn, DEMO_IDS.session);

    const agents = [
      [DEMO_IDS.agentRoot, 'Director', 'director', 'Coordinate the offline demo run.', null],
      [DEMO_IDS.agentControlled, 'Controlled worker', 'worker', 'Implement the controlled repository change.', DEMO_IDS.agentRoot],
      [DEMO_IDS.agentObserved, 'Observed worker', 'worker', 'Inspect provider output without steering it.', DEMO_IDS.agentRoot],
      [DEMO_IDS.agentHeuristic, 'Heuristic worker', 'worker', 'Infer a child task from the observed plan.', DEMO_IDS.agentRoot],
    ] as const;
    for (const [id, name, role, objective] of agents.map(([id, name, role, objective]) => [id, name, role, objective, null] as const)) insertIgnore(context, 'INSERT OR IGNORE INTO logical_agents(id, run_id, name, role, objective, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, DEMO_IDS.run, name, role, objective, now);
    const activations = [
      [DEMO_IDS.activationRoot, DEMO_IDS.agentRoot, 'settled', DEMO_IDS.runtimeFake],
      [DEMO_IDS.activationControlled, DEMO_IDS.agentControlled, 'settled', DEMO_IDS.runtimeCodex],
      [DEMO_IDS.activationObserved, DEMO_IDS.agentObserved, 'waiting_on_children', DEMO_IDS.runtimeClaude],
      [DEMO_IDS.activationHeuristic, DEMO_IDS.agentHeuristic, 'blocked', DEMO_IDS.runtimeKimi],
    ] as const;
    for (const [id, agentId, state, runtimeId] of activations) insertIgnore(context, 'INSERT OR IGNORE INTO agent_activations(id, logical_agent_id, machine_id, runtime_registration_id, workspace_id, native_session_id, ordinal, state, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)', id, agentId, DEMO_IDS.machine, runtimeId, DEMO_IDS.workspace, `fixture-${id}`, state, now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, source_reference, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'demo-edge-controlled', DEMO_IDS.run, DEMO_IDS.agentRoot, DEMO_IDS.agentControlled, 'platform', 'full', 'platform:child.created', 1, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, source_reference, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'demo-edge-observed', DEMO_IDS.run, DEMO_IDS.agentRoot, DEMO_IDS.agentObserved, 'provider', 'observe_only', 'provider:native-subagent', 0.82, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, source_reference, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'demo-edge-heuristic', DEMO_IDS.run, DEMO_IDS.agentRoot, DEMO_IDS.agentHeuristic, 'heuristic', 'uncertain', 'heuristic:fixture-transcript', 0.57, now);
    for (const [activationId, key, label, current, total] of [[DEMO_IDS.activationControlled, 'files', 'Files changed', 3, 3], [DEMO_IDS.activationObserved, 'tokens', 'Tokens observed', 220, 500]] as const) insertIgnore(context, 'INSERT OR IGNORE INTO activity_progress(activation_id, activity_key, label, current_value, total_value, unit, important, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', activationId, key, label, current, total, key === 'files' ? 'files' : 'tokens', now);
    insertIgnore(context, 'INSERT OR IGNORE INTO approvals(id, session_id, run_id, turn_id, runtime_approval_id, kind, summary, detail_redacted_json, state, requested_at, expires_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.approval, DEMO_IDS.session, DEMO_IDS.run, DEMO_IDS.turn, 'fixture-approval-1', 'repository_write', 'Allow the controlled worker to apply its patch?', json({ paths: ['src/demo/**'], risk: 'low' }), 'pending', now, later, 1);

    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_sessions(id, project_id, user_id, machine_id, agent_label, developer_label, worktree_hash, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.coordinationSessionA, DEMO_IDS.project, DEMO_IDS.admin, DEMO_IDS.machine, 'controlled-worker', 'demo-admin', 'fixture-worktree-a', 'fixture-capabilities-v1', now, now, later);
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_sessions(id, project_id, user_id, machine_id, agent_label, developer_label, worktree_hash, capability_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.coordinationSessionB, DEMO_IDS.project, DEMO_IDS.member, DEMO_IDS.machine, 'observed-worker', 'demo-member', 'fixture-worktree-b', 'fixture-capabilities-v1', now, now, later);
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_claims(id, project_id, coordination_session_id, run_id, work_item_id, intent, task, worktree_hash, branch, base_revision, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.claimA, DEMO_IDS.project, DEMO_IDS.coordinationSessionA, DEMO_IDS.run, null, 'edit shared adapter', 'Update runtime adapter docs', 'fixture-worktree-a', 'demo/controlled', 'fixture-revision-001', 'in-progress', 'Editing runtime adapter documentation.', now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_claims(id, project_id, coordination_session_id, run_id, work_item_id, intent, task, worktree_hash, branch, base_revision, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.claimB, DEMO_IDS.project, DEMO_IDS.coordinationSessionB, DEMO_IDS.run, null, 'review shared adapter', 'Review runtime adapter docs', 'fixture-worktree-b', 'demo/observed', 'fixture-revision-001', 'in-progress', 'Reviewing the same runtime adapter documentation.', now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)', DEMO_IDS.claimA, 'apps/server/src/demo/index.ts');
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)', DEMO_IDS.claimB, 'apps/server/src/demo/index.ts');
    insertIgnore(context, 'INSERT OR IGNORE INTO coordination_conflicts(id, project_id, claim_id, conflicting_claim_id, severity, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.conflict, DEMO_IDS.project, DEMO_IDS.claimA, DEMO_IDS.claimB, 'blocking', json([{ type: 'files', detail: [{ mine: 'apps/server/src/demo/index.ts', theirs: 'apps/server/src/demo/index.ts' }] }]), now);

    insertIgnore(context, 'INSERT OR IGNORE INTO gateway_connections(id, team_id, provider_id, name, base_url, enabled, status, last_checked_at, retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)', DEMO_IDS.gateway, DEMO_IDS.team, DEMO_IDS.providerOpenAI, 'Fixture CLIProxy', 'http://fixture.invalid/cliproxy', 'healthy', now, 30, now, now);
    const catalogModels = parseCliProxyCatalog({ data: [{ id: 'gpt-4o-mini', display_name: 'GPT-4o Mini (fixture)', context_window: 128000, max_output_tokens: 16384, capabilities: { tools: true, streaming: true } }] }).models;
    const catalogSource: CatalogSource = { connectionId: DEMO_IDS.gateway, providerId: DEMO_IDS.providerOpenAI, baseUrl: 'http://fixture.invalid/cliproxy', endpoint: '/v1/models', shape: 'openai', clientVersion: null, connectionRevision: 1, credentialScope: 'anonymous', cpaVersion: 'offline-fixture' };
    insertIgnore(context, 'INSERT OR IGNORE INTO gateway_catalog_snapshots(id, connection_id, provider_id, schema_version, source_json, observed_at, content_hash, models_json, diff_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)', 'demo-catalog-snapshot', DEMO_IDS.gateway, DEMO_IDS.providerOpenAI, json(catalogSource), now, catalogContentHash({ source: catalogSource, models: catalogModels }), json(catalogModels), json({ added: ['gpt-4o-mini'], removed: [], changed: [] }));
    insertIgnore(context, 'INSERT OR IGNORE INTO gateway_catalog_state(connection_id, snapshot_id, last_attempt_at, last_success_at) VALUES (?, ?, ?, ?)', DEMO_IDS.gateway, 'demo-catalog-snapshot', now, now);
    insertIgnore(context, 'INSERT OR IGNORE INTO gateway_accounts(id, connection_id, auth_index, provider, label, masked_source, status, status_message, quota_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.gatewayAccountA, DEMO_IDS.gateway, 'fixture-0', 'openai', 'Demo OpenAI account', 'fixture••••0000', 'healthy', 'Within fixture quota', json({ limitTokens: 100000, usedTokens: 192, remainingTokens: 99808, resetAt: later }), now);
    insertIgnore(context, 'INSERT OR IGNORE INTO gateway_accounts(id, connection_id, auth_index, provider, label, masked_source, status, status_message, quota_json, cooldown_until, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', DEMO_IDS.gatewayAccountB, DEMO_IDS.gateway, 'fixture-1', 'anthropic', 'Demo Anthropic account', 'fixture••••0001', 'cooldown', 'Fixture rate limit sample', json({ limitTokens: 50000, usedTokens: 50000, remainingTokens: 0, resetAt: later }), later, now);
    const requestRows = [
      ['demo-gateway-request-1', 'fixture-req-001', 'openai', 'gpt-4o-mini', DEMO_IDS.gatewayAccountA, 'fixture-0', 200, 0, null, null, 418, 112, 128, 64, 0, 32, 0, 1280],
      ['demo-gateway-request-2', 'fixture-req-002', 'anthropic', 'claude-3-5-sonnet', DEMO_IDS.gatewayAccountB, 'fixture-1', 429, 1, 'rate_limit', 'fixture quota exhausted', 92, null, 0, 0, 0, 0, 0, null],
      ['demo-gateway-request-3', 'fixture-req-003', 'kimi', 'kimi-k2', DEMO_IDS.gatewayAccountA, 'fixture-0', 200, 0, null, null, 302, 88, 96, 41, 0, 0, 0, 740],
    ] as const;
    for (const [id, eventHash, provider, model, accountId, authIndex, statusCode, failed, failureCategory, failureSummary, durationMs, ttftMs, inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheCreationTokens, cost] of requestRows) insertIgnore(context, 'INSERT OR IGNORE INTO gateway_requests(id, connection_id, event_hash, schema_version, request_id, occurred_at, provider, model, requested_model, account_id, auth_index, endpoint, status_code, failed, failure_category, failure_summary, duration_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_creation_tokens, estimated_cost_microusd, session_id, project_id, correlation_confidence, correlation_reason, trace_reference, redacted_metadata_json, ingested_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, DEMO_IDS.gateway, eventHash, eventHash, now, provider, model, model, accountId, authIndex, '/v1/chat/completions', statusCode, failed, failureCategory, failureSummary, durationMs, ttftMs, inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheCreationTokens, cost, DEMO_IDS.session, DEMO_IDS.project, 'exact', 'fixture request id', `fixture-trace-${id}`, json({ source: 'fake-cliproxy' }), now);

    appendEvent(context, DEMO_IDS.project, 'demo-session-created', 'session.created', 'session', DEMO_IDS.session, { title: 'Offline collaborative demo' }, { type: 'user', userId: DEMO_IDS.admin });
    appendEvent(context, DEMO_IDS.project, 'demo-run-started', 'run.started', 'run', DEMO_IDS.run, { objective: 'Prepare a safe, reviewable offline demo patch.' }, { type: 'user', userId: DEMO_IDS.admin });
    appendEvent(context, DEMO_IDS.project, 'demo-child-controlled', 'child.discovered', 'agent', DEMO_IDS.agentControlled, { evidence: 'platform', control: 'full' }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeFake });
    appendEvent(context, DEMO_IDS.project, 'demo-child-observed', 'child.discovered', 'agent', DEMO_IDS.agentObserved, { evidence: 'provider', control: 'observe_only' }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeClaude });
    appendEvent(context, DEMO_IDS.project, 'demo-child-heuristic', 'child.discovered', 'agent', DEMO_IDS.agentHeuristic, { evidence: 'heuristic', control: 'uncertain' }, { type: 'system' }, { kind: 'heuristic', adapter: 'demo-seed' });
    appendEvent(context, DEMO_IDS.project, 'demo-child-started', 'child.started', 'agent', DEMO_IDS.agentControlled, { activationId: DEMO_IDS.activationControlled }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeCodex });
    appendEvent(context, DEMO_IDS.project, 'demo-claim-a-created', 'claim.created', 'coordination_claim', DEMO_IDS.claimA, { status: 'in-progress', files: ['apps/server/src/demo/index.ts'] }, { type: 'user', userId: DEMO_IDS.admin });
    appendEvent(context, DEMO_IDS.project, 'demo-claim-b-created', 'claim.created', 'coordination_claim', DEMO_IDS.claimB, { status: 'in-progress', files: ['apps/server/src/demo/index.ts'] }, { type: 'user', userId: DEMO_IDS.member });
    appendEvent(context, DEMO_IDS.project, 'demo-progress-controlled', 'progress.changed', 'activation', DEMO_IDS.activationControlled, { activityKey: 'files', currentValue: 3, totalValue: 3, unit: 'files' }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeCodex });
    appendEvent(context, DEMO_IDS.project, 'demo-progress-observed', 'progress.changed', 'activation', DEMO_IDS.activationObserved, { activityKey: 'tokens', currentValue: 220, totalValue: 500, unit: 'tokens' }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeClaude });
    appendEvent(context, DEMO_IDS.project, 'demo-approval-requested', 'approval.requested', 'approval', DEMO_IDS.approval, { state: 'pending', summary: 'Allow the controlled worker to apply its patch?' }, { type: 'runtime', runtimeId: DEMO_IDS.runtimeFake });
    appendEvent(context, DEMO_IDS.project, 'demo-conflict-detected', 'conflict.detected', 'conflict', DEMO_IDS.conflict, { severity: 'blocking', claimId: DEMO_IDS.claimA, conflictingClaimId: DEMO_IDS.claimB }, { type: 'system' });
    appendEvent(context, DEMO_IDS.project, 'gateway:demo-gateway:fixture-req-001', 'progress.changed', 'gateway_request', 'fixture-req-001', { provider: 'openai', model: 'gpt-4o-mini', inputTokens: 128, outputTokens: 64, failed: false }, { type: 'system' }, { kind: 'import', adapter: 'cliproxy', rawReference: 'fake-cliproxy.jsonl' });
    appendEvent(context, DEMO_IDS.project, 'gateway:demo-gateway:fixture-req-002', 'progress.changed', 'gateway_request', 'fixture-req-002', { provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 0, outputTokens: 0, failed: true }, { type: 'system' }, { kind: 'import', adapter: 'cliproxy', rawReference: 'fake-cliproxy.jsonl' });
    appendEvent(context, DEMO_IDS.project, 'gateway:demo-gateway:fixture-req-003', 'progress.changed', 'gateway_request', 'fixture-req-003', { provider: 'kimi', model: 'kimi-k2', inputTokens: 96, outputTokens: 41, failed: false }, { type: 'system' }, { kind: 'import', adapter: 'cliproxy', rawReference: 'fake-cliproxy.jsonl' });
  });
  return { seeded: !existed, ids: DEMO_IDS, counts: counts(context) };
}

export { FAKE_CLIPROXY_FIXTURE, FAKE_CLIPROXY_JSONL, FAKE_RUNTIME_FIXTURE, FAKE_RUNTIME_SCENARIO };
