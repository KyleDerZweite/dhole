import { describe, expect, it } from 'vitest';
import { NodeCommandSchema } from '@dhole-control/shared';
import { EventStore } from '../../lib/events.js';
import { openDatabase } from '../../lib/database.js';
import { secureIds } from '../../lib/clock.js';
import type { ServerContext } from '../../lib/module.js';
import { createCoordinationService } from '../coordination/index.js';
import { OrchestrationService } from './service.js';
import type { CoordinationApi } from './types.js';

const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

function fixture() {
  const database = openDatabase(':memory:', clock);
  database.exec(`
    INSERT INTO teams(id, name, created_at) VALUES ('team', 'Team', '2026-01-01T00:00:00.000Z');
    INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES ('user', 'u@example.test', 'User', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO team_members(team_id, user_id, role, created_at) VALUES ('team', 'user', 'administrator', '2026-01-01T00:00:00.000Z');
    INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES ('project', 'team', 'Project', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO repositories(id, project_id, label, default_branch, created_by, created_at, updated_at) VALUES ('repository', 'project', 'Repository', 'main', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES ('session', 'project', 'Session', 'idle', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES ('run', 'session', 'Test objective', 'queued', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO machines(id, team_id, name, status, available_slots, created_at, updated_at) VALUES ('machine-a', 'team', 'A', 'connected', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO machines(id, team_id, name, status, available_slots, created_at, updated_at) VALUES ('machine-b', 'team', 'B', 'connected', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, available, observed_at) VALUES ('runtime-a', 'machine-a', 'fake', 'Fake A', '1', '{}', 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, available, observed_at) VALUES ('runtime-b', 'machine-b', 'fake', 'Fake B', '1', '{}', 1, '2026-01-01T00:00:00.000Z');
  `);
  const events = new EventStore(database, clock, secureIds);
  const context = { database, clock, ids: secureIds, events, config: {} } as ServerContext;
  return { database, context, service: new OrchestrationService(context) };
}

describe('orchestration scheduler', () => {
  it('audits profile lifecycle changes with identifiers but without profile content', () => {
    const { database, service } = fixture();
    const secret = 'profile-secret-value';
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'audited-profile',
      name: 'Audited profile',
      createdBy: 'user',
      config: { fake: false, apiKey: secret },
    });
    service.activateProfileVersion('project', profile.profile.id, profile.version.id, 'user');
    const active = service.createProfileVersion({
      projectId: 'project',
      profileId: profile.profile.id,
      createdBy: 'user',
      lifecycle: 'active',
      config: { fake: true, password: secret },
    });
    const deprecated = service.createProfileVersion({
      projectId: 'project',
      profileId: profile.profile.id,
      createdBy: 'user',
      lifecycle: 'deprecated',
      config: { fake: false, workspacePolicy: 'none', token: secret },
    });
    const rows = database.prepare(`SELECT actor_type, actor_id, action, target_type, target_id, detail_json
      FROM audit_records WHERE project_id = ? AND action LIKE 'orchestration.profile%' ORDER BY rowid`).all('project') as Array<{
        actor_type: string;
        actor_id: string | null;
        action: string;
        target_type: string;
        target_id: string | null;
        detail_json: string;
      }>;
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.actor_type === 'user' && row.actor_id === 'user')).toBe(true);
    expect(rows.every((row) => row.target_id && row.detail_json.includes(row.target_id))).toBe(true);
    expect(rows.some((row) => row.action === 'orchestration.profile.create' && row.target_id === profile.profile.id)).toBe(true);
    expect(rows.some((row) => row.action === 'orchestration.profile.version.create' && row.target_id === active.id)).toBe(true);
    expect(rows.some((row) => row.action === 'orchestration.profile.version.activate' && row.target_id === profile.version.id)).toBe(true);
    expect(rows.some((row) => row.action === 'orchestration.profile.version.deprecate' && row.target_id === profile.version.id)).toBe(true);
    expect(rows.some((row) => row.action === 'orchestration.profile.version.deprecate' && row.target_id === deprecated.id)).toBe(true);
    expect(rows.every((row) => !row.detail_json.includes(secret))).toBe(true);
    expect(rows.every((row) => row.target_type === 'orchestration_profile' || row.target_type === 'orchestration_profile_version')).toBe(true);
  });

  it('rolls back profile rows when an audit insert fails', () => {
    const { database, service } = fixture();
    database.exec(`CREATE TRIGGER fail_orchestration_profile_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'orchestration.profile.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => service.createProfile({
      projectId: 'project',
      stableKey: 'audit-rollback',
      name: 'Audit rollback',
      createdBy: 'user',
      config: { fake: false },
    })).toThrow('audit unavailable');
    expect(database.prepare("SELECT count(*) AS count FROM orchestration_profiles WHERE stable_key = 'audit-rollback'").get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM orchestration_profile_versions').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM audit_records').get()).toEqual({ count: 0 });
  });

  it('rejects credential-bearing direct memory and skill proposals before persistence', () => {
    const { database, service } = fixture();
    const now = clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('memory-pack', 'project', 'orchestration-pack', 'Orchestration pack', 'project', now);
    database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('skill', 'project', 'orchestration-skill', 'Orchestration skill', now);
    const execution = service.startExecution({
      projectId: 'project',
      runId: 'run',
      profileVersionId: service.createProfile({ projectId: 'project', stableKey: 'proposal-guards', name: 'Proposal guards', createdBy: 'user', config: { fake: true, initialChildren: 0, workspacePolicy: 'none' } }).version.id,
      autoTick: false,
    });
    expect(() => service.proposeMemory('project', execution.id, { packId: 'memory-pack', title: 'api_key=memory-secret', body: 'safe', userId: 'user' })).toThrow('Memory content must not contain credentials');
    expect(() => service.proposeMemory('project', execution.id, { packId: 'memory-pack', title: 'safe', body: 'Authorization: Bearer memory-secret', userId: 'user' })).toThrow('Memory content must not contain credentials');
    expect(() => service.proposeSkill('project', execution.id, { skillId: 'skill', markdown: 'api_key=skill-secret', userId: 'user' })).toThrow('Skill markdown must not contain credentials');
    expect(() => service.proposeSkill('project', execution.id, { skillId: 'skill', markdown: 'safe markdown', manifest: { apiKey: 'skill-secret' }, userId: 'user' })).toThrow('Skill markdown must not contain credentials');
    expect(database.prepare('SELECT count(*) AS count FROM memory_proposals').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM skill_versions').get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM audit_records WHERE action IN ('memory.propose', 'skill.propose')").get()).toEqual({ count: 0 });
  });

  it('audits successful direct proposals without storing proposal content in audit rows', () => {
    const { database, service } = fixture();
    const now = clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('memory-pack', 'project', 'orchestration-pack', 'Orchestration pack', 'project', now);
    database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('skill', 'project', 'orchestration-skill', 'Orchestration skill', now);
    const profile = service.createProfile({ projectId: 'project', stableKey: 'proposal-audit', name: 'Proposal audit', createdBy: 'user', config: { fake: true, initialChildren: 0, workspacePolicy: 'none' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    const memory = service.proposeMemory('project', execution.id, { packId: 'memory-pack', title: 'API key rotation', body: 'Describe the API key lifecycle without values', sourceReference: 'adr/1', userId: 'user' });
    const skill = service.proposeSkill('project', execution.id, { skillId: 'skill', markdown: 'safe skill markdown', manifest: { description: 'safe' }, userId: 'user' });
    const rows = database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records WHERE action IN ('memory.propose', 'skill.propose') ORDER BY rowid").all() as Array<{ actor_type: string; actor_id: string | null; action: string; target_type: string; target_id: string; detail_json: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.actor_type === 'user' && row.actor_id === 'user')).toBe(true);
    expect(rows.find((row) => row.action === 'memory.propose')).toMatchObject({ target_type: 'memory_proposal', target_id: memory.id });
    expect(rows.find((row) => row.action === 'skill.propose')).toMatchObject({ target_type: 'skill_version', target_id: skill.id });
    expect(rows.every((row) => !row.detail_json.includes('API key rotation') && !row.detail_json.includes('safe skill markdown'))).toBe(true);
    expect(rows.every((row) => row.detail_json.includes(execution.id))).toBe(true);
  });

  it('rolls back direct proposals when their audit insert fails', () => {
    const { database, service } = fixture();
    const now = clock.now().toISOString();
    database.prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('memory-pack', 'project', 'orchestration-pack', 'Orchestration pack', 'project', now);
    database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('skill', 'project', 'orchestration-skill', 'Orchestration skill', now);
    const profile = service.createProfile({ projectId: 'project', stableKey: 'proposal-rollback', name: 'Proposal rollback', createdBy: 'user', config: { fake: true, initialChildren: 0, workspacePolicy: 'none' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    database.exec(`CREATE TRIGGER fail_memory_proposal_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'memory.propose' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => service.proposeMemory('project', execution.id, { packId: 'memory-pack', title: 'safe', body: 'safe', userId: 'user' })).toThrow('audit unavailable');
    expect(database.prepare('SELECT count(*) AS count FROM memory_proposals').get()).toEqual({ count: 0 });
    database.exec('DROP TRIGGER fail_memory_proposal_audit');
    database.exec(`CREATE TRIGGER fail_skill_proposal_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'skill.propose' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => service.proposeSkill('project', execution.id, { skillId: 'skill', markdown: 'safe', userId: 'user' })).toThrow('audit unavailable');
    expect(database.prepare('SELECT count(*) AS count FROM skill_versions').get()).toEqual({ count: 0 });
  });

  it('strips unknown profile config fields before persistence', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'secret-config',
      name: 'Secret config',
      createdBy: 'user',
      config: { fake: true, apiKey: 'should-not-persist' },
    });
    expect(profile.version.config_json).not.toContain('should-not-persist');
    expect(JSON.parse(profile.version.config_json)).not.toHaveProperty('apiKey');
    const stored = database.prepare('SELECT config_json FROM orchestration_profile_versions WHERE id = ?').get(profile.version.id) as { config_json: string };
    expect(stored.config_json).not.toContain('should-not-persist');
  });

  it('binds profile version creation to the route project', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'bound-profile', name: 'Bound profile', createdBy: 'user', config: { fake: true } });
    expect(() => service.createProfileVersion({ projectId: 'other-project', profileId: profile.profile.id, createdBy: 'user', config: { fake: true } })).toThrow('Unknown orchestration profile');
    expect((database.prepare('SELECT count(*) AS count FROM orchestration_profile_versions WHERE profile_id = ?').get(profile.profile.id) as { count: number }).count).toBe(1);
  });

  it('does not reactivate deprecated profile versions', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'deprecated-version', name: 'Deprecated version', createdBy: 'user', config: { fake: false } });
    const deprecated = service.createProfileVersion({ projectId: 'project', profileId: profile.profile.id, createdBy: 'user', lifecycle: 'deprecated', config: { fake: false, workspacePolicy: 'none' } });
    expect(() => service.activateProfileVersion('project', profile.profile.id, deprecated.id, 'user')).toThrow('Deprecated orchestration profile versions cannot be activated');
    expect((database.prepare('SELECT lifecycle FROM orchestration_profile_versions WHERE id = ?').get(deprecated.id) as { lifecycle: string }).lifecycle).toBe('deprecated');
  });

  it.each(['settled', 'failed', 'cancelled'] as const)('rejects starting a %s run without reopening it', (state) => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: `terminal-run-${state}`, name: `Terminal ${state}`, createdBy: 'user', config: { fake: false } });
    const completedAt = clock.now().toISOString();
    database.prepare('UPDATE runs SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(state, completedAt, completedAt, 'run');

    expect(() => service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false })).toThrow('Terminal runs are immutable; resume with a new run');
    expect((database.prepare('SELECT state, completed_at FROM runs WHERE id = ?').get('run') as { state: string; completed_at: string }).state).toBe(state);
    expect((database.prepare('SELECT state, completed_at FROM runs WHERE id = ?').get('run') as { state: string; completed_at: string }).completed_at).toBe(completedAt);
    expect((database.prepare('SELECT count(*) AS count FROM orchestration_executions WHERE run_id = ?').get('run') as { count: number }).count).toBe(0);
  });

  it('rejects terminal execution and item mutations before dispatching commands', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'terminal-guards', name: 'Terminal guards', createdBy: 'user', config: { fake: false, initialChildren: 0, workspacePolicy: 'shared' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    const child = service.createChild({ projectId: 'project', executionId: execution.id, objective: 'queued child' });
    service.cancel('project', execution.id, 'user');
    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'late child' })).toThrow('Orchestration execution is terminal');
    expect(() => service.sendMessage('project', execution.id, child.id, 'late message')).toThrow('Orchestration execution is terminal');
    expect(() => service.cancelChild('project', execution.id, child.id)).toThrow('Orchestration execution is terminal');
    expect((database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count).toBe(0);
  });

  it.each([
    { maxConcurrency: 1, siblingCommandState: 'queued' },
    { maxConcurrency: 2, siblingCommandState: 'running' },
  ] as const)('fail-fast terminalizes a %s sibling without leaving executable commands', ({ maxConcurrency, siblingCommandState }) => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: `fail-fast-${maxConcurrency}`,
      name: 'Fail fast',
      createdBy: 'user',
      config: { fake: false, initialChildren: 2, workspacePolicy: 'shared', completion: { failFast: true }, limits: { maxConcurrency, maxRetries: 0 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const children = service.getExecution('project', execution.id).workItems.filter((item) => item.parentWorkItemId).sort((left, right) => left.ordinal - right.ordinal);
    expect(children).toHaveLength(2);
    const firstCommand = database.prepare("SELECT id FROM node_commands WHERE operation_key LIKE ?").get(`%:${children[0]!.id}:%`) as { id: string } | undefined;
    expect(firstCommand).toBeDefined();
    if (siblingCommandState === 'running') {
      database.prepare("UPDATE node_commands SET state = 'running', updated_at = ? WHERE operation_key LIKE ?").run(clock.now().toISOString(), `%:${children[1]!.id}:%`);
    }
    database.prepare("UPDATE node_commands SET state = 'failed', error_summary = 'boom', completed_at = ?, updated_at = ? WHERE id = ?").run(clock.now().toISOString(), clock.now().toISOString(), firstCommand!.id);
    service.tick('project');
    expect(service.getExecution('project', execution.id).state).toBe('failed');
    expect((database.prepare('SELECT state FROM runs WHERE id = ?').get('run') as { state: string }).state).toBe('failed');
    expect(service.childStatus('project', execution.id, children[0]!.id).state).toBe('failed');
    expect(service.childStatus('project', execution.id, children[1]!.id).state).toBe('cancelled');
    const states = database.prepare('SELECT state FROM node_commands').all() as Array<{ state: string }>;
    expect(states.every((row) => !['queued', 'delivered', 'accepted', 'running'].includes(row.state))).toBe(true);
    if (siblingCommandState === 'running') {
      expect(states.some((row) => row.state === 'uncertain')).toBe(true);
    }
  });

  it.each(['failed', 'cancelled'] as const)('reconciles an externally terminal %s run before scheduling', (state) => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: `external-${state}`, name: 'External terminal', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'shared' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    database.prepare('UPDATE node_commands SET state = \'running\', updated_at = ? WHERE kind = \'create_runtime_session\'').run(clock.now().toISOString());
    const now = clock.now().toISOString();
    const completedAt = '2025-12-31T23:59:00.000Z';
    database.prepare('UPDATE runs SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(state, completedAt, now, 'run');
    database.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?').run(state, now, 'session');
    service.tick('project');
    expect(service.getExecution('project', execution.id).state).toBe(state);
    expect(service.childStatus('project', execution.id, service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId)!.id).state).toBe('cancelled');
    expect((database.prepare('SELECT state FROM runs WHERE id = ?').get('run') as { state: string }).state).toBe(state);
    expect((database.prepare('SELECT completed_at FROM runs WHERE id = ?').get('run') as { completed_at: string }).completed_at).toBe(completedAt);
    expect((database.prepare('SELECT state FROM sessions WHERE id = ?').get('session') as { state: string }).state).toBe(state);
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE state IN ('queued', 'delivered', 'accepted', 'running')").get() as { count: number }).count).toBe(0);
    const commandCount = (database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count;
    service.tick('project');
    expect((database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count).toBe(commandCount);
  });

  it('does not dispatch cancellation for an already terminal child', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'terminal-child', name: 'Terminal child', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'shared' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    database.prepare("UPDATE orchestration_work_items SET state = 'settled', completed_at = ?, updated_at = ? WHERE id = ?").run(clock.now().toISOString(), clock.now().toISOString(), child!.id);
    const before = (database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count;
    expect(service.cancelChild('project', execution.id, child!.id).state).toBe('settled');
    expect((database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count).toBe(before);
  });

  it('enforces remaining profile budget for child declarations', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'budget-admission', name: 'Budget admission', createdBy: 'user', config: { fake: false, initialChildren: 0, workspacePolicy: 'none', limits: { budget: { maxTokens: 100, maxCostMicrousd: 1_000 } } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.createChild({ projectId: 'project', executionId: execution.id, objective: 'first', budget: { maxTokens: 60, maxCostMicrousd: 400 } });
    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'second', budget: { maxTokens: 50, maxCostMicrousd: 400 } })).toThrow('Child budget exceeds remaining orchestration budget');
    expect((database.prepare('SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ?').get(execution.id) as { count: number }).count).toBe(2);
  });

  it('blocks new placement when recorded child usage exhausts profile budget', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'budget-usage', name: 'Budget usage', createdBy: 'user', config: { fake: false, initialChildren: 0, workspacePolicy: 'shared', limits: { maxConcurrency: 1, budget: { maxTokens: 100 } } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    const first = service.createChild({ projectId: 'project', executionId: execution.id, objective: 'first', budget: { maxTokens: 50 } });
    const second = service.createChild({ projectId: 'project', executionId: execution.id, objective: 'second', budget: { maxTokens: 50 } });
    database.prepare("UPDATE orchestration_work_items SET state = 'blocked', error_summary = 'children pending' WHERE execution_id = ? AND parent_work_item_id IS NULL").run(execution.id);
    service.tick('project');
    database.prepare("UPDATE orchestration_work_items SET state = 'settled', result_json = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ usage: { totalTokens: 100 } }), clock.now().toISOString(), clock.now().toISOString(), first.id);
    service.tick('project');
    expect(service.childStatus('project', execution.id, second.id).state).toBe('blocked');
    expect(service.childStatus('project', execution.id, second.id).errorSummary).toBe('Orchestration budget exhausted');
  });

  it('binds child creation to the route project', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'bound-child', name: 'Bound child', createdBy: 'user', config: { fake: false, initialChildren: 0, workspacePolicy: 'none' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    expect(() => service.createChild({ projectId: 'other-project', executionId: execution.id, objective: 'cross-project child' })).toThrow('Unknown orchestration execution');
    expect((database.prepare('SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ?').get(execution.id) as { count: number }).count).toBe(1);
  });

  it('enforces child depth and metadata bounds before persistence', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'child-bounds',
      name: 'Child bounds',
      createdBy: 'user',
      config: { fake: false, initialChildren: 0, workspacePolicy: 'none', limits: { maxDepth: 0 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });

    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'too deep' })).toThrow('Maximum orchestration depth exceeded');
    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'large deliverables', deliverables: 'x'.repeat(200_001) })).toThrow();
    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'large acceptance', acceptance: 'x'.repeat(200_001) })).toThrow();
    expect(() => service.createChild({ projectId: 'project', executionId: execution.id, objective: 'large budget', budget: { detail: 'x'.repeat(50_001) } })).toThrow();
    expect((database.prepare('SELECT count(*) AS count FROM orchestration_work_items WHERE execution_id = ?').get(execution.id) as { count: number }).count).toBe(1);
  });

  it('reconciles completed setup phases after lease expiry', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'recovery',
      name: 'Recovery',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();

    const now = clock.now().toISOString();
    const worktreeRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_worktree'").get() as { payload_json: string };
    const worktreeCommand = NodeCommandSchema.parse(JSON.parse(worktreeRow.payload_json) as unknown);
    if (worktreeCommand.kind !== 'create_worktree') throw new Error('Expected worktree command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE id = ? AND operation_key = ?").run(now, now, worktreeCommand.commandId, worktreeCommand.operationKey);
    database.prepare("UPDATE orchestration_executions SET scheduler_lease_expires_at = '2025-12-31T23:59:00.000Z' WHERE id = ?").run(execution.id);
    expect(service.recoverExpiredLeases('project')).toBe(1);
    expect((database.prepare('SELECT count(*) AS count FROM node_commands WHERE kind = \'create_runtime_session\'').get() as { count: number }).count).toBe(1);
    expect(service.getExecution('project', execution.id).workItems.find((item) => item.id === child!.id)?.state).toBe('running');

    const runtimeRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const runtimeCommand = NodeCommandSchema.parse(JSON.parse(runtimeRow.payload_json) as unknown);
    if (runtimeCommand.kind !== 'create_runtime_session') throw new Error('Expected runtime command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND operation_key = ?").run(JSON.stringify({ runtimeSessionId: 'recovered-runtime' }), now, now, runtimeCommand.commandId, runtimeCommand.operationKey);
    database.prepare("UPDATE orchestration_executions SET scheduler_lease_expires_at = '2025-12-31T23:59:00.000Z' WHERE id = ?").run(execution.id);
    expect(service.recoverExpiredLeases('project')).toBe(1);
    const commands = database.prepare('SELECT kind FROM node_commands ORDER BY rowid').all() as Array<{ kind: string }>;
    expect(commands.map((command) => command.kind)).toEqual(['create_worktree', 'create_runtime_session', 'send_message']);
    expect(service.getExecution('project', execution.id).workItems.find((item) => item.id === child!.id)?.state).toBe('running');
  });

  it('expires a stale running command during lease recovery', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'stale-command',
      name: 'Stale command',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'shared', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    const commandRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const command = NodeCommandSchema.parse(JSON.parse(commandRow.payload_json) as unknown);
    database.prepare("UPDATE node_commands SET state = 'running', expires_at = '2025-12-31T23:59:00.000Z', updated_at = ? WHERE id = ? AND operation_key = ?").run(clock.now().toISOString(), command.commandId, command.operationKey);
    database.prepare("UPDATE orchestration_executions SET scheduler_lease_expires_at = '2025-12-31T23:59:00.000Z' WHERE id = ?").run(execution.id);

    expect(service.recoverExpiredLeases('project')).toBe(1);
    expect((database.prepare('SELECT state FROM node_commands WHERE id = ? AND operation_key = ?').get(command.commandId, command.operationKey) as { state: string }).state).toBe('expired');
    const recovered = service.getExecution('project', execution.id).workItems.find((item) => item.id === child!.id);
    expect(recovered?.state).toBe('queued');
    expect(recovered?.machineId).toBeUndefined();
  });

  it('keeps an orchestration item running when its node command is uncertain', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'uncertain-recovery',
      name: 'Uncertain recovery',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'shared', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    const commandRow = database.prepare("SELECT id AS command_id, operation_key FROM node_commands WHERE kind = 'create_runtime_session'").get() as { command_id: string; operation_key: string };
    const now = clock.now().toISOString();
    database.prepare("UPDATE node_commands SET state = 'uncertain', expires_at = '2000-01-01T00:00:00.000Z', updated_at = ? WHERE id = ? AND operation_key = ?").run(now, commandRow.command_id, commandRow.operation_key);
    database.prepare("UPDATE orchestration_executions SET scheduler_lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(execution.id);

    expect(service.recoverExpiredLeases('project')).toBe(1);
    const stored = database.prepare('SELECT state FROM node_commands WHERE id = ? AND operation_key = ?').get(commandRow.command_id, commandRow.operation_key) as { state: string };
    const recovered = service.getExecution('project', execution.id).workItems.find((item) => item.id === child!.id);
    expect(stored.state).toBe('uncertain');
    expect(recovered?.state).toBe('running');
    expect(recovered?.machineId).toBe('machine-a');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'create_runtime_session'").get() as { count: number }).count).toBe(1);
  });

  it('queues isolated worktree cleanup when setup completed before cancel', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'cancel-cleanup', name: 'Cancel cleanup', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1 } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const worktreeRow = database.prepare("SELECT id, payload_json FROM node_commands WHERE kind = 'create_worktree'").get() as { id: string; payload_json: string };
    const worktreeCommand = NodeCommandSchema.parse(JSON.parse(worktreeRow.payload_json) as unknown);
    if (worktreeCommand.kind !== 'create_worktree') throw new Error('Expected worktree command');
    const now = clock.now().toISOString();
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE id = ? AND operation_key = ?").run(now, now, worktreeCommand.commandId, worktreeCommand.operationKey);
    service.cancel('project', execution.id, 'user');
    const cleanup = database.prepare("SELECT payload_json, state FROM node_commands WHERE kind = 'remove_worktree'").get() as { payload_json: string; state: string };
    const cleanupCommand = NodeCommandSchema.parse(JSON.parse(cleanup.payload_json) as unknown);
    expect(cleanupCommand.kind).toBe('remove_worktree');
    expect(cleanup.state).toBe('queued');
  });

  it('waits for failed isolated worktree cleanup before retrying a child', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'retry-cleanup', name: 'Retry cleanup', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1, maxRetries: 1 } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId)!;
    const now = clock.now().toISOString();
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE kind = 'create_worktree'").run(now, now);
    service.tick('project');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'create_runtime_session'").run(JSON.stringify({ runtimeSessionId: 'retry-runtime' }), now, now);
    service.tick('project');
    database.prepare("UPDATE node_commands SET state = 'failed', error_summary = 'turn failed', completed_at = ?, updated_at = ? WHERE kind = 'send_message' AND operation_key LIKE '%:turn:%'").run(now, now);
    service.tick('project');
    expect(service.childStatus('project', execution.id, child.id).state).toBe('queued');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'remove_worktree'").get() as { count: number }).count).toBe(0);
    const cancel = database.prepare("SELECT id FROM node_commands WHERE kind = 'cancel'").get() as { id: string };
    expect(cancel).toBeDefined();
    service.tick('project');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'create_worktree'").get() as { count: number }).count).toBe(1);
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, cancel.id);
    service.tick('project');
    const remove = database.prepare("SELECT id FROM node_commands WHERE kind = 'remove_worktree'").get() as { id: string };
    expect(remove).toBeDefined();
    service.tick('project');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'create_worktree'").get() as { count: number }).count).toBe(1);
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, remove.id);
    service.tick('project');
    expect((database.prepare('SELECT state FROM worktrees ORDER BY created_at LIMIT 1').get() as { state: string }).state).toBe('removed');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'create_worktree'").get() as { count: number }).count).toBe(2);
  });

  it('reconciles terminal remove-worktree commands into truthful worktree state', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'remove-reconcile', name: 'Remove reconcile', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1 } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const worktreeRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_worktree'").get() as { payload_json: string };
    const worktreeCommand = NodeCommandSchema.parse(JSON.parse(worktreeRow.payload_json) as unknown);
    if (worktreeCommand.kind !== 'create_worktree') throw new Error('Expected worktree command');
    const now = clock.now().toISOString();
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE kind = 'create_worktree'").run(now, now);
    service.cancel('project', execution.id, 'user');
    const removeRow = database.prepare("SELECT id, operation_key, payload_json FROM node_commands WHERE kind = 'remove_worktree'").get() as { id: string; operation_key: string; payload_json: string };
    const removeCommand = NodeCommandSchema.parse(JSON.parse(removeRow.payload_json) as unknown);
    if (removeCommand.kind !== 'remove_worktree') throw new Error('Expected remove command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, removeRow.id);
    service.tick('project');
    expect((database.prepare('SELECT state FROM worktrees').get() as { state: string }).state).toBe('removed');

    database.prepare(`INSERT INTO worktrees(id, project_id, repository_id, machine_id, path_reference, branch, base_revision, state, created_at, updated_at)
      VALUES ('failed-worktree', 'project', 'repository', 'machine-a', '.dhole/worktrees/failed', 'dhole/failed', 'main', 'ready', ?, ?)`).run(now, now);
    database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at, completed_at)
      VALUES ('failed-remove', 'machine-a', 'project', 'orchestration:failed:work:item:remove_worktree:1', 'remove_worktree', ?, 'failed', ?, ?, ?, ?)`)
      .run(JSON.stringify({ kind: 'remove_worktree', commandId: 'failed-remove', operationKey: 'orchestration:failed:work:item:remove_worktree:1', issuedAt: now, expiresAt: now, repositoryId: 'repository', relativeTarget: '.dhole/worktrees/failed' }), now, now, now, now);
    service.tick('project');
    expect((database.prepare("SELECT state FROM worktrees WHERE id = 'failed-worktree'").get() as { state: string }).state).toBe('failed');
  });

  it('defers isolated worktree cleanup until runtime cancellation is terminal', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'cancel-runtime-cleanup', name: 'Cancel runtime cleanup', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1 } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const now = clock.now().toISOString();
    const worktreeRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_worktree'").get() as { payload_json: string };
    const worktree = NodeCommandSchema.parse(JSON.parse(worktreeRow.payload_json) as unknown);
    if (worktree.kind !== 'create_worktree') throw new Error('Expected worktree command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE kind = 'create_worktree'").run(now, now);
    service.tick('project');
    const runtimeRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const runtime = NodeCommandSchema.parse(JSON.parse(runtimeRow.payload_json) as unknown);
    if (runtime.kind !== 'create_runtime_session') throw new Error('Expected runtime command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'create_runtime_session'").run(JSON.stringify({ runtimeSessionId: 'cancel-runtime' }), now, now);
    service.tick('project');
    service.cancel('project', execution.id, 'user');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'remove_worktree'").get() as { count: number }).count).toBe(0);
    database.prepare("UPDATE node_commands SET state = 'failed', error_summary = 'runtime still active', completed_at = ?, updated_at = ? WHERE kind = 'cancel'").run(now, now);
    service.tick('project');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'remove_worktree'").get() as { count: number }).count).toBe(0);
    database.prepare("UPDATE node_commands SET state = 'completed', error_summary = NULL, result_json = '{}', completed_at = ?, updated_at = ? WHERE kind = 'cancel'").run(now, now);
    service.tick('project');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'remove_worktree'").get() as { count: number }).count).toBe(1);
  });

  it('defers work when a connected machine has no runtime registration', () => {
    const { database, service } = fixture();
    database.prepare("UPDATE machines SET status = 'disconnected' WHERE id IN ('machine-a', 'machine-b')").run();
    database.prepare("INSERT INTO machines(id, team_id, name, status, available_slots, created_at, updated_at) VALUES ('machine-no-runtime', 'team', 'No runtime', 'connected', 1, ?, ?)").run(clock.now().toISOString(), clock.now().toISOString());
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'no-runtime',
      name: 'No runtime',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'shared', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child?.state).toBe('queued');
    expect((database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count).toBe(0);
  });

  it('respects machine slots across workers in one execution', () => {
    const { database, service } = fixture();
    database.prepare("UPDATE machines SET status = 'disconnected' WHERE id = 'machine-b'").run();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'one-slot',
      name: 'One slot',
      createdBy: 'user',
      config: { fake: false, initialChildren: 2, workspacePolicy: 'shared', limits: { maxConcurrency: 2 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const children = service.getExecution('project', execution.id).workItems.filter((item) => item.parentWorkItemId);
    expect(children.filter((item) => item.state === 'running')).toHaveLength(1);
    expect(children.filter((item) => item.state === 'queued')).toHaveLength(1);
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE state NOT IN ('completed', 'failed', 'cancelled', 'expired')").get() as { count: number }).count).toBe(1);
  });

  it('does not place work on an eligible machine from another team', () => {
    const { database, service } = fixture();
    const now = clock.now().toISOString();
    database.prepare("UPDATE machines SET status = 'disconnected' WHERE id IN ('machine-a', 'machine-b')").run();
    database.prepare("INSERT INTO teams(id, name, created_at) VALUES ('team-other', 'Other', ?)").run(now);
    database.prepare("INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES ('project-other', 'team-other', 'Other project', 'user', ?, ?)").run(now, now);
    database.prepare("INSERT INTO machines(id, team_id, name, status, available_slots, created_at, updated_at) VALUES ('machine-other', 'team-other', 'Other machine', 'connected', 1, ?, ?)").run(now, now);
    database.prepare("INSERT INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, available, observed_at) VALUES ('runtime-other', 'machine-other', 'fake', 'Fake other', '1', '{}', 1, ?)").run(now);
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'team-placement',
      name: 'Team placement',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, eligibleMachineIds: ['machine-other'], workspacePolicy: 'shared' },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child?.state).toBe('queued');
    expect(child?.machineId).toBeUndefined();
    expect((database.prepare('SELECT count(*) AS count FROM node_commands').get() as { count: number }).count).toBe(0);
  });

  it('spawns two deterministic fake children and aggregates their result', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'fake', name: 'Fake', createdBy: 'user', config: { fake: true, limits: { maxConcurrency: 1 } } });
    service.activateProfileVersion('project', profile.profile.id, profile.version.id, 'user');
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, actorUserId: 'user' });
    expect(execution.state).toBe('settled');
    expect(execution.workItems.filter((item) => item.parentWorkItemId)).toHaveLength(2);
    expect(execution.result?.workItems).toHaveLength(2);
    expect((database.prepare("SELECT count(*) AS n FROM node_commands WHERE state = 'completed'").get() as { n: number }).n).toBe(2);
    const events = database.prepare("SELECT event_kind, payload_json FROM event_log WHERE project_id = 'project'").all() as Array<{ event_kind: string; payload_json: string }>;
    expect(events.filter((event) => event.event_kind.startsWith('child.') || event.event_kind.startsWith('run.')).every((event) => JSON.parse(event.payload_json).sessionId === 'session')).toBe(true);
  });

  it('blocks and later retries a child through native Coordination conflicts', () => {
    const { database, context } = fixture();
    const nativeCoordination = createCoordinationService(database, clock, secureIds, { events: context.events });
    const coordination: CoordinationApi = {
      reserveClaim: (projectId, input) => nativeCoordination.reserveClaim(projectId, input as unknown as Parameters<typeof nativeCoordination.reserveClaim>[1]),
      releaseClaim: (projectId, claimId, capability) => nativeCoordination.releaseClaim(projectId, claimId, capability),
    };
    const service = new OrchestrationService(context, { coordination });
    const existing = nativeCoordination.startSession('project', { agent: 'existing-worker' });
    const claim = nativeCoordination.createClaim('project', { sessionId: existing.id, capability: existing.capability!, intent: 'existing work', files: ['src/shared.ts'] });
    const profile = service.createProfile({ projectId: 'project', stableKey: 'native-conflict', name: 'Native conflict', createdBy: 'user', config: { fake: false, initialChildren: 0, workspacePolicy: 'shared', limits: { maxConcurrency: 2 } } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    const child = service.createChild({ projectId: 'project', executionId: execution.id, objective: 'conflicting work', claimScope: { files: ['src/shared.ts'] } });

    service.tick('project');
    expect(service.childStatus('project', execution.id, child.id).state).toBe('blocked');
    expect((database.prepare("SELECT count(*) AS count FROM coordination_claims WHERE work_item_id = ?").get(child.id) as { count: number }).count).toBe(0);

    nativeCoordination.releaseClaim('project', claim.claim.id, existing.capability!);
    service.tick('project');
    expect(service.childStatus('project', execution.id, child.id).state).toBe('running');
    expect((database.prepare("SELECT count(*) AS count FROM coordination_claims WHERE work_item_id = ?").get(child.id) as { count: number }).count).toBe(1);
  });

  it('redacts and bounds runtime results before persistence and events', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'redacted-result', name: 'Redacted result', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'shared' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    const createRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const createCommand = NodeCommandSchema.parse(JSON.parse(createRow.payload_json) as unknown);
    if (createCommand.kind !== 'create_runtime_session') throw new Error('Expected runtime command');
    const now = clock.now().toISOString();
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND operation_key = ?").run(JSON.stringify({ runtimeSessionId: 'result-runtime' }), now, now, createCommand.commandId, createCommand.operationKey);
    service.tick('project');
    const turnRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'send_message' AND operation_key LIKE '%:turn:%'").get() as { payload_json: string };
    const turnCommand = NodeCommandSchema.parse(JSON.parse(turnRow.payload_json) as unknown);
    if (turnCommand.kind !== 'send_message') throw new Error('Expected objective command');
    const result = { apiKey: 'sk-sensitive-value', nested: { authorization: 'Bearer sensitive-value' }, long: 'x'.repeat(10_000) };
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND operation_key = ?").run(JSON.stringify(result), now, now, turnCommand.commandId, turnCommand.operationKey);
    service.tick('project');
    service.tick('project');
    const settled = service.childStatus('project', execution.id, child!.id);
    expect(settled.result?.apiKey).toBe('[REDACTED]');
    expect(settled.result?.nested).toEqual({ authorization: '[REDACTED]' });
    expect(String(settled.result?.long)).toHaveLength(4_096);
    const event = database.prepare("SELECT payload_json FROM event_log WHERE event_kind = 'child.state.changed' ORDER BY project_sequence DESC LIMIT 1").get() as { payload_json: string };
    expect(JSON.stringify(JSON.parse(event.payload_json))).not.toContain('sensitive-value');
  });

  it('redacts credentials from outbound runtime messages without changing ordinary emails', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'redacted-message', name: 'Redacted message', createdBy: 'user', config: { fake: false, initialChildren: 1, workspacePolicy: 'shared' } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    const now = clock.now().toISOString();
    const createRow = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const createCommand = NodeCommandSchema.parse(JSON.parse(createRow.payload_json) as unknown);
    if (createCommand.kind !== 'create_runtime_session') throw new Error('Expected runtime command');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'create_runtime_session'")
      .run(JSON.stringify({ runtimeSessionId: 'message-runtime' }), now, now);
    service.tick('project');
    service.sendMessage('project', execution.id, child!.id, 'owner@example.com Authorization: Bearer super-secret-token api-key="sk-message-secret" password=hunter2 -----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----');
    const row = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'send_message' AND operation_key LIKE '%:message:%' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string };
    const command = NodeCommandSchema.parse(JSON.parse(row.payload_json) as unknown);
    if (command.kind !== 'send_message') throw new Error('Expected message command');
    expect(command.message).toContain('owner@example.com');
    expect(command.message).not.toContain('super-secret-token');
    expect(command.message).not.toContain('sk-message-secret');
    expect(command.message).not.toContain('hunter2');
    expect(command.message).not.toContain('private material');
  });

  it('pauses before scheduling and resumes deterministically', () => {
    const { service } = fixture();
    const profile = service.createProfile({ projectId: 'project', stableKey: 'pause', name: 'Pause', createdBy: 'user', config: { fake: true } });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, actorUserId: 'user', autoTick: false });
    service.pause('project', execution.id, 'user');
    expect(service.getExecution('project', execution.id).state).toBe('paused');
    service.resume('project', execution.id, 'user');
    expect(service.getExecution('project', execution.id).state).toBe('settled');
  });

  it('uses structured follow-up and cancel commands for a real runtime path', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'runtime',
      name: 'Runtime',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'shared', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, actorUserId: 'user', autoTick: false });
    service.tick('project');
    const child = service.getExecution('project', execution.id).workItems.find((item) => item.parentWorkItemId);
    expect(child).toBeDefined();
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'create_runtime_session'")
      .run(JSON.stringify({ runtimeSessionId: 'runtime-session-1' }), clock.now().toISOString(), clock.now().toISOString());
    service.tick('project');
    service.sendMessage('project', execution.id, child!.id, 'review the result');
    service.cancelChild('project', execution.id, child!.id);
    const rows = database.prepare('SELECT kind, payload_json, state FROM node_commands ORDER BY rowid').all() as Array<{ kind: string; payload_json: string; state: string }>;
    expect(rows.map((row) => row.kind)).toEqual(['create_runtime_session', 'send_message', 'send_message', 'cancel']);
    for (const row of rows) expect(NodeCommandSchema.safeParse(JSON.parse(row.payload_json) as unknown).success).toBe(true);
    expect(rows.at(-1)?.state).toBe('queued');
    expect(service.getExecution('project', execution.id).state).toBe('cancelled');
  });

  it('creates an isolated worktree before starting the runtime session', () => {
    const { database, service } = fixture();
    const profile = service.createProfile({
      projectId: 'project',
      stableKey: 'isolated-runtime',
      name: 'Isolated runtime',
      createdBy: 'user',
      config: { fake: false, initialChildren: 1, workspacePolicy: 'isolated', limits: { maxConcurrency: 1 } },
    });
    const execution = service.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id, actorUserId: 'user', autoTick: false });
    service.tick('project');
    const worktreeCommand = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_worktree'").get() as { payload_json: string };
    const worktree = NodeCommandSchema.parse(JSON.parse(worktreeCommand.payload_json) as unknown);
    expect(worktree.kind).toBe('create_worktree');
    if (worktree.kind !== 'create_worktree') throw new Error('Expected worktree command');
    expect(worktree.baseRevision).toBe('main');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = '{}', completed_at = ?, updated_at = ? WHERE kind = 'create_worktree'")
      .run(clock.now().toISOString(), clock.now().toISOString());
    service.tick('project');
    const createCommand = database.prepare("SELECT payload_json FROM node_commands WHERE kind = 'create_runtime_session'").get() as { payload_json: string };
    const create = NodeCommandSchema.parse(JSON.parse(createCommand.payload_json) as unknown);
    expect(create.kind).toBe('create_runtime_session');
    if (create.kind !== 'create_runtime_session') throw new Error('Expected runtime create command');
    expect(create.cwd).toBe(worktree.relativeTarget);
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'create_runtime_session'")
      .run(JSON.stringify({ runtimeSessionId: 'runtime-session-isolated' }), clock.now().toISOString(), clock.now().toISOString());
    service.tick('project');
    database.prepare("UPDATE node_commands SET state = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE kind = 'send_message'")
      .run(JSON.stringify({ text: 'isolated result' }), clock.now().toISOString(), clock.now().toISOString());
    service.tick('project');
    service.tick('project');
    expect(service.getExecution('project', execution.id).state).toBe('settled');
    expect((database.prepare('SELECT state FROM worktrees').get() as { state: string }).state).toBe('settled');
  });
});
