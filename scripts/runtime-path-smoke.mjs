import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureIds, systemClock } from '../apps/server/dist/lib/clock.js';
import { openDatabase } from '../apps/server/dist/lib/database.js';
import { EventStore } from '../apps/server/dist/lib/events.js';
import { MachineService, handleNodeConnection } from '../apps/server/dist/modules/core/machines/index.js';
import { loadNodeConfig } from '../apps/node/dist/config.js';
import { FakeNode } from '../apps/node/dist/fake.js';
import { FakeRuntimeAdapter } from '../apps/node/dist/runtimes/fake.js';

const repository = mkdtempSync(join(tmpdir(), 'dhole-runtime-repository-'));
const state = mkdtempSync(join(tmpdir(), 'dhole-runtime-node-'));
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
  throw new Error(message);
};

try {
  execFileSync('git', ['init', '-qb', 'main', repository]);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'runtime@example.test']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Dhole Runtime Smoke']);
  writeFileSync(join(repository, 'README.md'), 'runtime path fixture\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
  const at = new Date().toISOString();
  database.exec(`
    INSERT INTO teams(id, name, created_at) VALUES ('team', 'Team', '${at}');
    INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES ('user', 'runtime@example.test', 'Runtime', 'fixture', '${at}', '${at}');
    INSERT INTO team_members(team_id, user_id, role, created_at) VALUES ('team', 'user', 'administrator', '${at}');
    INSERT INTO projects(id, team_id, name, created_by, created_at, updated_at) VALUES ('project', 'team', 'Project', 'user', '${at}', '${at}');
    INSERT INTO repositories(id, project_id, label, default_branch, created_by, created_at, updated_at) VALUES ('repository', 'project', 'Repository', 'main', 'user', '${at}', '${at}');
  `);
  const events = new EventStore(database, systemClock, secureIds);
  const machines = new MachineService(database, systemClock, secureIds, {}, events);
  const token = machines.issueEnrollmentToken({ teamId: 'team', label: 'runtime-node', createdBy: 'user' });
  const device = machines.consumeEnrollmentToken(token.token);
  machines.addRepositoryAllowlist(device.machineId, 'repository', repository);
  const fakeRuntime = new FakeRuntimeAdapter();
  const config = loadNodeConfig({
    DHOLE_NODE_MACHINE_ID: device.machineId,
    DHOLE_NODE_CREDENTIAL: device.credential,
    DHOLE_NODE_STATE_DIR: state,
    DHOLE_NODE_REPOSITORIES: JSON.stringify({ repository }),
  });
  const createNode = () => new FakeNode({ config, executor: { discoverRuntimes: () => [fakeRuntime.descriptor()] } });
  node = createNode();
  node.start();
  detach = handleNodeConnection(node.serverSocket, machines, { machineId: device.machineId, credential: device.credential });
  await waitFor(() => machines.getMachine(device.machineId)?.status === 'connected', 'Fake node did not connect');
  await waitFor(() => database.prepare("SELECT count(*) AS count FROM runtime_registrations WHERE machine_id = ? AND kind = 'fake' AND available = 1").get(device.machineId).count === 1, 'Fake runtime was not discovered');

  const command = (kind, fields) => ({
    commandId: `command-${kind}`, operationKey: `operation-${kind}`, kind,
    issuedAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...fields,
  });
  const execute = async (command) => {
    machines.enqueueCommand({ machineId: device.machineId, projectId: 'project', command });
    await waitFor(() => {
      const current = machines.getCommand(device.machineId, command.operationKey);
      assert.ok(!['failed', 'uncertain', 'expired'].includes(current?.state), `${command.kind} failed: ${current?.error ?? current?.state}`);
      return current?.state === 'completed';
    }, `${command.kind} did not complete`);
    return machines.getCommand(device.machineId, command.operationKey);
  };
  const worktreePath = '.dhole/worktrees/runtime-path';
  const worktree = command('create_worktree', {
    repositoryId: 'repository', branch: 'codex/runtime-smoke', baseRevision: 'main', relativeTarget: worktreePath,
  });
  await execute(worktree);
  assert.equal(readFileSync(join(repository, worktreePath, 'README.md'), 'utf8'), 'runtime path fixture\n');
  assert.equal(execFileSync('git', ['-C', join(repository, worktreePath), 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'codex/runtime-smoke');

  const created = await execute(command('create_runtime_session', {
    repositoryId: 'repository', runtimeId: fakeRuntime.descriptor().id,
    runtimeSessionKey: 'runtime-path', cwd: worktreePath,
  }));
  assert.ok(created.result.runtimeSessionId, 'Runtime session did not return its native ID');
  const message = command('send_message', { runtimeSessionId: created.result.runtimeSessionId, message: 'Complete the runtime path fixture' });
  const completed = await execute(message);
  assert.equal(completed.result.text, 'Fake response: Complete the runtime path fixture');
  assert.ok(completed.result.events.some((event) => event.type === 'message.completed' && event.text === completed.result.text));
  assert.deepEqual(machines.listCommands(device.machineId).map(({ kind, state }) => [kind, state]), [
    ['create_worktree', 'completed'], ['create_runtime_session', 'completed'], ['send_message', 'completed'],
  ]);
  assert.deepEqual(machines.enqueueCommand({ machineId: device.machineId, projectId: 'project', command: message }), completed,
    'A server retry must return the original completed command');
  assert.throws(() => machines.enqueueCommand({ machineId: device.machineId, projectId: 'project', command: { ...message, message: 'Changed retry' } }),
    { code: 'operation_key_conflict' });

  const originalJournal = node.client.journal.list();
  detach();
  node.stop();
  node = createNode();
  node.start();
  detach = handleNodeConnection(node.serverSocket, machines, { machineId: device.machineId, credential: device.credential });
  await waitFor(() => machines.getMachine(device.machineId)?.status === 'connected', 'Restarted node did not connect');
  const replayed = [];
  node.serverSocket.on('message', (frame) => { replayed.push(JSON.parse(String(frame))); });
  for (const retry of [worktree, message]) node.serverSocket.send(JSON.stringify({ type: 'command', protocol: 'dhole.node.v1', command: retry }));
  await waitFor(() => replayed.filter((frame) => frame.type === 'command_status' && frame.state === 'completed').length === 2,
    'Restarted node did not replay its completed journal entries');
  assert.equal(replayed.filter((frame) => frame.type === 'runtime_event').length, 0, 'Duplicate delivery executed the runtime again');
  assert.deepEqual(node.client.journal.list(), originalJournal, 'Duplicate delivery rewrote the durable operation journal');
  assert.equal(machines.listCommands(device.machineId).length, 3, 'Duplicate delivery created extra commands');
  process.stdout.write('runtime path smoke: Core worktree -> fake runtime -> message -> durable restart replay\n');
} finally {
  detach?.();
  node?.stop();
  database.close();
  if (priorFakeRuntime === undefined) delete process.env.DHOLE_NODE_ENABLE_FAKE;
  else process.env.DHOLE_NODE_ENABLE_FAKE = priorFakeRuntime;
  rmSync(repository, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
