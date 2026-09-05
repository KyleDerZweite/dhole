import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureIds, systemClock } from '../apps/server/dist/lib/clock.js';
import { openDatabase } from '../apps/server/dist/lib/database.js';
import { EventStore } from '../apps/server/dist/lib/events.js';
import { MachineService, handleNodeConnection } from '../apps/server/dist/modules/core/machines/index.js';
import { SessionsService } from '../apps/server/dist/modules/core/sessions/service.js';
import { loadNodeConfig } from '../apps/node/dist/config.js';
import { FakeNode } from '../apps/node/dist/fake.js';
import { FakeRuntimeAdapter } from '../apps/node/dist/runtimes/fake.js';

const repository = mkdtempSync(join(tmpdir(), 'dhole-session-repository-'));
const state = mkdtempSync(join(tmpdir(), 'dhole-session-node-'));
const database = openDatabase(':memory:', systemClock);
const priorFakeRuntime = process.env.DHOLE_NODE_ENABLE_FAKE;
process.env.DHOLE_NODE_ENABLE_FAKE = 'true';
let node;
let detach;

const waitFor = async (predicate, message, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(typeof message === 'function' ? message() : message);
};

try {
  execFileSync('git', ['init', '-qb', 'main', repository]);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'session@example.test']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Dhole Session Smoke']);
  writeFileSync(join(repository, 'README.md'), 'session runtime fixture\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
  const at = new Date().toISOString();
  database.exec(`
    INSERT INTO teams(id,name,created_at) VALUES ('team','Team','${at}');
    INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES ('user','session@example.test','Session','fixture','${at}','${at}');
    INSERT INTO team_members(team_id,user_id,role,created_at) VALUES ('team','user','administrator','${at}');
    INSERT INTO projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('project','team','Project','user','${at}','${at}');
    INSERT INTO repositories(id,project_id,label,default_branch,created_by,created_at,updated_at) VALUES ('repository','project','Repository','main','user','${at}','${at}');
  `);
  const events = new EventStore(database, systemClock, secureIds);
  const context = { database, clock: systemClock, ids: secureIds, events, config: {} };
  const machines = new MachineService(database, systemClock, secureIds, {}, events);
  const enrollment = machines.issueEnrollmentToken({ teamId: 'team', label: 'session-node', createdBy: 'user' });
  const device = machines.consumeEnrollmentToken(enrollment.token);
  machines.addRepositoryAllowlist(device.machineId, 'repository', repository);
  const fakeRuntime = new FakeRuntimeAdapter();
  node = new FakeNode({ config: loadNodeConfig({ DHOLE_NODE_MACHINE_ID: device.machineId, DHOLE_NODE_CREDENTIAL: device.credential, DHOLE_NODE_STATE_DIR: state, DHOLE_NODE_REPOSITORIES: JSON.stringify({ repository }), DHOLE_NODE_ENABLE_FAKE: 'true' }), executor: { discoverRuntimes: () => [fakeRuntime.descriptor()] } });
  node.start();
  detach = handleNodeConnection(node.serverSocket, machines, { machineId: device.machineId, credential: device.credential });
  await waitFor(() => machines.getMachine(device.machineId)?.status === 'connected', 'Fake node did not connect');
  await waitFor(() => Boolean(database.prepare("SELECT id FROM runtime_registrations WHERE machine_id = ? AND kind = 'fake' AND available = 1").get(device.machineId)), 'Fake runtime was not discovered');
  const runtime = database.prepare("SELECT id FROM runtime_registrations WHERE machine_id = ? AND kind = 'fake'").get(device.machineId);
  const user = { id: 'user', email: 'session@example.test', displayName: 'Session', role: 'administrator', teamId: 'team' };
  const service = new SessionsService(context, machines);
  const session = service.createSession(user, 'project', { title: 'Interactive smoke', runtimeRegistrationId: runtime.id });
  service.queueMessage(user, session.id, { body: 'ping' });
  await waitFor(() => {
    service.maintenance();
    return service.getSummary(session.id)?.state === 'idle';
  }, () => `Interactive session did not settle: ${JSON.stringify({ summary: service.getSummary(session.id), commands: machines.listCommands(device.machineId) })}`);
  const snapshot = service.getSnapshot(user, session.id);
  assert.deepEqual(snapshot.messages.map((message) => message.body), ['ping', 'Fake response: ping']);
  assert.equal(snapshot.runs[0]?.state, 'settled');
  assert.equal(database.prepare("SELECT count(*) AS count FROM node_commands WHERE kind = 'send_message' AND state = 'completed'").get().count, 1);
  process.stdout.write('session runtime smoke: message -> fake runtime -> agent response -> settled\n');
} finally {
  detach?.();
  node?.stop();
  database.close();
  if (priorFakeRuntime === undefined) delete process.env.DHOLE_NODE_ENABLE_FAKE;
  else process.env.DHOLE_NODE_ENABLE_FAKE = priorFakeRuntime;
  rmSync(repository, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
