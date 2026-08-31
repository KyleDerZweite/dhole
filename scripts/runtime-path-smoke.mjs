import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureIds, systemClock } from '../apps/server/dist/lib/clock.js';
import { openDatabase } from '../apps/server/dist/lib/database.js';
import { EventStore } from '../apps/server/dist/lib/events.js';
import { FleetService, handleNodeConnection } from '../apps/server/dist/modules/fleet/index.js';
import { OrchestrationService } from '../apps/server/dist/modules/orchestration/service.js';
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
    INSERT INTO sessions(id, project_id, title, state, created_by, created_at, updated_at) VALUES ('session', 'project', 'Runtime path', 'idle', 'user', '${at}', '${at}');
    INSERT INTO runs(id, session_id, root_objective, state, created_by, created_at, updated_at) VALUES ('run', 'session', 'Complete the runtime path fixture', 'queued', 'user', '${at}', '${at}');
  `);
  const events = new EventStore(database, systemClock, secureIds);
  const context = { database, clock: systemClock, ids: secureIds, events, config: {} };
  const fleet = new FleetService(database, systemClock, secureIds);
  const token = fleet.issueEnrollmentToken({ teamId: 'team', label: 'runtime-node', createdBy: 'user' });
  const device = fleet.consumeEnrollmentToken(token.token);
  fleet.addRepositoryAllowlist(device.machineId, 'repository', repository);
  const fakeRuntime = new FakeRuntimeAdapter();
  node = new FakeNode({
    config: loadNodeConfig({
      DHOLE_NODE_MACHINE_ID: device.machineId,
      DHOLE_NODE_CREDENTIAL: device.credential,
      DHOLE_NODE_STATE_DIR: state,
      DHOLE_NODE_REPOSITORIES: JSON.stringify({ repository }),
    }),
    executor: { discoverRuntimes: () => [fakeRuntime.descriptor()] },
  });
  node.start();
  detach = handleNodeConnection(node.serverSocket, fleet, { machineId: device.machineId, credential: device.credential });
  await waitFor(() => fleet.getMachine(device.machineId)?.status === 'connected', 'Fake node did not connect');
  await waitFor(() => database.prepare("SELECT count(*) AS count FROM runtime_registrations WHERE machine_id = ? AND kind = 'fake' AND available = 1").get(device.machineId).count === 1, 'Fake runtime was not discovered');

  const orchestration = new OrchestrationService(context, { fleet });
  const profile = orchestration.createProfile({
    projectId: 'project',
    stableKey: 'runtime-path',
    name: 'Runtime path',
    createdBy: 'user',
    config: {
      fake: false,
      initialChildren: 1,
      eligibleMachineIds: [device.machineId],
      workspacePolicy: 'isolated',
      limits: { maxConcurrency: 1, maxRetries: 0 },
    },
  });
  const started = orchestration.startExecution({ projectId: 'project', runId: 'run', profileVersionId: profile.version.id });
  try {
    await waitFor(() => {
      orchestration.tick('project');
      return orchestration.getExecution('project', started.id).state === 'settled';
    }, 'Orchestration did not settle through the node runtime');
  } catch (error) {
    const snapshot = orchestration.getExecution('project', started.id);
    const commandStates = fleet.listCommands(device.machineId).map((command) => ({ kind: command.kind, state: command.state, error: command.error }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ snapshot, commandStates })}`);
  }

  const completed = orchestration.getExecution('project', started.id);
  const child = completed.workItems.find((item) => item.parentWorkItemId);
  assert.equal(child?.result?.text, 'Fake response: Complete the runtime path fixture\n\nWorker role: worker-1');
  const commands = fleet.listCommands(device.machineId);
  assert.deepEqual(commands.map((command) => command.kind), ['create_worktree', 'create_runtime_session', 'send_message']);
  assert.deepEqual(commands.map((command) => command.state), ['completed', 'completed', 'completed']);
  assert.equal(database.prepare('SELECT state FROM worktrees').get().state, 'settled');
  process.stdout.write('runtime path smoke: worktree -> fake adapter -> objective -> settled\n');
} finally {
  detach?.();
  node?.stop();
  database.close();
  if (priorFakeRuntime === undefined) delete process.env.DHOLE_NODE_ENABLE_FAKE;
  else process.env.DHOLE_NODE_ENABLE_FAKE = priorFakeRuntime;
  rmSync(repository, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
