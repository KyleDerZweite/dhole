import { describe, expect, it } from 'vitest';
import type { NodeCommand } from '@dhole-control/shared';
import { EventStore } from '../../../lib/events.js';
import { openDatabase } from '../../../lib/database.js';
import type { Clock, IdSource } from '../../../lib/clock.js';
import type { ServerContext, AuthenticatedUser } from '../../../lib/module.js';
import { SessionsError, SessionsService, type SessionMachines } from './service.js';
import { SessionSubscriptionHub } from './ws.js';
import { removeProjectMember, setProjectMember } from '../projects.js';

const ids: IdSource = { id: (() => { let n = 0; return () => `id-${++n}`; })(), token: () => 'token-value-long-enough' };

function fixture() {
  const database = openDatabase(':memory:', { now: () => new Date('2026-08-30T00:00:00.000Z') });
  database.exec(`INSERT INTO teams(id,name,created_at) VALUES ('team-1','Team','2026-08-30T00:00:00.000Z');
    INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES ('u1','one@example.test','One','x','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'),('u2','two@example.test','Two','x','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z');
    INSERT INTO team_members(team_id,user_id,role,created_at) VALUES ('team-1','u1','member','2026-08-30T00:00:00.000Z'),('team-1','u2','member','2026-08-30T00:00:00.000Z');
    INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at,visibility) VALUES ('p1','team-1','Project','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z','team');`);
  const clock: Clock = { now: () => new Date('2026-08-30T00:00:00.000Z') };
  const context: ServerContext = { config: {} as ServerContext['config'], database, clock, ids, events: new EventStore(database, clock, ids) };
  const one: AuthenticatedUser = { id: 'u1', email: 'one@example.test', displayName: 'One', role: 'member', teamId: 'team-1' };
  const two: AuthenticatedUser = { id: 'u2', email: 'two@example.test', displayName: 'Two', role: 'member', teamId: 'team-1' };
  return { database, context, service: new SessionsService(context), one, two };
}

describe('sessions state machine', () => {
  it('requires current project permission as well as transcript membership for every operation', () => {
    const { service, context, database, one, two } = fixture();
    database.prepare("UPDATE projects SET visibility = 'private' WHERE id = 'p1'").run();
    const session = service.createSession(one, 'p1', { title: 'private transcript' });
    const run = service.createRun(one, session.id, { rootObjective: 'private objective' });
    expect(() => service.authorizedEvents(one, 'other-project', session.id)).toThrow('Session does not belong');
    expect(() => service.listSessions(two, 'p1')).toThrow('Project access');
    expect(() => service.createSession(two, 'p1', { title: 'uninvited' })).toThrow('Project access');
    expect(() => service.addParticipant(one, session.id, two.id)).toThrow('Participant must have access');
    setProjectMember(context, one, 'p1', two.id, 'viewer');
    expect(service.listSessions(two, 'p1')).toEqual([]);
    expect(() => service.getTree(two, run.id)).toThrow('Session participant');
    service.addParticipant(one, session.id, two.id);
    expect(service.getSnapshot(two, session.id).session.id).toBe(session.id);
    expect(() => service.queueMessage(two, session.id, { body: 'viewer write' })).toThrow('Project access');
    expect(() => service.createRun(two, session.id, { rootObjective: 'viewer run' })).toThrow('Project access');
    expect(() => service.setRunState(two, run.id, 'running')).toThrow('Project access');
    expect(() => service.acquireSteeringLease(two, session.id)).toThrow('Project access');
    setProjectMember(context, one, 'p1', two.id, 'editor');
    expect(service.queueMessage(two, session.id, { body: 'editor write' }).body).toBe('editor write');
    const lease = service.acquireSteeringLease(two, session.id);
    const frames: string[] = [];
    const hub = new SessionSubscriptionHub(context, service);
    hub.subscribe({ readyState: 1, send: (frame) => frames.push(frame) }, two, session.id);
    frames.length = 0;
    removeProjectMember(context, one, 'p1', two.id);
    expect(service.canRead(two, session.id)).toBe(false);
    expect(() => service.getSnapshot(two, session.id)).toThrow('Project access');
    expect(() => service.getTree(two, run.id)).toThrow('Project access');
    expect(() => service.renewSteeringLease(two, session.id, lease.token)).toThrow('Project access');
    expect(hub.publishTransient(session.id, { delta: 'private after revoke' })).toBe(0);
    service.queueMessage(one, session.id, { body: 'owner after revoke' });
    context.events.flushOutbox();
    expect(frames).toEqual([]);
    hub.close();
    database.close();
  });

  it('drives a runtime-backed session through create, send, agent response, and settlement', () => {
    const { service, database, one, two } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    const machines: SessionMachines = { enqueueCommand: ({ machineId, projectId, command }) => { const now = new Date('2026-08-30T00:00:00.000Z').toISOString(); database.prepare("INSERT OR IGNORE INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(command.commandId, machineId, projectId, command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now); return { id: command.commandId }; } };
    service.setMachines(machines);
    const session = service.createSession(one, 'p1', { title: 'native', runtimeRegistrationId: 'rt1' });
    service.addParticipant(one, session.id, two.id);
    const messageInput = { body: 'hello user@example.test api-key=supersecret', idempotencyKey: 'runtime-message-retry' };
    const human = service.queueMessage(one, session.id, messageInput);
    expect(human.status).toBe('delivered');
    const create = database.prepare("SELECT * FROM node_commands WHERE kind = 'create_runtime_session'").get() as { id: string; operation_key: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ runtimeSessionId: 'native-1' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', create.id);
    service.maintenance();
    const send = database.prepare("SELECT * FROM node_commands WHERE kind = 'send_message'").get() as { id: string };
    const sendPayload = JSON.parse((database.prepare("SELECT payload_json FROM node_commands WHERE id = ?").get(send.id) as { payload_json: string }).payload_json) as { message: string };
    expect(sendPayload.message).not.toContain('supersecret');
    expect(sendPayload.message).toContain('user@example.test');
    expect((database.prepare('SELECT body FROM messages WHERE id = ?').get(human.id) as { body: string }).body).toContain('supersecret');
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ turnId: 'provider-turn-1', text: 'world' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', send.id);
    service.maintenance();
    const snapshot = service.getSnapshot(one, session.id);
    expect(service.queueMessage(one, session.id, messageInput).id).toBe(human.id);
    expect(service.getSnapshot(one, session.id).runs).toHaveLength(1);
    expect(snapshot.participants.map((participant) => participant.displayName)).toEqual(['One', 'Two']);
    expect(snapshot.messages.map((item) => item.body)).toEqual(['hello user@example.test api-key=supersecret', 'world']);
    expect(snapshot.session.state).toBe('idle');
    expect(snapshot.runs[0]?.state).toBe('settled');
    expect(snapshot.turns[0]?.runtimeTurnId).toBe('provider-turn-1');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind IN ('create_runtime_session','send_message')").get() as { count: number }).count).toBe(2);
  });

  it('routes runtime events by command and native session, sanitizes reserved IDs, and ignores late events', () => {
    const { service, database, context, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'runtime events' });
    const run = service.createRun(one, session.id, { rootObjective: 'events' });
    const turn = service.startTurn(one, { runId: run.id });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    database.prepare("UPDATE agent_activations SET native_session_id = 'native-session', machine_id = 'm1', runtime_registration_id = 'rt1' WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?)").run(run.id);
    const now = new Date().toISOString();
    const command = { commandId: 'runtime-event-command', operationKey: 'runtime-event-operation', kind: 'send_message', runtimeSessionId: 'native-session', message: 'hello', issuedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'running',?,?,?)`).run(command.commandId, 'm1', 'p1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const transients: Array<Record<string, unknown>> = [];
    service.setTransientEventHandler((_sessionId, payload) => transients.push(payload.payload));
    service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event: { eventId: 'transient-1', eventKind: 'message.delta', occurredAt: now, payload: { runtimeSessionId: 'evil-session', sessionId: 'evil-session', delta: 'partial' } } });
    expect(transients).toEqual([{ delta: 'partial' }]);
    const event = { eventId: 'durable-1', eventKind: 'tool.call.started', occurredAt: now, payload: { sessionId: 'evil-session', runId: 'evil-run', turnId: 'evil-turn', runtimeSessionId: 'evil-session', name: 'safe' } };
    service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event });
    service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event });
    const stored = database.prepare("SELECT payload_json FROM event_log WHERE event_kind = 'tool.call.started' AND source_native_event_id = 'durable-1'").get() as { payload_json: string };
    expect(JSON.parse(stored.payload_json)).toMatchObject({ sessionId: session.id, runId: run.id, turnId: turn.id, name: 'safe' });
    expect(stored.payload_json).not.toContain('evil-session');
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'tool.call.started' AND source_native_event_id = 'durable-1'").get()).toEqual({ count: 1 });
    // Machine reduces terminal runtime events while its command transaction is
    // open.  The Sessions reducer must reuse that ambient transaction rather
    // than attempting a nested better-sqlite3 transaction.
    context.events.transaction(() => service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event: { ...event, eventId: 'durable-nested-1', eventKind: 'tool.call.completed' } }));
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'tool.call.completed' AND source_native_event_id = 'durable-nested-1'").get()).toEqual({ count: 1 });
    database.prepare("UPDATE agent_activations SET state = 'settled' WHERE native_session_id = 'native-session'").run();
    service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event: { ...event, eventId: 'late-1', eventKind: 'tool.call.completed' } });
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'tool.call.completed' AND source_native_event_id = 'late-1'").get()).toEqual({ count: 0 });
  });

  it('keeps a runtime run live until active descendants settle', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    const machines: SessionMachines = { enqueueCommand: ({ machineId, projectId, command }) => { const now = new Date('2026-08-30T00:00:00.000Z').toISOString(); database.prepare("INSERT OR IGNORE INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(command.commandId, machineId, projectId, command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now); return { id: command.commandId }; } };
    service.setMachines(machines);
    const session = service.createSession(one, 'p1', { title: 'runtime descendants', runtimeRegistrationId: 'rt1' });
    const human = service.queueMessage(one, session.id, { body: 'root work' });
    const run = service.getSnapshot(one, session.id).runs[0]!;
    const root = service.getTree(run.id)[0]!;
    const child = service.createAgent(one, run.id, { name: 'child', parentLogicalAgentId: root.id, evidence: 'platform' });
    service.startActivation(one, child.activationId);
    const create = database.prepare("SELECT id FROM node_commands WHERE kind = 'create_runtime_session'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ runtimeSessionId: 'native-descendant' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', create.id);
    service.maintenance();
    const send = database.prepare("SELECT id FROM node_commands WHERE kind = 'send_message'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ turnId: 'provider-turn', text: 'root done' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', send.id);
    service.maintenance();
    expect(service.getSnapshot(one, session.id).session.state).toBe('busy');
    expect(service.getSnapshot(one, session.id).runs.find((item) => item.id === run.id)?.state).toBe('running');
    expect(service.getTree(run.id)[0]!.state).toBe('waiting_on_children');
    service.updateActivationState(one, child.activationId, 'settled');
    expect(service.getSnapshot(one, session.id).session.state).toBe('idle');
    expect(service.getSnapshot(one, session.id).runs.find((item) => item.id === run.id)?.state).toBe('settled');
    expect(human.status).toBe('delivered');
  });

  it('persists provider turn IDs from terminal results and answers runtime approvals', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{\"approvalResponses\":true}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'runtime approval' });
    const run = service.createRun(one, session.id, { rootObjective: 'approval' });
    service.startTurn(one, { runId: run.id });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    database.prepare("UPDATE agent_activations SET native_session_id = 'native-session', machine_id = 'm1', runtime_registration_id = 'rt1' WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?)").run(run.id);
    const now = new Date().toISOString();
    const command = { commandId: 'runtime-approval-command', operationKey: 'runtime-approval-operation', kind: 'send_message', runtimeSessionId: 'native-session', message: 'hello', issuedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'completed',?,?,?)`).run(command.commandId, 'm1', 'p1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    service.handleRuntimeEvent({ projectId: 'p1', machineId: 'm1', commandId: command.commandId, operationKey: command.operationKey, event: { eventId: 'approval-event-1', eventKind: 'approval.requested', occurredAt: now, payload: { runtimeApprovalId: 'provider-approval-1', kind: 'command', summary: 'Run command', detail: { apiKey: 'sk-secret' } } } });
    const approval = service.getSnapshot(one, session.id).approvals[0]!;
    expect(approval.runtimeApprovalId).toBeUndefined();
    expect(JSON.stringify(approval.detail)).not.toContain('sk-secret');
    let queued: NodeCommand | undefined;
    service.setMachines({ enqueueCommand: ({ command: value }) => { queued = value; return { id: value.commandId }; } });
    const answered = service.answerApproval(one, session.id, approval.id, { decision: 'approve_once' });
    expect(answered.state).toBe('approved');
    expect(service.getSummary(session.id)?.state).toBe('busy');
    expect(queued).toMatchObject({ kind: 'answer_approval', runtimeSessionId: 'native-session', approvalId: 'provider-approval-1', decision: 'approve_once' });
  });

  it('rejects runtime approval responses when the runtime lacks the capability', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{\"approvalResponses\":false}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'unsupported approval', runtimeRegistrationId: 'rt1' });
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'Run command' });
    expect(() => service.answerApproval(one, session.id, approval.id, { decision: 'deny' })).toThrowError(/approval responses/iu);
    expect(service.getSnapshot(one, session.id).approvals[0]?.state).toBe('pending');
  });

  it('rejects explicit runtime starts that would create DB-only work', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'runtime explicit', runtimeRegistrationId: 'rt1' });
    expect(() => service.createRun(one, session.id, { rootObjective: 'work' })).toThrowError(/queueing a message/iu);
    database.prepare('UPDATE sessions SET runtime_registration_id = NULL WHERE id = ?').run(session.id);
    const run = service.createRun(one, session.id, { rootObjective: 'work' });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    expect(() => service.startRun(one, run.id)).toThrowError(/queueing a message/iu);
    expect(() => service.startTurn(one, { runId: run.id })).toThrowError(/queueing a message/iu);
  });

  it('keeps the provider cancel command deliverable while cancelling a runtime run', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{\"cancellation\":true}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    service.setMachines({ enqueueCommand: ({ machineId, projectId, command }) => {
      const now = new Date('2026-08-30T00:00:00.000Z').toISOString();
      database.prepare("INSERT OR IGNORE INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(command.commandId, machineId, projectId, command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
      return { id: command.commandId };
    } });
    const session = service.createSession(one, 'p1', { title: 'cancel runtime', runtimeRegistrationId: 'rt1' });
    service.queueMessage(one, session.id, { body: 'long-running work' });
    const run = service.getSnapshot(one, session.id).runs[0]!;
    const create = database.prepare("SELECT id FROM node_commands WHERE kind = 'create_runtime_session'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ runtimeSessionId: 'native-cancel', turnId: 'provider-turn' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', create.id);
    service.maintenance();
    database.prepare("UPDATE session_turns SET runtime_turn_id = 'provider-turn' WHERE run_id = ?").run(run.id);
    database.prepare("UPDATE agent_activations SET native_session_id = 'native-cancel' WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?)").run(run.id);
    service.cancelSession(one, session.id);
    const cancel = database.prepare("SELECT state FROM node_commands WHERE kind = 'cancel'").get() as { state: string };
    expect(cancel.state).toBe('queued');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind <> 'cancel' AND state = 'cancelled'").get() as { count: number }).count).toBeGreaterThan(0);
  });

  it('terminalizes runtime turns and queued commands when a run is failed', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    const machines: SessionMachines = { enqueueCommand: ({ machineId, projectId, command }) => { const now = new Date('2026-08-30T00:00:00.000Z').toISOString(); database.prepare("INSERT OR IGNORE INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(command.commandId, machineId, projectId, command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now); return { id: command.commandId }; } };
    service.setMachines(machines);
    const session = service.createSession(one, 'p1', { title: 'terminal run', runtimeRegistrationId: 'rt1' });
    const message = service.queueMessage(one, session.id, { body: 'fail' });
    const run = service.getSnapshot(one, session.id).runs[0]!;
    service.setRunState(one, run.id, 'failed');
    const snapshot = service.getSnapshot(one, session.id);
    expect(snapshot.session.state).toBe('failed');
    expect(snapshot.runs[0]?.state).toBe('failed');
    expect(snapshot.turns[0]?.state).toBe('failed');
    expect(snapshot.messages.find((item) => item.id === message.id)?.status).toBe('failed');
    expect((database.prepare("SELECT state FROM node_commands WHERE kind = 'create_runtime_session'").get() as { state: string }).state).toBe('cancelled');
  });

  it('keeps queued runtime follow-ups FIFO and reconciles duplicate maintenance idempotently', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    const machines: SessionMachines = { enqueueCommand: ({ machineId, projectId, command }) => { const now = new Date('2026-08-30T00:00:00.000Z').toISOString(); database.prepare("INSERT OR IGNORE INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(command.commandId, machineId, projectId, command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now); return { id: command.commandId }; } };
    service.setMachines(machines);
    const session = service.createSession(one, 'p1', { title: 'native', runtimeRegistrationId: 'rt1' });
    service.queueMessage(one, session.id, { body: 'one' });
    database.prepare('UPDATE sessions SET runtime_registration_id = NULL WHERE id = ?').run(session.id);
    const foreignRun = service.createRun(one, session.id, { rootObjective: 'foreign' });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    database.prepare("UPDATE runs SET created_at = '2026-08-29T00:00:00.000Z' WHERE id = ?").run(foreignRun.id);
    const foreign = { id: 'foreign-message' };
    database.prepare('UPDATE sessions SET next_message_sequence = next_message_sequence + 1 WHERE id = ?').run(session.id);
    database.prepare("INSERT INTO messages(id, session_id, run_id, turn_id, sequence, role, author_user_id, body, status, include_human_identity, created_at) VALUES (?, ?, ?, NULL, (SELECT next_message_sequence FROM sessions WHERE id = ?), 'human', ?, ?, 'queued', 0, ?)").run(foreign.id, session.id, foreignRun.id, session.id, one.id, 'foreign', '2026-08-30T00:00:00.000Z');
    service.queueMessage(one, session.id, { body: 'two' });
    const create = database.prepare("SELECT * FROM node_commands WHERE kind = 'create_runtime_session'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ runtimeSessionId: 'native-1' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', create.id);
    service.maintenance();
    const firstSend = database.prepare("SELECT * FROM node_commands WHERE kind = 'send_message'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ text: 'r1' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', firstSend.id);
    service.maintenance();
    service.maintenance();
    const resume = database.prepare("SELECT * FROM node_commands WHERE kind = 'resume_runtime_session'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', completed_at=?, updated_at=? WHERE id=?").run('2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', resume.id);
    service.maintenance();
    const secondSend = database.prepare("SELECT * FROM node_commands WHERE kind = 'send_message' ORDER BY rowid DESC").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='completed', result_json=?, completed_at=?, updated_at=? WHERE id=?").run(JSON.stringify({ text: 'r2' }), '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', secondSend.id);
    service.maintenance();
    service.maintenance();
    expect(service.getSnapshot(one, session.id).messages.map((item) => item.body)).toEqual(['one', 'foreign', 'two', 'r1', 'r2']);
    expect(service.getSnapshot(one, session.id).messages.find((item) => item.id === foreign.id)?.status).toBe('queued');
    expect((database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'send_message'").get() as { count: number }).count).toBe(2);
  });

  it('fails the turn, run, and session when a runtime command fails', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{}',1,'2026-08-30T00:00:00.000Z'); INSERT INTO repositories(id,project_id,label,created_by,created_at,updated_at) VALUES ('repo1','p1','repo','u1','2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO machine_repository_allowlists(machine_id,repository_id,canonical_root,created_at) VALUES ('m1','repo1','/tmp','2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'native', runtimeRegistrationId: 'rt1' });
    service.queueMessage(one, session.id, { body: 'fail me' });
    const create = database.prepare("SELECT id FROM node_commands WHERE kind = 'create_runtime_session'").get() as { id: string };
    database.prepare("UPDATE node_commands SET state='failed', error_summary='provider unavailable', completed_at=?, updated_at=? WHERE id=?").run('2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', create.id);
    service.maintenance();
    expect(service.getSnapshot(one, session.id).session.state).toBe('failed');
    expect(service.getSnapshot(one, session.id).runs[0]?.state).toBe('failed');
    expect(service.getSnapshot(one, session.id).messages[0]?.status).toBe('failed');
  });

  it('rolls back an approval answer when runtime command enqueue fails', () => {
    const { service, database, one } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{\"approvalResponses\":true}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'approval runtime' });
    const run = service.createRun(one, session.id, { rootObjective: 'approval' });
    const turn = service.startTurn(one, { runId: run.id });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    database.prepare("UPDATE agent_activations SET native_session_id='native', machine_id='m1', runtime_registration_id='rt1' WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?)").run(run.id);
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'Run command', turnId: turn.id });
    service.setMachines({ enqueueCommand: () => { throw new Error('machines unavailable'); } });
    expect(() => service.answerApproval(one, session.id, approval.id, { decision: 'deny' })).toThrow('machines unavailable');
    expect((database.prepare('SELECT state FROM approvals WHERE id = ?').get(approval.id) as { state: string }).state).toBe('pending');
  });
  it('allocates FIFO message sequences for two participants while busy', () => {
    const { service, one, two } = fixture();
    const session = service.createSession(one, 'p1', { title: 'shared' });
    service.addParticipant(one, session.id, two.id);
    const run = service.createRun(one, session.id, { rootObjective: 'work' });
    service.startTurn(one, { runId: run.id });
    const a = service.queueMessage(one, session.id, { body: 'first' });
    const b = service.queueMessage(two, session.id, { body: 'second' });
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    expect(service.getSnapshot(two, session.id).messages.map((message) => message.body)).toEqual(['first', 'second']);
  });

  it('enforces steering capability and renewable lease ownership', () => {
    const { service, database, one, two } = fixture();
    database.exec("INSERT INTO machines(id,team_id,name,status,available_slots,created_at,updated_at) VALUES ('m1','team-1','m','connected',1,'2026-08-30T00:00:00.000Z','2026-08-30T00:00:00.000Z'); INSERT INTO runtime_registrations(id,machine_id,kind,label,protocol_version,capabilities_json,available,observed_at) VALUES ('rt1','m1','fake','Fake','1','{\"activeTurnSteering\":true}',1,'2026-08-30T00:00:00.000Z');");
    const session = service.createSession(one, 'p1', { title: 'steer' });
    service.addParticipant(one, session.id, two.id);
    const run = service.createRun(one, session.id, { rootObjective: 'work' });
    const turn = service.startTurn(one, { runId: run.id });
    database.prepare("UPDATE sessions SET runtime_registration_id = 'rt1' WHERE id = ?").run(session.id);
    database.prepare("UPDATE agent_activations SET native_session_id = 'native-session', machine_id = 'm1', runtime_registration_id = 'rt1' WHERE logical_agent_id IN (SELECT id FROM logical_agents WHERE run_id = ?)").run(run.id);
    database.prepare("UPDATE session_turns SET runtime_turn_id = 'provider-turn-1' WHERE id = ?").run(turn.id);
    const lease = service.acquireSteeringLease(one, session.id);
    expect(() => service.acquireSteeringLease(two, session.id)).toThrowError(SessionsError);
    expect(service.steer(one, session.id, { turnId: turn.id, message: 'change', leaseToken: lease.token }).accepted).toBe(true);
    expect((database.prepare("SELECT kind FROM node_commands WHERE kind = 'steer'").get() as { kind: string }).kind).toBe('steer');
  });

  it('answers an approval once and prevents participant IDOR', () => {
    const { service, one, two } = fixture();
    const session = service.createSession(one, 'p1', { title: 'approval' });
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'Run tests' });
    expect(() => service.answerApproval(two, session.id, approval.id, { decision: 'deny' })).toThrowError(SessionsError);
    service.addParticipant(one, session.id, two.id);
    expect(service.answerApproval(two, session.id, approval.id, { decision: 'approve_once' }).state).toBe('approved');
    expect(() => service.answerApproval(one, session.id, approval.id, { decision: 'deny' })).toThrowError(SessionsError);
  });

  it('keeps parents waiting for active descendants and preserves resumed ordinals', () => {
    const { service, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'lineage' });
    const run = service.createRun(one, session.id, { rootObjective: 'root' });
    const root = service.getTree(run.id)[0]!;
    const child = service.createAgent(one, run.id, { name: 'child', parentLogicalAgentId: root.id, evidence: 'platform' });
    service.startActivation(one, child.activationId);
    expect(service.updateActivationState(one, root.activationId, 'settled').state).toBe('waiting_on_children');
    service.updateActivationState(one, child.activationId, 'settled');
    expect(service.getTree(run.id)[0]!.state).toBe('settled');
    const resumed = service.resumeActivation(one, child.id, {});
    expect(resumed.activationId).not.toBe(child.activationId);
    expect(service.getTree(run.id)[0]!.children.find((node) => node.id === child.id)!.activationId).toBe(resumed.activationId);
  });

  it('keeps running children running when settlement must wait for them', () => {
    const { service, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'aggregate status' });
    const run = service.createRun(one, session.id, { rootObjective: 'finish with child' });
    service.startRun(one, run.id);
    const root = service.getTree(run.id)[0]!;
    const child = service.createAgent(one, run.id, { name: 'child', parentLogicalAgentId: root.id, evidence: 'platform' });
    service.startActivation(one, child.activationId);
    expect(service.setRunState(one, run.id, 'settled').state).toBe('running');
    expect(service.getTree(run.id)[0]).toMatchObject({ state: 'waiting_on_children', children: [{ state: 'running' }] });
    service.updateActivationState(one, child.activationId, 'settled');
    expect(service.getSnapshot(one, session.id).runs[0]?.state).toBe('settled');
  });

  it('filters snapshot events by their stored aggregate rather than payload session IDs', () => {
    const { service, context, one, two } = fixture();
    const first = service.createSession(one, 'p1', { title: 'private' });
    const second = service.createSession(two, 'p1', { title: 'viewer session' });
    context.events.transaction(() => context.events.append({ projectId: 'p1', eventKind: 'tool.call.completed', aggregateType: 'session', aggregateId: first.id, actor: { type: 'system' }, source: { kind: 'platform', adapter: 'fixture' }, payload: { sessionId: second.id, privateOutput: 'first-session-only' } }));
    expect(JSON.stringify(service.getSnapshot(two, second.id).events)).not.toContain('first-session-only');
    expect(JSON.stringify(service.authorizedEvents(one, 'p1', first.id))).toContain('first-session-only');
  });

  it('rejects cross-session references and keeps terminal activations immutable', () => {
    const { service, one } = fixture();
    const first = service.createSession(one, 'p1', { title: 'first' });
    const firstRun = service.createRun(one, first.id, { rootObjective: 'first run' });
    const firstTurn = service.startTurn(one, { runId: firstRun.id });
    const firstRoot = service.getTree(firstRun.id)[0]!;
    const second = service.createSession(one, 'p1', { title: 'second' });
    expect(() => service.queueMessage(one, second.id, { body: 'invalid', runId: firstRun.id })).toThrowError(SessionsError);
    expect(() => service.createApproval(one, second.id, { kind: 'command', summary: 'invalid', turnId: firstTurn.id })).toThrowError(SessionsError);
    expect(() => service.completeAgentMessage(one, second.id, { body: 'invalid', logicalAgentId: firstRoot.id })).toThrowError(SessionsError);
    service.updateActivationState(one, firstRoot.activationId, 'settled');
    expect(() => service.updateActivationState(one, firstRoot.activationId, 'running')).toThrowError(SessionsError);
  });

  it('does not reopen terminal runs and never inserts a turn for them', () => {
    const { service, database, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'terminal run' });
    const run = service.createRun(one, session.id, { rootObjective: 'done' });
    service.setRunState(one, run.id, 'settled');
    expect(service.getTree(run.id)[0]?.state).toBe('settled');
    const eventsBefore = (database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'run.settled'").get() as { count: number }).count;
    expect(() => service.startTurn(one, { runId: run.id })).toThrowError(SessionsError);
    expect(() => service.setRunState(one, run.id, 'running')).toThrowError(SessionsError);
    expect(service.setRunState(one, run.id, 'settled').state).toBe('settled');
    expect((database.prepare('SELECT count(*) AS count FROM session_turns WHERE run_id = ?').get(run.id) as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'run.settled'").get() as { count: number }).count).toBe(eventsBefore);
  });

  it('rejects all run-scoped writes after terminal settlement', () => {
    const { service, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'terminal writes' });
    const run = service.createRun(one, session.id, { rootObjective: 'done' });
    const root = service.getTree(run.id)[0]!;
    const pendingApproval = service.createApproval(one, session.id, { kind: 'command', summary: 'late answer', runId: run.id });
    service.updateActivationState(one, root.activationId, 'settled');
    service.setRunState(one, run.id, 'settled');

    expect(() => service.createAgent(one, run.id, { name: 'late child', parentLogicalAgentId: root.id, evidence: 'platform' })).toThrowError(SessionsError);
    expect(() => service.resumeActivation(one, root.id, {})).toThrowError(SessionsError);
    expect(() => service.queueMessage(one, session.id, { body: 'late', runId: run.id })).toThrowError(SessionsError);
    expect(() => service.createApproval(one, session.id, { kind: 'command', summary: 'late', runId: run.id })).toThrowError(SessionsError);
    expect(() => service.completeAgentMessage(one, session.id, { body: 'late', runId: run.id, logicalAgentId: root.id })).toThrowError(SessionsError);
    expect(() => service.answerApproval(one, session.id, pendingApproval.id, { decision: 'deny' })).toThrowError(SessionsError);
  });

  it('keeps completed turns and run events consistent and idempotent', () => {
    const { service, database, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'turn completion' });
    const run = service.createRun(one, session.id, { rootObjective: 'work' });
    const turn = service.startTurn(one, { runId: run.id });
    service.completeTurn(one, turn.id, 'completed');
    expect(service.getSnapshot(one, session.id).runs[0]!.state).toBe('running');
    expect((database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'run.settled'").get() as { count: number }).count).toBe(0);
    expect(() => service.completeTurn(one, turn.id, 'failed')).toThrowError(SessionsError);
    expect(service.completeTurn(one, turn.id, 'completed').state).toBe('completed');
  });

  it('rejects writes after cancellation and idempotency-key reuse', () => {
    const { service, database, one, two } = fixture();
    const first = service.createSession(one, 'p1', { title: 'first' });
    const second = service.createSession(one, 'p1', { title: 'second' });
    const key = 'idem-key-1';
    service.queueMessage(one, first.id, { body: 'same', idempotencyKey: key });
    const run = service.createRun(one, first.id, { rootObjective: 'later' });
    expect(() => service.queueMessage(one, first.id, { body: 'same', runId: run.id, idempotencyKey: key })).toThrowError(SessionsError);
    const explicitKey = 'idem-key-2';
    service.queueMessage(one, first.id, { body: 'explicit', runId: run.id, idempotencyKey: explicitKey });
    const newer = service.createRun(one, first.id, { rootObjective: 'newer' });
    database.prepare("UPDATE runs SET created_at = '2026-08-30T00:00:01.000Z' WHERE id = ?").run(newer.id);
    expect(() => service.queueMessage(one, first.id, { body: 'explicit', idempotencyKey: explicitKey })).toThrowError(SessionsError);
    expect(() => service.queueMessage(one, second.id, { body: 'same', idempotencyKey: key })).toThrowError(SessionsError);
    service.addParticipant(one, first.id, two.id);
    expect(() => service.queueMessage(two, first.id, { body: 'same', idempotencyKey: key })).toThrowError(SessionsError);
    service.cancelSession(one, first.id);
    expect(() => service.queueMessage(one, first.id, { body: 'later' })).toThrowError(SessionsError);
    expect(() => service.createRun(one, first.id, { rootObjective: 'later' })).toThrowError(SessionsError);
  });

  it('sanitizes native event references and runtime session ids from browser events', () => {
    const { service, context, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'safe events' });
    context.events.transaction(() => { context.events.append({ projectId: 'p1', eventKind: 'session.created', aggregateType: 'session', aggregateId: session.id, actor: { type: 'system' }, source: { kind: 'provider', nativeEventId: 'provider-secret', rawReference: 'raw-secret' }, payload: { sessionId: session.id, runtimeSessionId: 'native-secret' } }); });
    const event = service.authorizedEvents(one, 'p1', session.id).at(-1)!;
    expect(event.source.nativeEventId).toBeUndefined();
    expect(event.source.rawReference).toBeUndefined();
    expect(event.payload.runtimeSessionId).toBe('[REDACTED]');
  });

  it('sanitizes live websocket events before publishing', async () => {
    const { service, context, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'live events' });
    const frames: Array<Record<string, unknown>> = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>) };
    const hub = new SessionSubscriptionHub(context, service);
    hub.subscribe(socket, one, session.id);
    context.events.transaction(() => { context.events.append({ projectId: 'p1', eventKind: 'session.created', aggregateType: 'session', aggregateId: session.id, actor: { type: 'system' }, source: { kind: 'provider', nativeEventId: 'provider-secret', rawReference: 'raw-secret' }, payload: { sessionId: session.id, runtimeSessionId: 'native-secret' } }); });
    await Promise.resolve();
    const event = frames.map((frame) => frame.event).find((value) => Boolean(value && typeof value === 'object' && 'payload' in value && (value as { payload?: Record<string, unknown> }).payload?.runtimeSessionId)) as { source: Record<string, unknown>; payload: Record<string, unknown> } | undefined;
    expect(event?.source.nativeEventId).toBeUndefined();
    expect(event?.source.rawReference).toBeUndefined();
    expect(event?.payload.runtimeSessionId).toBe('[REDACTED]');
    hub.close();
  });

  it('closes a websocket that crosses the buffered high-water mark after send', async () => {
    const { service, context, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'backpressure' });
    let bufferedAmount = 0;
    let closeCode: number | undefined;
    const socket = {
      readyState: 1,
      get bufferedAmount() { return bufferedAmount; },
      send: () => { bufferedAmount = 256 * 1024 * 128 + 1; },
      close: (code?: number) => { closeCode = code; },
    };
    const hub = new SessionSubscriptionHub(context, service);
    const watermark = (context.database.prepare('SELECT event_sequence FROM projects WHERE id = ?').get('p1') as { event_sequence: number }).event_sequence;
    hub.subscribe(socket, one, session.id, watermark);
    context.events.transaction(() => {
      context.events.append({ projectId: 'p1', eventKind: 'session.created', aggregateType: 'session', aggregateId: session.id, actor: { type: 'system' }, source: { kind: 'platform', adapter: 'test' }, payload: { sessionId: session.id } });
    });
    await Promise.resolve();
    expect(closeCode).toBe(1013);
    hub.close();
  });

  it('expires approvals before accepting an answer', () => {
    const { service, database, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'approval expiry' });
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'expired', expiresAt: '2026-08-29T00:00:00.000Z' });
    expect(() => service.answerApproval(one, session.id, approval.id, { decision: 'approve_once' })).toThrowError(SessionsError);
    expect((database.prepare('SELECT state FROM approvals WHERE id = ?').get(approval.id) as { state: string }).state).toBe('expired');
  });

  it('maintenance expires due approvals and restores idle session state', () => {
    const { service, database, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'approval maintenance' });
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'expired', expiresAt: '2026-08-29T00:00:00.000Z' });
    service.maintenance();
    expect((database.prepare('SELECT state FROM approvals WHERE id = ?').get(approval.id) as { state: string }).state).toBe('expired');
    expect(service.getSummary(session.id)!.state).toBe('idle');
    expect((database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'approval.answered' AND aggregate_id = ?").get(approval.id) as { count: number }).count).toBe(1);
  });

  it('redacts approval detail before storing snapshots', () => {
    const { service, one } = fixture();
    const session = service.createSession(one, 'p1', { title: 'redaction' });
    const approval = service.createApproval(one, session.id, { kind: 'command', summary: 'safe', detail: { apiKey: 'sk-super-secret', nested: { password: 'pw-secret' }, note: 'user@example.com' } });
    const detail = service.getSnapshot(one, session.id).approvals.find((item) => item.id === approval.id)!.detail;
    expect(JSON.stringify(detail)).not.toContain('sk-super-secret');
    expect(JSON.stringify(detail)).not.toContain('pw-secret');
    expect(JSON.stringify(detail)).not.toContain('user@example.com');
  });

  it('revalidates current membership and disabled status for private reads', () => {
    const { service, database, one, two } = fixture();
    const session = service.createSession(one, 'p1', { title: 'membership' });
    service.addParticipant(one, session.id, two.id);
    expect(service.canRead(two, session.id)).toBe(true);
    database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-08-30T00:00:00.000Z', two.id);
    expect(service.canRead(two, session.id)).toBe(false);
    database.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(two.id);
    database.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run('team-1', two.id);
    expect(service.canRead(two, session.id)).toBe(false);
  });
});
