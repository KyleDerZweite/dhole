import { createHash } from 'node:crypto';
import type { EventEnvelope, NodeCommand } from '@dhole-control/shared';
import { HttpError } from '../../../lib/http.js';
import type { AuthenticatedUser, ServerContext } from '../../../lib/module.js';
import { hashToken, redactText, tokenMatches } from '../../../lib/security.js';
import { canAccessProject } from '../projects.js';
import type {
  AnswerApprovalInput,
  CreateAgentInput,
  CreateRunInput,
  CreateSessionInput,
  ProgressInput,
  QueueMessageInput,
  ResumeActivationInput,
  SessionApproval,
  SessionMessage,
  SessionParticipant,
  SessionProgress,
  SessionRun,
  SessionSnapshot,
  SessionSummary,
  SessionTurn,
  RuntimeRegistration,
  StartTurnInput,
  SteerInput,
  TurnState,
  RunState,
} from './types.js';
import type { AgentTreeNode } from './types.js';

const ACTIVE_ACTIVATION_STATES = new Set(['queued', 'running', 'waiting_on_children', 'needs_input', 'needs_approval', 'blocked']);
const TERMINAL_ACTIVATION_STATES = new Set(['settled', 'failed', 'cancelled', 'stale']);
const TERMINAL_RUN_STATES = new Set<RunState>(['settled', 'failed', 'cancelled']);
const LEASE_MS = 30_000;

export class SessionsError extends HttpError {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 422 | 413 | 429 | 500 | 503, code: string, message: string) {
    super(status, code, message);
  }
}

/** Narrow Machine seam keeps Sessions unit-testable without coupling to Machine's class. */
export interface SessionMachines {
  enqueueCommand(input: { machineId: string; projectId: string; command: NodeCommand }): Record<string, unknown>;
  deliverPending?(machineId: string): void;
}
export type SessionsTransientEventHandler = (sessionId: string, payload: { eventKind: string; payload: Record<string, unknown>; occurredAt: string }) => void;

export class SessionsService {
  private machines: SessionMachines | undefined;
  private transientEventHandler: SessionsTransientEventHandler | undefined;

  constructor(private readonly context: ServerContext, machines?: SessionMachines) { this.machines = machines; }

  setMachines(machines: SessionMachines): void { this.machines = machines; }
  setTransientEventHandler(handler: SessionsTransientEventHandler): void { this.transientEventHandler = handler; }

  createSession(user: AuthenticatedUser, projectId: string, input: CreateSessionInput): SessionSummary {
    this.assertProjectMember(projectId, user, true);
    this.validatePlacementScope(projectId, input);
    const now = this.now();
    const id = this.context.ids.id();
    this.context.events.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO sessions(id, project_id, title, runtime_registration_id, model_id, workspace_id, state, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
      `).run(id, projectId, input.title, input.runtimeRegistrationId ?? null, input.modelId ?? null, input.workspaceId ?? null, user.id, now, now);
      this.context.database.prepare('INSERT INTO session_participants(session_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, user.id, now);
      this.append(projectId, 'session.created', 'session', id, user, { sessionId: id, title: input.title });
      this.audit(projectId, user, 'session.create', 'session', id, 'allowed', { title: input.title });
    });
    return this.getSummary(id)!;
  }

  listSessions(user: AuthenticatedUser, projectId: string): SessionSummary[] {
    this.assertProjectMember(projectId, user);
    const rows = this.context.database.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as SessionRow[];
    return rows.filter((row) => this.isParticipant(row.id, user.id) || this.isTeamAdministrator(user.teamId, user.id)).map(rowToSummary);
  }

  listRuntimeRegistrations(user: AuthenticatedUser, projectId: string): RuntimeRegistration[] {
    this.assertProjectMember(projectId, user);
    const rows = this.context.database.prepare(`SELECT rr.id, rr.machine_id, rr.kind, rr.label, rr.available, rr.capabilities_json FROM runtime_registrations rr JOIN machines m ON m.id = rr.machine_id WHERE m.team_id = ? AND m.status = 'connected' AND rr.available = 1 ORDER BY m.name, rr.label`).all(user.teamId) as Array<{ id: string; machine_id: string; kind: string; label: string; available: number; capabilities_json: string }>;
    return rows.map((row) => ({ id: row.id, machineId: row.machine_id, kind: row.kind, label: row.label, available: row.available === 1, capabilities: parseJson(row.capabilities_json) }));
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const row = this.context.database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
    return row ? rowToSummary(row) : undefined;
  }

  /** Reconciles durable Machine command outcomes into the session state machine. */
  maintenance(): void {
    this.expirePendingApprovals();
    this.reconcileApprovalCommands();
    const rows = this.context.database.prepare(`
      SELECT s.id, s.project_id, s.created_by, s.runtime_registration_id, s.active_turn_id, s.state,
             rr.machine_id, rr.kind AS runtime_kind
      FROM sessions s JOIN runtime_registrations rr ON rr.id = s.runtime_registration_id
      WHERE s.runtime_registration_id IS NOT NULL AND s.state NOT IN ('cancelled','closed')
    `).all() as RuntimeSessionRow[];
    for (const session of rows) this.reconcileRuntimeSession(session);
  }

  private reconcileApprovalCommands(): void {
    const rows = this.context.database.prepare("SELECT c.project_id, c.payload_json, c.error_summary, c.state, s.id AS session_id, s.created_by FROM node_commands c JOIN approvals a ON json_extract(c.payload_json, '$.approvalId') = COALESCE(a.runtime_approval_id, a.id) JOIN sessions s ON s.id = a.session_id WHERE c.kind = 'answer_approval' AND c.state IN ('failed','expired','cancelled') AND s.state NOT IN ('failed','cancelled','closed')").all() as Array<{ project_id: string; payload_json: string; error_summary: string | null; state: string; session_id: string; created_by: string }>;
    for (const row of rows) {
      const actor = this.systemActor(row.created_by, row.project_id);
      this.context.events.transaction(() => {
        const changed = this.context.database.prepare("UPDATE sessions SET state = 'failed', updated_at = ? WHERE id = ? AND state NOT IN ('failed','cancelled','closed')").run(this.now(), row.session_id).changes;
        if (changed) this.append(row.project_id, 'run.failed', 'session', row.session_id, actor, { sessionId: row.session_id, reason: 'Runtime approval command failed', error: redactText(row.error_summary ?? `command ${row.state}`, 2_000) });
      });
    }
  }

  handleRuntimeEvent(input: { projectId: string; machineId: string; commandId: string; operationKey: string; event: { eventId: string; eventKind: string; payload: Record<string, unknown>; occurredAt: string } }): void {
    const durable = ['approval.requested', 'tool.call.started', 'tool.call.completed'].includes(input.event.eventKind);
    const transient = ['message.delta', 'turn.started', 'turn.completed', 'turn.steered', 'turn.cancelled'].includes(input.event.eventKind);
    if (!durable && !transient) return;
    const row = this.context.database.prepare('SELECT payload_json FROM node_commands WHERE machine_id = ? AND id = ? AND operation_key = ? AND project_id = ?').get(input.machineId, input.commandId, input.operationKey, input.projectId) as { payload_json: string } | undefined;
    if (!row) return;
    const command = parseJson(row.payload_json);
    const runtimeSessionId = typeof command.runtimeSessionId === 'string' ? command.runtimeSessionId : undefined;
    if (!runtimeSessionId) return;
    const activation = this.context.database.prepare(`SELECT a.id AS activation_id, a.logical_agent_id, a.native_session_id, t.id AS turn_id, r.id AS run_id, s.id AS session_id, s.created_by FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id JOIN runs r ON r.id = l.run_id JOIN sessions s ON s.id = r.session_id LEFT JOIN session_turns t ON t.run_id = r.id AND t.state = 'running' WHERE s.project_id = ? AND a.machine_id = ? AND a.native_session_id = ? AND a.state IN ('running','needs_input','needs_approval') AND r.state NOT IN ('settled','failed','cancelled') AND s.state NOT IN ('cancelled','closed') ORDER BY a.ordinal DESC LIMIT 1`).get(input.projectId, input.machineId, runtimeSessionId) as { activation_id: string; logical_agent_id: string; turn_id: string | null; run_id: string; session_id: string; created_by: string } | undefined;
    if (!activation) return;
    // Only turn lifecycle/delta events may establish a provider turn ID.  A
    // tool or approval payload's reserved `turnId` is untrusted metadata and
    // must not steer later commands to an attacker-chosen turn.
    const providerTurnId = transient && (typeof input.event.payload.turnId === 'string' ? input.event.payload.turnId : typeof input.event.payload.runtimeTurnId === 'string' ? input.event.payload.runtimeTurnId : undefined);
    if (providerTurnId && activation.turn_id) this.context.database.prepare('UPDATE session_turns SET runtime_turn_id = COALESCE(runtime_turn_id, ?) WHERE id = ?').run(providerTurnId.slice(0, 240), activation.turn_id);
    if (transient) {
      this.transientEventHandler?.(activation.session_id, { eventKind: input.event.eventKind, payload: sanitizeRuntimePayload(input.event.payload), occurredAt: input.event.occurredAt });
      return;
    }
    const actor = this.systemActor(activation.created_by, input.projectId);
    // Machine reduces terminal command events while its command-state
    // transaction is still open.  EventStore transactions are deliberately
    // not nestable (better-sqlite3 rejects SAVEPOINT-style nesting), so reuse
    // the ambient transaction when this callback is invoked from Machine and
    // start one only for standalone runtime-event frames.
    const reduce = (): void => {
      const existingEvent = this.context.database.prepare('SELECT event_id FROM event_log WHERE project_id = ? AND source_adapter = ? AND source_native_event_id = ?').get(input.projectId, 'sessions.runtime', input.event.eventId);
      if (existingEvent) return;
      const payload = sanitizeRuntimePayload(input.event.payload);
      if (input.event.eventKind === 'approval.requested') {
        const runtimeApprovalId = typeof input.event.payload.runtimeApprovalId === 'string' ? input.event.payload.runtimeApprovalId : typeof input.event.payload.approvalId === 'string' ? input.event.payload.approvalId : input.event.eventId;
        const prior = this.context.database.prepare('SELECT id FROM approvals WHERE session_id = ? AND runtime_approval_id = ?').get(activation.session_id, runtimeApprovalId);
        if (!prior) {
          const approvalId = this.context.ids.id();
          const kind = typeof input.event.payload.kind === 'string' ? redactText(input.event.payload.kind, 120) : 'runtime_approval';
          const summary = typeof input.event.payload.summary === 'string' ? redactText(input.event.payload.summary, 240) : 'Runtime approval requested';
          this.context.database.prepare(`INSERT INTO approvals(id, session_id, run_id, turn_id, runtime_approval_id, kind, summary, detail_redacted_json, state, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(approvalId, activation.session_id, activation.run_id, activation.turn_id, runtimeApprovalId, kind, summary, JSON.stringify(payload), input.event.occurredAt);
          this.context.database.prepare("UPDATE sessions SET state = 'needs_approval', updated_at = ? WHERE id = ?").run(this.now(), activation.session_id);
          this.appendRuntimeEvent(input.projectId, 'approval.requested', 'approval', approvalId, actor, { sessionId: activation.session_id, approvalId, kind, summary }, input.event.eventId);
        }
      }
      if (input.event.eventKind === 'tool.call.started' || input.event.eventKind === 'tool.call.completed') {
        this.appendRuntimeEvent(input.projectId, input.event.eventKind as 'tool.call.started' | 'tool.call.completed', 'session', activation.session_id, actor, { ...payload, sessionId: activation.session_id, runId: activation.run_id, turnId: activation.turn_id }, input.event.eventId);
      }
      this.context.database.prepare('UPDATE agent_activations SET last_activity_at = ? WHERE id = ?').run(this.now(), activation.activation_id);
    };
    if (this.context.database.inTransaction) reduce();
    else this.context.events.transaction(reduce);
  }

  addParticipant(user: AuthenticatedUser, sessionId: string, participantUserId: string): SessionParticipant {
    const session = this.authorizeSession(user, sessionId, true);
    const target = this.context.database.prepare('SELECT id, display_name FROM users WHERE id = ? AND disabled_at IS NULL').get(participantUserId) as { id: string; display_name: string } | undefined;
    if (!target) throw new SessionsError(404, 'user_not_found', 'User was not found');
    if (!canAccessProject(this.context, { id: participantUserId, teamId: session.teamId }, session.projectId)) throw new SessionsError(422, 'not_a_project_member', 'Participant must have access to the project');
    const now = this.now();
    this.context.events.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO session_participants(session_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(session_id, user_id) DO UPDATE SET left_at = NULL
      `).run(sessionId, participantUserId, now);
      this.audit(session.projectId, user, 'session.participant.add', 'session_participant', `${sessionId}:${participantUserId}`, 'allowed', { participantUserId });
    });
    return { userId: participantUserId, displayName: target.display_name, joinedAt: now };
  }

  queueMessage(user: AuthenticatedUser, sessionId: string, input: QueueMessageInput): SessionMessage {
    const session = this.authorizeSession(user, sessionId, true);
    const now = this.now();
    const idempotencyKey = input.idempotencyKey;
    const requestHash = createHash('sha256').update(JSON.stringify([input.body, input.runId ?? null, input.turnId ?? null, Boolean(input.includeHumanIdentity)])).digest('hex');
    let commandToQueue: { machineId: string; projectId: string; command: NodeCommand } | undefined;
    const result = this.context.events.transaction(() => {
      const activeTurn = session.activeTurnId
        ? this.context.database.prepare("SELECT id, run_id FROM session_turns WHERE id = ? AND state = 'running'").get(session.activeTurnId) as { id: string; run_id: string } | undefined
        : undefined;
      if (idempotencyKey) {
        const existing = this.context.database.prepare(`
          SELECT payload_json FROM event_log WHERE project_id = ? AND idempotency_key = ?
        `).get(session.projectId, idempotencyKey) as { payload_json: string } | undefined;
        if (existing) {
          const payload = JSON.parse(existing.payload_json) as { messageId?: string; requestHash?: string };
          const prior = payload.messageId ? this.context.database.prepare('SELECT * FROM messages WHERE id = ?').get(payload.messageId) as MessageRow | undefined : undefined;
          if (!prior || prior.session_id !== sessionId || prior.author_user_id !== user.id || prior.body !== input.body || prior.include_human_identity !== (input.includeHumanIdentity ? 1 : 0)) {
            throw new SessionsError(409, 'idempotency_key_reused', 'Idempotency key was already used for a different message');
          }
          if (payload.requestHash) {
            if (payload.requestHash !== requestHash) throw new SessionsError(409, 'idempotency_key_reused', 'Idempotency key was already used for a different message');
            return rowToMessage(prior);
          }
          let normalizedReferences: { runId?: string; turnId?: string };
          try {
            normalizedReferences = this.sessionReferences(sessionId, input.runId ?? activeTurn?.run_id ?? this.latestRunId(sessionId), input.turnId ?? activeTurn?.id, true);
          } catch {
            throw new SessionsError(409, 'idempotency_key_reused', 'Idempotency key was already used for a different message');
          }
          if (prior.run_id !== (normalizedReferences.runId ?? null) || prior.turn_id !== (normalizedReferences.turnId ?? null)) {
            throw new SessionsError(409, 'idempotency_key_reused', 'Idempotency key was already used for a different message');
          }
          return rowToMessage(prior);
        }
      }
      const references = this.sessionReferences(sessionId, input.runId ?? activeTurn?.run_id ?? this.latestRunId(sessionId), input.turnId ?? activeTurn?.id);
      const runtimeStart = Boolean(session.runtimeRegistrationId && !activeTurn && session.state === 'idle' && !references.runId && !references.turnId);
      const placement = runtimeStart ? this.runtimePlacement(session.projectId, session.runtimeRegistrationId!) : undefined;
      if (runtimeStart && !placement) throw new SessionsError(422, 'runtime_unavailable', 'No allowlisted repository is available for the configured runtime');
      const sequenceRow = this.context.database.prepare('UPDATE sessions SET next_message_sequence = next_message_sequence + 1, updated_at = ? WHERE id = ? RETURNING next_message_sequence').get(now, sessionId) as { next_message_sequence: number } | undefined;
      if (!sequenceRow) throw new SessionsError(404, 'session_not_found', 'Session was not found');
      const messageIdValue = this.context.ids.id();
      this.context.database.prepare(`
        INSERT INTO messages(id, session_id, run_id, turn_id, sequence, role, author_user_id, body, status, include_human_identity, created_at)
        VALUES (?, ?, ?, ?, ?, 'human', ?, ?, 'queued', ?, ?)
      `).run(messageIdValue, sessionId, references.runId ?? null, references.turnId ?? null, sequenceRow.next_message_sequence, user.id, input.body, input.includeHumanIdentity ? 1 : 0, now);
      this.append(session.projectId, 'human.message.queued', 'session', sessionId, user, { sessionId, messageId: messageIdValue, sequence: sequenceRow.next_message_sequence, queued: Boolean(activeTurn), includeHumanIdentity: Boolean(input.includeHumanIdentity), ...(idempotencyKey ? { requestHash } : {}) }, idempotencyKey);
      this.audit(session.projectId, user, 'session.message.queue', 'message', messageIdValue, 'allowed', { sequence: sequenceRow.next_message_sequence });

      if (runtimeStart && placement) {
        const runId = this.context.ids.id();
        const logicalAgentId = this.context.ids.id();
        const activationId = this.context.ids.id();
        const turnId = this.context.ids.id();
        this.context.database.prepare(`INSERT INTO runs(id, session_id, root_objective, issue_reference, state, created_by, created_at, started_at, updated_at) VALUES (?, ?, ?, NULL, 'running', ?, ?, ?, ?)`).run(runId, sessionId, input.body, user.id, now, now, now);
        this.context.database.prepare('INSERT INTO logical_agents(id, run_id, name, role, objective, created_at) VALUES (?, ?, \'root\', \'root\', ?, ?)').run(logicalAgentId, runId, input.body, now);
        this.context.database.prepare(`INSERT INTO agent_activations(id, logical_agent_id, machine_id, runtime_registration_id, workspace_id, ordinal, state, started_at, last_activity_at) VALUES (?, ?, ?, ?, NULL, 1, 'running', ?, ?)`).run(activationId, logicalAgentId, placement.machineId, session.runtimeRegistrationId, now, now);
        this.context.database.prepare(`INSERT INTO session_turns(id, session_id, run_id, runtime_turn_id, state, started_at, created_at) VALUES (?, ?, ?, NULL, 'running', ?, ?)`).run(turnId, sessionId, runId, now, now);
        this.context.database.prepare("UPDATE messages SET run_id = ?, turn_id = ?, status = 'delivered', delivered_at = ? WHERE id = ?").run(runId, turnId, now, messageIdValue);
        this.context.database.prepare("UPDATE sessions SET state = 'busy', active_turn_id = ?, updated_at = ? WHERE id = ?").run(turnId, now, sessionId);
        this.append(session.projectId, 'run.started', 'run', runId, user, { sessionId, runId });
        this.append(session.projectId, 'human.message.delivered', 'session', sessionId, user, { sessionId, messageId: messageIdValue, turnId });
        const operationKey = `session:${sessionId}:run:${runId}:create`;
        const command = this.commandForOperation(placement.machineId, operationKey, () => ({
          kind: 'create_runtime_session' as const,
          commandId: this.context.ids.id(),
          operationKey,
          issuedAt: now,
          expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(),
          repositoryId: placement.repositoryId,
          runtimeId: placement.runtimeId,
          runtimeSessionKey: `session-${sessionId}-${runId}`,
          cwd: '.',
        }));
        commandToQueue = { machineId: placement.machineId, projectId: session.projectId, command };
        this.enqueueCommand(commandToQueue);
      }
      return rowToMessage(this.context.database.prepare('SELECT * FROM messages WHERE id = ?').get(messageIdValue) as MessageRow);
    });
    return result;
  }

  completeAgentMessage(user: AuthenticatedUser, sessionId: string, input: { body: string; runId?: string | undefined; turnId?: string | undefined; logicalAgentId?: string | undefined }): SessionMessage {
    const session = this.authorizeSession(user, sessionId, true);
    const now = this.now();
    return this.context.events.transaction(() => {
      const references = this.sessionReferences(sessionId, input.runId ?? this.latestRunId(sessionId), input.turnId ?? session.activeTurnId);
      if (input.logicalAgentId) {
        const agent = this.context.database.prepare('SELECT l.id, l.run_id FROM logical_agents l JOIN runs r ON r.id = l.run_id WHERE l.id = ? AND r.session_id = ?').get(input.logicalAgentId, sessionId) as { id: string; run_id: string } | undefined;
        if (!agent) throw new SessionsError(422, 'invalid_logical_agent', 'Logical agent does not belong to this session');
        this.assertRunWritable(agent.run_id);
        if (references.runId && references.runId !== agent.run_id) throw new SessionsError(422, 'invalid_agent_run', 'Logical agent does not belong to the selected run');
      }
      const sequence = this.context.database.prepare('UPDATE sessions SET next_message_sequence = next_message_sequence + 1, updated_at = ? WHERE id = ? RETURNING next_message_sequence').get(now, sessionId) as { next_message_sequence: number };
      const id = this.context.ids.id();
      this.context.database.prepare(`INSERT INTO messages(id, session_id, run_id, turn_id, sequence, role, logical_agent_id, body, status, include_human_identity, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, 'completed', 0, ?, ?)`)
        .run(id, sessionId, references.runId ?? null, references.turnId ?? null, sequence.next_message_sequence, input.logicalAgentId ?? null, input.body, now, now);
      this.append(session.projectId, 'agent.message.completed', 'session', sessionId, user, { sessionId, messageId: id, sequence: sequence.next_message_sequence, logicalAgentId: input.logicalAgentId });
      return rowToMessage(this.context.database.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow);
    });
  }

  createRun(user: AuthenticatedUser, sessionId: string, input: CreateRunInput): SessionRun {
    const session = this.authorizeSession(user, sessionId, true);
    if (session.runtimeRegistrationId) throw new SessionsError(422, 'runtime_requires_message', 'Runtime-backed sessions start runs by queueing a message');
    const now = this.now();
    const runId = this.context.ids.id();
    this.context.events.transaction(() => {
      this.context.database.prepare(`INSERT INTO runs(id, session_id, root_objective, issue_reference, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(runId, sessionId, input.rootObjective, input.issueReference ?? null, user.id, now, now);
      const logicalAgentId = this.context.ids.id();
      const activationId = this.context.ids.id();
      this.context.database.prepare('INSERT INTO logical_agents(id, run_id, name, role, objective, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(logicalAgentId, runId, 'root', 'root', input.rootObjective, now);
      this.context.database.prepare(`INSERT INTO agent_activations(id, logical_agent_id, ordinal, state, started_at, last_activity_at) VALUES (?, ?, 1, 'queued', NULL, ?)`)
        .run(activationId, logicalAgentId, now);
      this.audit(session.projectId, user, 'run.create', 'run', runId, 'allowed', {});
    });
    return this.getRun(runId)!;
  }

  startRun(user: AuthenticatedUser, runId: string): SessionRun {
    const run = this.authorizeRun(user, runId, true);
    const session = this.authorizeSession(user, run.sessionId, true);
    if (session.runtimeRegistrationId) throw new SessionsError(422, 'runtime_requires_message', 'Runtime-backed sessions start runs by queueing a message');
    const now = this.now();
    this.context.events.transaction(() => {
      const changed = this.context.database.prepare("UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND state IN ('queued', 'paused')").run(now, now, runId).changes;
      if (!changed && run.state !== 'running') throw new SessionsError(409, 'invalid_run_state', 'Run is not startable');
      this.context.database.prepare(`UPDATE agent_activations SET state = 'running', started_at = COALESCE(started_at, ?), last_activity_at = ? WHERE logical_agent_id IN (SELECT l.id FROM logical_agents l WHERE l.run_id = ? AND NOT EXISTS (SELECT 1 FROM agent_edges e WHERE e.child_logical_agent_id = l.id)) AND ordinal = (SELECT max(a2.ordinal) FROM agent_activations a2 WHERE a2.logical_agent_id = agent_activations.logical_agent_id) AND state = 'queued'`).run(now, now, runId);
      if (changed) this.append(run.projectId, 'run.started', 'run', runId, user, { sessionId: run.sessionId, runId });
      this.audit(run.projectId, user, 'run.start', 'run', runId, 'allowed', {});
    });
    return this.getRun(runId)!;
  }

  setRunState(user: AuthenticatedUser, runId: string, state: RunState): SessionRun {
    // Repeating the current terminal state is a safe idempotent read; all
    // other terminal-run writes are rejected by authorizeRun's shared guard.
    const run = this.authorizeRun(user, runId, true, true);
    const now = this.now();
    this.context.events.transaction(() => {
      const currentRun = this.context.database.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: RunState } | undefined;
      if (!currentRun) throw new SessionsError(404, 'run_not_found', 'Run was not found');
      if (TERMINAL_RUN_STATES.has(currentRun.state)) {
        if (currentRun.state !== state) throw new SessionsError(409, 'run_terminal', 'Terminal runs are immutable; resume the session with a new run');
        return;
      }
      if (currentRun.state === state) return;
      let nextState = state;
      if (state === 'settled' && this.hasActiveDescendantForRun(runId)) nextState = 'running';
      const terminal = nextState === 'settled' || nextState === 'failed' || nextState === 'cancelled';
      if (nextState === 'failed' || nextState === 'cancelled') {
        this.terminalizeRuntimeDescendants(run.sessionId, runId, nextState, now);
        this.context.database.prepare("UPDATE agent_activations SET state = ?, ended_at = COALESCE(ended_at, ?), last_activity_at = ? WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?) AND state NOT IN ('settled','failed','cancelled','stale')").run(nextState, now, now, runId);
      }
      this.context.database.prepare('UPDATE runs SET state = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?').run(nextState, terminal ? 1 : 0, terminal ? now : null, now, runId);
      if (state === 'settled' && nextState === 'running') {
        this.context.database.prepare("UPDATE agent_activations SET state = 'waiting_on_children', last_activity_at = ? WHERE logical_agent_id IN (SELECT l.id FROM logical_agents l WHERE l.run_id = ? AND NOT EXISTS (SELECT 1 FROM agent_edges e WHERE e.child_logical_agent_id = l.id)) AND state NOT IN ('settled','failed','cancelled','stale')").run(now, runId);
      }
      if (nextState === 'settled') {
        this.context.database.prepare("UPDATE agent_activations SET state = 'settled', ended_at = ?, last_activity_at = ? WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?) AND state NOT IN ('settled','failed','cancelled','stale')").run(now, now, runId);
      }
      if (nextState === 'settled' || nextState === 'failed' || nextState === 'cancelled') this.append(run.projectId, nextState === 'failed' ? 'run.failed' : 'run.settled', 'run', runId, user, { sessionId: run.sessionId, runId, state: nextState });
      if (nextState === 'failed' || nextState === 'cancelled' || nextState === 'settled') {
        this.context.database.prepare("UPDATE sessions SET state = CASE ? WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'settled' THEN CASE WHEN state = 'busy' THEN 'idle' ELSE state END END, active_turn_id = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('closed')").run(nextState, now, run.sessionId);
      }
      this.audit(run.projectId, user, 'run.state', 'run', runId, 'allowed', { state: nextState });
    });
    return this.getRun(runId)!;
  }

  startTurn(user: AuthenticatedUser, input: StartTurnInput): SessionTurn {
    const run = this.authorizeRun(user, input.runId, true);
    if (run.sessionId !== this.sessionIdForTurnRun(input.runId)) throw new SessionsError(422, 'invalid_run', 'Run is not attached to a session');
    const session = this.authorizeSession(user, run.sessionId, true);
    if (session.runtimeRegistrationId) throw new SessionsError(422, 'runtime_turn_requires_message', 'Runtime-backed sessions start turns by queueing a message');
    const now = this.now();
    const turnId = this.context.ids.id();
    return this.context.events.transaction(() => {
      const currentRun = this.context.database.prepare('SELECT state FROM runs WHERE id = ?').get(input.runId) as { state: RunState } | undefined;
      if (!currentRun) throw new SessionsError(404, 'run_not_found', 'Run was not found');
      if (TERMINAL_RUN_STATES.has(currentRun.state)) throw new SessionsError(409, 'run_terminal', 'Cannot start a turn for a terminal run');
      const active = this.context.database.prepare("SELECT id FROM session_turns WHERE session_id = ? AND state = 'running'").get(session.id) as { id: string } | undefined;
      if (active) throw new SessionsError(409, 'active_turn_exists', 'Only one normal turn may be active per session');
      const runStarted = this.context.database.prepare("UPDATE runs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND state IN ('queued', 'paused', 'running')").run(now, now, input.runId).changes;
      if (!runStarted && currentRun.state !== 'running') throw new SessionsError(409, 'invalid_run_state', 'Run is not startable');
      if (currentRun.state !== 'running' && runStarted) this.append(run.projectId, 'run.started', 'run', input.runId, user, { sessionId: run.sessionId, runId: input.runId });
      this.context.database.prepare(`UPDATE agent_activations SET state = 'running', started_at = COALESCE(started_at, ?), last_activity_at = ? WHERE logical_agent_id IN (SELECT l.id FROM logical_agents l WHERE l.run_id = ? AND NOT EXISTS (SELECT 1 FROM agent_edges e WHERE e.child_logical_agent_id = l.id)) AND state = 'queued'`).run(now, now, input.runId);
      this.context.database.prepare(`INSERT INTO session_turns(id, session_id, run_id, runtime_turn_id, state, started_at, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`)
        .run(turnId, run.sessionId, input.runId, input.runtimeTurnId ?? null, now, now);
      const sessionChanged = this.context.database.prepare("UPDATE sessions SET state = 'busy', active_turn_id = ?, updated_at = ? WHERE id = ? AND state NOT IN ('cancelled', 'closed')").run(turnId, now, run.sessionId).changes;
      if (!sessionChanged) throw new SessionsError(409, 'session_not_writable', 'Session is no longer writable');
      const queued = this.context.database.prepare("SELECT * FROM messages WHERE session_id = ? AND status = 'queued' AND (run_id IS NULL OR run_id = ?) ORDER BY sequence LIMIT 1").get(run.sessionId, input.runId) as MessageRow | undefined;
      if (queued) {
        this.context.database.prepare("UPDATE messages SET status = 'delivered', turn_id = ?, delivered_at = ? WHERE id = ? AND status = 'queued'").run(turnId, now, queued.id);
        this.append(run.projectId, 'human.message.delivered', 'session', run.sessionId, user, { sessionId: run.sessionId, messageId: queued.id, turnId });
      }
      this.audit(run.projectId, user, 'turn.start', 'turn', turnId, 'allowed', { runId: input.runId });
      return rowToTurn(this.context.database.prepare('SELECT * FROM session_turns WHERE id = ?').get(turnId) as TurnRow);
    });
  }

  startTurnForSession(user: AuthenticatedUser, sessionId: string, input: StartTurnInput): SessionTurn {
    const run = this.authorizeRun(user, input.runId, true);
    if (run.sessionId !== sessionId) throw new SessionsError(403, 'session_forbidden', 'Run does not belong to this session');
    return this.startTurn(user, input);
  }

  completeTurn(user: AuthenticatedUser, turnId: string, state: Extract<TurnState, 'completed' | 'failed' | 'cancelled'> = 'completed'): SessionTurn {
    const turn = this.authorizeTurn(user, turnId, true);
    const now = this.now();
    this.context.events.transaction(() => {
      const current = this.context.database.prepare('SELECT * FROM session_turns WHERE id = ?').get(turnId) as TurnRow | undefined;
      if (!current) throw new SessionsError(404, 'turn_not_found', 'Turn was not found');
      if (current.state !== 'running') {
        if (current.state === state) return;
        throw new SessionsError(409, 'turn_not_running', 'Turn is no longer running');
      }
      this.assertRunWritable(turn.runId);
      const changed = this.context.database.prepare('UPDATE session_turns SET state = ?, completed_at = ? WHERE id = ? AND state = \'running\'').run(state, now, turnId).changes;
      if (!changed) throw new SessionsError(409, 'turn_not_running', 'Turn is no longer running');
      this.context.database.prepare("UPDATE messages SET status = ?, completed_at = ? WHERE turn_id = ? AND status = 'delivered'").run(state === 'completed' ? 'completed' : state, now, turnId);
      if (state !== 'completed') {
        this.terminalizeRuntimeDescendants(turn.sessionId, turn.runId, state, now);
        this.context.database.prepare("UPDATE agent_activations SET state = ?, ended_at = COALESCE(ended_at, ?), last_activity_at = ? WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?) AND state NOT IN ('settled','failed','cancelled','stale')").run(state, now, now, turn.runId);
      }
      this.context.database.prepare(`UPDATE sessions SET state = CASE WHEN state = 'busy' THEN 'idle' ELSE state END, active_turn_id = CASE WHEN active_turn_id = ? THEN NULL ELSE active_turn_id END, updated_at = ? WHERE id = ?`).run(turnId, now, turn.sessionId);
      const runRow = this.context.database.prepare('SELECT state FROM runs WHERE id = ?').get(turn.runId) as { state: RunState } | undefined;
      if (!runRow) throw new SessionsError(404, 'run_not_found', 'Run was not found');
      if (!TERMINAL_RUN_STATES.has(runRow.state)) this.context.database.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now, turn.runId);
      if ((state === 'failed' || state === 'cancelled') && !TERMINAL_RUN_STATES.has(runRow.state)) {
        const runChanged = this.context.database.prepare('UPDATE runs SET state = ?, completed_at = ?, updated_at = ? WHERE id = ? AND state NOT IN (\'settled\', \'failed\', \'cancelled\')').run(state, now, now, turn.runId).changes;
        if (runChanged) {
          const eventKind = state === 'failed' ? 'run.failed' : 'run.settled';
          this.append(turn.projectId, eventKind, 'run', turn.runId, user, { sessionId: turn.sessionId, runId: turn.runId, turnId, state });
        }
      }
      this.audit(turn.projectId, user, `turn.${state}`, 'turn', turnId, 'allowed', {});
    });
    return this.getTurn(turnId)!;
  }

  startActivation(user: AuthenticatedUser, activationId: string): AgentTreeNode {
    const activation = this.context.database.prepare('SELECT a.*, l.run_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id WHERE a.id = ?').get(activationId) as ActivationRow | undefined;
    if (!activation) throw new SessionsError(404, 'activation_not_found', 'Agent activation was not found');
    const run = this.authorizeRun(user, activation.run_id, true);
    const now = this.now();
    this.context.events.transaction(() => {
      const changed = this.context.database.prepare("UPDATE agent_activations SET state = 'running', started_at = COALESCE(started_at, ?), last_activity_at = ? WHERE id = ? AND state = 'queued'").run(now, now, activationId).changes;
      if (!changed && activation.state !== 'running') throw new SessionsError(409, 'activation_not_queued', 'Activation is not queued');
      this.append(run.projectId, 'child.started', 'activation', activationId, user, { sessionId: run.sessionId, runId: run.id, activationId, logicalAgentId: activation.logical_agent_id });
      this.audit(run.projectId, user, 'agent.activation.start', 'activation', activationId, 'allowed', {});
    });
    return this.getAgentNode(activation.logical_agent_id)!;
  }

  acquireSteeringLease(user: AuthenticatedUser, sessionId: string, providedToken?: string): { token: string; expiresAt: string } {
    const session = this.authorizeSession(user, sessionId, true);
    const nowDate = this.context.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + LEASE_MS).toISOString();
    const token = providedToken ?? this.context.ids.token(32);
    const existing = this.context.database.prepare('SELECT * FROM steering_leases WHERE session_id = ?').get(sessionId) as LeaseRow | undefined;
    if (existing && existing.expires_at > now && existing.holder_user_id !== user.id) {
      this.audit(session.projectId, user, 'session.steering.lease', 'steering_lease', sessionId, 'denied', { reason: 'held' });
      throw new SessionsError(409, 'steering_lease_held', 'Another participant currently holds the steering lease');
    }
    if (existing && existing.holder_user_id === user.id && providedToken && !tokenMatches(providedToken, existing.lease_token_hash)) {
      throw new SessionsError(403, 'invalid_steering_lease', 'Steering lease token is invalid');
    }
    this.context.events.transaction(() => {
      this.context.database.prepare(`INSERT INTO steering_leases(session_id, holder_user_id, lease_token_hash, acquired_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET holder_user_id = excluded.holder_user_id, lease_token_hash = excluded.lease_token_hash, expires_at = excluded.expires_at, renewed_at = excluded.renewed_at`).run(sessionId, user.id, hashToken(token), existing && existing.holder_user_id === user.id ? existing.acquired_at : now, expiresAt, now);
      this.audit(session.projectId, user, 'session.steering.lease', 'steering_lease', sessionId, 'allowed', { expiresAt });
    });
    return { token, expiresAt };
  }

  renewSteeringLease(user: AuthenticatedUser, sessionId: string, token: string): { expiresAt: string } {
    this.authorizeSession(user, sessionId, true);
    const nowDate = this.context.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + LEASE_MS).toISOString();
    const changed = this.context.database.prepare('UPDATE steering_leases SET expires_at = ?, renewed_at = ? WHERE session_id = ? AND holder_user_id = ? AND lease_token_hash = ? AND expires_at > ?').run(expiresAt, now, sessionId, user.id, hashToken(token), now).changes;
    if (!changed) throw new SessionsError(409, 'steering_lease_expired', 'Steering lease is missing or expired');
    return { expiresAt };
  }

  steer(user: AuthenticatedUser, sessionId: string, input: SteerInput): { turnId: string; accepted: true } {
    const session = this.authorizeSession(user, sessionId, true);
    const turn = this.context.database.prepare("SELECT * FROM session_turns WHERE id = ? AND session_id = ? AND state = 'running'").get(input.turnId, sessionId) as TurnRow | undefined;
    if (!turn) throw new SessionsError(409, 'turn_not_running', 'Turn is not active');
    this.assertRunWritable(turn.run_id);
    const runtime = session.runtimeRegistrationId ? this.context.database.prepare('SELECT capabilities_json FROM runtime_registrations WHERE id = ?').get(session.runtimeRegistrationId) as { capabilities_json: string } | undefined : undefined;
    const capabilities = runtime ? parseJson(runtime.capabilities_json) : {};
    if (capabilities.activeTurnSteering !== true) {
      this.audit(session.projectId, user, 'session.steer', 'turn', input.turnId, 'denied', { reason: 'unsupported_capability' });
      throw new SessionsError(422, 'steering_unsupported', 'The configured runtime does not support active-turn steering');
    }
    const now = this.now();
    const lease = this.context.database.prepare('SELECT * FROM steering_leases WHERE session_id = ?').get(sessionId) as LeaseRow | undefined;
    if (!lease || lease.expires_at <= now || lease.holder_user_id !== user.id || !tokenMatches(input.leaseToken, lease.lease_token_hash)) {
      this.audit(session.projectId, user, 'session.steer', 'turn', input.turnId, 'denied', { reason: 'invalid_lease' });
      throw new SessionsError(409, 'steering_lease_required', 'A valid steering lease is required');
    }
    const activation = this.context.database.prepare(`SELECT a.native_session_id, rr.machine_id, t.runtime_turn_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id JOIN runs r ON r.id = l.run_id JOIN runtime_registrations rr ON rr.id = a.runtime_registration_id LEFT JOIN session_turns t ON t.id = ? WHERE r.session_id = ? AND a.state IN ('running','needs_input','needs_approval') ORDER BY a.ordinal DESC LIMIT 1`).get(input.turnId, sessionId) as { native_session_id: string | null; machine_id: string; runtime_turn_id: string | null } | undefined;
    let steerCommand: { machineId: string; projectId: string; command: NodeCommand } | undefined;
    if (activation?.native_session_id) {
      const runtimeTurnId = activation.runtime_turn_id;
      if (!runtimeTurnId) {
        throw new SessionsError(409, 'runtime_pending', 'Runtime turn is not ready for steering');
      }
      const operationKey = `session:${sessionId}:turn:${input.turnId}:steer:${createHash('sha256').update(input.message).digest('hex').slice(0, 16)}`;
      const now = this.now();
      const command = this.commandForOperation(activation.machine_id, operationKey, () => ({ kind: 'steer' as const, commandId: this.context.ids.id(), operationKey, issuedAt: now, expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(), runtimeSessionId: activation.native_session_id!, turnId: runtimeTurnId, message: sanitizeOutboundText(input.message) }));
      steerCommand = { machineId: activation.machine_id, projectId: session.projectId, command };
    } else if (session.runtimeRegistrationId) {
      throw new SessionsError(409, 'runtime_pending', 'Runtime session is not ready for steering');
    }
    this.context.events.transaction(() => {
      if (steerCommand) this.enqueueCommand(steerCommand);
      this.audit(session.projectId, user, 'session.steer', 'turn', input.turnId, 'allowed', { messageLength: input.message.length });
    });
    return { turnId: input.turnId, accepted: true };
  }

  cancelSession(user: AuthenticatedUser, sessionId: string, turnId?: string): SessionSummary {
    const session = this.authorizeSession(user, sessionId, true);
    let cancelCommand: { machineId: string; projectId: string; command: NodeCommand } | undefined;
    const active = this.context.database.prepare("SELECT t.id, t.runtime_turn_id, a.native_session_id, a.machine_id FROM session_turns t JOIN logical_agents l ON l.run_id = t.run_id JOIN agent_activations a ON a.logical_agent_id = l.id WHERE t.session_id = ? AND t.state = 'running' AND (? IS NULL OR t.id = ?) ORDER BY a.ordinal DESC LIMIT 1").get(sessionId, turnId ?? null, turnId ?? null) as { id: string; runtime_turn_id: string | null; native_session_id: string | null; machine_id: string | null } | undefined;
    if (active?.native_session_id && active.machine_id) {
      const runtimeTurnId = active.runtime_turn_id;
      if (!runtimeTurnId) throw new SessionsError(409, 'runtime_pending', 'Runtime turn is not ready for cancellation');
      const operationKey = `session:${sessionId}:turn:${active.id}:cancel`;
      const now = this.now();
      const command = this.commandForOperation(active.machine_id, operationKey, () => ({ kind: 'cancel' as const, commandId: this.context.ids.id(), operationKey, issuedAt: now, expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(), runtimeSessionId: active.native_session_id!, turnId: runtimeTurnId }));
      cancelCommand = { machineId: active.machine_id, projectId: session.projectId, command };
    }
    const now = this.now();
    this.context.events.transaction(() => {
      const activeRuns = this.context.database.prepare("SELECT id FROM runs WHERE session_id = ? AND state IN ('queued', 'running', 'paused', 'cancelling')").all(sessionId) as Array<{ id: string }>;
      for (const run of activeRuns) this.terminalizeRuntimeDescendants(sessionId, run.id, 'cancelled', now);
      if (turnId) this.context.database.prepare("UPDATE session_turns SET state = 'cancelled', completed_at = ? WHERE id = ? AND session_id = ? AND state IN ('queued', 'running')").run(now, turnId, sessionId);
      else this.context.database.prepare("UPDATE session_turns SET state = 'cancelled', completed_at = ? WHERE session_id = ? AND state IN ('queued', 'running')").run(now, sessionId);
      this.context.database.prepare("UPDATE runs SET state = 'cancelled', completed_at = ?, updated_at = ? WHERE session_id = ? AND state IN ('queued', 'running', 'paused', 'cancelling')").run(now, now, sessionId);
      this.context.database.prepare("UPDATE agent_activations SET state = 'cancelled', ended_at = ?, last_activity_at = ? WHERE logical_agent_id IN (SELECT l.id FROM logical_agents l JOIN runs r ON r.id = l.run_id WHERE r.session_id = ?) AND state NOT IN ('settled', 'failed', 'cancelled', 'stale')").run(now, now, sessionId);
      this.context.database.prepare("UPDATE messages SET status = 'cancelled', completed_at = COALESCE(completed_at, ?) WHERE session_id = ? AND status = 'queued'").run(now, sessionId);
      this.context.database.prepare("UPDATE sessions SET state = 'cancelled', active_turn_id = NULL, updated_at = ? WHERE id = ?").run(now, sessionId);
      for (const run of activeRuns) this.append(session.projectId, 'run.settled', 'run', run.id, user, { sessionId, runId: run.id, state: 'cancelled' });
      // Queue the provider cancellation after terminalizing the run so the
      // broad command cleanup cannot cancel this command itself.
      if (cancelCommand) this.enqueueCommand(cancelCommand);
      this.audit(session.projectId, user, 'session.cancel', 'session', sessionId, 'allowed', { turnId });
    });
    return this.getSummary(sessionId)!;
  }

  createApproval(user: AuthenticatedUser, sessionId: string, input: { kind: string; summary: string; detail?: Record<string, unknown> | undefined; runId?: string | undefined; turnId?: string | undefined; expiresAt?: string | undefined; runtimeApprovalId?: string | undefined }): SessionApproval {
    const session = this.authorizeSession(user, sessionId, true);
    const references = this.sessionReferences(sessionId, input.runId, input.turnId);
    const now = this.now();
    const id = this.context.ids.id();
    const detail = redactedApprovalRecord(input.detail);
    const kind = redactText(input.kind, 120);
    const summary = redactText(input.summary, 240);
    this.context.events.transaction(() => {
      this.context.database.prepare(`INSERT INTO approvals(id, session_id, run_id, turn_id, runtime_approval_id, kind, summary, detail_redacted_json, state, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, sessionId, references.runId ?? null, references.turnId ?? null, input.runtimeApprovalId ?? null, kind, summary, JSON.stringify(detail), now, input.expiresAt ?? null);
      this.context.database.prepare("UPDATE sessions SET state = 'needs_approval', updated_at = ? WHERE id = ?").run(now, sessionId);
      this.append(session.projectId, 'approval.requested', 'approval', id, user, { sessionId, approvalId: id, kind, summary });
    });
    return this.getApproval(id)!;
  }

  answerApproval(user: AuthenticatedUser, sessionId: string, approvalId: string, input: AnswerApprovalInput): SessionApproval {
    const session = this.authorizeSession(user, sessionId, true);
    const approval = this.context.database.prepare('SELECT * FROM approvals WHERE id = ? AND session_id = ?').get(approvalId, sessionId) as ApprovalRow | undefined;
    if (!approval) throw new SessionsError(404, 'approval_not_found', 'Approval was not found');
    const now = this.now();
    let expired = false;
    if (approval.state === 'pending' && approval.expires_at && Date.parse(approval.expires_at) <= Date.parse(now)) {
      this.context.events.transaction(() => {
        expired = this.context.database.prepare("UPDATE approvals SET state = 'expired', answered_at = ?, version = version + 1 WHERE id = ? AND session_id = ? AND state = 'pending'").run(now, approvalId, sessionId).changes > 0;
        if (expired) {
          this.context.database.prepare("UPDATE sessions SET state = CASE WHEN state = 'needs_approval' AND NOT EXISTS (SELECT 1 FROM approvals WHERE session_id = ? AND state = 'pending') THEN CASE WHEN active_turn_id IS NOT NULL THEN 'busy' ELSE 'idle' END ELSE state END, updated_at = ? WHERE id = ?").run(sessionId, now, sessionId);
          this.append(session.projectId, 'approval.answered', 'approval', approvalId, user, { sessionId, approvalId, state: 'expired' });
        }
      });
      if (expired) {
        this.audit(session.projectId, user, 'approval.answer', 'approval', approvalId, 'denied', { reason: 'expired' });
        throw new SessionsError(409, 'approval_expired', 'Approval has expired');
      }
    }
    if (approval.state === 'pending' && session.runtimeRegistrationId) {
      const runtime = this.context.database.prepare('SELECT capabilities_json FROM runtime_registrations WHERE id = ?').get(session.runtimeRegistrationId) as { capabilities_json: string } | undefined;
      const capabilities = runtime ? parseJson(runtime.capabilities_json) : {};
      if (capabilities.approvalResponses !== true) {
        this.audit(session.projectId, user, 'approval.answer', 'approval', approvalId, 'denied', { reason: 'unsupported_capability' });
        throw new SessionsError(422, 'approval_response_unsupported', 'The configured runtime does not support approval responses');
      }
    }
    if (approval.run_id && approval.state === 'pending') this.assertRunWritable(approval.run_id);
    const state = input.decision === 'cancel' ? 'cancelled' : input.decision === 'deny' ? 'denied' : 'approved';
    let approvalCommand: { machineId: string; projectId: string; command: NodeCommand } | undefined;
    const approvalRuntime = this.context.database.prepare(`SELECT a.native_session_id, a.machine_id FROM approvals p JOIN session_turns t ON t.id = p.turn_id JOIN logical_agents l ON l.run_id = t.run_id JOIN agent_activations a ON a.logical_agent_id = l.id WHERE p.id = ? AND p.session_id = ? ORDER BY a.ordinal DESC LIMIT 1`).get(approvalId, sessionId) as { native_session_id: string | null; machine_id: string | null } | undefined;
    if (approvalRuntime?.native_session_id && approvalRuntime.machine_id) {
      const operationKey = `session:${sessionId}:approval:${approvalId}:answer:${state}`;
      const command = this.commandForOperation(approvalRuntime.machine_id, operationKey, () => ({ kind: 'answer_approval' as const, commandId: this.context.ids.id(), operationKey, issuedAt: now, expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(), runtimeSessionId: approvalRuntime.native_session_id!, approvalId: approval.runtime_approval_id ?? approvalId, decision: input.decision }));
      approvalCommand = { machineId: approvalRuntime.machine_id, projectId: session.projectId, command };
    }
    const result = this.context.events.transaction(() => {
      const expectedVersion = input.expectedVersion ?? approval.version;
      const changed = this.context.database.prepare("UPDATE approvals SET state = ?, decision = ?, answered_by = ?, answered_at = ?, version = version + 1 WHERE id = ? AND session_id = ? AND state = 'pending' AND version = ?").run(state, input.decision, user.id, now, approvalId, sessionId, expectedVersion).changes;
      if (!changed) {
        this.audit(session.projectId, user, 'approval.answer', 'approval', approvalId, 'denied', { reason: 'already_answered_or_version' });
        throw new SessionsError(409, 'approval_already_answered', 'Approval is no longer pending');
      }
      if (approvalCommand) this.enqueueCommand(approvalCommand);
      this.context.database.prepare("UPDATE sessions SET state = CASE WHEN state = 'needs_approval' AND NOT EXISTS (SELECT 1 FROM approvals WHERE session_id = ? AND state = 'pending') THEN CASE WHEN active_turn_id IS NOT NULL THEN 'busy' ELSE 'idle' END ELSE state END, updated_at = ? WHERE id = ?").run(sessionId, now, sessionId);
      this.append(session.projectId, 'approval.answered', 'approval', approvalId, user, { sessionId, approvalId, decision: input.decision });
      this.audit(session.projectId, user, 'approval.answer', 'approval', approvalId, 'allowed', { decision: input.decision });
      return this.getApproval(approvalId)!;
    });
    return result;
  }

  createAgent(user: AuthenticatedUser, runId: string, input: CreateAgentInput): AgentTreeNode {
    const run = this.authorizeRun(user, runId, true);
    this.validatePlacementScope(run.projectId, input);
    const now = this.now();
    const logicalAgentId = this.context.ids.id();
    const activationId = this.context.ids.id();
    const evidence = input.evidence;
    const expectedControl = evidence === 'platform' ? 'full' : evidence === 'heuristic' ? 'uncertain' : 'observe_only';
    if (input.control && input.control !== expectedControl) throw new SessionsError(422, 'invalid_lineage_control', 'Lineage evidence and control are incompatible');
    const control = expectedControl;
    this.context.events.transaction(() => {
      if (input.parentLogicalAgentId) {
        // The child ID is freshly allocated and never accepted from input, so
        // this create-only edge API cannot point back to an existing descendant.
        const parent = this.context.database.prepare('SELECT id FROM logical_agents WHERE id = ? AND run_id = ?').get(input.parentLogicalAgentId, runId);
        if (!parent) throw new SessionsError(404, 'parent_agent_not_found', 'Parent logical agent was not found');
      }
      this.context.database.prepare('INSERT INTO logical_agents(id, run_id, name, role, objective, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(logicalAgentId, runId, input.name, input.role ?? null, input.objective ?? null, now);
      this.context.database.prepare(`INSERT INTO agent_activations(id, logical_agent_id, machine_id, runtime_registration_id, workspace_id, ordinal, state, last_activity_at) VALUES (?, ?, ?, ?, ?, 1, 'queued', ?)`)
        .run(activationId, logicalAgentId, input.machineId ?? null, input.runtimeRegistrationId ?? null, input.workspaceId ?? null, now);
      if (input.parentLogicalAgentId) this.context.database.prepare('INSERT INTO agent_edges(id, run_id, parent_logical_agent_id, child_logical_agent_id, evidence, control, source_reference, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.context.ids.id(), runId, input.parentLogicalAgentId, logicalAgentId, evidence, control, input.sourceReference ?? null, input.confidence ?? null, now);
      this.append(run.projectId, 'child.discovered', 'agent', logicalAgentId, user, { sessionId: run.sessionId, runId, logicalAgentId, activationId, evidence, control });
    });
    return this.getAgentNode(logicalAgentId)!;
  }

  resumeActivation(user: AuthenticatedUser, logicalAgentId: string, input: ResumeActivationInput): AgentTreeNode {
    const agent = this.context.database.prepare('SELECT * FROM logical_agents WHERE id = ?').get(logicalAgentId) as AgentRow | undefined;
    if (!agent) throw new SessionsError(404, 'agent_not_found', 'Logical agent was not found');
    const run = this.authorizeRun(user, agent.run_id, true);
    this.validatePlacementScope(run.projectId, input);
    const latest = this.latestActivation(logicalAgentId);
    if (!latest || !TERMINAL_ACTIVATION_STATES.has(latest.state)) throw new SessionsError(409, 'activation_not_resumable', 'Only a completed activation can be resumed');
    const edge = this.context.database.prepare('SELECT control FROM agent_edges WHERE child_logical_agent_id = ?').get(logicalAgentId) as { control: 'full' | 'observe_only' | 'uncertain' } | undefined;
    if (edge && edge.control !== 'full') throw new SessionsError(422, 'activation_read_only', 'Provider and hook children are read-only');
    const ordinal = (this.context.database.prepare('SELECT max(ordinal) AS ordinal FROM agent_activations WHERE logical_agent_id = ?').get(logicalAgentId) as { ordinal: number }).ordinal + 1;
    const activationId = this.context.ids.id();
    const now = this.now();
    this.context.events.transaction(() => {
      this.context.database.prepare(`INSERT INTO agent_activations(id, logical_agent_id, machine_id, runtime_registration_id, workspace_id, native_session_id, ordinal, state, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
        .run(activationId, logicalAgentId, input.machineId ?? null, input.runtimeRegistrationId ?? null, input.workspaceId ?? null, input.nativeSessionId ?? null, ordinal, now, now);
      this.append(run.projectId, 'child.activation.resumed', 'agent', logicalAgentId, user, { sessionId: run.sessionId, runId: run.id, logicalAgentId, activationId, ordinal });
      this.audit(run.projectId, user, 'agent.activation.resume', 'activation', activationId, 'allowed', { logicalAgentId, ordinal });
    });
    return this.getAgentNode(logicalAgentId)!;
  }

  updateActivationState(user: AuthenticatedUser, activationId: string, state: AgentTreeNode['state']): AgentTreeNode {
    const activation = this.context.database.prepare('SELECT a.*, l.run_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id WHERE a.id = ?').get(activationId) as ActivationRow | undefined;
    if (!activation) throw new SessionsError(404, 'activation_not_found', 'Agent activation was not found');
    const run = this.authorizeRun(user, activation.run_id, true, activation.state === state && TERMINAL_ACTIVATION_STATES.has(state));
    if (activation.state === state) return this.getAgentNode(activation.logical_agent_id)!;
    if (TERMINAL_ACTIVATION_STATES.has(activation.state)) {
      throw new SessionsError(409, 'activation_terminal', 'A terminal activation is immutable; resume the logical agent instead');
    }
    const now = this.now();
    this.context.events.transaction(() => {
      let nextState = state;
      if (state === 'settled' && this.hasActiveDescendant(activation.logical_agent_id)) nextState = 'waiting_on_children';
      const endedAt = TERMINAL_ACTIVATION_STATES.has(nextState) ? now : null;
      this.context.database.prepare('UPDATE agent_activations SET state = ?, ended_at = ?, last_activity_at = ? WHERE id = ?').run(nextState, endedAt, now, activationId);
      this.append(run.projectId, 'child.state.changed', 'activation', activationId, user, { sessionId: run.sessionId, runId: run.id, activationId, logicalAgentId: activation.logical_agent_id, state: nextState });
      this.reconcileAncestors(run.projectId, run.sessionId, run.id, activation.logical_agent_id, user);
      this.audit(run.projectId, user, 'agent.activation.state', 'activation', activationId, 'allowed', { state: nextState });
    });
    return this.getAgentNode(activation.logical_agent_id)!;
  }

  upsertProgress(user: AuthenticatedUser, activationId: string, input: ProgressInput): SessionProgress {
    const activation = this.context.database.prepare('SELECT a.*, l.run_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id WHERE a.id = ?').get(activationId) as ActivationRow | undefined;
    if (!activation) throw new SessionsError(404, 'activation_not_found', 'Agent activation was not found');
    const run = this.authorizeRun(user, activation.run_id, true);
    const now = this.now();
    const old = this.context.database.prepare('SELECT * FROM activity_progress WHERE activation_id = ? AND activity_key = ?').get(activationId, input.activityKey) as ProgressRow | undefined;
    this.context.events.transaction(() => {
      this.context.database.prepare(`INSERT INTO activity_progress(activation_id, activity_key, label, current_value, total_value, unit, important, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activation_id, activity_key) DO UPDATE SET label = excluded.label, current_value = excluded.current_value, total_value = excluded.total_value, unit = excluded.unit, important = excluded.important, updated_at = excluded.updated_at`).run(activationId, input.activityKey, input.label, input.currentValue ?? null, input.totalValue ?? null, input.unit ?? null, input.important ? 1 : 0, now);
      const changed = !old || old.label !== input.label || old.current_value !== (input.currentValue ?? null) || old.total_value !== (input.totalValue ?? null) || old.unit !== (input.unit ?? null) || old.important !== (input.important ? 1 : 0);
      if (changed) this.append(run.projectId, 'progress.changed', 'activation', activationId, user, { sessionId: run.sessionId, runId: run.id, activationId, activityKey: input.activityKey, label: input.label, currentValue: input.currentValue, totalValue: input.totalValue, unit: input.unit, important: Boolean(input.important) });
    });
    return rowToProgress(this.context.database.prepare('SELECT * FROM activity_progress WHERE activation_id = ? AND activity_key = ?').get(activationId, input.activityKey) as ProgressRow);
  }

  getProgress(user: AuthenticatedUser, activationId: string): SessionProgress[] {
    const activation = this.context.database.prepare('SELECT a.*, l.run_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id WHERE a.id = ?').get(activationId) as ActivationRow | undefined;
    if (!activation) throw new SessionsError(404, 'activation_not_found', 'Agent activation was not found');
    this.authorizeRun(user, activation.run_id, false);
    return (this.context.database.prepare('SELECT * FROM activity_progress WHERE activation_id = ? ORDER BY updated_at').all(activationId) as ProgressRow[]).map(rowToProgress);
  }

  getSnapshot(user: AuthenticatedUser, sessionId: string, afterSequence = 0): SessionSnapshot {
    const session = this.authorizeSession(user, sessionId, false);
    const summary = this.getSummary(sessionId)!;
    const participants = (this.context.database.prepare(`SELECT p.user_id, u.display_name, p.joined_at, p.left_at
      FROM session_participants p JOIN users u ON u.id = p.user_id
      WHERE p.session_id = ? AND p.left_at IS NULL ORDER BY p.joined_at`).all(sessionId) as ParticipantRow[]).map(rowToParticipant);
    const runs = (this.context.database.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at').all(sessionId) as RunRow[]).map(rowToRun);
    const turns = (this.context.database.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY created_at').all(sessionId) as TurnRow[]).map(rowToTurn);
    const messages = (this.context.database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence').all(sessionId) as MessageRow[]).map(rowToMessage);
    const approvals = (this.context.database.prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at').all(sessionId) as ApprovalRow[]).map(rowToApproval);
    const progress = (this.context.database.prepare(`SELECT p.* FROM activity_progress p JOIN agent_activations a ON a.id = p.activation_id JOIN logical_agents l ON l.id = a.logical_agent_id JOIN runs r ON r.id = l.run_id WHERE r.session_id = ? ORDER BY p.updated_at`).all(sessionId) as ProgressRow[]).map(rowToProgress);
    const tree = runs.flatMap((run) => this.getTree(run.id));
    const watermark = (this.context.database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get(session.projectId) as { event_sequence: number }).event_sequence;
    const events = this.authorizedEvents(session.projectId, sessionId, afterSequence);
    return { session: summary, participants, runs, turns, messages, approvals, tree, progress, watermark, events };
  }

  authorizedEvents(user: AuthenticatedUser, projectId: string, sessionId: string, afterSequence?: number): EventEnvelope[];
  authorizedEvents(projectId: string, sessionId: string, afterSequence?: number): EventEnvelope[];
  authorizedEvents(first: AuthenticatedUser | string, second: string, third?: string | number, fourth?: number): EventEnvelope[] {
    const projectId = typeof first === 'string' ? first : second;
    const sessionId = typeof first === 'string' ? second : third as string;
    const afterSequence = typeof first === 'string' ? (third as number | undefined) ?? 0 : fourth ?? 0;
    if (typeof first !== 'string' && this.authorizeSession(first, sessionId, false).projectId !== projectId) throw new SessionsError(403, 'project_forbidden', 'Session does not belong to this project');
    return this.context.events.listAfter(projectId, afterSequence)
      .filter((event) => sessionIdForEvent(this.context.database, event) === sessionId)
      .map((event) => this.publicEvent(event));
  }

  publicEvent(event: EventEnvelope): EventEnvelope {
    const { nativeEventId: _nativeEventId, rawReference: _rawReference, ...source } = event.source;
    return { ...event, source, payload: redactRuntimeIdentifiers(event.payload) };
  }

  canRead(user: AuthenticatedUser, sessionId: string): boolean {
    try {
      this.authorizeSession(user, sessionId, false);
      return true;
    } catch {
      return false;
    }
  }

  getTree(runId: string): AgentTreeNode[];
  getTree(user: AuthenticatedUser, runId: string): AgentTreeNode[];
  getTree(first: string | AuthenticatedUser, second?: string): AgentTreeNode[] {
    const runId = typeof first === 'string' ? first : second!;
    if (typeof first !== 'string') this.authorizeRun(first, runId, false);
    const agents = this.context.database.prepare('SELECT * FROM logical_agents WHERE run_id = ? ORDER BY created_at').all(runId) as AgentRow[];
    const edges = this.context.database.prepare('SELECT parent_logical_agent_id, child_logical_agent_id, evidence, control FROM agent_edges WHERE run_id = ?').all(runId) as EdgeRow[];
    const children = new Map<string, EdgeRow[]>();
    for (const edge of edges) children.set(edge.parent_logical_agent_id, [...(children.get(edge.parent_logical_agent_id) ?? []), edge]);
    const hasParent = new Set(edges.map((edge) => edge.child_logical_agent_id));
    const build = (agent: AgentRow, edge?: EdgeRow): AgentTreeNode => {
      const activation = this.latestActivation(agent.id);
      const state = activation?.state ?? 'stale';
      const node: AgentTreeNode = {
        id: agent.id,
        activationId: activation?.id ?? agent.id,
        ...(edge ? { parentId: edge.parent_logical_agent_id } : {}),
        name: agent.name,
        state,
        evidence: edge?.evidence ?? 'platform',
        control: edge?.control ?? 'full',
        ...(activation?.machine_id ? { machineId: activation.machine_id } : {}),
        runtimeId: activation?.runtime_registration_id ?? 'unassigned',
        startedAt: activation?.started_at ?? agent.created_at,
        children: (children.get(agent.id) ?? []).flatMap((child) => {
          const childAgent = agents.find((candidate) => candidate.id === child.child_logical_agent_id);
          return childAgent ? [build(childAgent, child)] : [];
        }),
      };
      return node;
    };
    return agents.filter((agent) => !hasParent.has(agent.id)).map((agent) => build(agent));
  }

  private getAgentNode(logicalAgentId: string): AgentTreeNode | undefined {
    const agent = this.context.database.prepare('SELECT * FROM logical_agents WHERE id = ?').get(logicalAgentId) as AgentRow | undefined;
    if (!agent) return undefined;
    return this.getTree(agent.run_id).flatMap(function find(node): AgentTreeNode[] { return node.id === logicalAgentId ? [node] : node.children.flatMap(find); })[0];
  }

  private reconcileAncestors(projectId: string, sessionId: string, runId: string, logicalAgentId: string, actor: AuthenticatedUser): void {
    const parents = this.context.database.prepare('SELECT parent_logical_agent_id FROM agent_edges WHERE child_logical_agent_id = ?').all(logicalAgentId) as { parent_logical_agent_id: string }[];
    for (const parent of parents) {
      const active = this.hasActiveDescendant(parent.parent_logical_agent_id);
      const activation = this.latestActivation(parent.parent_logical_agent_id);
      // Terminal activations are immutable. A resumed logical agent receives a
      // new activation; never reopen the historical parent activation here.
      if (activation && !active && activation.state === 'waiting_on_children') {
        this.context.database.prepare("UPDATE agent_activations SET state = 'settled', ended_at = ?, last_activity_at = ? WHERE id = ?").run(this.now(), this.now(), activation.id);
        this.append(projectId, 'child.state.changed', 'activation', activation.id, actor, { sessionId, runId, activationId: activation.id, logicalAgentId: parent.parent_logical_agent_id, state: 'settled' });
      }
      this.reconcileAncestors(projectId, sessionId, runId, parent.parent_logical_agent_id, actor);
    }
    this.reconcileRunCompletion(projectId, sessionId, runId, actor);
  }

  private reconcileRunCompletion(projectId: string, sessionId: string, runId: string, actor: AuthenticatedUser): void {
    if (this.hasActiveDescendantForRun(runId)) return;
    const run = this.context.database.prepare('SELECT state FROM runs WHERE id = ? AND session_id = ?').get(runId, sessionId) as { state: RunState } | undefined;
    if (!run || run.state !== 'running') return;
    const root = this.context.database.prepare("SELECT a.state FROM logical_agents l JOIN agent_activations a ON a.logical_agent_id = l.id WHERE l.run_id = ? AND l.name = 'root' ORDER BY a.ordinal DESC LIMIT 1").get(runId) as { state: AgentTreeNode['state'] } | undefined;
    if (!root || root.state !== 'settled') return;
    const now = this.now();
    this.context.database.prepare("UPDATE runs SET state = 'settled', completed_at = ?, updated_at = ? WHERE id = ? AND state = 'running'").run(now, now, runId);
    this.context.database.prepare("UPDATE sessions SET state = CASE WHEN state = 'busy' THEN 'idle' ELSE state END, active_turn_id = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('failed','cancelled','closed')").run(now, sessionId);
    this.append(projectId, 'run.settled', 'run', runId, actor, { sessionId, runId });
  }

  private hasActiveDescendant(logicalAgentId: string, visited = new Set<string>()): boolean {
    if (visited.has(logicalAgentId)) return false;
    visited.add(logicalAgentId);
    const children = this.context.database.prepare('SELECT child_logical_agent_id FROM agent_edges WHERE parent_logical_agent_id = ?').all(logicalAgentId) as { child_logical_agent_id: string }[];
    for (const child of children) {
      const activation = this.latestActivation(child.child_logical_agent_id);
      if (activation && ACTIVE_ACTIVATION_STATES.has(activation.state)) return true;
      if (this.hasActiveDescendant(child.child_logical_agent_id, visited)) return true;
    }
    return false;
  }

  private hasActiveDescendantForRun(runId: string): boolean {
    const childRows = this.context.database.prepare('SELECT child_logical_agent_id FROM agent_edges WHERE run_id = ?').all(runId) as { child_logical_agent_id: string }[];
    return childRows.some((row) => {
      const activation = this.latestActivation(row.child_logical_agent_id);
      return Boolean(activation && ACTIVE_ACTIVATION_STATES.has(activation.state));
    });
  }

  private latestActivation(logicalAgentId: string): ActivationRow | undefined {
    return this.context.database.prepare('SELECT * FROM agent_activations WHERE logical_agent_id = ? ORDER BY ordinal DESC LIMIT 1').get(logicalAgentId) as ActivationRow | undefined;
  }

  private runtimePlacement(projectId: string, registrationId: string): RuntimePlacement | undefined {
    const runtime = this.context.database.prepare(`SELECT rr.machine_id, rr.kind AS runtime_id FROM runtime_registrations rr JOIN machines m ON m.id = rr.machine_id WHERE rr.id = ? AND m.team_id = (SELECT team_id FROM projects WHERE id = ?) AND m.status = 'connected' AND rr.available = 1`).get(registrationId, projectId) as { machine_id: string; runtime_id: string } | undefined;
    if (!runtime) return undefined;
    const repository = this.context.database.prepare(`SELECT r.id FROM repositories r JOIN machine_repository_allowlists a ON a.repository_id = r.id WHERE r.project_id = ? AND a.machine_id = ? ORDER BY r.created_at LIMIT 1`).get(projectId, runtime.machine_id) as { id: string } | undefined;
    return repository ? { machineId: runtime.machine_id, runtimeId: runtime.runtime_id, repositoryId: repository.id } : undefined;
  }

  private expirePendingApprovals(): void {
    const now = this.now();
    const rows = this.context.database.prepare(`
      SELECT a.id, a.session_id, a.run_id, s.project_id, s.created_by
      FROM approvals a JOIN sessions s ON s.id = a.session_id
      WHERE a.state = 'pending' AND a.expires_at IS NOT NULL AND a.expires_at <= ?
    `).all(now) as Array<{ id: string; session_id: string; run_id: string | null; project_id: string; created_by: string }>;
    if (!rows.length) return;
    this.context.events.transaction(() => {
      for (const row of rows) {
        const changed = this.context.database.prepare("UPDATE approvals SET state = 'expired', answered_at = ?, version = version + 1 WHERE id = ? AND state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, row.id, now).changes;
        if (!changed) continue;
        const remaining = this.context.database.prepare("SELECT 1 FROM approvals WHERE session_id = ? AND state = 'pending'").get(row.session_id);
        if (!remaining) this.context.database.prepare("UPDATE sessions SET state = CASE WHEN state = 'needs_approval' THEN CASE WHEN active_turn_id IS NOT NULL THEN 'busy' ELSE 'idle' END ELSE state END, updated_at = ? WHERE id = ?").run(now, row.session_id);
        const actor = this.systemActor(row.created_by, row.project_id);
        this.append(row.project_id, 'approval.answered', 'approval', row.id, actor, { sessionId: row.session_id, approvalId: row.id, state: 'expired', ...(row.run_id ? { runId: row.run_id } : {}) });
        this.audit(row.project_id, actor, 'approval.expire', 'approval', row.id, 'allowed', { reason: 'expired' });
      }
    });
  }

  private commandForOperation<T extends NodeCommand>(machineId: string, operationKey: string, create: () => T): T {
    const existing = this.context.database.prepare('SELECT payload_json FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(machineId, operationKey) as { payload_json: string } | undefined;
    if (existing) {
      try { return JSON.parse(existing.payload_json) as T; } catch { /* fall through and let Machine reject malformed history */ }
    }
    return create();
  }

  private enqueueCommand(input: { machineId: string; projectId: string; command: NodeCommand }): void {
    if (this.machines) {
      this.machines.enqueueCommand(input);
      // Machine defers transport while the enclosing transaction is open; retry
      // once the commit is visible to the node connection.
      if (this.machines.deliverPending) queueMicrotask(() => this.machines?.deliverPending?.(input.machineId));
      return;
    }
    const now = this.now();
    this.context.database.prepare(`INSERT OR IGNORE INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(input.command.commandId, input.machineId, input.projectId, input.command.operationKey, input.command.kind, JSON.stringify(input.command), now, input.command.expiresAt, now);
  }

  private reconcileRuntimeSession(session: RuntimeSessionRow): void {
    const run = this.context.database.prepare("SELECT * FROM runs WHERE session_id = ? AND state IN ('queued','running','paused','cancelling') ORDER BY created_at DESC LIMIT 1").get(session.id) as RunRow | undefined;
    if (!run) return;
    const root = this.context.database.prepare("SELECT l.id AS logical_agent_id, a.* FROM logical_agents l JOIN agent_activations a ON a.logical_agent_id = l.id WHERE l.run_id = ? AND l.name = 'root' ORDER BY a.ordinal DESC LIMIT 1").get(run.id) as (ActivationRow & { logical_agent_id: string }) | undefined;
    const turn = session.active_turn_id
      ? this.context.database.prepare("SELECT * FROM session_turns WHERE id = ? AND state = 'running'").get(session.active_turn_id) as TurnRow | undefined
      : this.context.database.prepare("SELECT * FROM session_turns WHERE run_id = ? AND state = 'running' ORDER BY created_at LIMIT 1").get(run.id) as TurnRow | undefined;
    if (!root || !turn) return;
    const placement = this.runtimePlacement(session.project_id, session.runtime_registration_id!);
    if (!placement) return;
    const createKey = `session:${session.id}:run:${run.id}:create`;
    const createRow = this.context.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(placement.machineId, createKey) as CommandRow | undefined;
    if (!createRow) return;
    if (['failed','expired','cancelled'].includes(createRow.state)) { if (createRow.state === 'cancelled') this.cancelRuntimeTurn(session, run, turn, root); else this.failRuntimeTurn(session, run, turn, root, createRow.error_summary ?? `Runtime create ${createRow.state}`); return; }
    let runtimeSessionId: string | undefined = root.native_session_id ?? undefined;
    if (!runtimeSessionId && createRow.state === 'completed') {
      const result = parseJson(createRow.result_json ?? '{}');
      runtimeSessionId = typeof result.runtimeSessionId === 'string' ? result.runtimeSessionId : undefined;
      if (!runtimeSessionId) { this.failRuntimeTurn(session, run, turn, root, 'Runtime did not return a session identifier'); return; }
      this.context.events.transaction(() => {
        this.context.database.prepare('UPDATE agent_activations SET native_session_id = ?, last_activity_at = ? WHERE id = ? AND native_session_id IS NULL').run(runtimeSessionId, this.now(), root.id);
      });
    }
    if (!runtimeSessionId || createRow.state !== 'completed') return;
    const turnOrdinal = this.context.database.prepare('SELECT count(*) AS count FROM session_turns WHERE run_id = ? AND created_at <= ?').get(run.id, turn.created_at) as { count: number };
    if (turnOrdinal.count > 1) {
      const resumeKey = `session:${session.id}:run:${run.id}:turn:${turn.id}:resume`;
      const resumeRow = this.context.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(placement.machineId, resumeKey) as CommandRow | undefined;
      if (!resumeRow) {
        const now = this.now();
        const command = this.commandForOperation(placement.machineId, resumeKey, () => ({ kind: 'resume_runtime_session' as const, commandId: this.context.ids.id(), operationKey: resumeKey, issuedAt: now, expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(), repositoryId: placement.repositoryId, runtimeId: placement.runtimeId, runtimeSessionId: runtimeSessionId! }));
        this.enqueueCommand({ machineId: placement.machineId, projectId: session.project_id, command });
        return;
      }
      if (['failed','expired','cancelled'].includes(resumeRow.state)) { if (resumeRow.state === 'cancelled') this.cancelRuntimeTurn(session, run, turn, root); else this.failRuntimeTurn(session, run, turn, root, resumeRow.error_summary ?? `Runtime resume ${resumeRow.state}`); return; }
      if (resumeRow.state !== 'completed') return;
    }
    const human = this.context.database.prepare("SELECT * FROM messages WHERE turn_id = ? AND role = 'human' ORDER BY sequence LIMIT 1").get(turn.id) as MessageRow | undefined;
    if (!human) return;
    const sendKey = `session:${session.id}:run:${run.id}:turn:${turn.id}:send`;
    let sendRow = this.context.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(placement.machineId, sendKey) as CommandRow | undefined;
    if (!sendRow) {
      const now = this.now();
      const command = this.commandForOperation(placement.machineId, sendKey, () => ({ kind: 'send_message' as const, commandId: this.context.ids.id(), operationKey: sendKey, issuedAt: now, expiresAt: new Date(this.context.clock.now().getTime() + 24 * 60 * 60_000).toISOString(), runtimeSessionId: runtimeSessionId!, message: sanitizeOutboundText(human.body) }));
      this.enqueueCommand({ machineId: placement.machineId, projectId: session.project_id, command });
      sendRow = this.context.database.prepare('SELECT * FROM node_commands WHERE machine_id = ? AND operation_key = ?').get(placement.machineId, sendKey) as CommandRow | undefined;
    }
    if (!sendRow || !['completed','failed','expired','cancelled'].includes(sendRow.state)) return;
    if (sendRow.state !== 'completed') { if (sendRow.state === 'cancelled') this.cancelRuntimeTurn(session, run, turn, root); else this.failRuntimeTurn(session, run, turn, root, sendRow.error_summary ?? `Runtime send ${sendRow.state}`); return; }
    if (typeof parseJson(sendRow.result_json ?? '{}').text !== 'string') { this.failRuntimeTurn(session, run, turn, root, 'Runtime response did not include text'); return; }
    this.completeRuntimeTurn(session, run, turn, root, sendRow);
  }

  private completeRuntimeTurn(session: RuntimeSessionRow, run: RunRow, turn: TurnRow, root: ActivationRow & { logical_agent_id: string }, send: CommandRow): void {
    const now = this.now();
    const result = parseJson(send.result_json ?? '{}');
    const text = typeof result.text === 'string' ? sanitizeOutboundText(result.text) : '';
    const runtimeTurnId = typeof result.turnId === 'string' && result.turnId.length > 0 ? result.turnId.slice(0, 240) : undefined;
    const actor = this.systemActor(session.created_by, session.project_id);
    this.context.events.transaction(() => {
      const current = this.context.database.prepare('SELECT state FROM session_turns WHERE id = ?').get(turn.id) as { state: TurnState } | undefined;
      if (!current || current.state !== 'running') return;
      // Some adapters emit no turn.started event (or its runtime event can be
      // dropped/truncated).  Preserve the provider turn ID from the terminal
      // command result so later steer/cancel commands never fall back to the
      // Dhole turn ID.
      if (runtimeTurnId) this.context.database.prepare('UPDATE session_turns SET runtime_turn_id = COALESCE(runtime_turn_id, ?) WHERE id = ?').run(runtimeTurnId, turn.id);
      if (!this.context.database.prepare("SELECT 1 FROM messages WHERE turn_id = ? AND role = 'agent'").get(turn.id)) {
        const seq = this.context.database.prepare('UPDATE sessions SET next_message_sequence = next_message_sequence + 1, updated_at = ? WHERE id = ? RETURNING next_message_sequence').get(now, session.id) as { next_message_sequence: number };
        const id = this.context.ids.id();
        this.context.database.prepare(`INSERT INTO messages(id, session_id, run_id, turn_id, sequence, role, logical_agent_id, body, status, include_human_identity, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, 'completed', 0, ?, ?)`).run(id, session.id, run.id, turn.id, seq.next_message_sequence, root.logical_agent_id, text, now, now);
        this.append(session.project_id, 'agent.message.completed', 'session', session.id, actor, { sessionId: session.id, messageId: id, turnId: turn.id, logicalAgentId: root.logical_agent_id });
      }
      this.context.database.prepare("UPDATE messages SET status = 'completed', completed_at = ? WHERE turn_id = ? AND role = 'human' AND status = 'delivered'").run(now, turn.id);
      this.context.database.prepare("UPDATE session_turns SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'running'").run(now, turn.id);
      const queued = this.context.database.prepare("SELECT id FROM messages WHERE session_id = ? AND status = 'queued' AND (run_id IS NULL OR run_id = ?) ORDER BY sequence LIMIT 1").get(session.id, run.id) as { id: string } | undefined;
      if (queued) {
        const nextTurn = this.context.ids.id();
        this.context.database.prepare("INSERT INTO session_turns(id, session_id, run_id, runtime_turn_id, state, started_at, created_at) VALUES (?, ?, ?, NULL, 'running', ?, ?)").run(nextTurn, session.id, run.id, now, now);
        this.context.database.prepare("UPDATE messages SET run_id = ?, turn_id = ?, status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'queued'").run(run.id, nextTurn, now, queued.id);
        this.context.database.prepare("UPDATE sessions SET active_turn_id = ?, updated_at = ? WHERE id = ?").run(nextTurn, now, session.id);
        this.append(session.project_id, 'human.message.delivered', 'session', session.id, actor, { sessionId: session.id, messageId: queued.id, turnId: nextTurn });
      } else if (this.hasActiveDescendantForRun(run.id)) {
        // The root turn can finish while native child agents are still active.
        // Keep the run/session live and let descendant reconciliation settle
        // the root once every child reaches a terminal state.
        this.context.database.prepare("UPDATE agent_activations SET state = 'waiting_on_children', last_activity_at = ? WHERE id = ? AND state = 'running'").run(now, root.id);
        this.context.database.prepare("UPDATE runs SET state = 'running', completed_at = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('failed','cancelled')").run(now, run.id);
        this.context.database.prepare("UPDATE sessions SET state = 'busy', active_turn_id = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('failed','cancelled','closed')").run(now, session.id);
      } else {
        this.context.database.prepare("UPDATE agent_activations SET state = 'settled', ended_at = ?, last_activity_at = ? WHERE id = ? AND state NOT IN ('settled','failed','cancelled','stale')").run(now, now, root.id);
        this.context.database.prepare("UPDATE runs SET state = 'settled', completed_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('settled','failed','cancelled')").run(now, now, run.id);
        this.context.database.prepare("UPDATE sessions SET state = 'idle', active_turn_id = NULL, updated_at = ? WHERE id = ?").run(now, session.id);
        this.append(session.project_id, 'run.settled', 'run', run.id, actor, { sessionId: session.id, runId: run.id });
      }
    });
  }

  private failRuntimeTurn(session: RuntimeSessionRow, run: RunRow, turn: TurnRow, root: ActivationRow, reason: string): void {
    const now = this.now();
    const actor = this.systemActor(session.created_by, session.project_id);
    this.context.events.transaction(() => {
      this.terminalizeRuntimeDescendants(session.id, run.id, 'failed', now);
      this.context.database.prepare("UPDATE messages SET status = 'failed', completed_at = ? WHERE turn_id = ? AND status IN ('queued','delivered')").run(now, turn.id);
      this.context.database.prepare("UPDATE messages SET status = 'failed', completed_at = ? WHERE session_id = ? AND status = 'queued' AND (run_id IS NULL OR run_id = ?)").run(now, session.id, run.id);
      this.context.database.prepare("UPDATE session_turns SET state = 'failed', completed_at = ? WHERE id = ? AND state = 'running'").run(now, turn.id);
      this.context.database.prepare("UPDATE agent_activations SET state = 'failed', ended_at = ?, last_activity_at = ? WHERE id = ? AND state NOT IN ('settled','failed','cancelled','stale')").run(now, now, root.id);
      this.context.database.prepare("UPDATE runs SET state = 'failed', completed_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('settled','failed','cancelled')").run(now, now, run.id);
      this.context.database.prepare("UPDATE sessions SET state = 'failed', active_turn_id = NULL, updated_at = ? WHERE id = ?").run(now, session.id);
      this.append(session.project_id, 'run.failed', 'run', run.id, actor, { sessionId: session.id, runId: run.id, error: redactText(reason, 2_000) });
    });
  }

  private cancelRuntimeTurn(session: RuntimeSessionRow, run: RunRow, turn: TurnRow, root: ActivationRow): void {
    const now = this.now();
    const actor = this.systemActor(session.created_by, session.project_id);
    this.context.events.transaction(() => {
      this.terminalizeRuntimeDescendants(session.id, run.id, 'cancelled', now);
      this.context.database.prepare("UPDATE messages SET status = 'cancelled', completed_at = ? WHERE turn_id = ? AND status IN ('queued','delivered')").run(now, turn.id);
      this.context.database.prepare("UPDATE messages SET status = 'cancelled', completed_at = ? WHERE session_id = ? AND status = 'queued' AND (run_id IS NULL OR run_id = ?)").run(now, session.id, run.id);
      this.context.database.prepare("UPDATE session_turns SET state = 'cancelled', completed_at = ? WHERE id = ? AND state = 'running'").run(now, turn.id);
      this.context.database.prepare("UPDATE agent_activations SET state = 'cancelled', ended_at = ?, last_activity_at = ? WHERE id = ? AND state NOT IN ('settled','failed','cancelled','stale')").run(now, now, root.id);
      this.context.database.prepare("UPDATE sessions SET state = 'cancelled', active_turn_id = NULL, updated_at = ? WHERE id = ?").run(now, session.id);
      this.append(session.project_id, 'run.settled', 'run', run.id, actor, { sessionId: session.id, runId: run.id, state: 'cancelled' });
    });
  }

  private terminalizeRuntimeDescendants(sessionId: string, runId: string, state: 'failed' | 'cancelled', now: string): void {
    const descendants = this.context.database.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT e.child_logical_agent_id
        FROM agent_edges e
        JOIN logical_agents l ON l.id = e.parent_logical_agent_id
        WHERE e.run_id = ? AND l.run_id = ? AND l.name = 'root'
        UNION ALL
        SELECT e.child_logical_agent_id
        FROM agent_edges e JOIN descendants d ON d.id = e.parent_logical_agent_id
        WHERE e.run_id = ?
      )
      SELECT id FROM descendants
    `).all(runId, runId, runId) as Array<{ id: string }>;
    for (const descendant of descendants) {
      this.context.database.prepare("UPDATE agent_activations SET state = ?, ended_at = COALESCE(ended_at, ?), last_activity_at = ? WHERE logical_agent_id = ? AND state NOT IN ('settled','failed','cancelled','stale')").run(state, now, now, descendant.id);
    }
    this.context.database.prepare("UPDATE session_turns SET state = ?, completed_at = COALESCE(completed_at, ?) WHERE run_id = ? AND state IN ('queued','running')").run(state, now, runId);
    this.context.database.prepare("UPDATE messages SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE run_id = ? AND status IN ('queued','delivered')").run(state, now, runId);
    this.context.database.prepare("UPDATE node_commands SET state = 'cancelled', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE project_id = (SELECT project_id FROM sessions WHERE id = ?) AND operation_key LIKE ? AND state IN ('queued','delivered','accepted','running')").run(now, now, sessionId, `session:${sessionId}:run:${runId}:%`);
  }

  private systemActor(userId: string, projectId: string): AuthenticatedUser {
    const row = this.context.database.prepare('SELECT u.id, u.email, u.display_name, p.team_id FROM users u JOIN projects p ON p.id = ? WHERE u.id = ?').get(projectId, userId) as { id: string; email: string; display_name: string; team_id: string } | undefined;
    return row ? { id: row.id, email: row.email, displayName: row.display_name, role: 'administrator', teamId: row.team_id } : { id: userId, email: 'system@localhost', displayName: 'System', role: 'administrator', teamId: '' };
  }

  private latestRunId(sessionId: string): string | undefined {
    const row = this.context.database.prepare("SELECT id FROM runs WHERE session_id = ? AND state IN ('queued', 'running', 'paused', 'cancelling') ORDER BY created_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row?.id;
  }

  private sessionReferences(sessionId: string, runId?: string, turnId?: string, allowTerminalRun = false): { runId?: string; turnId?: string } {
    let resolvedRunId = runId;
    if (turnId) {
      const turn = this.context.database.prepare('SELECT run_id FROM session_turns WHERE id = ? AND session_id = ?').get(turnId, sessionId) as { run_id: string } | undefined;
      if (!turn) throw new SessionsError(422, 'invalid_turn', 'Turn does not belong to this session');
      if (resolvedRunId && resolvedRunId !== turn.run_id) throw new SessionsError(422, 'invalid_turn_run', 'Turn does not belong to the selected run');
      resolvedRunId = turn.run_id;
    }
    if (resolvedRunId) {
      const run = this.context.database.prepare('SELECT id, state FROM runs WHERE id = ? AND session_id = ?').get(resolvedRunId, sessionId) as { id: string; state: RunState } | undefined;
      if (!run) throw new SessionsError(422, 'invalid_run', 'Run does not belong to this session');
      if (!allowTerminalRun && TERMINAL_RUN_STATES.has(run.state)) throw new SessionsError(409, 'run_terminal', 'Terminal runs are immutable; resume with a new run');
    }
    return { ...(resolvedRunId ? { runId: resolvedRunId } : {}), ...(turnId ? { turnId } : {}) };
  }

  private assertRunWritable(runId: string): void {
    const run = this.context.database.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: RunState } | undefined;
    if (!run) throw new SessionsError(404, 'run_not_found', 'Run was not found');
    if (TERMINAL_RUN_STATES.has(run.state)) throw new SessionsError(409, 'run_terminal', 'Terminal runs are immutable; resume with a new run');
  }

  private sessionIdForTurnRun(runId: string): string {
    const row = this.context.database.prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as { session_id: string } | undefined;
    return row?.session_id ?? '';
  }

  private getRun(runId: string): SessionRun | undefined {
    const row = this.context.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  private getTurn(turnId: string): SessionTurn | undefined {
    const row = this.context.database.prepare('SELECT * FROM session_turns WHERE id = ?').get(turnId) as TurnRow | undefined;
    return row ? rowToTurn(row) : undefined;
  }

  private getApproval(approvalId: string): SessionApproval | undefined {
    const row = this.context.database.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  private authorizeRun(user: AuthenticatedUser, runId: string, write: boolean, allowTerminalRun = false): RunRow & { projectId: string; sessionId: string } {
    const row = this.context.database.prepare('SELECT r.*, s.project_id, s.state AS session_state, p.team_id FROM runs r JOIN sessions s ON s.id = r.session_id JOIN projects p ON p.id = s.project_id WHERE r.id = ?').get(runId) as (RunRow & { project_id: string; team_id: string; session_state: SessionSummary['state'] }) | undefined;
    if (!row) throw new SessionsError(404, 'run_not_found', 'Run was not found');
    this.assertProjectMember(row.project_id, user, write);
    if (!this.isParticipant(row.session_id, user.id) && !this.isTeamAdministrator(row.team_id, user.id)) throw new SessionsError(403, 'session_forbidden', 'Session participant access is required');
    if (write && (row.session_state === 'cancelled' || row.session_state === 'closed') && !(allowTerminalRun && TERMINAL_RUN_STATES.has(row.state))) throw new SessionsError(409, 'session_not_writable', 'Session is no longer writable');
    if (write && TERMINAL_RUN_STATES.has(row.state) && !allowTerminalRun) throw new SessionsError(409, 'run_terminal', 'Terminal runs are immutable; resume with a new run');
    return { ...row, projectId: row.project_id, sessionId: row.session_id };
  }

  private authorizeTurn(user: AuthenticatedUser, turnId: string, write: boolean): TurnRow & { projectId: string; sessionId: string; runId: string } {
    const row = this.context.database.prepare('SELECT t.*, s.project_id, s.state AS session_state, p.team_id FROM session_turns t JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.id = s.project_id WHERE t.id = ?').get(turnId) as (TurnRow & { project_id: string; team_id: string; session_state: SessionSummary['state'] }) | undefined;
    if (!row) throw new SessionsError(404, 'turn_not_found', 'Turn was not found');
    this.assertProjectMember(row.project_id, user, write);
    if (!this.isParticipant(row.session_id, user.id) && !this.isTeamAdministrator(row.team_id, user.id)) throw new SessionsError(403, 'session_forbidden', 'Session participant access is required');
    if (write && (row.session_state === 'cancelled' || row.session_state === 'closed')) throw new SessionsError(409, 'session_not_writable', 'Session is no longer writable');
    return { ...row, projectId: row.project_id, sessionId: row.session_id, runId: row.run_id };
  }

  private authorizeSession(user: AuthenticatedUser, sessionId: string, write: boolean): SessionRow & { projectId: string; teamId: string; activeTurnId?: string; runtimeRegistrationId?: string } {
    const row = this.context.database.prepare('SELECT s.*, p.team_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sessionId) as (SessionRow & { team_id: string }) | undefined;
    if (!row) throw new SessionsError(404, 'session_not_found', 'Session was not found');
    this.assertProjectMember(row.project_id, user, write);
    const participant = this.isParticipant(sessionId, user.id);
    if (!participant && !this.isTeamAdministrator(row.team_id, user.id)) throw new SessionsError(403, 'session_forbidden', 'Session participant access is required');
    if (write && (row.state === 'cancelled' || row.state === 'closed')) throw new SessionsError(409, row.state === 'closed' ? 'session_closed' : 'session_cancelled', 'Session is no longer writable');
    return {
      ...row,
      projectId: row.project_id,
      teamId: row.team_id,
      ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}),
      ...(row.runtime_registration_id ? { runtimeRegistrationId: row.runtime_registration_id } : {}),
    };
  }

  private assertProjectMember(projectId: string, user: AuthenticatedUser, write = false): void {
    if (!canAccessProject(this.context, user, projectId, write)) throw new SessionsError(403, 'project_forbidden', 'Project access is not authorized');
  }

  private validatePlacementScope(projectId: string, input: { machineId?: string | undefined; runtimeRegistrationId?: string | undefined; workspaceId?: string | undefined; modelId?: string | undefined }): void {
    const project = this.context.database.prepare('SELECT team_id FROM projects WHERE id = ?').get(projectId) as { team_id: string } | undefined;
    if (!project) throw new SessionsError(404, 'project_not_found', 'Project was not found');
    let machineId = input.machineId;
    if (machineId) {
      const machine = this.context.database.prepare('SELECT id FROM machines WHERE id = ? AND team_id = ?').get(machineId, project.team_id);
      if (!machine) throw new SessionsError(422, 'invalid_machine', 'Machine is not in the project team');
    }
    if (input.runtimeRegistrationId) {
      const runtime = this.context.database.prepare('SELECT rr.machine_id FROM runtime_registrations rr JOIN machines m ON m.id = rr.machine_id WHERE rr.id = ? AND m.team_id = ?').get(input.runtimeRegistrationId, project.team_id) as { machine_id: string } | undefined;
      if (!runtime) throw new SessionsError(422, 'invalid_runtime_registration', 'Runtime registration is not in the project team');
      if (machineId && machineId !== runtime.machine_id) throw new SessionsError(422, 'invalid_runtime_machine', 'Runtime registration does not belong to the selected machine');
      machineId = runtime.machine_id;
    }
    if (input.workspaceId) {
      const workspace = this.context.database.prepare('SELECT w.machine_id FROM workspaces w JOIN machines m ON m.id = w.machine_id JOIN repositories r ON r.id = w.repository_id WHERE w.id = ? AND m.team_id = ? AND r.project_id = ?').get(input.workspaceId, project.team_id, projectId) as { machine_id: string } | undefined;
      if (!workspace) throw new SessionsError(422, 'invalid_workspace', 'Workspace is not attached to the project team and repository');
      if (machineId && machineId !== workspace.machine_id) throw new SessionsError(422, 'invalid_workspace_machine', 'Workspace does not belong to the selected machine');
    }
    if (input.modelId) {
      const model = this.context.database.prepare('SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND p.team_id = ?').get(input.modelId, project.team_id);
      if (!model) throw new SessionsError(422, 'invalid_model', 'Model is not in the project team');
    }
  }

  private isParticipant(sessionId: string, userId: string): boolean {
    return Boolean(this.context.database.prepare('SELECT 1 FROM session_participants WHERE session_id = ? AND user_id = ? AND left_at IS NULL').get(sessionId, userId));
  }

  private isTeamAdministrator(teamId: string, userId: string): boolean {
    const row = this.context.database.prepare("SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? AND tm.user_id = ? AND tm.role = 'administrator' AND u.disabled_at IS NULL").get(teamId, userId);
    return Boolean(row);
  }

  private append(projectId: string, eventKind: Parameters<ServerContext['events']['append']>[0]['eventKind'], aggregateType: string, aggregateId: string, actor: AuthenticatedUser, payload: Record<string, unknown>, idempotencyKey?: string): EventEnvelope {
    return this.context.events.append({ projectId, eventKind, aggregateType, aggregateId, actor: { type: 'user', userId: actor.id }, source: { kind: 'platform', adapter: 'sessions' }, payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  private appendRuntimeEvent(projectId: string, eventKind: 'approval.requested' | 'tool.call.started' | 'tool.call.completed', aggregateType: string, aggregateId: string, actor: AuthenticatedUser, payload: Record<string, unknown>, nativeEventId: string): void {
    this.context.events.append({ projectId, eventKind, aggregateType, aggregateId, actor: { type: 'user', userId: actor.id }, source: { kind: 'provider', adapter: 'sessions.runtime', nativeEventId }, payload });
  }

  private audit(projectId: string, actor: AuthenticatedUser, action: string, targetType: string, targetId: string | null, outcome: 'allowed' | 'denied' | 'failed', detail: Record<string, unknown>): void {
    this.context.database.prepare('INSERT INTO audit_records(id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at) VALUES (?, ?, \'user\', ?, ?, ?, ?, ?, ?, ?)').run(this.context.ids.id(), projectId, actor.id, action, targetType, targetId, outcome, JSON.stringify(detail), this.now());
  }

  private now(): string { return this.context.clock.now().toISOString(); }
}

interface SessionRow { id: string; project_id: string; title: string; runtime_registration_id: string | null; model_id: string | null; workspace_id: string | null; state: SessionSummary['state']; active_turn_id: string | null; created_by: string; created_at: string; updated_at: string; }
interface RuntimeSessionRow { id: string; project_id: string; created_by: string; runtime_registration_id: string | null; active_turn_id: string | null; state: SessionSummary['state']; machine_id: string; runtime_kind: string; }
interface RuntimePlacement { machineId: string; runtimeId: string; repositoryId: string; }
interface CommandRow { machine_id: string; operation_key: string; kind: string; state: string; payload_json: string; result_json: string | null; error_summary: string | null; }
interface ParticipantRow { user_id: string; display_name: string; joined_at: string; left_at: string | null; }
interface RunRow { id: string; session_id: string; root_objective: string; issue_reference: string | null; state: SessionRun['state']; created_by: string; created_at: string; started_at: string | null; completed_at: string | null; updated_at: string; }
interface TurnRow { id: string; session_id: string; run_id: string; runtime_turn_id: string | null; state: TurnState; started_at: string | null; completed_at: string | null; created_at: string; projectId?: string; }
interface MessageRow { id: string; session_id: string; run_id: string | null; turn_id: string | null; sequence: number; role: SessionMessage['role']; author_user_id: string | null; logical_agent_id: string | null; body: string; status: SessionMessage['status']; include_human_identity: number; created_at: string; delivered_at: string | null; completed_at: string | null; }
interface ApprovalRow { id: string; session_id: string; run_id: string | null; turn_id: string | null; runtime_approval_id: string | null; kind: string; summary: string; detail_redacted_json: string; state: SessionApproval['state']; requested_at: string; expires_at: string | null; answered_by: string | null; answered_at: string | null; decision: SessionApproval['decision'] | null; version: number; }
interface LeaseRow { session_id: string; holder_user_id: string; lease_token_hash: string; acquired_at: string; expires_at: string; renewed_at: string; }
interface AgentRow { id: string; run_id: string; name: string; role: string | null; objective: string | null; created_at: string; state?: AgentTreeNode['state']; }
interface ActivationRow { id: string; logical_agent_id: string; machine_id: string | null; runtime_registration_id: string | null; workspace_id: string | null; native_session_id: string | null; ordinal: number; state: AgentTreeNode['state']; started_at: string | null; ended_at: string | null; last_activity_at: string | null; run_id: string; }
interface EdgeRow { parent_logical_agent_id: string; child_logical_agent_id: string; evidence: AgentTreeNode['evidence']; control: AgentTreeNode['control']; }
interface ProgressRow { activation_id: string; activity_key: string; label: string; current_value: number | null; total_value: number | null; unit: string | null; important: number; updated_at: string; }

function parseJson(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
const REDACTED_FIELD = /(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key|cookie)/i;
function redactApprovalDetail(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, 2_048);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactApprovalDetail(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) output[key] = REDACTED_FIELD.test(key) ? '[REDACTED]' : redactApprovalDetail(item, depth + 1);
    return output;
  }
  return '[REDACTED]';
}
function redactedApprovalRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = redactApprovalDetail(value ?? {});
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
}
function redactRuntimeIdentifiers(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (/^(?:runtimeSessionId|nativeSessionId|native_session_id|runtime_session_id)$/u.test(key)) { output[key] = '[REDACTED]'; continue; }
    output[key] = redactRuntimeIdentifierValue(item, depth + 1);
  }
  return output;
}
function redactRuntimeIdentifierValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => redactRuntimeIdentifierValue(item, depth + 1));
  return value && typeof value === 'object' ? redactRuntimeIdentifiers(value as Record<string, unknown>, depth) : value;
}
function sanitizeRuntimePayload(value: Record<string, unknown>): Record<string, unknown> {
  const stripped = Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:projectId|sessionId|runId|turnId|machineId|activationId|runtimeSessionId|runtimeApprovalId|approvalId|nativeSessionId|native_session_id|runtime_session_id)$/u.test(key)));
  return redactRuntimeIdentifiers(redactedApprovalRecord(stripped));
}
function sanitizeOutboundText(value: string): string {
  return value.slice(0, 200_000)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|authorization|private[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[REDACTED]');
}
function rowToSummary(row: SessionRow): SessionSummary { return { id: row.id, projectId: row.project_id, title: row.title, ...(row.runtime_registration_id ? { runtimeRegistrationId: row.runtime_registration_id } : {}), ...(row.model_id ? { modelId: row.model_id } : {}), ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}), state: row.state, ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }; }
function rowToParticipant(row: ParticipantRow): SessionParticipant { return { userId: row.user_id, displayName: row.display_name, joinedAt: row.joined_at, ...(row.left_at ? { leftAt: row.left_at } : {}) }; }
function rowToRun(row: RunRow): SessionRun { return { id: row.id, sessionId: row.session_id, rootObjective: row.root_objective, ...(row.issue_reference ? { issueReference: row.issue_reference } : {}), state: row.state, createdBy: row.created_by, createdAt: row.created_at, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}), updatedAt: row.updated_at }; }
function rowToTurn(row: TurnRow): SessionTurn { return { id: row.id, sessionId: row.session_id, runId: row.run_id, ...(row.runtime_turn_id ? { runtimeTurnId: row.runtime_turn_id } : {}), state: row.state, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}), createdAt: row.created_at }; }
function rowToMessage(row: MessageRow): SessionMessage { return { id: row.id, sessionId: row.session_id, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}), sequence: row.sequence, role: row.role, ...(row.author_user_id ? { authorUserId: row.author_user_id } : {}), ...(row.logical_agent_id ? { logicalAgentId: row.logical_agent_id } : {}), body: row.body, status: row.status, includeHumanIdentity: row.include_human_identity === 1, createdAt: row.created_at, ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}) }; }
function rowToApproval(row: ApprovalRow): SessionApproval { return { id: row.id, sessionId: row.session_id, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}), kind: row.kind, summary: row.summary, detail: parseJson(row.detail_redacted_json), state: row.state, requestedAt: row.requested_at, ...(row.expires_at ? { expiresAt: row.expires_at } : {}), ...(row.answered_by ? { answeredBy: row.answered_by } : {}), ...(row.answered_at ? { answeredAt: row.answered_at } : {}), ...(row.decision ? { decision: row.decision } : {}), version: row.version }; }
function rowToProgress(row: ProgressRow): SessionProgress { return { activationId: row.activation_id, activityKey: row.activity_key, label: row.label, ...(row.current_value === null ? {} : { currentValue: row.current_value }), ...(row.total_value === null ? {} : { totalValue: row.total_value }), ...(row.unit ? { unit: row.unit } : {}), important: row.important === 1, updatedAt: row.updated_at }; }

export function sessionIdForEvent(database: ServerContext['database'], event: EventEnvelope): string | undefined {
  if (event.aggregateType === 'session') return event.aggregateId;
  if (event.parentAggregateId && database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(event.parentAggregateId)) return event.parentAggregateId;
  switch (event.aggregateType) {
    case 'run':
      return (database.prepare('SELECT session_id FROM runs WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    case 'turn':
      return (database.prepare('SELECT session_id FROM session_turns WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    case 'activation':
      return (database.prepare('SELECT r.session_id FROM agent_activations a JOIN logical_agents l ON l.id = a.logical_agent_id JOIN runs r ON r.id = l.run_id WHERE a.id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    case 'agent':
      return (database.prepare('SELECT r.session_id FROM logical_agents l JOIN runs r ON r.id = l.run_id WHERE l.id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    case 'approval':
      return (database.prepare('SELECT session_id FROM approvals WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    case 'message':
      return (database.prepare('SELECT session_id FROM messages WHERE id = ?').get(event.aggregateId) as { session_id: string } | undefined)?.session_id;
    default:
      return undefined;
  }
}
