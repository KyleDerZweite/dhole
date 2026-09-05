import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CoordinationService, CoordinationError, BlockingOverlapError } from './service.js';
import { checkOverlap, normalizePath, pathsOverlap, pairConflicts } from './overlap.js';

const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids = { id: (() => { let n = 0; return () => `id-${++n}`; })(), token: (() => { let n = 0; return () => `capability-token-${++n}`; })() };

function fixture(customClock: { now: () => Date } = clock): { db: Database.Database; service: CoordinationService } {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY);
    INSERT INTO teams(id) VALUES ('team');
    CREATE TABLE users (id TEXT PRIMARY KEY, disabled_at TEXT);
    CREATE TABLE team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (team_id, user_id));
    CREATE TABLE machines (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, team_id TEXT NOT NULL);
    INSERT INTO projects(id, team_id) VALUES ('p', 'team');
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    INSERT INTO sessions(id, project_id) VALUES ('run-session', 'p');
    INSERT INTO runs(id, session_id) VALUES ('run-1', 'run-session'), ('run-2', 'run-session');
    CREATE TABLE coordination_sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT, machine_id TEXT, agent_label TEXT NOT NULL,
      developer_label TEXT, worktree_hash TEXT, capability_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE coordination_claims (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, coordination_session_id TEXT NOT NULL, run_id TEXT,
      work_item_id TEXT, intent TEXT NOT NULL, task TEXT, worktree_hash TEXT, branch TEXT, base_revision TEXT,
      status TEXT NOT NULL, blocked_on TEXT, summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE coordination_claim_files (claim_id TEXT NOT NULL, normalized_path TEXT NOT NULL, PRIMARY KEY (claim_id, normalized_path));
    CREATE TABLE coordination_claim_components (claim_id TEXT NOT NULL, normalized_component TEXT NOT NULL, PRIMARY KEY (claim_id, normalized_component));
    CREATE TABLE coordination_findings (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, kind TEXT, text TEXT NOT NULL, files_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_conflicts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, claim_id TEXT NOT NULL, conflicting_claim_id TEXT NOT NULL, severity TEXT NOT NULL, reasons_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE coordination_repo_reports (session_id TEXT PRIMARY KEY, branch TEXT, revision TEXT, dirty_files_json TEXT NOT NULL DEFAULT '[]', reported_at TEXT NOT NULL);
    CREATE TABLE coordination_claim_settlements (claim_id TEXT PRIMARY KEY, commits_json TEXT NOT NULL DEFAULT '[]', prs_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE coordination_agent_executions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, run_hash TEXT NOT NULL, agent_hash TEXT NOT NULL,
      parent_hash TEXT, parent_execution_id TEXT, harness TEXT NOT NULL, name TEXT, role TEXT, task TEXT,
      state TEXT NOT NULL, state_reason TEXT, provenance TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
      UNIQUE(project_id, run_hash, agent_hash)
    );
    CREATE TABLE coordination_agent_events (
      project_id TEXT NOT NULL, event_id TEXT NOT NULL, execution_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(project_id, event_id)
    );
    CREATE INDEX coordination_claim_files_lookup ON coordination_claim_files(normalized_path);
    CREATE INDEX coordination_claim_components_lookup ON coordination_claim_components(normalized_component);
  `);
  db.exec(readFileSync(new URL('../../../migrations/012_coordination_integrity.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO users(id) VALUES ('user-one'), ('user-two'); INSERT INTO team_members VALUES ('team', 'user-one', 'member', '2026-01-01'), ('team', 'user-two', 'member', '2026-01-01');");
  return { db, service: new CoordinationService(db, customClock, ids) };
}

describe('coordination overlap', () => {
  it('normalizes exact and prefix paths', () => {
    expect(normalizePath('.\\src//api/./route.ts')).toBe('src/api/route.ts');
    expect(pathsOverlap('src/api', 'src/api/route.ts')).toBe(true);
    expect(pathsOverlap('src/apis', 'src/api/route.ts')).toBe(false);
  });

  it('matches components case-insensitively and tasks on two tokens only', () => {
    const claims = [{ id: 'a', coordinationSessionId: 'one', scope: { files: [], components: ['Gateway'], intent: 'Improve quota view' } }];
    expect(checkOverlap(claims, { files: [], components: ['gateway'], intent: 'anything' })).toHaveLength(1);
    expect(checkOverlap([{ id: 'b', coordinationSessionId: 'two', scope: { files: [], components: [], intent: 'repair auth token refresh' } }], { files: [], components: [], intent: 'update auth token' })).toHaveLength(1);
  });

  it('detects independent sessions sharing a non-empty worktree', () => {
    const claims = [{ id: 'a', coordinationSessionId: 'one', scope: { files: ['src/a.ts'], components: [], intent: 'x', worktree: 'same' } }];
    expect(checkOverlap(claims, { files: ['src/a.ts'], components: [], intent: 'x', worktree: 'same' })).toHaveLength(1);
    expect(pairConflicts([...claims, { ...claims[0]!, id: 'b', coordinationSessionId: 'two' }])).toHaveLength(1);
  });
});

describe('coordination service', () => {
  it('keeps claims after transport end and allows same user/worktree adoption', () => {
    const { service } = fixture();
    const first = service.startSession('p', { agent: 'codex', userId: 'user-one', developer: 'dev', worktree: '/private/checkout', capability: 'first-capability' });
    const firstCapability = first.capability!;
    const claim = service.createClaim('p', { sessionId: first.id, capability: firstCapability, intent: 'edit API', files: ['src/a.ts'] }).claim;
    service.endSession('p', first.id, firstCapability);
    const second = service.startSession('p', { agent: 'codex', userId: 'user-one', developer: 'dev', worktree: '/private/checkout', capability: 'second-capability' });
    const updated = service.updateClaim('p', claim.id, { capability: second.capability!, status: 'testing' });
    expect(updated.status).toBe('testing');
    expect(service.getState('p').claims).toHaveLength(1);
    expect(service.getState('p').sessions[0]?.worktree).toMatch(/^wt_/);
  });

  it('rejects foreign machine and inactive user attribution at session creation', () => {
    const { db, service } = fixture();
    db.prepare('INSERT INTO teams(id) VALUES (?)').run('other-team');
    db.prepare('INSERT INTO users(id, disabled_at) VALUES (?, NULL), (?, ?)').run('same-team-user', 'disabled-user', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, \'member\', ?), (?, ?, \'member\', ?)').run('team', 'same-team-user', clock.now().toISOString(), 'other-team', 'disabled-user', clock.now().toISOString());
    db.prepare('INSERT INTO machines(id, team_id, status) VALUES (?, ?, ?), (?, ?, ?)').run('foreign-machine', 'other-team', 'enrolled', 'same-team-machine', 'team', 'enrolled');
    expect(() => service.startSession('p', { agent: 'one', machineId: 'foreign-machine' })).toThrowError(CoordinationError);
    expect(() => service.startSession('p', { agent: 'one', userId: 'disabled-user' })).toThrowError(CoordinationError);
    expect(service.startSession('p', { agent: 'one', machineId: 'same-team-machine', userId: 'same-team-user' }).active).toBe(true);
  });

  it('rejects absolute POSIX, Windows, and UNC paths before persistence', () => {
    const { db, service } = fixture();
    const session = service.startSession('p', { agent: 'one' });
    for (const file of ['/tmp/secrets.txt', 'C:\\tmp\\secrets.txt', '\\\\server\\share\\secrets.txt']) {
      expect(() => service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'unsafe path', files: [file] })).toThrowError(CoordinationError);
      expect(() => service.heartbeat('p', session.id, { capability: session.capability!, dirtyFiles: [file] })).toThrowError(CoordinationError);
    }
    expect((db.prepare('SELECT count(*) AS n FROM coordination_claims').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM coordination_repo_reports').get() as { n: number }).n).toBe(0);
  });

  it('rejects parent traversal in claim, dirty-file, and overlap paths', () => {
    const { db, service } = fixture();
    const session = service.startSession('p', { agent: 'one' });
    for (const file of ['../secrets.txt', 'src/../secrets.txt', '..\\secrets.txt', 'src\\..\\secrets.txt']) {
      expect(() => service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'unsafe path', files: [file] })).toThrowError(CoordinationError);
      expect(() => service.heartbeat('p', session.id, { capability: session.capability!, dirtyFiles: [file] })).toThrowError(CoordinationError);
      expect(() => checkOverlap([], { files: [file], components: [], intent: 'unsafe path' })).toThrow(/traversal/u);
    }
    expect((db.prepare('SELECT count(*) AS n FROM coordination_claims').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM coordination_repo_reports').get() as { n: number }).n).toBe(0);
  });

  it('rejects run IDs missing from or outside the project', () => {
    const { service, db } = fixture();
    db.prepare('INSERT INTO projects(id, team_id) VALUES (?, ?)').run('other-project', 'team');
    db.prepare('INSERT INTO sessions(id, project_id) VALUES (?, ?)').run('other-run-session', 'other-project');
    db.prepare('INSERT INTO runs(id, session_id) VALUES (?, ?)').run('run-other-project', 'other-run-session');
    const session = service.startSession('p', { agent: 'one' });
    expect(() => service.createClaim('p', { sessionId: session.id, capability: session.capability!, runId: 'run-other-project', intent: 'outside run' })).toThrowError(CoordinationError);
    expect(() => service.recordAgentEvent('p', { eventId: 'outside-run', runId: 'native-run', agentId: 'agent', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' }, 'run-other-project')).toThrowError(CoordinationError);
    expect(service.recordAgentEvent('p', { eventId: 'native-run', runId: 'native-run', agentId: 'agent', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' }).execution.state).toBe('active');
    expect(() => service.getState('p', 'run-other-project')).toThrowError(CoordinationError);
    expect(() => service.check('p', { files: [], components: [], intent: 'outside run' }, 'run-other-project')).toThrowError(CoordinationError);
  });

  it('suppresses the same session but detects independent sessions in one checkout', () => {
    const { service } = fixture();
    const one = service.startSession('p', { agent: 'one', worktree: '/private/checkout' });
    const two = service.startSession('p', { agent: 'two', worktree: '/private/checkout' });
    service.createClaim('p', { sessionId: one.id, capability: one.capability!, intent: 'edit file', files: ['src/a.ts'] });
    const sameSession = service.createClaim('p', { sessionId: one.id, capability: one.capability!, intent: 'edit file', files: ['src/a.ts'] });
    expect(sameSession.conflicts).toHaveLength(0);
    const sameWorktree = service.createClaim('p', { sessionId: two.id, capability: two.capability!, intent: 'edit file', files: ['src/a.ts'] });
    expect(sameWorktree.conflicts).toHaveLength(2);
  });

  it('rejects expired session capabilities for claim mutation', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { service } = fixture({ now: () => new Date(current) });
    const session = service.startSession('p', { agent: 'one' });
    const claim = service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'edit file' }).claim;
    current = new Date('2026-01-01T00:05:00.000Z');
    expect(() => service.updateClaim('p', claim.id, { capability: session.capability!, status: 'testing' })).toThrowError(CoordinationError);
    expect(() => service.heartbeat('p', session.id, { capability: session.capability! })).toThrowError(CoordinationError);
  });

  it('keeps session end idempotent while requiring its capability', () => {
    const { service } = fixture();
    const session = service.startSession('p', { agent: 'one' });
    const ended = service.endSession('p', session.id, session.capability!);
    const repeated = service.endSession('p', session.id, session.capability!);
    expect(repeated.session.endedAt).toBe(ended.session.endedAt);
    expect(() => service.endSession('p', session.id)).toThrowError(CoordinationError);
  });

  it('returns advisory conflicts and rejects enforced blocking reservations atomically', () => {
    const { service, db } = fixture();
    const one = service.startSession('p', { agent: 'one' });
    const two = service.startSession('p', { agent: 'two' });
    service.createClaim('p', { sessionId: one.id, capability: one.capability!, intent: 'edit file', files: ['src/a.ts'] });
    const advisory = service.createClaim('p', { sessionId: two.id, capability: two.capability!, intent: 'edit file', files: ['src/a.ts'] });
    expect(advisory.conflicts[0]?.reasons[0]?.type).toBe('files');
    expect(() => service.reserveClaim('p', { sessionId: two.id, capability: two.capability!, intent: 'edit file', files: ['src/a.ts'] })).toThrow(BlockingOverlapError);
    expect((db.prepare('SELECT count(*) AS n FROM coordination_claims').get() as { n: number }).n).toBe(2);
  });

  it('settles claims and keeps findings', () => {
    const { service } = fixture();
    const session = service.startSession('p', { agent: 'one' });
    const capability = session.capability!;
    const claim = service.createClaim('p', { sessionId: session.id, capability, intent: 'edit file' }).claim;
    service.updateClaim('p', claim.id, { capability, finding: 'api key: sk-secret', findingKind: 'gotcha' });
    const complete = service.completeClaim('p', claim.id, { capability, commits: ['abc'], summary: 'done' });
    expect(complete.status).toBe('done');
    expect((complete as unknown as ClaimWithExtras).findings[0]?.text).toContain('[REDACTED]');
    expect(service.getState('p').completed[0]?.status).toBe('done');
  });

  it('backfills lineage when a child event arrives before its parent', () => {
    const { service } = fixture();
    const child = service.recordAgentEvent('p', {
      eventId: 'child-event',
      runId: 'run-1',
      agentId: 'child',
      parentAgentId: 'parent',
      harness: 'fixture',
      state: 'active',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    service.recordAgentEvent('p', {
      eventId: 'parent-event',
      runId: 'run-1',
      agentId: 'parent',
      harness: 'fixture',
      state: 'active',
      occurredAt: '2026-01-01T00:00:01.000Z',
    });
    expect(service.getState('p').agents.find((agent) => agent.id === child.execution.id)?.parentAvailable).toBe(true);
  });

  it('isolates run-scoped claims, conflicts, and agent state', () => {
    const { service } = fixture();
    const one = service.startSession('p', { agent: 'one' });
    const two = service.startSession('p', { agent: 'two' });
    const claimOne = service.createClaim('p', { sessionId: one.id, capability: one.capability!, runId: 'run-1', intent: 'edit one', files: ['src/one.ts'] }, 'run-1').claim;
    const secondClaim = service.createClaim('p', { sessionId: two.id, capability: two.capability!, runId: 'run-1', intent: 'edit one again', files: ['src/one.ts'] }, 'run-1').claim;
    const three = service.startSession('p', { agent: 'three' });
    service.createClaim('p', { sessionId: three.id, capability: three.capability!, runId: 'run-2', intent: 'edit two', files: ['src/two.ts'] }, 'run-2');
    service.recordAgentEvent('p', { eventId: 'run-1-event', runId: 'run-1', agentId: 'agent-one', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' }, 'run-1');
    service.recordAgentEvent('p', { eventId: 'run-2-event', runId: 'run-2', agentId: 'agent-two', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' }, 'run-2');
    const state = service.getState('p', 'run-1');
    expect(state.claims.map((claim) => claim.id)).toEqual(expect.arrayContaining([claimOne.id, secondClaim.id]));
    expect(state.claims).toHaveLength(2);
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]?.id).toBeTruthy();
    expect(state.conflicts.length).toBeGreaterThan(0);
    expect(service.getState('p', 'run-2').conflicts).toHaveLength(0);
    expect(() => service.updateClaim('p', claimOne.id, { capability: one.capability!, runId: 'run-2' }, 'run-2')).toThrowError(CoordinationError);
  });

  it('requires session proof and keeps cross-user adoption and failed updates from changing ownership', () => {
    const { service, db } = fixture();
    const first = service.startSession('p', { agent: 'one', userId: 'user-one', developer: 'shared label', worktree: 'checkout' });
    const claim = service.createClaim('p', { sessionId: first.id, capability: first.capability!, userId: 'user-one', intent: 'API', files: ['src/api'] }).claim;
    for (const capability of [undefined, 'wrong-capability']) {
      expect(() => service.heartbeat('p', first.id, { ...(capability ? { capability } : {}) })).toThrowError(CoordinationError);
      expect(() => service.reportRepo('p', first.id, { ...(capability ? { capability } : {}), dirtyFiles: [] })).toThrowError(CoordinationError);
      expect(() => service.endSession('p', first.id, capability)).toThrowError(CoordinationError);
      expect(() => service.check('p', { sessionId: first.id, files: ['src/api/route.ts'], components: [], intent: 'API' }, undefined, capability)).toThrowError(CoordinationError);
    }
    expect(() => service.updateClaim('p', claim.id, { capability: first.capability!, userId: 'user-two' })).toThrowError(CoordinationError);
    service.endSession('p', first.id, first.capability!);
    const other = service.startSession('p', { agent: 'two', userId: 'user-two', developer: 'shared label', worktree: 'checkout' });
    expect(() => service.updateClaim('p', claim.id, { capability: other.capability!, userId: 'user-two', status: 'testing' })).toThrowError(CoordinationError);
    const replacement = service.startSession('p', { agent: 'one', userId: 'user-one', developer: 'renamed user', worktree: 'checkout' });
    expect(() => service.updateClaim('p', claim.id, { capability: replacement.capability!, userId: 'user-one', blockedOn: 'missing' })).toThrowError(CoordinationError);
    expect((db.prepare('SELECT coordination_session_id FROM coordination_claims WHERE id = ?').get(claim.id) as { coordination_session_id: string }).coordination_session_id).toBe(first.id);
    expect(service.updateClaim('p', claim.id, { capability: replacement.capability!, userId: 'user-one', status: 'testing' }).coordinationSessionId).toBe(replacement.id);
  });

  it('detects sibling work items in one session and claims beyond the state preview', () => {
    const { service, db } = fixture();
    const session = service.startSession('p', { agent: 'orchestrator' });
    service.reserveClaim('p', { sessionId: session.id, capability: session.capability!, workItemId: 'child-one', intent: 'API', files: ['src/api'] });
    expect(() => service.reserveClaim('p', { sessionId: session.id, capability: session.capability!, workItemId: 'child-two', intent: 'API route', files: ['src/api/route.ts'] })).toThrowError(BlockingOverlapError);
    const limited = new CoordinationService(db, clock, ids, { maxStateItems: 1 });
    limited.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'unrelated', files: ['src/unrelated.ts'] });
    expect(limited.getState('p').claims).toHaveLength(1);
    expect(limited.check('p', { files: ['src/api/route.ts'], components: [], intent: 'route' })).toHaveLength(1);
  });

  it('revives expired claims under a new id, preserves findings, and merges completion retry evidence', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { service, db } = fixture({ now: () => new Date(current) });
    const first = service.startSession('p', { agent: 'one', userId: 'user-one', worktree: 'checkout' });
    const original = service.createClaim('p', { sessionId: first.id, capability: first.capability!, intent: 'repair auth', task: 'https://github.com/example/repo/issues/7', files: ['src/auth.ts'] }).claim;
    service.updateClaim('p', original.id, { capability: first.capability!, finding: 'The expired cookie loops', findingKind: 'root-cause' });
    current = new Date('2026-01-01T01:00:00.000Z');
    service.sweep('p');
    const terminal = db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(original.id);
    const replacement = service.startSession('p', { agent: 'one', userId: 'user-one', worktree: 'checkout' });
    expect(() => service.updateClaim('p', original.id, { capability: replacement.capability!, status: 'testing' })).toThrowError(CoordinationError);
    const revived = service.reviveClaim('p', original.id, { capability: replacement.capability!, status: 'testing' }).claim;
    expect(revived.id).not.toBe(original.id);
    expect(revived.scope.task).toBe(original.scope.task);
    expect((revived as unknown as ClaimWithExtras).findings[0]?.text).toBe('The expired cookie loops');
    expect(service.reviveClaim('p', original.id, { capability: replacement.capability! }).claim.id).toBe(revived.id);
    const complete = service.completeClaim('p', original.id, { capability: replacement.capability!, commits: ['abc'], summary: 'fixed' });
    expect(complete.id).toBe(revived.id);
    const settled = db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(revived.id);
    current = new Date('2026-01-01T01:00:01.000Z');
    const retry = service.completeClaim('p', original.id, { capability: replacement.capability!, commits: ['abc', 'def'], prs: ['https://github.com/example/repo/pull/8'], summary: 'must not replace original' });
    expect(retry).toMatchObject({ commits: ['abc', 'def'], prs: ['https://github.com/example/repo/pull/8'], summary: 'fixed' });
    expect(db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(original.id)).toEqual(terminal);
    expect(db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(revived.id)).toEqual(settled);
    expect(() => db.prepare("UPDATE coordination_claims SET status = 'testing' WHERE id = ?").run(original.id)).toThrow(/immutable/u);
  });

  it('releases blockers after settlement and keeps release retries immutable', () => {
    const { service, db } = fixture();
    const session = service.startSession('p', { agent: 'one' });
    const first = service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'first' }).claim;
    const blocked = service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'second', status: 'blocked', blockedOn: first.id }).claim;
    service.releaseClaim('p', first.id, session.capability!);
    const terminal = db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(first.id);
    service.releaseClaim('p', first.id, session.capability!);
    expect(db.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(first.id)).toEqual(terminal);
    expect(service.getState('p').claims.find((claim) => claim.id === blocked.id)).toMatchObject({ status: 'in-progress' });
    expect(service.getState('p').claims.find((claim) => claim.id === blocked.id)?.blockedOn).toBeUndefined();
  });

  it('ends transport waits without deleting the work when the owner session expires', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { service } = fixture({ now: () => new Date(current) });
    const owner = service.startSession('p', { agent: 'one' });
    const follower = service.startSession('p', { agent: 'two' });
    const first = service.createClaim('p', { sessionId: owner.id, capability: owner.capability!, intent: 'first', files: ['src/first.ts'] }).claim;
    const blocked = service.createClaim('p', { sessionId: follower.id, capability: follower.capability!, intent: 'second', status: 'blocked', blockedOn: first.id }).claim;
    current = new Date('2026-01-01T00:05:00.000Z');
    expect(() => service.heartbeat('p', owner.id, { capability: owner.capability! })).toThrowError(CoordinationError);
    const state = service.getState('p');
    expect(state.claims.find((claim) => claim.id === first.id)?.status).toBe('investigating');
    expect(state.claims.find((claim) => claim.id === blocked.id)?.blockedOn).toBeUndefined();
    expect(service.check('p', { files: ['src/first.ts'], components: [], intent: 'first' })).toHaveLength(1);
  });

  it('scopes lifecycle identity and retry ids to users and native runs without resolving cross-user parents', () => {
    const { service } = fixture();
    const event = { eventId: 'same-event', runId: 'native-run', agentId: 'parent', harness: 'fixture', state: 'active' as const, occurredAt: clock.now().toISOString() };
    const one = service.recordAgentEvent('p', { ...event, userId: 'user-one' });
    const child = service.recordAgentEvent('p', { ...event, eventId: 'child', agentId: 'child', parentAgentId: 'parent', userId: 'user-two' });
    expect(child.execution.parentAvailable).toBe(false);
    const two = service.recordAgentEvent('p', { ...event, userId: 'user-two' });
    expect(two.execution.id).not.toBe(one.execution.id);
    expect(service.getState('p').agents.find((agent) => agent.id === child.execution.id)?.parentAvailable).toBe(true);
    expect(service.recordAgentEvent('p', { ...event, userId: 'user-one' }).idempotent).toBe(true);
    expect(() => service.recordAgentEvent('p', { ...event, userId: 'user-one', state: 'blocked' })).toThrowError(CoordinationError);
  });

  it('orders lifecycle events, clamps far-future times, and resumes terminal executions only on later events', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { service } = fixture({ now: () => new Date(current) });
    const event = { runId: 'native-run', agentId: 'one', userId: 'user-one', harness: 'fixture' };
    service.recordAgentEvent('p', { ...event, eventId: 'start', state: 'active', occurredAt: current.toISOString() });
    current = new Date('2026-01-01T00:00:10.000Z');
    const terminal = service.recordAgentEvent('p', { ...event, eventId: 'end', state: 'completed', occurredAt: current.toISOString() });
    const late = service.recordAgentEvent('p', { ...event, eventId: 'late', state: 'active', occurredAt: '2026-01-01T00:00:05.000Z' });
    expect(late.execution).toEqual(terminal.execution);
    current = new Date('2026-01-01T00:00:20.000Z');
    const resumed = service.recordAgentEvent('p', { ...event, eventId: 'resume', state: 'active', occurredAt: '2099-01-01T00:00:00.000Z' });
    expect(resumed.execution).toMatchObject({ id: terminal.execution.id, state: 'active', endedAt: null, updatedAt: current.toISOString() });
    current = new Date('2026-01-01T00:00:30.000Z');
    expect(service.recordAgentEvent('p', { ...event, eventId: 'wait', state: 'waiting', occurredAt: current.toISOString() }).execution.state).toBe('waiting');
    expect(() => service.recordAgentEvent('p', { ...event, eventId: 'invalid', state: 'active', occurredAt: 'not a timestamp' })).toThrowError(CoordinationError);
    expect(() => service.recordAgentEvent('p', { ...event, agentId: 'missing', eventId: 'old', state: 'active', occurredAt: '2025-01-01T00:00:00.000Z' })).toThrowError(CoordinationError);
    current = new Date('2026-01-01T01:00:00.000Z');
    expect(service.getState('p').agents[0]?.stale).toBe(true);
    expect(service.recordAgentEvent('p', { ...event, eventId: 'stale', state: 'completed', occurredAt: '2026-01-01T00:00:25.000Z' }).execution.state).toBe('waiting');
  });

  it('preserves terminal claims and executions across retries after event retention', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { db, service } = fixture({ now: () => new Date(current) });
    const session = service.startSession('p', { agent: 'one' });
    const claim = service.createClaim('p', { sessionId: session.id, capability: session.capability!, intent: 'edit one' }).claim;
    expect(service.completeClaim('p', claim.id, { capability: session.capability!, status: 'done' }).status).toBe('done');
    expect(service.completeClaim('p', claim.id, { capability: session.capability!, status: 'done' }).status).toBe('done');
    expect(() => service.completeClaim('p', claim.id, { capability: session.capability!, status: 'abandoned' })).toThrowError(CoordinationError);

    service.recordAgentEvent('p', { eventId: 'terminal-event', runId: 'run-1', agentId: 'agent-one', harness: 'fixture', state: 'completed', occurredAt: current.toISOString() });
    current = new Date('2026-01-10T00:00:00.000Z');
    service.sweep();
    const replay = service.recordAgentEvent('p', { eventId: 'late-event', runId: 'run-1', agentId: 'agent-one', harness: 'fixture', state: 'active', occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(replay.execution.state).toBe('completed');
    expect(replay.execution.endedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((db.prepare('SELECT count(*) AS n FROM coordination_agent_events').get() as { n: number }).n).toBe(1);
  });
});

type ClaimWithExtras = { findings: Array<{ text: string }> };
