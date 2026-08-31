import { createHash, timingSafeEqual } from 'node:crypto';
import type { Claim, ClaimScope } from '@dhole-control/shared';
import type { Clock, IdSource } from '../../lib/clock.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import type { DatabaseConnection } from '../../lib/database.js';
import type { EventStore } from '../../lib/events.js';
import { redactText } from '../../lib/security.js';
import {
  checkOverlap,
  hasBlockingOverlap,
  normalizePath,
  type ConflictWarning,
  type OverlapClaim,
  type OverlapReason,
  type WorkScope,
} from './overlap.js';

export const DEFAULT_SESSION_TTL_MS = 120_000;
export const DEFAULT_CLAIM_IDLE_TTL_MS = 45 * 60_000;
const TERMINAL_STATUSES = ['done', 'abandoned', 'expired', 'released'] as const;
const ACTIVE_STATUSES = ['investigating', 'in-progress', 'testing', 'blocked'] as const;
const FINDING_KINDS = ['root-cause', 'gotcha', 'decision', 'api-change'] as const;

type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
type FindingKind = (typeof FINDING_KINDS)[number];

export class CoordinationError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 404 | 409 | 422, readonly code: string, message: string,
    readonly details?: unknown) {
    super(message);
    this.name = 'CoordinationError';
  }
}

export class BlockingOverlapError extends CoordinationError {
  constructor(readonly conflicts: ConflictWarning[]) {
    super(409, 'coordination_conflict', 'The requested work overlaps an enforced claim', conflicts);
    this.name = 'BlockingOverlapError';
  }
}

export interface CoordinationServiceOptions {
  sessionTtlMs?: number;
  claimIdleTtlMs?: number;
  maxStateItems?: number;
  events?: EventStore;
}

export interface StartSessionInput {
  agent?: string;
  agentLabel?: string;
  developer?: string | null;
  developerLabel?: string | null;
  machine?: string | null;
  machineId?: string | null;
  worktree?: string | null;
  capability?: string;
  userId?: string | null;
}

export interface CoordinationSession {
  id: string;
  projectId: string;
  agent: string;
  developer: string | null;
  machineId: string | null;
  /** An opaque digest, never the client's absolute checkout path. */
  worktree: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  endedAt: string | null;
  active: boolean;
  /** Returned only by startSession; never persisted or included in state. */
  capability?: string;
}

export interface RepoReport {
  branch: string | null;
  revision: string | null;
  dirtyFiles: string[];
  reportedAt: string;
}

export interface CreateClaimInput {
  sessionId: string;
  intent: string;
  task?: string | null;
  files?: string[];
  components?: string[];
  branch?: string | null;
  baseRevision?: string | null;
  worktree?: string | null;
  runId?: string | null;
  workItemId?: string | null;
  status?: ActiveStatus;
  blockedOn?: string | null;
  capability?: string;
  /** `enforced` is used by orchestration; normal Mediation claims are advisory. */
  mode?: 'advisory' | 'enforced';
  enforce?: boolean;
}

export interface PatchClaimInput {
  runId?: string | null;
  intent?: string;
  task?: string | null;
  files?: string[];
  components?: string[];
  branch?: string | null;
  baseRevision?: string | null;
  worktree?: string | null;
  status?: ActiveStatus;
  blockedOn?: string | null;
  finding?: string;
  findingFiles?: string[];
  findingKind?: FindingKind;
  capability?: string;
}

export interface CompleteClaimInput {
  runId?: string | null;
  commits?: string[];
  prs?: string[];
  summary?: string | null;
  status?: Extract<TerminalStatus, 'done' | 'abandoned'>;
  capability?: string;
}

export interface ClaimResult {
  claim: Claim;
  conflicts: ConflictWarning[];
}

export interface AgentEventInput {
  eventId: string;
  runId: string;
  agentId: string;
  parentAgentId?: string | null;
  harness: string;
  name?: string | null;
  role?: string | null;
  task?: string | null;
  state: 'starting' | 'active' | 'waiting' | 'blocked' | 'needs-input' | 'completed' | 'failed' | 'cancelled';
  stateReason?: string | null;
  occurredAt: string | number;
  sessionId?: string;
  capability?: string;
}

export interface AgentExecutionView {
  id: string;
  projectId: string;
  name: string | null;
  role: string | null;
  task: string | null;
  state: AgentEventInput['state'];
  stateReason: string | null;
  harness: string;
  provenance: 'harness-reported' | 'environment-reported';
  sessionId: string | null;
  parentAvailable: boolean;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  stale: boolean;
}

export interface CoordinationState {
  project: string;
  now: string;
  sessions: CoordinationSession[];
  claims: Claim[];
  completed: Claim[];
  conflicts: Array<{ claimId: string; conflictingClaimId: string; severity: 'info' | 'warning' | 'blocking'; reasons: OverlapReason[]; createdAt: string; resolvedAt: string | null }>;
  recentFiles: Array<{ file: string; agents: string[]; updatedAt: string }>;
  agents: AgentExecutionView[];
}

interface Row {
  [key: string]: unknown;
}

function asString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function capabilityHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function worktreeHash(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Stored hashes can flow back through overlap checks; keep one canonical
  // representation instead of hashing an opaque hash a second time.
  return /^wt_[A-Za-z0-9_-]{43}$/u.test(trimmed) ? trimmed : `wt_${digest(trimmed)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function cleanText(value: string | null | undefined, max = 2_000): string | null {
  if (value == null) return null;
  let text = redactText(value.trim(), max);
  // The shared redactor intentionally stays conservative. Coordination state
  // is durable, so also mask the common unquoted `token=...`/`api-key: ...`
  // forms before writing labels, findings or event summaries.
  text = text.replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1: [REDACTED]');
  return text || null;
}

function cleanFiles(files: readonly string[] | undefined): string[] {
  const values = files ?? [];
  if (values.some((file) => {
    const value = file.trim();
    const parts = value.replaceAll('\\', '/').split('/');
    return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[/\\]/u.test(value) || parts.some((part) => part === '..');
  })) throw new CoordinationError(422, 'invalid_path', 'Paths must be relative to the repository');
  return [...new Set(values.map((file) => normalizePath(file)).filter(Boolean))].slice(0, 500);
}

function cleanComponents(components: readonly string[] | undefined): string[] {
  return [...new Set((components ?? []).map((component) => component.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 100);
}

function isTerminal(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export class CoordinationService {
  readonly sessionTtlMs: number;
  readonly claimIdleTtlMs: number;
  readonly maxStateItems: number;
  readonly #events: EventStore | undefined;

  constructor(
    readonly database: DatabaseConnection,
    readonly clock: Clock = systemClock,
    readonly ids: IdSource = secureIds,
    options: CoordinationServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.claimIdleTtlMs = options.claimIdleTtlMs ?? DEFAULT_CLAIM_IDLE_TTL_MS;
    this.maxStateItems = options.maxStateItems ?? 200;
    this.#events = options.events;
  }

  private transaction<T>(operation: () => T): T {
    if (this.#events) return this.#events.transaction(operation);
    return this.database.transaction(operation)();
  }

  private appendEvent(projectId: string, eventKind: 'session.created' | 'claim.created' | 'claim.updated' | 'claim.settled' | 'conflict.detected', aggregateId: string,
    payload: Record<string, unknown>, sessionId?: string): void {
    if (!this.#events) return;
    let actor: { type: 'system' } | { type: 'user'; userId: string } = { type: 'system' };
    if (sessionId) {
      const row = this.database.prepare('SELECT user_id FROM coordination_sessions WHERE id = ?').get(sessionId) as Row | undefined;
      if (row?.user_id) actor = { type: 'user', userId: String(row.user_id) };
    }
    this.#events.append({
      projectId,
      eventKind,
      aggregateType: eventKind === 'session.created' ? 'coordination_session' : 'coordination_claim',
      aggregateId,
      actor,
      source: { kind: 'platform', adapter: 'coordination' },
      payload,
    });
  }

  private requireProject(projectId: string): void {
    const exists = this.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) throw new CoordinationError(404, 'project_not_found', 'Project not found');
  }

  private requireRunProject(projectId: string, runId: string | null | undefined): void {
    if (runId == null) return;
    // Standalone Coordination fixtures may omit the server's runs table. The
    // migrated application schema always has it, so enforce its project binding
    // whenever that boundary exists.
    const hasRunsTable = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
    if (!hasRunsTable) return;
    const run = this.database.prepare(`SELECT r.id FROM runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ? AND s.project_id = ?`).get(runId, projectId);
    if (!run) throw new CoordinationError(403, 'run_project_mismatch', 'The run is outside this project');
  }

  private requireSession(projectId: string, sessionId: string, capability?: string, allowEnded = false, requireCapability = false): Row {
    this.requireProject(projectId);
    const row = this.database.prepare('SELECT * FROM coordination_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId) as Row | undefined;
    if (!row) throw new CoordinationError(404, 'session_not_found', 'Session not found');
    if (!allowEnded && row.ended_at) throw new CoordinationError(403, 'session_ended', 'Session has ended');
    if (!row.ended_at && String(row.expires_at) <= this.clock.now().toISOString()) {
      this.database.prepare('UPDATE coordination_sessions SET ended_at = expires_at WHERE id = ?').run(sessionId);
      if (!allowEnded) throw new CoordinationError(403, 'session_expired', 'Session has expired; start a new session');
    }
    if (requireCapability && capability === undefined) throw new CoordinationError(403, 'capability_required', 'Session capability required');
    if (capability !== undefined) this.assertCapability(row, capability);
    return row;
  }

  /**
   * A run-scoped compatibility token may mutate a coordination session only
   * while all of that session's existing claims are either unbound or tied to
   * the same run. Coordination sessions predate run binding, so this keeps
   * legacy unbound sessions usable without adding another schema column.
   */
  private requireSessionRunScope(projectId: string, sessionId: string, runScope?: string): void {
    if (runScope === undefined) return;
    this.requireRunProject(projectId, runScope);
    const mismatch = this.database.prepare(`SELECT 1 FROM coordination_claims
      WHERE project_id = ? AND coordination_session_id = ? AND run_id IS NOT NULL AND run_id <> ? LIMIT 1`)
      .get(projectId, sessionId, runScope);
    if (mismatch) throw new CoordinationError(403, 'run_scope_denied', 'The coordination session has claims outside this run');
  }

  private assertCapability(row: Row, capability: string): void {
    const expected = asString(row.capability_hash);
    if (!expected || !capability) throw new CoordinationError(403, 'capability_required', 'Session capability required');
    const actual = capabilityHash(capability);
    const ok = expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
    if (!ok) throw new CoordinationError(403, 'capability_invalid', 'Session capability is invalid');
  }

  private findSessionByCapability(projectId: string, capability: string): Row {
    const row = this.database.prepare('SELECT * FROM coordination_sessions WHERE project_id = ? AND capability_hash = ?')
      .get(projectId, capabilityHash(capability)) as Row | undefined;
    if (!row) throw new CoordinationError(403, 'capability_invalid', 'Session capability is invalid');
    if (row.ended_at) throw new CoordinationError(403, 'session_ended', 'Session has ended');
    if (String(row.expires_at) <= this.clock.now().toISOString()) {
      this.database.prepare('UPDATE coordination_sessions SET ended_at = expires_at WHERE id = ? AND ended_at IS NULL').run(row.id);
      throw new CoordinationError(403, 'session_expired', 'Session has expired; start a new session');
    }
    return row;
  }

  private sessionView(row: Row, capability?: string): CoordinationSession {
    const endedAt = asString(row.ended_at);
    const view: CoordinationSession = {
      id: String(row.id), projectId: String(row.project_id), agent: String(row.agent_label),
      developer: asString(row.developer_label), machineId: asString(row.machine_id),
      worktree: asString(row.worktree_hash), createdAt: String(row.created_at), lastSeenAt: String(row.last_seen_at),
      expiresAt: String(row.expires_at), endedAt, active: endedAt == null && String(row.expires_at) > this.clock.now().toISOString(),
    };
    if (capability) view.capability = capability;
    return view;
  }

  startSession(projectId: string, input: StartSessionInput): CoordinationSession {
    this.requireProject(projectId);
    const userId = input.userId?.trim() || null;
    const machineId = cleanText(input.machineId ?? input.machine, 160);
    const projectRow = this.database.prepare('SELECT team_id FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (projectRow?.team_id != null) {
      const teamId = String(projectRow.team_id);
      if (userId) {
        const user = this.database.prepare(`SELECT u.id FROM users u
          JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
          WHERE u.id = ? AND u.disabled_at IS NULL`).get(teamId, userId);
        if (!user) throw new CoordinationError(403, 'user_scope_denied', 'Session user is not active in this project team');
      }
      if (machineId) {
        const machine = this.database.prepare(`SELECT m.id FROM machines m
          WHERE m.id = ? AND m.team_id = ? AND m.status <> 'revoked'`).get(machineId, teamId);
        if (!machine) throw new CoordinationError(403, 'machine_scope_denied', 'Session machine is not enrolled in this project team');
      }
    }
    const t = this.clock.now();
    const capability = input.capability ?? this.ids.token(24);
    const sessionId = this.ids.id();
    const createdAt = t.toISOString();
    const expiresAt = new Date(t.getTime() + this.sessionTtlMs).toISOString();
    const agent = cleanText(input.agentLabel ?? input.agent, 120);
    if (!agent) throw new CoordinationError(422, 'invalid_agent', 'Agent label is required');
    const developer = cleanText(input.developerLabel ?? input.developer, 160);
    const worktree = worktreeHash(input.worktree);
    this.transaction(() => {
      this.database.prepare(`INSERT INTO coordination_sessions
        (id, project_id, user_id, machine_id, agent_label, developer_label, worktree_hash, capability_hash,
         created_at, last_seen_at, expires_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        sessionId, projectId, userId, machineId, agent, developer, worktree,
        capabilityHash(capability), createdAt, createdAt, expiresAt,
      );
      this.appendEvent(projectId, 'session.created', sessionId, { agent: agent }, sessionId);
    });
    const row = this.database.prepare('SELECT * FROM coordination_sessions WHERE id = ?').get(sessionId) as Row;
    return this.sessionView(row, capability);
  }

  heartbeat(projectId: string, sessionId: string, input: { activity?: string | null; branch?: string | null; revision?: string | null; dirtyFiles?: string[]; capability?: string }, runScope?: string): CoordinationSession {
    const row = this.requireSession(projectId, sessionId, input.capability, false, true);
    this.requireSessionRunScope(projectId, sessionId, runScope);
    const t = this.clock.now();
    const seen = t.toISOString();
    const expires = new Date(t.getTime() + this.sessionTtlMs).toISOString();
    this.transaction(() => {
      this.database.prepare('UPDATE coordination_sessions SET last_seen_at = ?, expires_at = ?, ended_at = NULL WHERE id = ?')
        .run(seen, expires, sessionId);
      if (input.dirtyFiles !== undefined || input.branch !== undefined || input.revision !== undefined) {
        const previous = this.reportRepo(projectId, sessionId);
        this.database.prepare(`INSERT INTO coordination_repo_reports(session_id, branch, revision, dirty_files_json, reported_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET branch=excluded.branch,
          revision=excluded.revision, dirty_files_json=excluded.dirty_files_json, reported_at=excluded.reported_at`)
          .run(sessionId, cleanText(input.branch ?? previous?.branch, 240), cleanText(input.revision ?? previous?.revision, 240),
            JSON.stringify(cleanFiles(input.dirtyFiles ?? previous?.dirtyFiles)), seen);
      }
    });
    return this.sessionView({ ...row, last_seen_at: seen, expires_at: expires, ended_at: null }, input.capability);
  }

  endSession(projectId: string, sessionId: string, capability?: string, reason = 'transport ended', runScope?: string): { ok: true; session: CoordinationSession } {
    const row = this.requireSession(projectId, sessionId, capability, true, true);
    this.requireSessionRunScope(projectId, sessionId, runScope);
    if (row.ended_at) return { ok: true, session: this.sessionView(row, capability) };
    const endedAt = this.clock.now().toISOString();
    this.transaction(() => {
      this.database.prepare('UPDATE coordination_sessions SET ended_at = ?, expires_at = ? WHERE id = ?').run(endedAt, endedAt, sessionId);
    });
    // The reason is intentionally not persisted; it can contain paths or a prompt.
    void reason;
    return { ok: true, session: this.sessionView({ ...row, ended_at: endedAt, expires_at: endedAt }, capability) };
  }

  reportRepo(projectId: string, sessionId: string, input?: { branch?: string | null; revision?: string | null; dirtyFiles?: string[]; capability?: string }, runScope?: string): RepoReport | null {
    if (input) this.requireSession(projectId, sessionId, input.capability, false, true);
    else this.requireSession(projectId, sessionId, undefined, true, false);
    this.requireSessionRunScope(projectId, sessionId, runScope);
    if (input) {
      const reportedAt = this.clock.now().toISOString();
      this.transaction(() => {
        this.database.prepare(`INSERT INTO coordination_repo_reports(session_id, branch, revision, dirty_files_json, reported_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET branch=excluded.branch,
          revision=excluded.revision, dirty_files_json=excluded.dirty_files_json, reported_at=excluded.reported_at`)
          .run(sessionId, cleanText(input.branch, 240), cleanText(input.revision, 240), JSON.stringify(cleanFiles(input.dirtyFiles)), reportedAt);
      });
    }
    const row = this.database.prepare('SELECT * FROM coordination_repo_reports WHERE session_id = ?').get(sessionId) as Row | undefined;
    if (!row) return null;
    let dirtyFiles: string[] = [];
    try { dirtyFiles = cleanFiles(JSON.parse(String(row.dirty_files_json)) as string[]); } catch { /* corrupted legacy rows are empty */ }
    return { branch: asString(row.branch), revision: asString(row.revision), dirtyFiles, reportedAt: String(row.reported_at) };
  }

  private claimRows(projectId: string, terminal = false, runId?: string): Row[] {
    const predicate = terminal ? `status IN (${TERMINAL_STATUSES.map(() => '?').join(',')})` : `status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`;
    const args = terminal ? [...TERMINAL_STATUSES] : [...TERMINAL_STATUSES];
    const runPredicate = runId === undefined ? '' : ' AND run_id = ?';
    return this.database.prepare(`SELECT * FROM coordination_claims WHERE project_id = ?${runPredicate} AND ${predicate} ORDER BY updated_at DESC LIMIT ?`)
      .all(projectId, ...(runId === undefined ? [] : [runId]), ...args, this.maxStateItems) as Row[];
  }

  private claimView(row: Row): Claim {
    const claimId = String(row.id);
    const fileRows = this.database.prepare('SELECT normalized_path FROM coordination_claim_files WHERE claim_id = ? ORDER BY normalized_path').all(claimId) as Row[];
    const componentRows = this.database.prepare('SELECT normalized_component FROM coordination_claim_components WHERE claim_id = ? ORDER BY normalized_component').all(claimId) as Row[];
    const findingRows = this.database.prepare('SELECT kind, text, files_json, created_at FROM coordination_findings WHERE claim_id = ? ORDER BY created_at').all(claimId) as Row[];
    const settlement = this.database.prepare('SELECT commits_json, prs_json FROM coordination_claim_settlements WHERE claim_id = ?').get(claimId) as Row | undefined;
    const files = fileRows.map((file) => String(file.normalized_path));
    const components = componentRows.map((component) => String(component.normalized_component));
    const findings = findingRows.map((finding) => {
      let findingFiles: string[] = [];
      try { findingFiles = cleanFiles(JSON.parse(String(finding.files_json)) as string[]); } catch { /* empty */ }
      return { text: cleanText(String(finding.text), 2_000) ?? '', at: String(finding.created_at), files: findingFiles, kind: asString(finding.kind) as FindingKind | null };
    });
    let commits: string[] = [];
    let prs: string[] = [];
    if (settlement) {
      try { commits = JSON.parse(String(settlement.commits_json)) as string[]; } catch { /* empty */ }
      try { prs = JSON.parse(String(settlement.prs_json)) as string[]; } catch { /* empty */ }
    }
    const scope: ClaimScope = {
      files, components, intent: cleanText(String(row.intent), 2_000) ?? '',
      ...(row.task == null ? {} : { task: cleanText(String(row.task), 500) ?? '' }),
      ...(row.worktree_hash == null ? {} : { worktree: String(row.worktree_hash) }),
    };
    const claim: Claim = {
      id: claimId,
      projectId: String(row.project_id),
      coordinationSessionId: String(row.coordination_session_id),
      status: String(row.status) as Claim['status'],
      scope,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.run_id == null ? {} : { runId: String(row.run_id) }),
      ...(row.work_item_id == null ? {} : { workItemId: String(row.work_item_id) }),
      ...(row.blocked_on == null ? {} : { blockedOn: String(row.blocked_on) }),
    };
    // Extended fields are useful to server callers while the shared Claim wire
    // shape stays stable. They contain only relative paths and opaque ids.
    return Object.assign(claim, { findings, commits, prs, summary: asString(row.summary), branch: asString(row.branch), baseRevision: asString(row.base_revision) });
  }

  private overlapClaims(projectId: string, runId?: string): OverlapClaim[] {
    const claims = this.claimRows(projectId, false, runId).map((row) => {
      const claim = this.claimView(row);
      const repo = this.reportRepo(projectId, String(row.coordination_session_id));
      const dirtyFiles = repo?.dirtyFiles ?? [];
      return {
        id: claim.id,
        coordinationSessionId: claim.coordinationSessionId,
        status: claim.status,
        scope: {
          ...claim.scope,
          files: [...new Set([...claim.scope.files, ...dirtyFiles])],
        },
        agent: this.agentForSession(projectId, claim.coordinationSessionId),
        developer: this.developerForSession(projectId, claim.coordinationSessionId),
        updatedAt: claim.updatedAt,
      } satisfies OverlapClaim;
    });
    return claims;
  }

  private agentForSession(projectId: string, sessionId: string): string | null {
    const row = this.database.prepare('SELECT agent_label FROM coordination_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId) as Row | undefined;
    return row?.agent_label == null ? null : String(row.agent_label);
  }

  private developerForSession(projectId: string, sessionId: string): string | null {
    const row = this.database.prepare('SELECT developer_label FROM coordination_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId) as Row | undefined;
    return row?.developer_label == null ? null : String(row.developer_label);
  }

  check(projectId: string, scope: WorkScope, runId?: string): ConflictWarning[] {
    this.requireRunProject(projectId, runId);
    this.sweep(projectId);
    const proposed: WorkScope = {
      ...scope,
      files: cleanFiles(scope.files),
      components: cleanComponents(scope.components),
      intent: cleanText(scope.intent, 2_000) ?? '',
      task: cleanText(scope.task, 500),
      worktree: worktreeHash(scope.worktree),
    };
    return checkOverlap(this.overlapClaims(projectId, runId), proposed);
  }

  private insertClaim(projectId: string, input: CreateClaimInput, session: Row, conflicts: ConflictWarning[], runScope?: string): Claim {
    const t = this.clock.now().toISOString();
    const claimId = this.ids.id();
    const files = cleanFiles(input.files);
    const components = cleanComponents(input.components);
    const intent = cleanText(input.intent, 2_000);
    if (!intent) throw new CoordinationError(422, 'invalid_intent', 'Claim intent is required');
    const status = input.status ?? 'investigating';
    const blockedOn = input.blockedOn ?? null;
    if (blockedOn === claimId) throw new CoordinationError(422, 'invalid_blocker', 'A claim cannot block on itself');
    if (blockedOn) {
      const blocker = runScope === undefined
        ? this.database.prepare('SELECT id FROM coordination_claims WHERE project_id = ? AND id = ?').get(projectId, blockedOn)
        : this.database.prepare('SELECT id FROM coordination_claims WHERE project_id = ? AND id = ? AND run_id = ?').get(projectId, blockedOn, runScope);
      if (!blocker) throw new CoordinationError(422, 'invalid_blocker', 'blockedOn must reference a claim in this project');
    }
    const worktree = worktreeHash(input.worktree) ?? asString(session.worktree_hash);
    this.database.prepare(`INSERT INTO coordination_claims
      (id, project_id, coordination_session_id, run_id, work_item_id, intent, task, worktree_hash,
       branch, base_revision, status, blocked_on, summary, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`).run(
      claimId, projectId, session.id, input.runId ?? null, input.workItemId ?? null, intent,
      cleanText(input.task, 500), worktree, cleanText(input.branch, 240), cleanText(input.baseRevision, 240),
      status, blockedOn, t, t,
    );
    const insertFile = this.database.prepare('INSERT INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)');
    for (const file of files) insertFile.run(claimId, file);
    const insertComponent = this.database.prepare('INSERT INTO coordination_claim_components(claim_id, normalized_component) VALUES (?, ?)');
    for (const component of components) insertComponent.run(claimId, component);
    for (const conflict of conflicts) {
      this.database.prepare(`INSERT OR IGNORE INTO coordination_conflicts
        (id, project_id, claim_id, conflicting_claim_id, severity, reasons_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(this.ids.id(), projectId, claimId, conflict.claimId,
        hasBlockingOverlap(conflict.reasons) ? 'blocking' : 'warning', JSON.stringify(conflict.reasons), t);
    }
    this.appendEvent(projectId, 'claim.created', claimId, { status, fileCount: files.length, componentCount: components.length }, String(session.id));
    if (conflicts.length) this.appendEvent(projectId, 'conflict.detected', claimId, { count: conflicts.length }, String(session.id));
    const row = this.database.prepare('SELECT * FROM coordination_claims WHERE id = ?').get(claimId) as Row;
    return this.claimView(row);
  }

  private scopedRunId(scope: string | undefined, requested: string | null | undefined): string | null | undefined {
    if (scope !== undefined && requested != null && requested !== scope) {
      throw new CoordinationError(403, 'run_scope_denied', 'The API token is not valid for this run');
    }
    return scope ?? requested;
  }

  createClaim(projectId: string, input: CreateClaimInput, runScope?: string): ClaimResult {
    const runId = this.scopedRunId(runScope, input.runId);
    this.requireRunProject(projectId, runId);
    const scopedInput: CreateClaimInput = runId === input.runId
      ? input
      : { ...input, ...(runId === undefined ? {} : { runId }) };
    const session = this.requireSession(projectId, scopedInput.sessionId, scopedInput.capability, false, true);
    const scope: WorkScope = {
      files: cleanFiles(scopedInput.files), components: cleanComponents(scopedInput.components), intent: scopedInput.intent,
      task: scopedInput.task, worktree: scopedInput.worktree ?? asString(session.worktree_hash), sessionId: scopedInput.sessionId,
    };
    return this.transaction(() => {
      const conflicts = this.check(projectId, scope, runScope);
      if ((scopedInput.enforce || scopedInput.mode === 'enforced') && conflicts.some((conflict) => hasBlockingOverlap(conflict.reasons))) {
        throw new BlockingOverlapError(conflicts.filter((conflict) => hasBlockingOverlap(conflict.reasons)));
      }
      return { claim: this.insertClaim(projectId, scopedInput, session, conflicts, runScope), conflicts };
    });
  }

  /** Alias used by orchestration callers; enforced reservations are atomic. */
  reserveClaim(projectId: string, input: CreateClaimInput, runScope?: string): ClaimResult {
    return this.createClaim(projectId, { ...input, mode: 'enforced', enforce: true }, runScope);
  }

  private claimRow(projectId: string, claimId: string, runScope?: string): Row {
    const row = this.database.prepare('SELECT * FROM coordination_claims WHERE project_id = ? AND id = ?').get(projectId, claimId) as Row | undefined;
    if (!row) throw new CoordinationError(404, 'claim_not_found', 'Claim not found');
    if (runScope !== undefined && asString(row.run_id) !== runScope) {
      throw new CoordinationError(403, 'run_scope_denied', 'The claim is outside this run');
    }
    return row;
  }

  private authorizeClaim(projectId: string, claim: Row, capability?: string): Row {
    const owner = this.database.prepare('SELECT * FROM coordination_sessions WHERE project_id = ? AND id = ?')
      .get(projectId, claim.coordination_session_id) as Row | undefined;
    if (owner && !owner.ended_at && String(owner.expires_at) > this.clock.now().toISOString()) {
      if (capability !== undefined) this.assertCapability(owner, capability);
      else if (owner.capability_hash) throw new CoordinationError(403, 'capability_required', 'Session capability required');
      return owner;
    }
    if (!capability) throw new CoordinationError(403, 'capability_required', 'Session capability required to adopt a claim');
    const caller = this.findSessionByCapability(projectId, capability);
    if (owner && owner.developer_label !== caller.developer_label) {
      throw new CoordinationError(403, 'claim_owner_mismatch', 'Claim belongs to another developer');
    }
    if (owner && (!owner.worktree_hash || !caller.worktree_hash || caller.worktree_hash !== owner.worktree_hash)) {
      throw new CoordinationError(403, 'claim_worktree_mismatch', 'Claim belongs to another worktree');
    }
    this.database.prepare('UPDATE coordination_claims SET coordination_session_id = ?, updated_at = ? WHERE id = ?')
      .run(caller.id, this.clock.now().toISOString(), claim.id);
    return caller;
  }

  updateClaim(projectId: string, claimId: string, input: PatchClaimInput, runScope?: string): Claim {
    const runId = this.scopedRunId(runScope, input.runId);
    this.requireRunProject(projectId, runId);
    const claim = this.claimRow(projectId, claimId, runScope);
    const session = this.authorizeClaim(projectId, claim, input.capability);
    if (isTerminal(String(claim.status))) throw new CoordinationError(409, 'claim_settled', 'Settled claims cannot be patched');
    const current = this.claimView(this.claimRow(projectId, claimId, runScope));
    const files = input.files === undefined ? current.scope.files : cleanFiles(input.files);
    const components = input.components === undefined ? current.scope.components : cleanComponents(input.components);
    const blockedOn = input.blockedOn === undefined ? (current.blockedOn ?? null) : input.blockedOn;
    if (blockedOn === claimId) throw new CoordinationError(422, 'invalid_blocker', 'A claim cannot block on itself');
    const blocker = blockedOn && (runScope === undefined
      ? this.database.prepare('SELECT id FROM coordination_claims WHERE project_id = ? AND id = ?').get(projectId, blockedOn)
      : this.database.prepare('SELECT id FROM coordination_claims WHERE project_id = ? AND id = ? AND run_id = ?').get(projectId, blockedOn, runScope));
    if (blockedOn && !blocker) {
      throw new CoordinationError(422, 'invalid_blocker', 'blockedOn must reference a claim in this project');
    }
    const t = this.clock.now().toISOString();
    this.transaction(() => {
      this.database.prepare(`UPDATE coordination_claims SET intent = ?, task = ?, worktree_hash = ?, branch = ?,
        base_revision = ?, status = ?, blocked_on = ?, updated_at = ? WHERE id = ?`).run(
        cleanText(input.intent ?? current.scope.intent, 2_000),
        input.task === undefined ? current.scope.task ?? null : cleanText(input.task, 500),
        input.worktree === undefined ? asString(claim.worktree_hash) : worktreeHash(input.worktree),
        input.branch === undefined ? (current as Claim & { branch?: string | null }).branch ?? null : cleanText(input.branch, 240),
        input.baseRevision === undefined ? (current as Claim & { baseRevision?: string | null }).baseRevision ?? null : cleanText(input.baseRevision, 240),
        input.status ?? claim.status, blockedOn, t, claimId,
      );
      this.database.prepare('DELETE FROM coordination_claim_files WHERE claim_id = ?').run(claimId);
      const insertFile = this.database.prepare('INSERT INTO coordination_claim_files(claim_id, normalized_path) VALUES (?, ?)');
      for (const file of files) insertFile.run(claimId, file);
      this.database.prepare('DELETE FROM coordination_claim_components WHERE claim_id = ?').run(claimId);
      const insertComponent = this.database.prepare('INSERT INTO coordination_claim_components(claim_id, normalized_component) VALUES (?, ?)');
      for (const component of components) insertComponent.run(claimId, component);
      if (input.finding) {
        const finding = redactText(input.finding, 2_000);
        this.database.prepare(`INSERT INTO coordination_findings(id, claim_id, kind, text, files_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(this.ids.id(), claimId, input.findingKind ?? null, finding,
          JSON.stringify(cleanFiles(input.findingFiles ?? files)), t);
      }
      this.appendEvent(projectId, 'claim.updated', claimId, { status: input.status ?? claim.status, finding: Boolean(input.finding) }, String(session.id));
    });
    return this.claimView(this.claimRow(projectId, claimId, runScope));
  }

  completeClaim(projectId: string, claimId: string, input: CompleteClaimInput, runScope?: string): Claim {
    const runId = this.scopedRunId(runScope, input.runId);
    this.requireRunProject(projectId, runId);
    const claim = this.claimRow(projectId, claimId, runScope);
    const session = this.authorizeClaim(projectId, claim, input.capability);
    const status = input.status ?? 'done';
    if (isTerminal(String(claim.status))) {
      if (String(claim.status) === status) return this.claimView(claim);
      throw new CoordinationError(409, 'claim_settled', 'Settled claims cannot be completed again');
    }
    const commits = [...new Set((input.commits ?? []).map((value) => cleanText(value, 240)).filter((value): value is string => value != null))];
    const prs = [...new Set((input.prs ?? []).map((value) => cleanText(value, 500)).filter((value): value is string => value != null))];
    const t = this.clock.now().toISOString();
    this.transaction(() => {
      const existing = this.database.prepare('SELECT commits_json, prs_json FROM coordination_claim_settlements WHERE claim_id = ?').get(claimId) as Row | undefined;
      let priorCommits: string[] = [];
      let priorPrs: string[] = [];
      if (existing) {
        try { priorCommits = JSON.parse(String(existing.commits_json)) as string[]; } catch { /* empty */ }
        try { priorPrs = JSON.parse(String(existing.prs_json)) as string[]; } catch { /* empty */ }
      }
      this.database.prepare(`INSERT INTO coordination_claim_settlements(claim_id, commits_json, prs_json) VALUES (?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET commits_json=excluded.commits_json, prs_json=excluded.prs_json`)
        .run(claimId, JSON.stringify([...new Set([...priorCommits, ...commits])]), JSON.stringify([...new Set([...priorPrs, ...prs])]));
      this.database.prepare('UPDATE coordination_claims SET status = ?, summary = ?, blocked_on = NULL, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(status, cleanText(input.summary, 2_000), t, t, claimId);
      this.appendEvent(projectId, 'claim.settled', claimId, { status, commitCount: commits.length, prCount: prs.length }, String(session.id));
      this.database.prepare(`UPDATE coordination_conflicts SET resolved_at = ? WHERE (claim_id = ? OR conflicting_claim_id = ?)
        AND resolved_at IS NULL`).run(t, claimId, claimId);
    });
    return this.claimView(this.claimRow(projectId, claimId, runScope));
  }

  releaseClaim(projectId: string, claimId: string, capability?: string, runScope?: string): Claim {
    this.requireRunProject(projectId, runScope);
    const claim = this.claimRow(projectId, claimId, runScope);
    const session = this.authorizeClaim(projectId, claim, capability);
    if (isTerminal(String(claim.status)) && claim.status !== 'released') return this.claimView(claim);
    const t = this.clock.now().toISOString();
    this.transaction(() => {
      this.database.prepare('UPDATE coordination_claims SET status = \'released\', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(t, t, claimId);
      this.database.prepare('UPDATE coordination_conflicts SET resolved_at = ? WHERE (claim_id = ? OR conflicting_claim_id = ?) AND resolved_at IS NULL').run(t, claimId, claimId);
      this.appendEvent(projectId, 'claim.settled', claimId, { status: 'released' }, String(session.id));
    });
    return this.claimView(this.claimRow(projectId, claimId, runScope));
  }

  releaseReservation(projectId: string, claimId: string, capability?: string, runScope?: string): Claim {
    return this.releaseClaim(projectId, claimId, capability, runScope);
  }

  /** Reserve bounded orchestration work and release the claim if it fails. */
  async withReservation<T>(projectId: string, input: CreateClaimInput, operation: (claim: Claim) => T | Promise<T>): Promise<T> {
    const reserved = this.reserveClaim(projectId, input);
    try {
      return await operation(reserved.claim);
    } catch (error) {
      try { this.releaseClaim(projectId, reserved.claim.id, input.capability); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  recordAgentEvent(projectId: string, input: AgentEventInput, runScope?: string): { idempotent: boolean; execution: AgentExecutionView } {
    const runId = this.scopedRunId(runScope, input.runId);
    this.requireRunProject(projectId, runId);
    const session = input.sessionId
      ? this.requireSession(projectId, input.sessionId, input.capability, false, true)
      : input.capability ? this.findSessionByCapability(projectId, input.capability) : undefined;
    const sessionId = session ? String(session.id) : null;
    const payload = {
      eventId: input.eventId, runId: input.runId, agentId: input.agentId, parentAgentId: input.parentAgentId ?? null,
      harness: cleanText(input.harness, 64) ?? 'unknown', name: cleanText(input.name, 80), role: cleanText(input.role, 64),
      task: cleanText(input.task, 280), state: input.state, stateReason: cleanText(input.stateReason, 280), occurredAt: String(input.occurredAt),
    };
    const payloadHash = digest(stableJson(payload));
    const priorEvent = this.database.prepare('SELECT * FROM coordination_agent_events WHERE project_id = ? AND event_id = ?').get(projectId, input.eventId) as Row | undefined;
    if (priorEvent) {
      if (String(priorEvent.payload_hash) !== payloadHash) throw new CoordinationError(409, 'event_replay_mismatch', 'Agent event id was already used with different content');
      const row = this.database.prepare('SELECT * FROM coordination_agent_executions WHERE id = ?').get(priorEvent.execution_id) as Row;
      return { idempotent: true, execution: this.agentExecutionView(row) };
    }
    const runHash = digest(input.runId);
    const agentHash = digest(input.agentId);
    const parentHash = input.parentAgentId ? digest(input.parentAgentId) : null;
    const t = this.clock.now().toISOString();
    const existing = this.database.prepare('SELECT * FROM coordination_agent_executions WHERE project_id = ? AND run_hash = ? AND agent_hash = ?')
      .get(projectId, runHash, agentHash) as Row | undefined;
    const executionId = existing ? String(existing.id) : this.ids.id();
    if (existing && ['completed', 'failed', 'cancelled'].includes(String(existing.state))) {
      this.transaction(() => {
        this.database.prepare(`INSERT INTO coordination_agent_events(project_id, event_id, execution_id, payload_hash, occurred_at, received_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, input.eventId, executionId, payloadHash, String(input.occurredAt), t);
      });
      return { idempotent: false, execution: this.agentExecutionView(existing) };
    }
    this.transaction(() => {
      if (!existing) {
        const parent = parentHash ? this.database.prepare('SELECT id FROM coordination_agent_executions WHERE project_id = ? AND run_hash = ? AND agent_hash = ?')
          .get(projectId, runHash, parentHash) as Row | undefined : undefined;
        this.database.prepare(`INSERT INTO coordination_agent_executions
          (id, project_id, session_id, run_hash, agent_hash, parent_hash, parent_execution_id, harness, name, role, task,
           state, state_reason, provenance, started_at, updated_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'harness-reported', ?, ?, ?)`).run(
          executionId, projectId, sessionId, runHash, agentHash, parentHash, parent?.id ?? null, payload.harness,
          payload.name, payload.role, payload.task, payload.state, payload.stateReason, t, t,
          ['completed', 'failed', 'cancelled'].includes(input.state) ? t : null,
        );
      } else {
        this.database.prepare(`UPDATE coordination_agent_executions SET session_id = COALESCE(?, session_id), harness = ?,
          name = COALESCE(?, name), role = COALESCE(?, role), task = COALESCE(?, task), state = ?, state_reason = ?,
          updated_at = ?, ended_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE ended_at END WHERE id = ?`)
          .run(sessionId, payload.harness, payload.name, payload.role, payload.task, payload.state, payload.stateReason, t,
            input.state, t, executionId);
      }
      if (parentHash) {
        const parent = this.database.prepare('SELECT id FROM coordination_agent_executions WHERE project_id = ? AND run_hash = ? AND agent_hash = ?')
          .get(projectId, runHash, parentHash) as Row | undefined;
        this.database.prepare('UPDATE coordination_agent_executions SET parent_hash = ?, parent_execution_id = COALESCE(parent_execution_id, ?) WHERE id = ?')
          .run(parentHash, parent?.id ?? null, executionId);
      }
      this.database.prepare(`UPDATE coordination_agent_executions SET parent_execution_id = ?
        WHERE project_id = ? AND run_hash = ? AND parent_hash = ? AND parent_execution_id IS NULL AND id <> ?`)
        .run(executionId, projectId, runHash, agentHash, executionId);
      this.database.prepare(`INSERT INTO coordination_agent_events(project_id, event_id, execution_id, payload_hash, occurred_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, input.eventId, executionId, payloadHash, String(input.occurredAt), t);
    });
    const row = this.database.prepare('SELECT * FROM coordination_agent_executions WHERE id = ?').get(executionId) as Row;
    return { idempotent: false, execution: this.agentExecutionView(row) };
  }

  private agentExecutionView(row: Row): AgentExecutionView {
    const state = String(row.state) as AgentExecutionView['state'];
    return {
      id: String(row.id), projectId: String(row.project_id), name: asString(row.name), role: asString(row.role),
      task: cleanText(asString(row.task), 280), state, stateReason: cleanText(asString(row.state_reason), 280),
      harness: redactText(String(row.harness), 64), provenance: String(row.provenance) as AgentExecutionView['provenance'],
      sessionId: asString(row.session_id), parentAvailable: row.parent_execution_id != null,
      startedAt: String(row.started_at), updatedAt: String(row.updated_at), endedAt: asString(row.ended_at),
      stale: false,
    };
  }

  private conflicts(projectId: string, runId?: string): CoordinationState['conflicts'] {
    const runPredicate = runId === undefined ? '' : ` AND claim_id IN (SELECT id FROM coordination_claims WHERE project_id = ? AND run_id = ?)
      AND conflicting_claim_id IN (SELECT id FROM coordination_claims WHERE project_id = ? AND run_id = ?)`;
    const rows = this.database.prepare(`SELECT * FROM coordination_conflicts WHERE project_id = ? AND resolved_at IS NULL${runPredicate}
      ORDER BY created_at DESC LIMIT ?`).all(projectId, ...(runId === undefined ? [] : [projectId, runId, projectId, runId]), this.maxStateItems) as Row[];
    return rows.map((row) => {
      let reasons: OverlapReason[] = [];
      try { reasons = JSON.parse(String(row.reasons_json)) as OverlapReason[]; } catch { /* empty */ }
      return {
        claimId: String(row.claim_id), conflictingClaimId: String(row.conflicting_claim_id),
        severity: String(row.severity) as 'info' | 'warning' | 'blocking', reasons,
        createdAt: String(row.created_at), resolvedAt: asString(row.resolved_at),
      };
    });
  }

  getState(projectId: string, runId?: string): CoordinationState {
    this.requireRunProject(projectId, runId);
    this.sweep(projectId);
    const claimRows = this.claimRows(projectId, false, runId);
    const completedRows = this.claimRows(projectId, true, runId);
    const claims = claimRows.map((row) => this.claimView(row));
    const completed = completedRows.map((row) => this.claimView(row));
    const sessionIds = runId === undefined ? undefined : new Set([...claimRows, ...completedRows].map((row) => String(row.coordination_session_id)));
    const sessions = (this.database.prepare('SELECT * FROM coordination_sessions WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .all(projectId, this.maxStateItems) as Row[]).filter((row) => sessionIds === undefined || sessionIds.has(String(row.id))).map((row) => this.sessionView(row));
    const fileMap = new Map<string, { agents: Set<string>; updatedAt: string }>();
    for (const claim of claims) {
      const agent = this.agentForSession(projectId, claim.coordinationSessionId) ?? 'unknown';
      for (const file of claim.scope.files) {
        const prior = fileMap.get(file) ?? { agents: new Set<string>(), updatedAt: claim.updatedAt };
        prior.agents.add(agent);
        if (prior.updatedAt < claim.updatedAt) prior.updatedAt = claim.updatedAt;
        fileMap.set(file, prior);
      }
    }
    const recentFiles = [...fileMap.entries()].sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, this.maxStateItems)
      .map(([file, item]) => ({ file, agents: [...item.agents], updatedAt: item.updatedAt }));
    const agents = (runId === undefined
      ? this.database.prepare(`SELECT * FROM coordination_agent_executions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`).all(projectId, this.maxStateItems)
      : this.database.prepare(`SELECT * FROM coordination_agent_executions WHERE project_id = ? AND run_hash = ? ORDER BY updated_at DESC LIMIT ?`).all(projectId, digest(runId), this.maxStateItems)
    ) as Row[];
    return { project: projectId, now: nowIso(this.clock), sessions, claims, completed, conflicts: this.conflicts(projectId, runId), recentFiles, agents: agents.map((row) => this.agentExecutionView(row)) };
  }

  state(projectId: string, runId?: string): CoordinationState {
    return this.getState(projectId, runId);
  }

  sweep(projectId?: string): void {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.claimIdleTtlMs).toISOString();
    const sessionCutoff = now.toISOString();
    const projectClause = projectId ? ' AND project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    this.database.prepare(`UPDATE coordination_sessions SET ended_at = COALESCE(ended_at, expires_at)
      WHERE ended_at IS NULL AND expires_at <= ?${projectClause}`).run(sessionCutoff, ...args);
    const claimRows = this.database.prepare(`SELECT id, project_id FROM coordination_claims
      WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')}) AND updated_at < ?${projectClause}`)
      .all(...TERMINAL_STATUSES, cutoff, ...args) as Row[];
    for (const row of claimRows) {
      const t = now.toISOString();
      this.database.prepare("UPDATE coordination_claims SET status = 'expired', updated_at = ?, completed_at = ? WHERE id = ? AND status NOT IN ('done','abandoned','expired','released')")
        .run(t, t, row.id);
      this.database.prepare('UPDATE coordination_conflicts SET resolved_at = ? WHERE (claim_id = ? OR conflicting_claim_id = ?) AND resolved_at IS NULL').run(t, row.id, row.id);
    }
    // Keep bounded event history. The execution row remains, while old raw event
    // ids/hashes can be evicted because retries after this point are new events.
    this.database.prepare(`DELETE FROM coordination_agent_events WHERE received_at < datetime(?, '-7 days')`).run(now.toISOString());
  }
}

export function createCoordinationService(database: DatabaseConnection, clock?: Clock, ids?: IdSource, options?: CoordinationServiceOptions): CoordinationService {
  return new CoordinationService(database, clock, ids, options);
}

// Kept as a narrow alias for callers migrating from the old Mediation store.
export const CoordinationStore = CoordinationService;
