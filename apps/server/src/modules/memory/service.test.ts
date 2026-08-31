import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secureIds, systemClock } from '../../lib/clock.js';
import { openDatabase, type DatabaseConnection } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import type { AppEnvironment, ServerContext } from '../../lib/module.js';
import { memoryModule } from './index.js';
import { MemoryAuthorizationError, MemoryConflictError, MemoryContentError, MemoryService } from './service.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(withEvents = false): { memory: MemoryService; close: () => void; userId: string; outsiderId: string; projectId: string; database: DatabaseConnection; events?: EventStore } {
  const directory = mkdtempSync(join(tmpdir(), 'dhole-memory-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'dhole.db'), systemClock);
  const userId = 'user-memory';
  const outsiderId = 'outsider-memory';
  const projectId = 'project-memory';
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-memory', 'Memory', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, 'memory@example.test', 'Memory', 'not-used', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(outsiderId, 'outsider@example.test', 'Outsider', 'not-used', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('team-memory', userId, 'administrator', '2026-08-30T00:00:00.000Z');
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, 'team-memory', 'Memory', userId, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  const events = withEvents ? new EventStore(database, systemClock, secureIds) : undefined;
  return { memory: new MemoryService(database, systemClock, secureIds, events), close: () => database.close(), userId, outsiderId, projectId, database, ...(events ? { events } : {}) };
}

describe('memory generations', () => {
  it('folds immutable entries and clears without deleting history', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'working', name: 'Working', scope: 'project' }, f.userId);
    const first = f.memory.fold(pack.id, {
      entryIds: [],
      reason: 'initial',
    }, f.userId);
    expect(first.entries).toHaveLength(0);
    const proposal = f.memory.propose(pack.id, {
      title: 'Use SQLite', body: 'Keep the database local', sourceType: 'decision', sourceReference: 'adr/1', evidence: {}, baseGenerationId: first.id,
    }, f.userId);
    f.memory.decideProposal(proposal.id, { decision: 'approve' }, f.userId);
    const second = f.memory.fold(pack.id, { baseGenerationId: first.id, proposalIds: [proposal.id] }, f.userId);
    expect(second.entries[0]?.body).toContain('local');
    expect(f.memory.getPack(pack.id).activeGenerationId).toBe(second.id);
    expect(f.memory.listGenerations(pack.id)).toHaveLength(2);
    expect(() => f.memory.readContext(pack.id, { generationId: first.id })).toThrow(/Archived/);
    expect(f.memory.readContext(pack.id, { generationId: first.id, includeArchived: true }).entries).toHaveLength(0);
    const cleared = f.memory.clear(pack.id, f.userId, second.id);
    expect(cleared.entries).toHaveLength(0);
    expect(f.memory.listGenerations(pack.id)).toHaveLength(3);
    f.close();
  });

  it('rejects a stale fold base and searches active memory only', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'search', name: 'Search', scope: 'project' }, f.userId);
    const first = f.memory.fold(pack.id, { reason: 'initial' }, f.userId);
    // A direct row makes the FTS path exercise a non-empty active generation.
    const generation = f.memory.fold(pack.id, { baseGenerationId: first.id, reason: 'entry' }, f.userId);
    expect(() => f.memory.fold(pack.id, { baseGenerationId: first.id }, f.userId)).toThrow(MemoryConflictError);
    expect(f.memory.search(f.projectId, 'anything OR *', f.userId)).toEqual([]);
    expect(generation.contentHash).toMatch(/^[a-f0-9]{64}$/);
    f.close();
  });

  it('commits a proposal decision and its lifecycle event atomically', async () => {
    const f = fixture(true);
    const events = f.events!;
    const pack = f.memory.createPack(f.projectId, { stableKey: 'decisions', name: 'Decisions', scope: 'project' }, f.userId);
    const proposal = f.memory.propose(pack.id, {
      title: 'Use SQLite', body: 'Keep the database local', sourceType: 'decision', sourceReference: 'adr/1', evidence: {},
    }, f.userId);
    const decided = f.memory.decideProposal(proposal.id, { decision: 'approve', reason: 'Reviewed api_key=memory-secret (https://user:pass@example.test)' }, f.userId);
    expect(decided).toMatchObject({ state: 'approved', decidedBy: f.userId, decisionReason: 'Reviewed api_key=[REDACTED] (https://[REDACTED]@example.test)' });
    expect(f.database.prepare('SELECT decision_reason FROM memory_proposals WHERE id = ?').get(proposal.id)).toEqual({ decision_reason: 'Reviewed api_key=[REDACTED] (https://[REDACTED]@example.test)' });
    const decisionEvents = events.listAfter(f.projectId, 0).filter((event) => event.payload.proposalId === proposal.id && event.payload.state === 'approved');
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]).toMatchObject({
      eventKind: 'memory.decided',
      aggregateType: 'memory_pack',
      aggregateId: pack.id,
      actor: { type: 'user', userId: f.userId },
      payload: { proposalId: proposal.id, decision: 'approve', state: 'approved', reason: 'Reviewed api_key=[REDACTED] (https://[REDACTED]@example.test)' },
    });
    expect(() => f.memory.decideProposal(proposal.id, { decision: 'reject' }, f.userId)).toThrow(MemoryConflictError);
    expect(events.listAfter(f.projectId, 0).filter((event) => event.payload.proposalId === proposal.id)).toHaveLength(2);
    await Promise.resolve();
    f.close();
  });

  it('rolls back a proposal decision when its event append fails', async () => {
    const f = fixture(true);
    const events = f.events!;
    const pack = f.memory.createPack(f.projectId, { stableKey: 'rollback', name: 'Rollback', scope: 'project' }, f.userId);
    const proposal = f.memory.propose(pack.id, {
      title: 'Use SQLite', body: 'Keep the database local', sourceType: 'decision', sourceReference: 'adr/1', evidence: {},
    }, f.userId);
    const before = events.listAfter(f.projectId, 0).length;
    const append = vi.spyOn(events, 'append').mockImplementation(() => { throw new Error('forced event append failure'); });
    expect(() => f.memory.decideProposal(proposal.id, { decision: 'approve' }, f.userId)).toThrow('forced event append failure');
    expect(append).toHaveBeenCalledTimes(1);
    const pending = f.memory.getProposal(proposal.id, f.userId);
    expect(pending.state).toBe('pending');
    expect(pending.decidedBy).toBeUndefined();
    expect(pending.decidedAt).toBeUndefined();
    expect(events.listAfter(f.projectId, 0)).toHaveLength(before);
    append.mockRestore();
    await Promise.resolve();
    f.close();
  });

  it('does not activate an unreviewed draft generation', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'review', name: 'Review', scope: 'project' }, f.userId);
    const draftId = 'draft-memory-generation';
    f.database.prepare(`
      INSERT INTO memory_generations(id, pack_id, generation, content_hash, state, created_by, created_at)
      VALUES (?, ?, 1, ?, 'draft', ?, ?)
    `).run(draftId, pack.id, 'a'.repeat(64), f.userId, '2026-08-30T00:00:00.000Z');
    expect(() => f.memory.activateGeneration(pack.id, draftId, f.userId)).toThrow(/approved|archived/);
    f.close();
  });

  it('audits pack creation atomically with the pack row', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'audited', name: 'Audited', scope: 'project' }, f.userId);
    expect(f.database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records WHERE action = 'memory.pack.create'").get()).toMatchObject({
      actor_type: 'user', actor_id: f.userId, action: 'memory.pack.create', target_type: 'memory_pack', target_id: pack.id, detail_json: '{}',
    });

    f.database.exec(`CREATE TRIGGER fail_memory_pack_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'memory.pack.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => f.memory.createPack(f.projectId, { stableKey: 'rollback', name: 'Rollback', scope: 'project' }, f.userId)).toThrow('audit unavailable');
    expect(f.database.prepare("SELECT count(*) AS count FROM memory_packs WHERE stable_key = 'rollback'").get()).toEqual({ count: 0 });
    f.close();
  });

  it('rejects credential-bearing proposal fields while preserving technical text', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'safe-input', name: 'Safe input', scope: 'project' }, f.userId);
    const values = [
      { title: 'api_key=memory-secret', body: 'safe', sourceType: 'decision', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'Authorization: Bearer memory-secret', sourceType: 'decision', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'safe', sourceType: 'password=hunter2', sourceReference: 'adr/1' },
      { title: 'Architecture decision', body: 'safe', sourceType: 'decision', sourceReference: 'private-key=memory-secret' },
      { title: 'Architecture decision', body: 'safe', sourceType: 'decision', sourceReference: 'https://user:pass@example.test/adr/1' },
    ] as const;
    for (const value of values) {
      expect(() => f.memory.propose(pack.id, value, f.userId)).toThrow(MemoryContentError);
    }
    const safe = f.memory.propose(pack.id, {
      title: 'API key rotation design', body: 'Document the API key lifecycle without including its value', sourceType: 'decision', sourceReference: 'adr/1',
    }, f.userId);
    expect(safe.title).toBe('API key rotation design');
    expect(f.database.prepare('SELECT count(*) AS count FROM memory_proposals WHERE pack_id = ?').get(pack.id)).toEqual({ count: 1 });
    f.close();
  });

  it('rejects credential-bearing fold reasons before persisting generation metadata', () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'fold-reason', name: 'Fold reason', scope: 'project' }, f.userId);
    const initial = f.memory.fold(pack.id, { reason: 'initial' }, f.userId);
    expect(() => f.memory.fold(pack.id, { baseGenerationId: initial.id, reason: 'Authorization: Bearer fold-secret' }, f.userId)).toThrow(MemoryContentError);
    expect(() => f.memory.fold(pack.id, { baseGenerationId: initial.id, reason: 'Imported from https://user:pass@example.test' }, f.userId)).toThrow(MemoryContentError);
    expect(f.memory.getPack(pack.id).activeGenerationId).toBe(initial.id);
    expect(f.database.prepare('SELECT count(*) AS count FROM memory_generations WHERE pack_id = ?').get(pack.id)).toEqual({ count: 1 });
    f.close();
  });

  it('returns a typed 403 for cross-project service and route access', async () => {
    const f = fixture();
    const pack = f.memory.createPack(f.projectId, { stableKey: 'private', name: 'Private', scope: 'project' }, f.userId);
    expect(() => f.memory.getPack(pack.id, f.outsiderId)).toThrow(MemoryAuthorizationError);
    try {
      f.memory.getPack(pack.id, f.outsiderId);
    } catch (error) {
      expect(error).toMatchObject({ status: 403, statusCode: 403, code: 'memory_authorization_denied' });
    }

    const context: ServerContext = {
      config: { environment: 'test' } as ServerContext['config'],
      database: f.database,
      clock: systemClock,
      ids: secureIds,
      events: new EventStore(f.database, systemClock, secureIds),
    };
    const app = new Hono<AppEnvironment>();
    app.use('*', (c, next) => {
      c.set('user', { id: f.outsiderId, email: 'outsider@example.test', displayName: 'Outsider', role: 'member', teamId: 'other-team' });
      return next();
    });
    memoryModule.register(app, context);
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: 'internal_error' } }, 500));
    const response = await app.request(`/api/memory/packs/${pack.id}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'memory_authorization_denied' } });
    f.close();
  });
});
