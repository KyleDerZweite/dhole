import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { NodeRuntimeEvent } from '@dhole-control/shared';
import { openDatabase } from '../../../lib/database.js';
import { secureIds, systemClock } from '../../../lib/clock.js';
import { EventStore } from '../../../lib/events.js';
import { HttpError } from '../../../lib/http.js';
import { notifySessionAuthorizationChanged } from '../../../lib/session-auth.js';
import { hashToken } from '../../../lib/security.js';
import type { DholeApp, ServerContext } from '../../../lib/module.js';
import { accessModule } from '../../access/index.js';
import { MachineError, MachineService, authenticateNodeCredential, bearerCredential, createMachineService, registerMachineRoutes, handleNodeConnection } from './index.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(): MachineService {
  const database = openDatabase(':memory:', systemClock);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', new Date().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', new Date().toISOString(), new Date().toISOString());
  return new MachineService(database, systemClock, secureIds);
}

function setupWithEvents(): MachineService {
  const database = openDatabase(':memory:', systemClock);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', new Date().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.invalid', 'User', 'test', new Date().toISOString(), new Date().toISOString());
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', new Date().toISOString(), new Date().toISOString());
  return new MachineService(database, systemClock, secureIds, {}, new EventStore(database, systemClock, secureIds));
}

function setupHttp(): { app: DholeApp; machines: MachineService; context: ServerContext; database: ReturnType<typeof openDatabase>; machineId: string; cookie: string; bearer: string } {
  const database = openDatabase(':memory:', systemClock);
  const now = systemClock.now().toISOString();
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-http', 'Team', now);
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-http', 'http@example.invalid', 'HTTP Admin', 'test', now, now);
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, \'administrator\', ?)').run('team-http', 'user-http', now);
  database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-http', 'team-http', 'Project', 'user-http', now, now);
  const events = new EventStore(database, systemClock, secureIds);
  const context = { config: { environment: 'test' } as ServerContext['config'], database, clock: systemClock, ids: secureIds, events } satisfies ServerContext;
  const machines = createMachineService(context);
  const device = machines.consumeEnrollmentToken(machines.issueEnrollmentToken({ teamId: 'team-http', label: 'http-node', createdBy: 'user-http' }).token);
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
  registerMachineRoutes(app, context);
  app.onError((error, c) => error instanceof MachineError || error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status as 400 | 401 | 403 | 404 | 409 | 422) : c.json({ error: { code: 'internal_error' } }, 500));
  return { app, machines, context, database, machineId: device.machineId, cookie: 'dhole_session=cookie-session', bearer };
}

function enrolledMachine(machines: MachineService): { machineId: string; credential: string } {
  const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
  const enrolled = machines.consumeEnrollmentToken(issued.token);
  return { machineId: enrolled.machineId, credential: enrolled.credential };
}

describe('machines enrollment and command durability', () => {
  it('keeps offline demo fixtures readable for a full day before marking them stale', () => {
    let now = new Date('2026-08-31T00:00:00.000Z');
    const clock = { now: () => now };
    const database = openDatabase(':memory:', clock);
    const events = new EventStore(database, clock, secureIds);
    const context = { config: { demo: true } as ServerContext['config'], database, clock, ids: secureIds, events } satisfies ServerContext;
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('demo-team', 'Demo', now.toISOString());
    database.prepare("INSERT INTO machines(id, team_id, name, status, last_heartbeat_at, created_at, updated_at) VALUES ('demo-machine','demo-team','Demo fixture','connected',?,?,?)").run(now.toISOString(), now.toISOString(), now.toISOString());
    const machines = createMachineService(context);
    now = new Date('2026-08-31T23:59:00.000Z');
    expect(machines.markStale()).toBe(0);
    now = new Date('2026-09-01T00:01:00.000Z');
    expect(machines.markStale()).toBe(1);
    database.close();
  });

  it('hashes enrollment tokens and denies reuse', () => {
    const machines = setup();
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    expect(enrolled.credential).not.toBe(issued.token);
    expect(machines.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(true);
    expect(() => machines.consumeEnrollmentToken(issued.token)).toThrow(MachineError);
  });

  it('authenticates the replaceable credential from a Bearer header', () => {
    const machines = setup();
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    expect(bearerCredential(`Bearer ${enrolled.credential}`)).toBe(enrolled.credential);
    expect(authenticateNodeCredential(machines, enrolled.machineId, `Bearer ${enrolled.credential}`)).toBe(true);
    expect(authenticateNodeCredential(machines, enrolled.machineId, 'Bearer wrong-credential')).toBe(false);
  });

  it('deduplicates commands by operation key and retains state on reconnect', () => {
    const machines = setup();
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    const now = new Date();
    const command = { commandId: secureIds.id(), operationKey: `operation-${secureIds.id()}`, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    const first = machines.enqueueCommand(enrolled.machineId, command);
    const second = machines.enqueueCommand(enrolled.machineId, command);
    expect(second.id).toBe(first.id);
    expect(machines.listCommands(enrolled.machineId)).toHaveLength(1);
  });

  it('enforces repository allowlists and correlates status by the wire command id', () => {
    const machines = setup();
    const database = machines.database;
    const at = new Date().toISOString();
    database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', 'user-1', at, at);
    database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-1', 'project-1', 'Repository', 'user-1', at, at);
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
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
    expect(() => machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command })).toThrow(MachineError);
    machines.addRepositoryAllowlist(enrolled.machineId, 'repository-1', '/configured/on/node');
    const queued = machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command });
    expect(queued.id).toBe(command.commandId);
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { runtimeSessionId: 'runtime-session-1' },
      occurredAt: new Date().toISOString(),
    });
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('completed');
    database.prepare("UPDATE node_commands SET state = 'cancelled' WHERE machine_id = ? AND operation_key = ?").run(enrolled.machineId, command.operationKey);
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { late: true },
      occurredAt: new Date().toISOString(),
    });
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('cancelled');
  });

  it('tracks disconnect and reconnect status', () => {
    const machines = setup();
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    const socket = { readyState: 1, send: () => undefined, on: () => socket, close: () => undefined } as never;
    machines.attachConnection(enrolled.machineId, socket);
    expect(machines.getMachine(enrolled.machineId)?.status).toBe('connected');
    machines.disconnect(enrolled.machineId, socket);
    expect(machines.getMachine(enrolled.machineId)?.status).toBe('disconnected');
    const audit = machines.database.prepare("SELECT action, project_id FROM audit_records WHERE target_id = ? ORDER BY occurred_at").all(enrolled.machineId) as Array<{ action: string; project_id: string | null }>;
    expect(audit.map((entry) => entry.action)).toEqual(['machine.connected', 'machine.disconnected']);
    expect(audit.every((entry) => entry.project_id === null)).toBe(true);
  });

  it('marks runtimes missing from the latest heartbeat unavailable', () => {
    const machines = setup();
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'builder', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    machines.heartbeat(enrolled.machineId, 1, [{
      id: 'runtime-fake',
      kind: 'fake',
      label: 'Fake',
      protocolVersion: 'fixture.v1',
      capabilities: {},
      availability: { available: true },
    }]);
    expect((machines.database.prepare('SELECT available FROM runtime_registrations WHERE machine_id = ?').get(enrolled.machineId) as { available: number }).available).toBe(1);
    machines.heartbeat(enrolled.machineId, 1, []);
    expect((machines.database.prepare('SELECT available FROM runtime_registrations WHERE machine_id = ?').get(enrolled.machineId) as { available: number }).available).toBe(0);
  });

  it('leaves commands queued when a socket closes or throws during send', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    let readyState = 1;
    const sent: string[] = [];
    let sends = 0;
    const socket = {
      get readyState() { return readyState; },
      send(value: string) { sent.push(value); sends += 1; if (sends > 2) { readyState = 3; throw new Error('socket closed'); } },
      close() { readyState = 3; },
    } as never;
    machines.attachConnection(enrolled.machineId, socket);
    const now = new Date();
    const command = { commandId: 'command-transport', operationKey: 'operation-transport', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => machines.enqueueCommand(enrolled.machineId, command)).not.toThrow();
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.attemptCount).toBe(0);
    expect(sent.some((frame) => frame.includes('report_health'))).toBe(true);
  });

  it('leaves commands queued when the socket closes without throwing', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    let readyState = 1;
    let sends = 0;
    const socket = {
      get readyState() { return readyState; },
      send(_value: string) { sends += 1; if (sends > 2) readyState = 3; },
      close() { readyState = 3; },
    } as never;
    machines.attachConnection(enrolled.machineId, socket);
    const now = new Date();
    const command = { commandId: 'command-close', operationKey: 'operation-close', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => machines.enqueueCommand(enrolled.machineId, command)).not.toThrow();
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.attemptCount).toBe(0);
  });

  it('retires pending orchestration delivery while preserving uncertain outcomes and Core commands', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const at = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    for (const state of ['queued', 'delivered', 'accepted', 'running', 'uncertain']) {
      const commandId = `command-${state}`;
      const operationKey = `orchestration:legacy:work:${state}`;
      machines.database.prepare("INSERT INTO node_commands(id, machine_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, 'report_health', ?, ?, ?, ?, ?)").run(commandId, enrolled.machineId, operationKey, JSON.stringify({ commandId, operationKey, issuedAt: at, expiresAt, kind: 'report_health' }), state, at, expiresAt, at);
    }
    machines.enqueueCommand(enrolled.machineId, { commandId: 'core-command', operationKey: 'core-health', issuedAt: at, expiresAt, kind: 'report_health' });
    const sent: Array<{ type?: string; command?: { operationKey: string } }> = [];
    const socket = { readyState: 1, send(value: string) { sent.push(JSON.parse(value)); }, close() { /* noop */ } } as never;
    machines.attachConnection(enrolled.machineId, socket);
    expect(machines.getCommand(enrolled.machineId, 'orchestration:legacy:work:queued')?.state).toBe('cancelled');
    for (const state of ['delivered', 'accepted', 'running', 'uncertain']) {
      expect(machines.getCommand(enrolled.machineId, `orchestration:legacy:work:${state}`)?.state).toBe(state);
    }
    expect(sent.filter((message) => message.type === 'command').map((message) => message.command?.operationKey)).toEqual(['core-health']);
  });

  it.each(['completed', 'failed'] as const)('reconciles a queued retired command reported %s by the node journal', (state) => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const at = new Date().toISOString();
    const command = { commandId: 'legacy-terminal', operationKey: 'orchestration:legacy:work:terminal', issuedAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'report_health' as const };
    machines.enqueueCommand(enrolled.machineId, command);
    const sent: Array<{ type?: string }> = [];
    const socket = { readyState: 1, send(value: string) { sent.push(JSON.parse(value)); }, close() { /* noop */ } } as never;
    machines.attachConnection(enrolled.machineId, socket, [{ operationKey: command.operationKey, state }]);
    machines.deliverPending(enrolled.machineId);
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('uncertain');
    expect(sent.some((message) => message.type === 'command')).toBe(false);
    machines.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state, occurredAt: at, result: { healthy: state === 'completed' } });
    expect(machines.getCommand(enrolled.machineId, command.operationKey)).toMatchObject({ state, result: { healthy: state === 'completed' } });
  });

  it('does not let historical orchestration commands starve Core delivery', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const at = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const insert = machines.database.prepare("INSERT INTO node_commands(id, machine_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, 'report_health', ?, 'accepted', ?, ?, ?)");
    for (let index = 0; index < 100; index += 1) {
      const commandId = `historical-${index}`;
      const operationKey = `orchestration:legacy:work:${index}`;
      insert.run(commandId, enrolled.machineId, operationKey, JSON.stringify({ commandId, operationKey, issuedAt: at, expiresAt, kind: 'report_health' }), '2000-01-01T00:00:00.000Z', expiresAt, at);
    }
    machines.enqueueCommand(enrolled.machineId, { commandId: 'core-command', operationKey: 'core-health', issuedAt: at, expiresAt, kind: 'report_health' });
    const sent: Array<{ type?: string; command?: { operationKey: string } }> = [];
    const socket = { readyState: 1, send(value: string) { sent.push(JSON.parse(value)); }, close() { /* noop */ } } as never;
    machines.attachConnection(enrolled.machineId, socket);
    expect(sent.filter((message) => message.type === 'command').map((message) => message.command?.operationKey)).toEqual(['core-health']);
    expect((machines.database.prepare("SELECT COUNT(*) AS count FROM node_commands WHERE state = 'accepted'").get() as { count: number }).count).toBe(100);
  });

  it('does not expire or redeliver an uncertain command after its TTL', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const now = new Date();
    const command = { commandId: 'command-uncertain', operationKey: 'operation-uncertain', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    machines.enqueueCommand(enrolled.machineId, command);
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'uncertain',
      occurredAt: now.toISOString(),
    });
    machines.database.prepare("UPDATE node_commands SET expires_at = '2000-01-01T00:00:00.000Z' WHERE machine_id = ? AND operation_key = ?").run(enrolled.machineId, command.operationKey);
    const sent: string[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(value); }, close() { /* noop */ } } as never;
    machines.attachConnection(enrolled.machineId, socket);
    machines.deliverPending(enrolled.machineId);
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('uncertain');
    expect(sent.some((frame) => JSON.parse(frame).type === 'command')).toBe(false);
  });

  it('does not send a command before an outer transaction commits', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const sent: string[] = [];
    const socket = { readyState: 1, send(value: string) { sent.push(value); }, close() { /* noop */ } } as never;
    machines.attachConnection(enrolled.machineId, socket);
    const baseline = sent.length;
    const now = new Date();
    const command = { commandId: 'command-rollback', operationKey: 'operation-rollback', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    expect(() => machines.database.transaction(() => {
      machines.enqueueCommand(enrolled.machineId, command);
      expect(sent).toHaveLength(baseline);
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(machines.getCommand(enrolled.machineId, command.operationKey)).toBeUndefined();
    expect(sent).toHaveLength(baseline);
  });

  it('rejects operation-key aliases and records scoped command lifecycle events', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date();
    const command = { commandId: 'command-events', operationKey: 'operation-events', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), kind: 'report_health' as const };
    machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command });
    expect(() => machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command: { ...command, commandId: 'command-alias' } })).toThrow(MachineError);
    machines.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'accepted', occurredAt: now.toISOString() });
    machines.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { nested: { apiKey: 'sk-secretsecret' }, output: 'ok' }, occurredAt: now.toISOString() });
    const events = machines.database.prepare('SELECT event_kind, payload_json FROM event_log WHERE project_id = ? ORDER BY project_sequence').all('project-1') as Array<{ event_kind: string; payload_json: string }>;
    expect(events.map((event) => event.event_kind)).toEqual(['command.queued', 'command.acknowledged', 'command.completed']);
    expect(events[2]?.payload_json).not.toContain('sk-secretsecret');
    const stored = machines.getCommand(enrolled.machineId, command.operationKey);
    expect(JSON.stringify(stored?.result)).not.toContain('sk-secretsecret');
  });

  it('correlates runtime events to the authenticated machine and durable command', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-command-1', operationKey: 'runtime-operation-1', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-session-1', message: 'hello',
    };
    machines.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const events: NodeRuntimeEvent[] = [];
    machines.setRuntimeEventHandler(({ event }) => events.push(event));
    const event = { type: 'runtime_event' as const, protocol: 'dhole.node.v1' as const, commandId: command.commandId, operationKey: command.operationKey, sequence: 1, eventId: 'runtime-event-1', eventKind: 'tool.call.started', payload: { name: 'safe' }, occurredAt: now };
    machines.handleRuntimeEvent(enrolled.machineId, event);
    machines.handleRuntimeEvent('wrong-machine', event);
    machines.handleRuntimeEvent(enrolled.machineId, { ...event, operationKey: 'wrong-operation' });
    expect(events).toEqual([event]);
    machines.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { events: [{ ...event, type: 'tool.call.started' }] }, occurredAt: now });
    expect(events).toHaveLength(2);
    machines.handleStatus(enrolled.machineId, { type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey, state: 'completed', result: { events: [{ ...event, type: 'tool.call.started' }] }, occurredAt: now });
    expect(events).toHaveLength(2);
  });

  it('retains durable terminal events beyond the transient array bound', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-fallback-command', operationKey: 'runtime-fallback-operation', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-fallback-session', message: 'hello',
    };
    machines.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const transient = Array.from({ length: 130 }, (_, index) => ({
      type: 'message.delta', eventKind: 'message.delta', eventId: `fallback-transient-${index}`, sequence: index + 1, occurredAt: now,
    }));
    const durable = [
      { type: 'approval.requested', eventKind: 'approval.requested', eventId: 'fallback-approval', sequence: 131, occurredAt: now },
      { type: 'tool.call.started', eventKind: 'tool.call.started', eventId: 'fallback-tool-start', sequence: 132, occurredAt: now },
      { type: 'tool.call.completed', eventKind: 'tool.call.completed', eventId: 'fallback-tool-complete', sequence: 133, occurredAt: now },
    ];
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey,
      state: 'completed', result: { events: [...transient, ...durable] }, occurredAt: now,
    });
    const stored = machines.getCommand(enrolled.machineId, command.operationKey);
    expect(stored?.state).toBe('completed');
    const events = (stored?.result as Record<string, unknown> | undefined)?.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(133);
    expect(events.slice(-3).map((event) => event.eventId)).toEqual(['fallback-approval', 'fallback-tool-start', 'fallback-tool-complete']);
  });

  it('marks terminal status uncertain when durable event fallbacks exceed the frame budget', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date().toISOString();
    const command = {
      commandId: 'runtime-overflow-command', operationKey: 'runtime-overflow-operation', issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'send_message' as const,
      runtimeSessionId: 'native-overflow-session', message: 'hello',
    };
    machines.database.prepare(`INSERT INTO node_commands(id,machine_id,project_id,operation_key,kind,payload_json,state,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    const events = Array.from({ length: 300 }, (_, index) => ({
      type: 'tool.call.completed', eventKind: 'tool.call.completed', eventId: `fallback-overflow-${index}`, sequence: index + 1, details: 'x'.repeat(5_000),
    }));
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status', protocol: 'dhole.node.v1', commandId: command.commandId, operationKey: command.operationKey,
      state: 'completed', result: { events }, occurredAt: now,
    });
    expect(machines.getCommand(enrolled.machineId, command.operationKey)).toMatchObject({
      state: 'uncertain',
      result: undefined,
      error: 'Terminal runtime result exceeds frame limit; durable runtime events cannot be represented safely',
    });
  });

  it('strips raw artifact content from terminal command results', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
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
    machines.database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    machines.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { encoding: 'base64', byteLength: 24, relativePath: command.relativePath, content: Buffer.from('private runtime output').toString('base64'), stdout: 'private stdout', text: 'safe model text' },
      occurredAt: now,
    });
    const result = machines.getCommand(enrolled.machineId, command.operationKey)?.result;
    expect(result).toEqual({ repositoryId: command.repositoryId, relativePath: command.relativePath, encoding: 'base64', byteLength: 24 });
    expect(JSON.stringify(result)).not.toContain('private runtime output');
  });

  it('catches revoked-machine errors in message callbacks and closes safely', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    class FakeSocket extends EventEmitter {
      readyState = 1;
      readonly closes: Array<[number, string]> = [];
      send(_value: string): void { /* noop */ }
      close(code = 1000, reason = ''): void { this.closes.push([code, reason]); this.readyState = 3; }
    }
    const socket = new FakeSocket();
    handleNodeConnection(socket as never, machines, { credential: enrolled.credential });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', protocol: 'dhole.node.v1', machineId: enrolled.machineId, daemonVersion: 'test', journalOperations: [] })));
    machines.database.prepare("UPDATE machines SET status = 'revoked' WHERE id = ?").run(enrolled.machineId);
    expect(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat', protocol: 'dhole.node.v1', sentAt: new Date().toISOString(), availableSlots: 1, runtimes: [] })))).not.toThrow();
    expect(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'command_status', protocol: 'dhole.node.v1', commandId: 'missing', operationKey: 'missing', state: 'failed', occurredAt: new Date().toISOString() })))).not.toThrow();
    expect(socket.closes.some(([code]) => code === 4003)).toBe(true);
  });

  it('closes the active node transport when replacing its credential', () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const socket = {
      readyState: 1,
      closed: false,
      send: () => undefined,
      close: () => { socket.closed = true; socket.readyState = 3; },
    } as never as { readyState: number; closed: boolean; send: (value: string) => void; close: () => void };
    machines.attachConnection(enrolled.machineId, socket as never);
    const replacement = machines.replaceDeviceCredential(enrolled.machineId);
    expect(socket.closed).toBe(true);
    expect(machines.connection(enrolled.machineId)).toBeUndefined();
    expect(machines.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(false);
    expect(machines.authenticateNode(enrolled.machineId, replacement.credential)).toBe(true);
  });

  it('revokes live and future node access without changing command history', () => {
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date().toISOString();
    const command = { commandId: 'revoke-command', operationKey: 'revoke-operation', kind: 'report_health' as const, issuedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command });
    class FakeSocket extends EventEmitter {
      readyState = 1;
      readonly closes: number[] = [];
      readonly sent: string[] = [];
      send(value: string): void { this.sent.push(value); }
      close(code = 1000): void { this.closes.push(code); this.readyState = 3; this.emit('close'); }
    }
    const hello = Buffer.from(JSON.stringify({ type: 'hello', protocol: 'dhole.node.v1', machineId: enrolled.machineId, daemonVersion: 'test', journalOperations: [] }));
    const socket = new FakeSocket();
    handleNodeConnection(socket as never, machines, { credential: enrolled.credential });
    socket.emit('message', hello);
    const history = machines.database.prepare('SELECT * FROM node_commands').all();
    const events = machines.database.prepare('SELECT * FROM event_log').all();
    machines.revokeMachine(enrolled.machineId, 'user-1');
    const firstRevocation = machines.getMachine(enrolled.machineId);
    machines.revokeMachine(enrolled.machineId, 'user-1');
    expect(machines.getMachine(enrolled.machineId)).toEqual(firstRevocation);
    expect(firstRevocation).toMatchObject({ status: 'revoked', available_slots: 0 });
    expect(socket.closes).toEqual([4003]);
    expect(machines.connection(enrolled.machineId)).toBeUndefined();
    expect(machines.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(false);
    expect(machines.database.prepare('SELECT count(*) AS count FROM device_credentials WHERE machine_id = ? AND revoked_at IS NULL').get(enrolled.machineId)).toEqual({ count: 0 });
    expect(() => machines.replaceDeviceCredential(enrolled.machineId, 'user-1')).toThrow('Machine has been revoked');
    expect(() => machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command: { ...command, commandId: 'new-command', operationKey: 'new-operation' } })).toThrow('Machine has been revoked');
    expect(machines.enqueueCommand({ machineId: enrolled.machineId, projectId: 'project-1', command }).id).toBe(command.commandId);
    expect(() => machines.attachConnection(enrolled.machineId, new FakeSocket() as never)).toThrow('Machine has been revoked');
    const reconnect = new FakeSocket();
    handleNodeConnection(reconnect as never, machines, { credential: enrolled.credential });
    reconnect.emit('message', hello);
    expect(reconnect.closes).toEqual([4003]);
    expect(reconnect.sent).toEqual([]);
    expect(machines.database.prepare('SELECT * FROM node_commands').all()).toEqual(history);
    expect(machines.database.prepare('SELECT * FROM event_log').all()).toEqual(events);
    const audit = machines.database.prepare("SELECT * FROM audit_records WHERE action IN ('machine.revoked', 'device_credential.revoked')").all();
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(enrolled.credential);
  });

  it('keeps the transport and credentials when a revocation transaction rolls back', async () => {
    const machines = setup();
    const enrolled = enrolledMachine(machines);
    const socket = { readyState: 1, send: () => undefined, close: () => { socket.readyState = 3; } };
    machines.attachConnection(enrolled.machineId, socket as never);
    expect(() => machines.database.transaction(() => {
      machines.revokeMachine(enrolled.machineId, 'user-1');
      throw new Error('outer rollback');
    })()).toThrow('outer rollback');
    await Promise.resolve();
    expect(machines.authenticateNode(enrolled.machineId, enrolled.credential)).toBe(true);
    expect(machines.connection(enrolled.machineId)?.socket).toBe(socket);
    expect(socket.readyState).toBe(1);
    machines.database.transaction(() => machines.revokeMachine(enrolled.machineId, 'user-1'))();
    await Promise.resolve();
    expect(socket.readyState).toBe(3);
    expect(machines.connection(enrolled.machineId)).toBeUndefined();
  });

  it.each(['frame', 'delivery', 'notification'] as const)('ends active node access on %s when its parent authorization ends', (boundary) => {
    const { machines, context, machineId } = setupHttp();
    let allowed = true;
    machines.setMachineAuthorizationCheck(() => allowed);
    const { credential } = machines.replaceDeviceCredential(machineId);
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send(_value: string): void { /* noop */ }
      close(): void { this.readyState = 3; this.emit('close'); }
    }
    const socket = new FakeSocket();
    handleNodeConnection(socket as never, machines, { credential });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', protocol: 'dhole.node.v1', machineId, daemonVersion: 'test', journalOperations: [] })));
    expect(machines.connection(machineId)?.socket).toBe(socket);
    allowed = false;
    expect(machines.authenticateNode(machineId, credential)).toBe(false);
    expect(() => machines.replaceDeviceCredential(machineId)).toThrow('Machine authorization has ended');
    const now = new Date().toISOString();
    expect(() => machines.enqueueCommand(machineId, { commandId: 'rejected-command', operationKey: 'rejected-operation', kind: 'report_health', issuedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() })).toThrow('Machine authorization has ended');
    if (boundary === 'frame') socket.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat', protocol: 'dhole.node.v1', sentAt: now, availableSlots: 1, runtimes: [] })));
    else if (boundary === 'delivery') machines.deliverPending(machineId);
    else notifySessionAuthorizationChanged(context);
    expect(socket.readyState).toBe(3);
    expect(machines.connection(machineId)).toBeUndefined();
    expect(machines.getMachine(machineId)?.status).toBe('disconnected');
  });

  it('allows administrators to revoke only machines in their team', async () => {
    const { app, machines, database, machineId, cookie } = setupHttp();
    const at = new Date().toISOString();
    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('other-team', 'Other', at);
    const other = machines.consumeEnrollmentToken(machines.issueEnrollmentToken({ teamId: 'other-team', label: 'Other machine', createdBy: 'user-http' }).token);
    expect((await app.request(`/api/machines/${machineId}/revoke`, { method: 'POST' })).status).toBe(401);
    expect((await app.request(`/api/machines/${other.machineId}/revoke`, { method: 'POST', headers: { cookie } })).status).toBe(404);
    expect(machines.authenticateNode(other.machineId, other.credential)).toBe(true);
    const revoked = await app.request(`/api/machines/${machineId}/revoke`, { method: 'POST', headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
    expect(machines.getMachine(machineId)?.status).toBe('revoked');
    expect((await app.request(`/api/machines/${machineId}/revoke`, { method: 'POST', headers: { cookie } })).status).toBe(200);
  });

  it('never returns replacement credentials to cookie callers, but allows machines-admin bearer operators', async () => {
    const { app, machines, database, machineId, cookie, bearer } = setupHttp();
    const cookieResponse = await app.request(`/api/machines/${machineId}/credential/replace`, { method: 'POST', headers: { cookie } });
    expect(cookieResponse.status).toBe(403);
    const cookieBody = await cookieResponse.json() as Record<string, unknown>;
    expect(JSON.stringify(cookieBody)).not.toContain('credential');
    for (const browserHeaders of [{ cookie }, { origin: 'http://127.0.0.1:4173' }]) {
      const response = await app.request(`/api/machines/${machineId}/credential/replace`, { method: 'POST', headers: { ...browserHeaders, authorization: `Bearer ${bearer}` } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: 'api_token_required' } });
    }

    const bearerResponse = await app.request(`/api/machines/${machineId}/credential/replace`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
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
    expect(JSON.stringify(machines.listCommands(machineId))).not.toContain(rawCredential);
  });

  it('checks current project access before repository allowlists and manual commands', async () => {
    const { app, machines, database, machineId, cookie, bearer } = setupHttp();
    const at = new Date().toISOString();
    database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('http-repository', 'project-http', 'HTTP repository', 'user-http', at, at);
    const post = (path: string, body: unknown, authorization?: string) => app.request(`/api/machines/${machineId}/${path}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
    });
    const allowlist = { repositoryId: 'http-repository', canonicalRoot: '/fixture/repository' };
    expect((await post('allowlist', allowlist)).status).toBe(200);
    expect((await post('allowlist', allowlist, `Bearer ${bearer}`)).status).toBe(401);
    const command = { kind: 'create_runtime_session', runtimeId: 'fake', runtimeSessionKey: 'http-runtime', cwd: '.', commandId: 'http-command', operationKey: 'http-operation', issuedAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(), repositoryId: 'http-repository' };
    expect((await post('commands', { command, projectId: 'project-http' })).status).toBe(202);
    database.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(at, 'user-http');
    const before = database.prepare('SELECT * FROM node_commands').all();
    expect((await post('allowlist', { ...allowlist, canonicalRoot: '/another/repository' })).status).toBe(404);
    expect((await post('commands', { command: { ...command, commandId: 'denied-command', operationKey: 'denied-operation' } })).status).toBe(404);
    expect((await post('commands', { projectId: 'project-http', command: { kind: 'report_health', commandId: 'denied-health', operationKey: 'denied-health', issuedAt: at, expiresAt: command.expiresAt } })).status).toBe(404);
    expect(database.prepare('SELECT * FROM node_commands').all()).toEqual(before);
    expect(machines.database.prepare('SELECT canonical_root FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').get(machineId, 'http-repository')).toEqual({ canonical_root: '/fixture/repository' });
  });

  it('audits enrollment, credential, and allowlist mutations without secrets', () => {
    const machines = setup();
    const at = new Date().toISOString();
    machines.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-audit', 'team-1', 'Audit Project', 'user-1', at, at);
    machines.database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-audit', 'project-audit', 'Audit Repository', 'user-1', at, at);
    const issued = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'audited-node', createdBy: 'user-1' });
    const enrolled = machines.consumeEnrollmentToken(issued.token);
    const revocable = machines.issueEnrollmentToken({ teamId: 'team-1', label: 'revocable', createdBy: 'user-1' });
    machines.revokeEnrollmentToken(revocable.id, 'user-1');
    machines.addRepositoryAllowlist(enrolled.machineId, 'repository-audit', '/srv/audited-node', 'user-1');
    machines.removeRepositoryAllowlist(enrolled.machineId, 'repository-audit', 'user-1');
    const replacement = machines.replaceDeviceCredential(enrolled.machineId, 'user-1');
    const rows = machines.database.prepare('SELECT actor_type, actor_id, action, target_type, target_id, detail_json FROM audit_records ORDER BY rowid').all() as Array<{ actor_type: string; actor_id: string | null; action: string; target_type: string; target_id: string | null; detail_json: string }>;
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
    const machines = setupWithEvents();
    const enrolled = enrolledMachine(machines);
    const now = new Date().toISOString();
    const command = {
      commandId: 'command-reducer-failure',
      operationKey: 'operation-reducer-failure',
      issuedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'report_health' as const,
    };
    machines.database.prepare(`INSERT INTO node_commands(id, machine_id, project_id, operation_key, kind, payload_json, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(command.commandId, enrolled.machineId, 'project-1', command.operationKey, command.kind, JSON.stringify(command), now, command.expiresAt, now);
    machines.setRuntimeEventHandler(() => { throw new Error('runtime reducer failed'); });
    const runtimeEvent = { type: 'runtime_event' as const, protocol: 'dhole.node.v1' as const, commandId: command.commandId, operationKey: command.operationKey, sequence: 1, eventId: 'terminal-reducer-event', eventKind: 'tool.call.completed', payload: { name: 'safe' }, occurredAt: now };
    expect(() => machines.handleStatus(enrolled.machineId, {
      type: 'command_status',
      protocol: 'dhole.node.v1',
      commandId: command.commandId,
      operationKey: command.operationKey,
      state: 'completed',
      result: { events: [runtimeEvent] },
      occurredAt: now,
    })).toThrow('runtime reducer failed');
    expect(machines.getCommand(enrolled.machineId, command.operationKey)?.state).toBe('queued');
    expect((machines.database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'command.completed'").get() as { count: number }).count).toBe(0);
  });

  it('rolls back Machine mutations when audit insertion fails', () => {
    const machines = setup();
    machines.database.exec(`CREATE TRIGGER block_fleet_issue_audit BEFORE INSERT ON audit_records WHEN new.action = 'enrollment_token.issued' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);
    expect(() => machines.issueEnrollmentToken({ teamId: 'team-1', label: 'rollback-node', createdBy: 'user-1' })).toThrow('audit blocked');
    expect((machines.database.prepare('SELECT count(*) AS count FROM node_enrollment_tokens').get() as { count: number }).count).toBe(0);

    machines.database.exec('DROP TRIGGER block_fleet_issue_audit');
    const enrolled = enrolledMachine(machines);
    const at = new Date().toISOString();
    machines.database.prepare('INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-rollback', 'team-1', 'Rollback Project', 'user-1', at, at);
    machines.database.prepare('INSERT INTO repositories(id, project_id, label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('repository-rollback', 'project-rollback', 'Rollback Repository', 'user-1', at, at);
    machines.database.exec(`CREATE TRIGGER block_fleet_allowlist_audit BEFORE INSERT ON audit_records WHEN new.action = 'repository_allowlist.added' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);
    expect(() => machines.addRepositoryAllowlist(enrolled.machineId, 'repository-rollback', '/srv/rollback-node', 'user-1')).toThrow('audit blocked');
    expect((machines.database.prepare('SELECT count(*) AS count FROM machine_repository_allowlists WHERE machine_id = ? AND repository_id = ?').get(enrolled.machineId, 'repository-rollback') as { count: number }).count).toBe(0);
  });
});
