import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.js';
import type { EventStore } from '../../lib/events.js';
import { systemClock, secureIds } from '../../lib/clock.js';
import type { Clock, IdSource } from '../../lib/clock.js';
import type { DatabaseConnection } from '../../lib/database.js';
import { redactSecrets, redactText } from '../../lib/security.js';
import {
  MemoryDecisionInputSchema,
  MemoryFoldInputSchema,
  MemoryPackInputSchema,
  MemoryProposalActorSchema,
  MemoryProposalInputSchema,
  MemoryReadOptionsSchema,
  type MemoryContext,
  type MemoryEntry,
  type MemoryFoldInput,
  type MemoryGeneration,
  type MemoryPack,
  type MemoryPackInput,
  type MemoryProposal,
  type MemoryProposalActor,
  type MemoryProposalInput,
  type MemoryReadOptions,
} from './types.js';

export class MemoryConflictError extends Error {
  readonly code = 'memory_generation_conflict';
  readonly statusCode = 409;
  constructor(message = 'The memory pack changed; retry from the current generation') {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

export class MemoryAuthorizationError extends HttpError {
  readonly statusCode = 403;
  constructor(message = 'You are not authorized to access this memory pack') {
    super(403, 'memory_authorization_denied', message);
    this.name = 'MemoryAuthorizationError';
  }
}

export class MemoryContentError extends HttpError {
  readonly statusCode = 422;
  constructor() {
    super(422, 'memory_secret_forbidden', 'Memory content must not contain credentials');
    this.name = 'MemoryContentError';
  }
}

interface PackRow {
  id: string;
  project_id: string;
  stable_key: string;
  name: string;
  scope: 'project' | 'role' | 'phase';
  scope_key: string | null;
  active_generation_id: string | null;
  created_at: string;
}

interface GenerationRow {
  id: string;
  pack_id: string;
  parent_generation_id: string | null;
  generation: number;
  content_hash: string;
  state: 'draft' | 'approved' | 'active' | 'archived';
  fold_reason: string | null;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  archived_at: string | null;
}

interface EntryRow {
  id: string;
  generation_id: string;
  ordinal: number;
  title: string;
  body: string;
  source_type: string;
  source_reference: string;
  evidence_json: string;
  content_hash: string;
  created_at: string;
}

interface ProposalRow {
  id: string;
  pack_id: string;
  base_generation_id: string | null;
  proposed_by_user_id: string | null;
  proposed_by_activation_id: string | null;
  title: string;
  body: string;
  source_type: string;
  source_reference: string;
  state: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface MemorySearchOptions {
  packId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export class MemoryService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdSource = secureIds,
    private readonly events?: EventStore,
  ) {}

  createPack(projectId: string, input: MemoryPackInput, userId: string): MemoryPack {
    const parsed = MemoryPackInputSchema.parse(input);
    this.assertProjectAccess(projectId, userId);
    if ((parsed.scope === 'project' && parsed.scopeKey) || (parsed.scope !== 'project' && !parsed.scopeKey)) {
      throw new Error('scopeKey is required for role/phase packs and forbidden for project packs');
    }
    const id = this.ids.id();
    const now = this.clock.now().toISOString();
    return this.runTransaction(() => {
      this.database
        .prepare('INSERT INTO memory_packs(id, project_id, stable_key, name, scope, scope_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, parsed.stableKey, parsed.name, parsed.scope, parsed.scopeKey ?? null, now);
      this.recordAudit(projectId, userId, 'memory.pack.create', 'memory_pack', id);
      return {
        id,
        projectId,
        stableKey: parsed.stableKey,
        name: parsed.name,
        scope: parsed.scope,
        ...(parsed.scopeKey ? { scopeKey: parsed.scopeKey } : {}),
        createdAt: now,
      };
    });
  }

  listPacks(projectId: string, userId: string): MemoryPack[] {
    this.assertProjectAccess(projectId, userId);
    return (this.database.prepare('SELECT * FROM memory_packs WHERE project_id = ? ORDER BY stable_key').all(projectId) as PackRow[]).map(packFromRow);
  }

  getPack(packId: string, userId?: string): MemoryPack {
    const row = this.packRow(packId);
    if (!row) throw new Error('Memory pack not found');
    if (userId) this.assertProjectAccess(row.project_id, userId);
    return packFromRow(row);
  }

  listGenerations(packId: string, userId?: string): MemoryGeneration[] {
    this.getPack(packId, userId);
    const generations = this.database.prepare('SELECT * FROM memory_generations WHERE pack_id = ? ORDER BY generation DESC').all(packId) as GenerationRow[];
    return generations.map((row) => generationFromRow(row, this.entriesForGeneration(row.id)));
  }

  listProposals(packId: string, userId?: string): MemoryProposal[] {
    this.getPack(packId, userId);
    return (this.database.prepare('SELECT * FROM memory_proposals WHERE pack_id = ? ORDER BY created_at DESC').all(packId) as ProposalRow[]).map(proposalFromRow);
  }

  getProposal(proposalId: string, userId?: string): MemoryProposal {
    const row = this.database.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!row) throw new Error('Memory proposal not found');
    this.getPack(row.pack_id, userId);
    return proposalFromRow(row);
  }

  propose(packId: string, input: MemoryProposalInput, actor: MemoryProposalActor | string): MemoryProposal {
    const parsed = MemoryProposalInputSchema.parse(input);
    const normalizedActor = typeof actor === 'string' ? { type: 'user' as const, userId: actor } : MemoryProposalActorSchema.parse(actor);
    const pack = this.getPack(packId);
    if (normalizedActor.type === 'user') this.assertProjectAccess(pack.projectId, normalizedActor.userId);
    else this.assertActivationAccess(pack.projectId, normalizedActor.activationId);
    for (const value of [parsed.title, parsed.body, parsed.sourceType, parsed.sourceReference]) {
      if (containsMemoryCredential(value)) throw new MemoryContentError();
    }
    if (parsed.baseGenerationId) this.assertGeneration(packId, parsed.baseGenerationId);
    const id = this.ids.id();
    const now = this.clock.now().toISOString();
    this.runTransaction(() => {
      this.database.prepare(`
        INSERT INTO memory_proposals(
          id, pack_id, base_generation_id, proposed_by_user_id, proposed_by_activation_id,
          title, body, source_type, source_reference, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        packId,
        parsed.baseGenerationId ?? null,
        normalizedActor.type === 'user' ? normalizedActor.userId : null,
        normalizedActor.type === 'activation' ? normalizedActor.activationId : null,
        parsed.title,
        parsed.body,
        parsed.sourceType,
        parsed.sourceReference,
        now,
      );
      this.appendEvent(pack.projectId, normalizedActor.type === 'user' ? normalizedActor.userId : undefined, 'memory.proposed', packId, {
        proposalId: id,
        baseGenerationId: parsed.baseGenerationId,
      });
    });
    return this.getProposal(id);
  }

  decideProposal(proposalId: string, input: { decision: 'approve' | 'approved' | 'reject' | 'rejected'; reason?: string }, userId: string): MemoryProposal {
    const parsed = MemoryDecisionInputSchema.parse(input);
    const row = this.database.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!row) throw new Error('Memory proposal not found');
    const pack = this.getPack(row.pack_id, userId);
    const state = parsed.decision === 'approve' || parsed.decision === 'approved' ? 'approved' : 'rejected';
    const decisionReason = parsed.reason === undefined ? undefined : redactMemoryText(parsed.reason, 2_000);
    const now = this.clock.now().toISOString();
    this.runTransaction(() => {
      const result = this.database.prepare(`
        UPDATE memory_proposals SET state = ?, decided_by = ?, decision_reason = ?, decided_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(state, userId, decisionReason ?? null, now, proposalId);
      if (result.changes !== 1) throw new MemoryConflictError('Memory proposal has already been decided');
      this.appendEvent(pack.projectId, userId, 'memory.decided', pack.id, {
        proposalId,
        decision: parsed.decision,
        state,
        reason: decisionReason ?? null,
      });
    });
    return this.getProposal(proposalId, userId);
  }

  activateGeneration(packId: string, generationId: string, userId: string, expectedBaseGenerationId?: string): MemoryGeneration {
    const pack = this.getPack(packId, userId);
    const now = this.clock.now().toISOString();
    const generation = this.assertGeneration(packId, generationId);
    if (generation.state === 'active' && pack.activeGenerationId === generationId) return this.readGeneration(packId, generationId, userId);
    if (generation.state === 'draft') throw new Error('Only approved or archived memory generations can be activated');
    if (generation.state !== 'approved' && generation.state !== 'archived' && generation.state !== 'active') throw new Error('Memory generation is not activatable');
    this.runTransaction(() => {
      this.assertCurrentBase(packId, expectedBaseGenerationId ?? pack.activeGenerationId);
      const update = this.database.prepare('UPDATE memory_packs SET active_generation_id = ? WHERE id = ? AND active_generation_id IS ?').run(generationId, packId, expectedBaseGenerationId ?? pack.activeGenerationId ?? null);
      if (update.changes !== 1) throw new MemoryConflictError();
      this.database.prepare("UPDATE memory_generations SET state = 'archived', archived_at = ? WHERE pack_id = ? AND state = 'active' AND id <> ?").run(now, packId, generationId);
      this.database.prepare("UPDATE memory_generations SET state = 'active', activated_at = ?, archived_at = NULL WHERE id = ?").run(now, generationId);
      this.database.prepare('UPDATE memory_activation_history SET deactivated_at = ? WHERE pack_id = ? AND deactivated_at IS NULL').run(now, packId);
      this.database.prepare('INSERT INTO memory_activation_history(id, pack_id, generation_id, activated_by, activated_at) VALUES (?, ?, ?, ?, ?)').run(this.ids.id(), packId, generationId, userId, now);
      this.appendEvent(pack.projectId, userId, 'memory.activated', packId, { generationId, previousGenerationId: pack.activeGenerationId });
    });
    return this.readGeneration(packId, generationId, userId);
  }

  fold(packId: string, input: MemoryFoldInput, userId: string): MemoryGeneration {
    const parsed = MemoryFoldInputSchema.parse(input);
    const pack = this.getPack(packId, userId);
    if (parsed.reason !== undefined && containsMemoryCredential(parsed.reason)) throw new MemoryContentError();
    const baseGenerationId = parsed.baseGenerationId ?? pack.activeGenerationId;
    const now = this.clock.now().toISOString();
    return this.runTransaction(() => {
      this.assertCurrentBase(packId, baseGenerationId);
      const selectedEntries = baseGenerationId ? this.selectEntries(baseGenerationId, parsed.entryIds) : [];
      const selectedProposals = this.selectProposals(packId, baseGenerationId, parsed.proposalIds);
      const content = [
        ...selectedEntries.map((entry) => ({ title: entry.title, body: entry.body, sourceType: entry.sourceType, sourceReference: entry.sourceReference, evidence: entry.evidence })),
        ...selectedProposals.map((proposal) => ({ title: proposal.title, body: proposal.body, sourceType: proposal.sourceType, sourceReference: proposal.sourceReference, evidence: {} })),
      ];
      return this.insertActiveGeneration(pack, baseGenerationId, content, parsed.reason ?? 'fold', userId, now);
    });
  }

  clear(packId: string, userId: string, expectedBaseGenerationId?: string): MemoryGeneration {
    const pack = this.getPack(packId, userId);
    const now = this.clock.now().toISOString();
    return this.runTransaction(() => {
      const baseGenerationId = expectedBaseGenerationId ?? pack.activeGenerationId;
      this.assertCurrentBase(packId, baseGenerationId);
      return this.insertActiveGeneration(pack, baseGenerationId, [], 'clear', userId, now);
    });
  }

  readGeneration(packId: string, generationId: string, userId?: string): MemoryGeneration {
    this.getPack(packId, userId);
    const row = this.assertGeneration(packId, generationId);
    return generationFromRow(row, this.entriesForGeneration(generationId));
  }

  readContext(packId: string, options?: Partial<MemoryReadOptions>, userId?: string): MemoryContext {
    const parsed = MemoryReadOptionsSchema.parse(options ?? {});
    const pack = this.getPack(packId, userId);
    const generationId = parsed.generationId ?? pack.activeGenerationId;
    if (!generationId) throw new Error('Memory pack has no active generation');
    const generation = this.assertGeneration(packId, generationId);
    if (generation.state === 'archived' && !parsed.includeArchived) throw new Error('Archived memory must be explicitly requested');
    if (generation.state !== 'active' && generation.state !== 'archived') throw new Error('Only active or archived generations can be injected');
    let entries = this.entriesForGeneration(generationId);
    if (parsed.entryIds) {
      const allowed = new Set(parsed.entryIds);
      entries = entries.filter((entry) => allowed.has(entry.id));
    }
    let total = 0;
    let truncated = false;
    entries = entries.filter((entry, index) => {
      if (index >= parsed.maxEntries) {
        truncated = true;
        return false;
      }
      const size = entry.title.length + entry.body.length;
      if (total + size > parsed.maxChars) {
        truncated = true;
        return false;
      }
      total += size;
      return true;
    });
    return { pack, generation: generationFromRow(generation, entries), entries, truncated };
  }

  search(projectOrPackId: string, query: string, userId: string, options: MemorySearchOptions = {}): MemoryEntry[] {
    let projectId = projectOrPackId;
    let effectiveOptions = options;
    const project = this.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectOrPackId) as { id: string } | undefined;
    if (!project) {
      const pack = this.packRow(projectOrPackId);
      if (!pack) throw new Error('Project or memory pack not found');
      projectId = pack.project_id;
      effectiveOptions = { ...options, packId: options.packId ?? pack.id };
    }
    this.assertProjectAccess(projectId, userId);
    const terms = ftsQuery(query);
    if (!terms) return [];
    const includeArchived = effectiveOptions.includeArchived === true;
    const limit = Math.min(Math.max(effectiveOptions.limit ?? 100, 1), 500);
    const packClause = effectiveOptions.packId ? ' AND p.id = ?' : '';
    const stateClause = includeArchived ? "g.state IN ('active', 'archived')" : "g.state = 'active'";
    const params: unknown[] = [terms, projectId];
    if (effectiveOptions.packId) params.push(effectiveOptions.packId);
    params.push(limit);
    const rows = this.database.prepare(`
      SELECT e.* FROM memory_fts f
      JOIN memory_entries e ON e.id = f.entry_id
      JOIN memory_generations g ON g.id = e.generation_id
      JOIN memory_packs p ON p.id = g.pack_id
      WHERE memory_fts MATCH ? AND p.project_id = ? AND ${stateClause}${packClause}
      ORDER BY rank LIMIT ?
    `).all(...params) as EntryRow[];
    return rows.map(entryFromRow);
  }

  private insertActiveGeneration(
    pack: MemoryPack,
    parentGenerationId: string | null | undefined,
    content: readonly { title: string; body: string; sourceType: string; sourceReference: string; evidence: Record<string, unknown> }[],
    reason: string,
    userId: string,
    now: string,
  ): MemoryGeneration {
    const latest = this.database.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM memory_generations WHERE pack_id = ?').get(pack.id) as { generation: number };
    const generationNumber = latest.generation + 1;
    const normalized = content.map((entry) => {
      const sanitized = sanitizeMemoryEvidence(entry.evidence ?? {});
      return { ...entry, evidence: sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : {} };
    });
    const contentHash = digest({ parentGenerationId: parentGenerationId ?? null, generation: generationNumber, entries: normalized });
    const generationId = this.ids.id();
    this.database.prepare(`
      INSERT INTO memory_generations(id, pack_id, parent_generation_id, generation, content_hash, state, fold_reason, created_by, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(generationId, pack.id, parentGenerationId ?? null, generationNumber, contentHash, reason, userId, now, now);
    const insertEntry = this.database.prepare(`
      INSERT INTO memory_entries(id, generation_id, ordinal, title, body, source_type, source_reference, evidence_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    normalized.forEach((entry, index) => insertEntry.run(
      this.ids.id(),
      generationId,
      index,
      entry.title,
      entry.body,
      entry.sourceType,
      entry.sourceReference,
      JSON.stringify(entry.evidence),
      digest(entry),
      now,
    ));
    const update = this.database.prepare('UPDATE memory_packs SET active_generation_id = ? WHERE id = ? AND active_generation_id IS ?').run(generationId, pack.id, parentGenerationId ?? null);
    if (update.changes !== 1) throw new MemoryConflictError();
    this.database.prepare("UPDATE memory_generations SET state = 'archived', archived_at = ? WHERE pack_id = ? AND state = 'active' AND id <> ?").run(now, pack.id, generationId);
    this.database.prepare('UPDATE memory_activation_history SET deactivated_at = ? WHERE pack_id = ? AND deactivated_at IS NULL').run(now, pack.id);
    this.database.prepare('INSERT INTO memory_activation_history(id, pack_id, generation_id, activated_by, activated_at) VALUES (?, ?, ?, ?, ?)').run(this.ids.id(), pack.id, generationId, userId, now);
    this.appendEvent(pack.projectId, userId, 'memory.activated', pack.id, { generationId, previousGenerationId: parentGenerationId, reason: redactText(reason, 2_000) });
    return this.readGeneration(pack.id, generationId);
  }

  private selectEntries(generationId: string, ids?: readonly string[]): MemoryEntry[] {
    const entries = this.entriesForGeneration(generationId);
    if (!ids) return entries;
    const selected = new Set(ids);
    if (selected.size !== ids.length) throw new Error('Duplicate memory entry IDs are not allowed');
    if (ids.some((id) => !entries.some((entry) => entry.id === id))) throw new Error('Memory entry does not belong to the base generation');
    return entries.filter((entry) => selected.has(entry.id));
  }

  private selectProposals(packId: string, generationId: string | null | undefined, ids?: readonly string[]): MemoryProposal[] {
    if (!ids) return [];
    const selected = new Set(ids);
    if (selected.size !== ids.length) throw new Error('Duplicate memory proposal IDs are not allowed');
    const rows = this.database.prepare(`SELECT * FROM memory_proposals WHERE pack_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(packId, ...ids) as ProposalRow[];
    if (rows.length !== ids.length) throw new Error('Memory proposal does not belong to this pack');
    return rows.map(proposalFromRow).map((proposal) => {
      if (proposal.state !== 'approved') throw new Error('Only approved memory proposals can be folded');
      if (proposal.baseGenerationId && proposal.baseGenerationId !== generationId) throw new MemoryConflictError('Proposal is based on another generation');
      return proposal;
    });
  }

  private entriesForGeneration(generationId: string): MemoryEntry[] {
    return (this.database.prepare('SELECT * FROM memory_entries WHERE generation_id = ? ORDER BY ordinal').all(generationId) as EntryRow[]).map(entryFromRow);
  }

  private assertGeneration(packId: string, generationId: string): GenerationRow {
    const row = this.database.prepare('SELECT * FROM memory_generations WHERE id = ? AND pack_id = ?').get(generationId, packId) as GenerationRow | undefined;
    if (!row) throw new Error('Memory generation not found');
    return row;
  }

  private assertCurrentBase(packId: string, expected: string | null | undefined): void {
    const row = this.database.prepare('SELECT active_generation_id FROM memory_packs WHERE id = ?').get(packId) as { active_generation_id: string | null } | undefined;
    if (!row || row.active_generation_id !== (expected ?? null)) throw new MemoryConflictError();
  }

  private assertProjectAccess(projectId: string, userId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS ok FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
      JOIN users u ON u.id = tm.user_id
      WHERE p.id = ? AND u.id = ? AND u.disabled_at IS NULL
    `).get(projectId, userId) as { ok: number } | undefined;
    if (!row) throw new MemoryAuthorizationError();
  }

  private assertActivationAccess(projectId: string, activationId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS ok FROM agent_activations aa
      JOIN logical_agents la ON la.id = aa.logical_agent_id
      JOIN runs r ON r.id = la.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE aa.id = ? AND s.project_id = ?
    `).get(activationId, projectId) as { ok: number } | undefined;
    if (!row) throw new MemoryAuthorizationError();
  }

  private packRow(packId: string): PackRow | undefined {
    return this.database.prepare('SELECT * FROM memory_packs WHERE id = ?').get(packId) as PackRow | undefined;
  }

  private appendEvent(projectId: string, userId: string | undefined, eventKind: 'memory.proposed' | 'memory.decided' | 'memory.activated', aggregateId: string, payload: Record<string, unknown>): void {
    if (!this.events || !userId) return;
    this.events.append({
      projectId,
      eventKind,
      aggregateType: 'memory_pack',
      aggregateId,
      actor: { type: 'user', userId },
      source: { kind: 'platform', adapter: 'memory' },
      payload,
    });
  }

  /** Record setup actions in the immutable audit ledger without duplicating sensitive input. */
  private recordAudit(projectId: string, userId: string, action: string, targetType: string, targetId: string): void {
    this.database.prepare(`
      INSERT INTO audit_records(id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at)
      VALUES (?, ?, 'user', ?, ?, ?, ?, 'allowed', '{}', ?)
    `).run(this.ids.id(), projectId, userId, action, targetType, targetId, this.clock.now().toISOString());
  }

  private runTransaction<T>(operation: () => T): T {
    return this.events ? this.events.transaction(operation) : this.database.transaction(operation)();
  }
}

export type MemoryReadService = Pick<MemoryService, 'getPack' | 'listPacks' | 'listGenerations' | 'listProposals' | 'readGeneration' | 'readContext' | 'search' | 'getProposal'>;
export type MemoryProposalService = Pick<MemoryService, 'propose' | 'decideProposal' | 'fold' | 'clear' | 'activateGeneration'>;

function packFromRow(row: PackRow): MemoryPack {
  return {
    id: row.id,
    projectId: row.project_id,
    stableKey: row.stable_key,
    name: row.name,
    scope: row.scope,
    ...(row.scope_key ? { scopeKey: row.scope_key } : {}),
    ...(row.active_generation_id ? { activeGenerationId: row.active_generation_id } : {}),
    createdAt: row.created_at,
  };
}

function generationFromRow(row: GenerationRow, entries: MemoryEntry[]): MemoryGeneration {
  return {
    id: row.id,
    packId: row.pack_id,
    ...(row.parent_generation_id ? { parentGenerationId: row.parent_generation_id } : {}),
    generation: row.generation,
    contentHash: row.content_hash,
    state: row.state,
    ...(row.fold_reason ? { foldReason: row.fold_reason } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    entries,
  };
}

function entryFromRow(row: EntryRow): MemoryEntry {
  let evidence: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(row.evidence_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sanitized = sanitizeMemoryEvidence(value as Record<string, unknown>);
      if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) evidence = sanitized as Record<string, unknown>;
    }
  } catch {
    // A malformed legacy evidence value is exposed as an empty object, never as executable content.
  }
  return {
    id: row.id,
    generationId: row.generation_id,
    ordinal: row.ordinal,
    title: row.title,
    body: row.body,
    sourceType: row.source_type,
    sourceReference: row.source_reference,
    evidence,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function proposalFromRow(row: ProposalRow): MemoryProposal {
  return {
    id: row.id,
    packId: row.pack_id,
    ...(row.base_generation_id ? { baseGenerationId: row.base_generation_id } : {}),
    ...(row.proposed_by_user_id ? { proposedByUserId: row.proposed_by_user_id } : {}),
    ...(row.proposed_by_activation_id ? { proposedByActivationId: row.proposed_by_activation_id } : {}),
    title: row.title,
    body: row.body,
    sourceType: row.source_type,
    sourceReference: row.source_reference,
    state: row.state,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function ftsQuery(input: string): string {
  const bounded = input.trim().slice(0, 512);
  const terms = bounded.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 32) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

const MEMORY_URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/iu;
const MEMORY_URL_CREDENTIALS_GLOBAL = /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu;
const MEMORY_EVIDENCE_SENSITIVE_KEY = /(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key|cookie)/iu;

function containsMemoryCredential(value: string): boolean {
  return redactSecrets(value, value.length) !== value || MEMORY_URL_CREDENTIALS.test(value);
}

function redactMemoryText(value: string, maxLength: number): string {
  return redactSecrets(value, maxLength).replace(MEMORY_URL_CREDENTIALS_GLOBAL, '$1[REDACTED]@');
}

function sanitizeMemoryEvidence(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[REDACTED]';
  if (typeof value === 'string') return redactMemoryText(value, 2_048);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeMemoryEvidence(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = MEMORY_EVIDENCE_SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeMemoryEvidence(item, depth + 1);
  }
  return output;
}
