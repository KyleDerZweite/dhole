import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { NodeRuntimeEvent } from '@dhole-control/shared';
import { openDatabase } from '../../lib/database.js';
import { secureIds, systemClock } from '../../lib/clock.js';
import { EventStore } from '../../lib/events.js';
import { hashToken } from '../../lib/security.js';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { accessModule } from '../access/index.js';
import { FleetError, FleetService, authenticateNodeCredential, bearerCredential, createFleetService, fleetModule, handleNodeConnection } from './index.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(): FleetService {
  const database = openDatabase(':memory:', systemClock);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', new Date().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', new Date().toISOString(), new Date().toISOString());
  return new FleetService(database, systemClock, secureIds);
}

function setupWithEvents(): FleetService {
  const database = openDatabase(':memory:', systemClock);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', new Date().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', new Date().toISOString(), new Date().toISOString());
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', new Date().toISOString(), new Date().toISOString());
  return new FleetService(database, systemClock, secureIds, {}, new EventStore(database, systemClock, secureIds));
}

function setupHttp(): { app: DholeApp; fleet: FleetService; database: ReturnType<typeof openDatabase>; machineId: string; cookie: string; bearer: string } {
  const database = openDatabase(':memory:', systemClock);
  const now = systemClock.now().toISOString();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-http', 'Team', now);
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-http', 'http@example.invalid', 'HTTP Admin', 'test', now, now);
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, \'administrator\', ?)').run('team-http', 'user-http', now);
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-http', 'team-http', 'Project', 'user-http', now, now);
  const events = new EventStore(database, systemClock, secureIds);
  const context = { config: { environment: 'test' } as ServerContext['config'], database, clock: systemClock, ids: secureIds, events } satisfies ServerContext;
  const fleet = new FleetService(database, systemClock, secureIds, {}, events);
  const device = fleet.consumeEnrollmentToken(fleet.issueEnrollmentToken({ teamId: 'team-http', label: 'http-node', createdBy: 'user-http' }).token);
  const bearer = secureIds.token(32);
  database.prepare('INSERT INTO api_tokens(id, user_id, project_id, token_hash, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    secureIds.id(), 'user-http', 'project-http', hashToken(bearer), JSON.stringify({ permissions: ['fleet:admin'] }), now, new Date(Date.now() + 60_000).toISOString(),
  );
  const app = new Hono() as DholeApp;
  app.use('*', (c, next) => {
    if (c.req.header('cookie')) c.set('user', { id: 'user-http', email: 'http@example.invalid', displayName: 'HTTP Admin', role: 'administrator', teamId: 'team-http' });
    return next();
  });
  accessModule.register(app, context);
  fleetModule.register(app, context);
  app.onError((error, c) => error instanceof FleetError ? c.json({ error: { code: error.code } }, error.status as 400 | 401 | 403 | 404 | 409 | 422) : c.json({ error: { code: 'internal_error' } }, 500));
  return { app, fleet, database, machineId: device.machineId, cookie: 'dhole_session=cookie-session', bearer };
}

function enrolledMachine(fleet: FleetService): { machineId: string; credential: string } {
  const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
  const enrolled = fleet.consumeEnrollmentToken(issued.token);
  return { machineId: enrolled.machineId, credential: enrolled.credential };
}

describe('fleet enrollment and command durability', () => {
  it('keeps offline demo fixtures readable for a full day before marking them stale', () => {
    let now = new Date('2026-08-31T00:00:00.000Z');
    const clock = { now: () => now };
    const database = openDatabase(':memory:', clock);
    const events = new EventStore(database, clock, secureIds);
    const context = { config: { demo: true } as ServerContext['config'], database, clock, ids: secureIds, events } satisfies ServerContext;
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('demo-team', 'Demo', now.toISOString());
    database.prepare("INSERT INTO machines(id, team_id, name, status, last_heartbeat_at, created_at, updated_at) VALUES ('demo-machine','demo-team','Demo fixture','connected',?,?,?)").run(now.toISOString(), now.toISOString(), now.toISOString());
    const fleet = createFleetService(context);
    now = new Date('2026-08-31T23:59:00.000Z');
    expect(fleet.markStale()).toBe(0);
    now = new Date('2026-09-01T00:01:00.000Z');
    expect(fleet.markStale()).toBe(1);
    database.close();
  });

  it('hashes enrollment tokens and denies reuse', () => {
    const fleet = setup();
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    expect(enrolled.credential).not.toBe(issued.token);
    expect(fleet.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(true);
    expect(() => fleet.consumeEnrollmentToken(issued.token)).toThrow(FleetError);
  });

  it('authenticates the replaceable credential from a Bearer header', () => {
    const fleet = setup();
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    expect(bearerCredential(`Bearer ${enrolled.credential}`)).toBe(enrolled.credential);
    expect(authenticateNodeCredential(fleet, enrolled.machineId, `Bearer ${enrolled.credential}`)).toBe(true);
    expect(authenticateNodeCredential(fleet, enrolled.machineId, 'Bearer wrong-credential')).toBe(false);
  });

  it('deduplicates commands by operation key and retains state on reconnect', () => {
    const fleet = setup();
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    const now = new Date();
    const command = { commandId: secureIds.id(), operationKey: `operation-${secureIds.id()}`, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    const first = fleet.enqueueCommand(enrolled.machineId, command);
    const second = fleet.enqueueCommand(enrolled.machineId, command);
    expect(second.id).toBe(first.id);
    expect(fleet.listCommands(enrolled.machineId)).toHaveLength(1);
  });

  it('enforces repository allowlists and correlates status by the wire command id', () => {
    const fleet = setup();
    const database = fleet.database;
    const at = new Date().toISOString();
    database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', at, at);
    database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-1', 'project-1', 'Repository', 'user-1', at, at);
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    const command = {
      commandId: 'command-1',
      operationKey: 'operation-repository-1',
      issuedAt: at,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'create_runtime_session' as const,
      repositoryId: 'repository-1',
      runtimeId: 'fake',
      runtimeSessionKey: 'runtime-session-key-1',
      cwd: '.',
    };
    expect(() => fleet.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command })).toThrow(FleetError);
    fleet.addRepositoryAllowlist(enrolled.machineId, 'repository-1', '/configured/on/node');
    const queued = fleet.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command });
    expect(queued.id).toBe(command.commandId);
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { runtimeSessionId: 'runtime-session-1' },
      occurredAt: new Date().toISOString(),
    });
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('completed');
    database.prepare("UPDATE node_commands SET state = 'cancelled' WHERE machine_id = ? AND operation_key = ?").run(enrolled.machineId, command.operationKey);
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { late: true },
      occurredAt: new Date().toISOString(),
    });
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('cancelled');
  });

  it('tracks disconnect and reconnect status', () => {
    const fleet = setup();
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    const socket = { readyState: 1, send: () => undefined, on: () => socket, close: () => undefined } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    expect(fleet.getMachine(enrolled.machineId)?.status).toBe('connected');
    fleet.disconnect(enrolled.machineId, socket);
    expect(fleet.getMachine(enrolled.machineId)?.status).toBe('disconnected');
    const audit = fleet.database.prepare("SELECT action, project_id FROM audit_records WHERE target_id = ? ORDER BY occurred_at").all(enrolled.machineId) as Array<{ action: string; project_id: string | null }>;
    expect(audit.map((entry) => entry.action)).toEqual(['machine.connected', 'machine.disconnected']);
    expect(audit.every((entry) => entry.project_id === null)).toBe(true);
  });

  it('marks runtimes missing from the latest heartbeat unavailable', () => {
    const fleet = setup();
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    fleet.heartbeat(enrolled.machineId, 1, [{
      id: 'runtime-fake',
      kind: 'fake',
      label: 'Fake',
      protocolVersion: 'fixture.v1',
      capabilities: {},
      availability: { available: true },
    }]);
    expect((fleet.database.prepare('SELECT available FROM runtime_registrations WHERE machine_id = ?').get(enrolled.machineId) as { available: number }).available).toBe(1);
    fleet.heartbeat(enrolled.machineId, 1, []);
    expect((fleet.database.prepare('SELECT available FROM runtime_registrations WHERE machine_id = ?').get(enrolled.machineId) as { available: number }).available).toBe(0);
  });

  it('leaves commands queued when a socket closes or throws during send', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    let readyState = 1;
    const sent: string[] = [];
    let sends = 0;
    const socket = {
      get readyState() { return readyState; },
      send(value: string) { sent.push(value); sends += 1; if (sends > 2) { readyState = 3; throw new Error('socket closed'); } },
      close() { readyState = 3; },
    } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    const now = new Date();
    const command = { commandId: 'command-transport', operationKey: 'operation-transport', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => fleet.enqueueCommand(enrolled.machineId, command)).not.toThrow();
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.attemptCount).toBe(0);
    expect(sent.some((frame) => frame.includes('report_health'))).toBe(true);
  });

  it('leaves commands queued when the socket closes without throwing', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    let readyState = 1;
    let sends = 0;
    const socket = {
      get readyState() { return readyState; },
      send(_value: string) { sends += 1; if (sends > 2) readyState = 3; },
      close() { readyState = 3; },
    } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    const now = new Date();
    const command = { commandId: 'command-close', operationKey: 'operation-close', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => fleet.enqueueCommand(enrolled.machineId, command)).not.toThrow();
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.attemptCount).toBe(0);
  });

  it('cancels queued orchestration commands linked to terminal runs or sessions before delivery', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    const at = new Date().toISOString();
    fleet.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-terminal', 'team-1', 'Terminal Project', 'user-1', at, at);
    const addExecution = (suffix: string, runState: string, sessionState: string): string => {
      const sessionId = `session-${suffix}`;
      const runId = `run-${suffix}`;
      const profileId = `profile-${suffix}`;
      const versionId = `version-${suffix}`;
      const executionId = `execution-${suffix}`;
      const workItemId = `work-item-${suffix}`;
      const commandId = `command-${suffix}`;
      const operationKey = `orchestration-${suffix}-operation`;
      fleet.database.prepare("INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES (?, 'project-terminal', ?, ?, 'user-1', ?, ?)").run(sessionId, suffix, sessionState, at, at);
      fleet.database.prepare("INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'user-1', ?, ?)").run(runId, sessionId, suffix, runState, at, at);
      fleet.database.prepare("INSERT INTO orchestration_profiles(id, project_id, stable_key, name, active_version, created_at) VALUES (?, 'project-terminal', ?, ?, 1, ?)").run(profileId, suffix, suffix, at);
      fleet.database.prepare("INSERT INTO orchestration_profile_versions(id, profile_id, version, config_json, content_hash, lifecycle, created_by, created_at) VALUES (?, ?, 1, '{}', ?, 'active', 'user-1', ?)").run(versionId, profileId, versionId, at);
      fleet.database.prepare("INSERT INTO orchestration_executions(id, run_id, profile_version_id, state, max_concurrency, created_at, started_at, updated_at) VALUES (?, ?, ?, 'running', 1, ?, ?, ?)").run(executionId, runId, versionId, at, at, at);
      fleet.database.prepare("INSERT INTO orchestration_work_items(id, execution_id, objective, deliverables_json, acceptance_json, required_capabilities_json, claim_scope_json, workspace_policy, budget_json, depth, ordinal, attempt, state, machine_id, created_at, updated_at) VALUES (?, ?, ?, '{}', '{}', '{}', '{}', 'shared', '{}', 1, 1, 1, 'running', ?, ?, ?)").run(workItemId, executionId, suffix, enrolled.machineId, at, at);
      fleet.database.prepare("INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, 'project-terminal', ?, 'report_health', ?, 'queued', ?, ?, ?)").run(commandId, enrolled.machineId, operationKey, JSON.stringify({ commandId, operationKey, issuedAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'report_health' }), at, new Date(Date.now() + 60_000).toISOString(), at);
      return operationKey;
    };
    const runOperation = addExecution('run-terminal', 'cancelled', 'idle');
    const sessionOperation = addExecution('session-terminal', 'running', 'closed');
    const sent: unknown[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(JSON.parse(value) as unknown); }, close() { /* noop */ } } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    expect(fleet.getCommand(enrolled.machineId, runOperation)?.state).toBe('cancelled');
    expect(fleet.getCommand(enrolled.machineId, sessionOperation)?.state).toBe('cancelled');
    expect(sent.some((message) => (message as { type?: string }).type === 'command')).toBe(false);
  });

  it('does not expire or redeliver an uncertain command after its TTL', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    const now = new Date();
    const command = { commandId: 'command-uncertain', operationKey: 'operation-uncertain', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    fleet.enqueueCommand(enrolled.machineId, command);
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'uncertain',
      occurredAt: now.toISOString(),
    });
    fleet.database.prepare("UPDATE node_commands SET expires_at = '2000-01-01T00:00:00.000Z' WHERE machine_id = ? AND operation_key = ?").run(enrolled.machineId, command.operationKey);
    const sent: string[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(value); }, close() { /* noop */ } } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    fleet.deliverPending(enrolled.machineId);
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('uncertain');
    expect(sent.some((frame) => JSON.parse(frame).type === 'command')).toBe(false);
  });

  it('does not send a command before an outer transaction commits', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    const sent: string[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(value); }, close() { /* noop */ } } as never;
    fleet.attachConnection(enrolled.machineId, socket);
    const baseline = sent.length;
    const now = new Date();
    const command = { commandId: 'command-rollback', operationKey: 'operation-rollback', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => fleet.database.transaction(() => {
      fleet.enqueueCommand(enrolled.machineId, command);
      expect(sent).toHaveLength(baseline);
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)).toBeUndefined();
    expect(sent).toHaveLength(baseline);
  });

  it('rejects operation-key aliases and records scoped command lifecycle events', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date();
    const command = { commandId: 'command-events', operationKey: 'operation-events', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    fleet.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command });
    expect(() => fleet.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command: { ...command, commandId: 'command-alias' } })).toThrow(FleetError);
    fleet.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'accepted', occurredAt: now.toISOString() });
    fleet.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { nested: { apiKey: 'sk-secretsecret' }, output: 'ok' }, occurredAt: now.toISOString() });
    const events = fleet.database.prepare('SELECT event_kind, payload_json FROM event_log WHERE project_id = ? ORDER BY project_sequence').all('project-1') as Array<{ event_kind: string; payload_json: string }>;
    expect(events.map((event) => event.event_kind)).toEqual(['command.queued', 'command.acknowledged', 'command.completed']);
    expect(events[2]?.payload_json).not.toContain('sk-secretsecret');
    const stored = fleet.getCommand(enrolled.machineId, command.operationKey);
    expect(JSON.stringify(stored?.result)).not.toContain('sk-secretsecret');
  });

  it('correlates runtime events to the authenticated machine and durable command', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-command-1', operationKey: 'runtime-operation-1', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-session-1', message: 'hello',
    };
    fleet.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const events: NodeRuntimeEvent[] = [];
    fleet.setRuntimeEventHandler(({ event }) => events.push(event));
    const event = { type: 'runtime_event' as const, protocol: 'dhole.node.v1' as const, commandId: command.commandId, operationKey: command.operationKey, sequence: 1, eventId: 'runtime-event-1', eventKind: 'tool.call.started', payload: { name: 'safe' }, occurredAt: now };
    fleet.handleRuntimeEvent(enrolled.machineId, event);
    fleet.handleRuntimeEvent('wrong-machine', event);
    fleet.handleRuntimeEvent(enrolled.machineId, { ...event, operationKey: 'wrong-operation' });
    expect(events).toEqual([event]);
    fleet.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { events: [{ ...event, type: 'tool.call.started' }] }, occurredAt: now });
    expect(events).toHaveLength(2);
    fleet.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { events: [{ ...event, type: 'tool.call.started' }] }, occurredAt: now });
    expect(events).toHaveLength(2);
  });

  it('retains durable terminal events beyond the transient array bound', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-fallback-command', operationKey: 'runtime-fallback-operation', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-fallback-session', message: 'hello',
    };
    fleet.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const transient = Array.from({ length: 130 }, (_, index) => ({
      type: 'message.delta', eventKind: 'message.delta', eventId: `fallback-transient-${index}`, sequence: index + 1, occurredAt: now,
    }));
    const durable = [
      { type: 'approval.requested', eventKind: 'approval.requested', eventId: 'fallback-approval', sequence: 131, occurredAt: now },
      { type: 'tool.call.started', eventKind: 'tool.call.started', eventId: 'fallback-tool-start', sequence: 132, occurredAt: now },
      { type: 'tool.call.completed', eventKind: 'tool.call.completed', eventId: 'fallback-tool-complete', sequence: 133, occurredAt: now },
    ];
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey,
      state: 'completed', result: { events: [...transient, ...durable] }, occurredAt: now,
    });
    const stored = fleet.getCommand(enrolled.machineId, command.operationKey);
    expect(stored?.state).toBe('completed');
    const events = (stored?.result as Record<string, unknown> | undefined)?.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(133);
    expect(events.slice(-3).map((event) => event.eventId)).toEqual(['fallback-approval', 'fallback-tool-start', 'fallback-tool-complete']);
  });

  it('marks terminal status uncertain when durable event fallbacks exceed the frame budget', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-overflow-command', operationKey: 'runtime-overflow-operation', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-overflow-session', message: 'hello',
    };
    fleet.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const events = Array.from({ length: 300 }, (_, index) => ({
      type: 'tool.call.completed', eventKind: 'tool.call.completed', eventId: `fallback-overflow-${index}`, sequence: index + 1, details: 'x'.repeat(5_000),
    }));
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey,
      state: 'completed', result: { events }, occurredAt: now,
    });
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)).toMatchObject({
      state: 'uncertain',
      result: undefined,
      error: 'Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely',
    });
  });

  it('strips raw artifact content from terminal command results', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date().toISOString();
    const command = {
      commandId: 'command-artifact',
      operationKey: 'operation-artifact',
      issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'read_session_artifact' as const,
      repositoryId: 'repository-artifact',
      relativePath: 'logs/session.json',
      maxBytes: 1_024,
    };
    fleet.database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    fleet.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { encoding: 'base64', byteLength: 24, relativePath: command.relativePath, content: Buffer.from('private runtime output').toString('base64'), stdout: 'private stdout', text: 'safe model text' },
      occurredAt: now,
    });
    const result = fleet.getCommand(enrolled.machineId, command.operationKey)?.result;
    expect(result).toEqual({ repositoryId: command.repositoryId, relativePath: command.relativePath, encoding: 'base64', byteLength: 24 });
    expect(JSON.stringify(result)).not.toContain('private runtime output');
  });

  it('catches revoked-machine errors in message callbacks and closes safely', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    class FakeSocket extends EventEmitter {
      readyState = 1;
      readonly closes: Array<[number, string]> = [];
      send(_value: string): void { /* noop */ }
      close(code = 1000, reason = ''): void { this.closes.push([code, reason]); this.readyState = 3; }
    }
    const socket = new FakeSocket();
    handleNodeConnection(socket as never, fleet, { credential: enrolled.credential });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', protocol: 'dhole.node.v1', machineId: enrolled.machineId, daemonVersion: 'test', journalOperations: [] })));
    fleet.database.prepare("UPDATE machines SET status = 'revoked' WHERE id = ?").run(enrolled.machineId);
    expect(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat', protocol: 'dhole.node.v1', sentAt: new Date().toISOString(), availableSlots: 1, runtimes: [] })))).not.toThrow();
    expect(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'command_status', protocol: 'dhole.node.v1', commandId: 'missing', operationKey: 'missing', state: 'failed', occurredAt: new Date().toISOString() })))).not.toThrow();
    expect(socket.closes.some(([code]) => code === 4003)).toBe(true);
  });

  it('closes the active node transport when replacing its credential', () => {
    const fleet = setup();
    const enrolled = enrolledMachine(fleet);
    const socket = {
      readyState: 1,
      closed: false,
      send: () => undefined,
      close: () => { socket.closed = true; socket.readyState = 3; },
    } as never as { readyState: number; closed: boolean; send: (value: string) => void; close: () => void };
    fleet.attachConnection(enrolled.machineId, socket as never);
    const replacement = fleet.replaceDeviceCredential(enrolled.machineId);
    expect(socket.closed).toBe(true);
    expect(fleet.connection(enrolled.machineId)).toBeUndefined();
    expect(fleet.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(false);
    expect(fleet.authenticateNode(enrolled.machineId, replacement.credential)).toBe(true);
  });

  it('never returns replacement credentials to cookie callers, but allows fleet-admin bearer operators', async () => {
    const { app, fleet, database, machineId, cookie, bearer } = setupHttp();
    const cookieResponse = await app.request(`/api/fleet/machines/${machineId}/credential/replace`, { method: 'POST', headers: { cookie } });
    expect(cookieResponse.status).toBe(403);
    const cookieBody = await cookieResponse.json() as Record<string, unknown>;
    expect(JSON.stringify(cookieBody)).not.toContain('credential');

    const bearerResponse = await app.request(`/api/fleet/machines/${machineId}/credential/replace`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
    expect(bearerResponse.status).toBe(200);
    const body = await bearerResponse.json() as { credential?: string };
    expect(typeof body.credential).toBe('string');
    expect(body.credential).not.toBeUndefined();
    const rawCredential = body.credential as string;
    const auditJson = JSON.stringify(database.prepare('SELECT * FROM audit_records').all());
    const eventJson = JSON.stringify(database.prepare('SELECT * FROM event_log').all());
    const credentialJson = JSON.stringify(database.prepare('SELECT credential_hash FROM device_credentials').all());
    expect(auditJson).not.toContain(rawCredential);
    expect(eventJson).not.toContain(rawCredential);
    expect(credentialJson).not.toContain(rawCredential);
    expect(JSON.stringify(fleet.listCommands(machineId))).not.toContain(rawCredential);
  });

  it('audits enrollment, credential, and allowlist mutations without secrets', () => {
    const fleet = setup();
    const at = new Date().toISOString();
    fleet.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-audit', 'team-1', 'Audit Project', 'user-1', at, at);
    fleet.database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-audit', 'project-audit', 'Audit Repository', 'user-1', at, at);
    const issued = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'audited-node', createdBy: 'user-1' });
    const enrolled = fleet.consumeEnrollmentToken(issued.token);
    const revocable = fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'revocable', createdBy: 'user-1' });
    fleet.revokeEnrollmentToken(revocable.id, 'user-1');
    fleet.addRepositoryAllowlist(enrolled.machineId, 'repository-audit', '/srv/audited-node', 'user-1');
    fleet.removeRepositoryAllowlist(enrolled.machineId, 'repository-audit', 'user-1');
    const replacement = fleet.replaceDeviceCredential(enrolled.machineId, 'user-1');
    const rows = fleet.database.prepare('SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records ORDER BY rowid').all() as Array<{ actor_type: string; actor_id: string | null; action: string; target_type: string; target_id: string | null; detail_json: string }>;
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      'enrollment_token.issued',
      'enrollment_token.consumed',
      'enrollment_token.revoked',
      'repository_allowlist.added',
      'repository_allowlist.removed',
      'device_credential.revoked',
      'device_credential.replaced',
    ]));
    expect(rows.find((row) => row.action === 'enrollment_token.issued')).toMatchObject({ actor_type: 'user', actor_id: 'user-1', target_type: 'enrollment_token' });
    expect(rows.find((row) => row.action === 'enrollment_token.consumed')).toMatchObject({ actor_type: 'system', actor_id: null });
    const auditText = JSON.stringify(rows);
    expect(auditText).not.toContain(issued.token);
    expect(auditText).not.toContain(enrolled.credential);
    expect(auditText).not.toContain(replacement.credential);
  });

  it('rolls back terminal command completion when its runtime-event reducer fails', () => {
    const fleet = setupWithEvents();
    const enrolled = enrolledMachine(fleet);
    const now = new Date().toISOString();
    const command = {
      commandId: 'command-reducer-failure',
      operationKey: 'operation-reducer-failure',
      issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'report_health' as const,
    };
    fleet.database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    fleet.setRuntimeEventHandler(() => { throw new Error('runtime reducer failed'); });
    const runtimeEvent = { type: 'runtime_event' as const, protocol: 'dhole.node.v1' as const, commandId: command.commandId, operationKey: command.operationKey, sequence: 1, eventId: 'terminal-reducer-event', eventKind: 'tool.call.completed', payload: { name: 'safe' }, occurredAt: now };
    expect(() => fleet.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { events: [runtimeEvent] },
      occurredAt: now,
    })).toThrow('runtime reducer failed');
    expect(fleet.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect((fleet.database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'command.completed'").get() as { count: number }).count).toBe(0);
  });

  it('rolls back Fleet mutations when audit insertion fails', () => {
    const fleet = setup();
    fleet.database.exec(`CREATE TRIGGER block_fleet_issue_audit BEFORE INSERT ON audit_records WHEN new.action = 'enrollment_token.issued' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);
    expect(() => fleet.issueEnrollmentToken({ teamId: 'team-1', label: 'rollback-node', createdBy: 'user-1' })).toThrow('audit blocked');
    expect((fleet.database.prepare('SELECT count(*) AS count FROM node_enrollment_tokens').get() as { count: number }).count).toBe(0);

    fleet.database.exec('DROP TRIGGER block_fleet_issue_audit');
    const enrolled = enrolledMachine(fleet);
    const at = new Date().toISOString();
    fleet.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-rollback', 'team-1', 'Rollback Project', 'user-1', at, at);
    fleet.database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-rollback', 'project-rollback', 'Rollback Repository', 'user-1', at, at);
    fleet.database.exec(`CREATE TRIGGER block_fleet_allowlist_audit BEFORE INSERT ON audit_records WHEN new.action = 'repository_allowlist.added' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);
    expect(() => fleet.addRepositoryAllowlist(enrolled.machineId, 'repository-rollback', '/srv/rollback-node', 'user-1')).toThrow('audit blocked');
    expect((fleet.database.prepare('SELECT count(*) AS count FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').get(enrolled.machineId, 'repository-rollback') as { count: number }).count).toBe(0);
  });
});
