import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../apps/server/dist/app.js';
import { loadConfig } from '../apps/server/dist/lib/config.js';
import { createMachineService, handleNodeConnection } from '../apps/server/dist/modules/core/machines/index.js';
import { AgentBridge } from '../apps/node/dist/bridge.js';
import { loadNodeConfig, readCredentialState } from '../apps/node/dist/config.js';
import { FakeNode } from '../apps/node/dist/fake.js';
import { executeGatewayAction } from '../apps/node/dist/gateway-client.js';
import { connectMachine, createNativeProject, readAgentState } from '../apps/node/dist/onboarding.js';

const directory = mkdtempSync(join(tmpdir(), 'dhole-onboarding-smoke-'));
const repository = join(directory, 'repository');
const stateDir = join(directory, 'state');
const origin = 'http://localhost:4173';
const bootstrapToken = randomBytes(32).toString('base64url');
const password = randomBytes(32).toString('base64url');
const managementSecret = randomBytes(32).toString('base64url');
const catalogSecret = randomBytes(32).toString('base64url');
const secrets = [bootstrapToken, password, managementSecret, catalogSecret];
const exposed = [];
const requests = [];
const bridges = [];
const cpaRequests = [];
const priorFetch = globalThis.fetch;
let time = Date.now();
let application;
let pendingCode;
let browserHeaders;

async function verifyCoreMachineOnboarding() {
  const core = createApplication({ config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:',
    DHOLE_PUBLIC_ORIGIN: origin, DHOLE_BOOTSTRAP_TOKEN: bootstrapToken, DHOLE_MODULES: 'none' }), seed: false });
  const coreState = join(directory, 'core-state');
  let headers = {};
  let userCode;
  let node;
  let detach;
  const forward = async (url, init) => {
    const request = new Request(url, init);
    assert.equal(new URL(request.url).origin, origin, 'Core onboarding attempted an unexpected origin');
    request.headers.set('host', new URL(origin).host);
    const response = await core.app.fetch(request);
    if (response.ok && ['/api/auth/device/start', '/api/auth/device/poll', '/api/auth/device/enroll'].includes(new URL(request.url).pathname)) {
      const body = await response.clone().json();
      if (body.userCode) userCode = body.userCode;
      for (const key of ['deviceCode', 'token', 'credential']) if (body[key]) secrets.push(body[key]);
    }
    return response;
  };
  const browser = (path, body, method = 'POST') => forward(new URL(path, origin), { method,
    headers: { 'content-type': 'application/json', origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    headers = { 'x-dhole-bootstrap-token': bootstrapToken };
    const bootstrap = await browser('/api/auth/bootstrap', { email: 'core@example.test', displayName: 'Core fixture', password });
    assert.equal(bootstrap.status, 201, 'Core bootstrap failed with optional modules disabled');
    const account = await bootstrap.json();
    headers = { cookie: bootstrap.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '), 'x-csrf-token': account.csrfToken };
    const catalog = await browser('/api/modules', undefined, 'GET');
    assert.deepEqual((await catalog.json()).enabledModules, ['core', 'access']);
    const connected = await connectMachine({ server: origin, stateDir: coreState, machineName: 'Core smoke' }, {
      fetch: forward, now: () => time, output: (line) => exposed.push(line), sleep: async (ms) => {
        time += ms;
        const approved = await browser('/api/auth/device/approve', { userCode, permissions: ['project:read', 'projects:create', 'fleet:admin'] });
        assert.equal(approved.status, 200, 'Core machine approval failed');
      },
    });
    assert.deepEqual(connected, { enrolled: true, dryRun: false }, 'Core must enroll machines with all optional modules disabled');
    assert.equal(statSync(join(coreState, 'credential.json')).mode & 0o077, 0, 'Core node credentials must remain private');
    const device = readCredentialState(join(coreState, 'credential.json'));
    assert.ok(device, 'Core onboarding did not save node credentials');
    const machines = createMachineService(core.context);
    node = new FakeNode({ config: loadNodeConfig({ DHOLE_NODE_STATE_DIR: coreState }), executor: { discoverRuntimes: () => [] } });
    node.start();
    detach = handleNodeConnection(node.serverSocket, machines, device);
    const command = { commandId: 'core-health', operationKey: 'core-health', kind: 'report_health',
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    const dispatched = await browser(`/api/machines/${device.machineId}/commands`, { command });
    assert.equal(dispatched.status, 202, 'Core machine command route is unavailable');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && machines.getCommand(device.machineId, command.operationKey)?.state !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const commands = await browser(`/api/machines/${device.machineId}/commands`, undefined, 'GET');
    assert.equal(commands.status, 200);
    const completed = (await commands.json())[0];
    assert.equal(completed?.state, 'completed', 'Core node transport did not complete its health command');
    assert.equal(completed.result.ok, true);
    const listing = await browser('/api/machines', undefined, 'GET');
    assert.equal(listing.status, 200);
    const listed = await listing.json();
    assert.equal(listed[0]?.status, 'connected');
    exposed.push(JSON.stringify(listed), JSON.stringify(completed));
  } finally {
    detach?.();
    node?.stop();
    core.close();
  }
}

// Gateway captures this fixture transport. It never delegates to a network fetch.
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  assert.equal(target.origin, 'http://127.0.0.1:8787', 'Unexpected upstream origin');
  assert.equal(init?.method, 'GET', 'Unexpected upstream mutation');
  const catalog = target.pathname === '/v1/models';
  assert.ok(catalog || target.pathname === '/v0/management/config', 'Unexpected upstream route');
  assert.ok(new Headers(init.headers).get('authorization') === `Bearer ${catalog ? catalogSecret : managementSecret}`, 'Wrong CPA credential');
  cpaRequests.push(target.pathname);
  return Response.json(catalog ? { data: [{ id: 'smoke-model', owned_by: 'fixture', display_name: `Fixture ${managementSecret} ${catalogSecret}` }] } : {});
};

try {
  await verifyCoreMachineOnboarding();
  mkdirSync(repository);
  execFileSync('git', ['init', '-qb', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'onboarding fixture\n');
  application = createApplication({
    config: loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:', DHOLE_PUBLIC_ORIGIN: origin,
      DHOLE_BOOTSTRAP_TOKEN: bootstrapToken, DHOLE_MODULES: 'coordination,gateway,mcp',
      DHOLE_MASTER_KEYS: JSON.stringify({ smoke: randomBytes(32).toString('base64') }), DHOLE_MASTER_KEY_ID: 'smoke' }),
    clock: { now: () => new Date(time) }, seed: false,
  });
  const { app, context: { database } } = application;
  const forward = async (url, init) => {
    const request = new Request(url, init);
    const target = new URL(request.url);
    assert.equal(target.origin, origin, 'Client attempted an unexpected origin');
    request.headers.set('host', target.host);
    const response = await app.fetch(request);
    requests.push({ path: target.pathname, method: request.method, status: response.status });
    if (response.ok && (['/api/auth/device/start', '/api/auth/device/poll', '/api/auth/device/project'].includes(target.pathname)
      || request.method === 'POST' && (target.pathname.endsWith('/sessions') || target.pathname.endsWith('/catalog/tokens')))) {
      const body = await response.clone().json();
      if (body.userCode) pendingCode = body.userCode;
      for (const key of ['deviceCode', 'token', 'capability']) if (body[key]) secrets.push(body[key]);
    }
    return response;
  };
  const browser = (path, body, method = 'POST', headers = browserHeaders) => forward(new URL(path, origin), {
    method, headers: { 'content-type': 'application/json', origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bootstrap = await browser('/api/auth/bootstrap', { email: 'onboarding@example.test', displayName: 'Onboarding fixture', password },
    'POST', { 'x-dhole-bootstrap-token': bootstrapToken });
  assert.equal(bootstrap.status, 201, 'Native fixture bootstrap failed');
  const account = await bootstrap.json();
  assert.equal(account.user.role, 'administrator');
  browserHeaders = { cookie: bootstrap.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '), 'x-csrf-token': account.csrfToken };
  const methods = await browser('/api/auth/methods', undefined, 'GET');
  assert.equal((await methods.json()).bootstrap, false, 'Bootstrap must close after the first account');

  const output = (line) => { exposed.push(line); };
  const dependencies = { fetch: forward, now: () => time, output };
  const connected = await connectMachine({ server: origin, stateDir, agentOnly: true, machineName: 'Onboarding smoke' }, {
    ...dependencies,
    sleep: async (ms) => {
      time += ms;
      assert.ok(pendingCode, 'Client did not start device authorization');
      const approved = await browser('/api/auth/device/approve', {
        userCode: pendingCode, permissions: ['project:read', 'coordination:write', 'projects:create'],
      });
      assert.equal(approved.status, 200, 'Native browser approval failed');
      exposed.push(await approved.text());
      pendingCode = undefined;
    },
  });
  assert.deepEqual(connected, { enrolled: false, dryRun: false });
  assert.deepEqual(requests.filter(({ path }) => ['/api/auth/device/start', '/api/auth/device/approve', '/api/auth/device/poll'].includes(path))
    .map(({ path }) => path), ['/api/auth/device/start', '/api/auth/device/approve', '/api/auth/device/poll']);
  assert.equal(existsSync(join(stateDir, 'credential.json')), false, 'Agent-only connection must not enroll a node');
  assert.equal(statSync(join(stateDir, 'agent.json')).mode & 0o077, 0, 'Agent credentials must remain private');
  assert.equal(database.prepare('SELECT count(*) AS count FROM machines').get().count, 0);
  const agent = readAgentState(stateDir);

  const projectOptions = { stateDir, cwd: repository, name: 'Onboarding smoke', requestId: 'onboarding-project' };
  const project = await createNativeProject(projectOptions, dependencies);
  assert.ok(project?.repositoryId, 'Native project creation did not return a repository');
  assert.deepEqual(await createNativeProject(projectOptions, dependencies), project, 'Native project retry changed IDs');
  await assert.rejects(createNativeProject({ ...projectOptions, name: 'Conflicting retry' }, dependencies), { code: 'idempotency_conflict' });
  assert.equal(database.prepare('SELECT count(*) AS count FROM projects').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM repositories').get().count, 1);
  assert.equal(database.prepare('SELECT visibility FROM projects WHERE id = ?').get(project.projectId).visibility, 'private');
  const requestsBeforeDeniedGateway = requests.length;
  await assert.rejects(executeGatewayAction({ action: 'connections.list' }, { stateDir, projectId: project.projectId, fetch: forward, now: () => time }),
    { code: 'gateway_not_authorized' });
  assert.equal(requests.length, requestsBeforeDeniedGateway, 'Missing Gateway grant must be denied before sending a request');
  const gatewayScopeDenied = await forward(new URL('/api/auth/device/project', origin), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
    body: JSON.stringify({ mode: 'manual', projectId: project.projectId, permissions: ['gateway:manage'] }),
  });
  assert.equal(gatewayScopeDenied.status, 403, 'Server must refuse an unapproved Gateway grant');

  const startBridge = () => {
    const bridge = new AgentBridge({ stateDir, cwd: repository, projectId: project.projectId, fetch: forward, now: () => time });
    bridges.push(bridge);
    return bridge;
  };
  const rpc = async (bridge, method, params) => {
    const response = await bridge.handle({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
    exposed.push(JSON.stringify(response));
    assert.ok(response?.result && !response.result.isError, `${method} failed: ${JSON.stringify(requests.at(-1))}`);
    return response.result;
  };
  const firstBridge = startBridge();
  const catalogue = await rpc(firstBridge, 'tools/list');
  assert.ok(catalogue.tools.some(({ name }) => name === 'coordination_claim'), `Real MCP catalogue unavailable: ${JSON.stringify(requests.at(-1))}`);
  assert.ok(!catalogue.tools.some(({ name }) => name === 'gateway_manage'), 'Gateway management must require its grant');
  assert.ok(catalogue.tools.every(({ name, inputSchema }) => name !== 'coordination_session_register'
    && !Object.hasOwn(inputSchema.properties ?? {}, 'coordinationSessionId')));
  const created = await rpc(firstBridge, 'tools/call', { name: 'coordination_claim', arguments: {
    intent: 'Exercise fixture onboarding', files: ['README.md'], status: 'in-progress',
  } });
  const claimId = created.structuredContent.id;
  const firstSession = database.prepare('SELECT coordination_session_id AS id FROM coordination_claims WHERE id = ?').get(claimId).id;
  await firstBridge.close();
  assert.ok(database.prepare('SELECT ended_at FROM coordination_sessions WHERE id = ?').get(firstSession).ended_at);
  assert.equal(database.prepare('SELECT status FROM coordination_claims WHERE id = ?').get(claimId).status, 'in-progress');

  const restartedBridge = startBridge();
  await rpc(restartedBridge, 'tools/list');
  const completed = await rpc(restartedBridge, 'tools/call', { name: 'coordination_complete', arguments: {
    claimId, summary: 'Completed after restarting the local bridge', status: 'done',
  } });
  assert.equal(completed.structuredContent.id, claimId);
  assert.equal(completed.structuredContent.status, 'done');
  const completedRow = database.prepare('SELECT status, coordination_session_id AS sessionId FROM coordination_claims WHERE id = ?').get(claimId);
  assert.equal(completedRow.status, 'done');
  assert.notEqual(completedRow.sessionId, firstSession, 'Restart must establish a new transport session');
  const sessions = database.prepare('SELECT worktree_hash FROM coordination_sessions').all();
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].worktree_hash && sessions[0].worktree_hash === sessions[1].worktree_hash, 'Manual worktree identity must survive restart');

  const devices = await browser('/api/auth/devices', undefined, 'GET');
  assert.equal(devices.status, 200);
  exposed.push(await devices.text());
  const revoked = await browser(`/api/auth/devices/${agent.id}`, undefined, 'DELETE');
  assert.equal(revoked.status, 200, 'Browser device revocation failed');
  const denied = await restartedBridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'coordination_claim', arguments: { intent: 'Must be denied after revocation' },
  } });
  assert.equal(denied.result.isError, true, 'Revoked project credential retained MCP authority');
  assert.equal(requests.at(-1).status, 401);
  assert.equal(database.prepare('SELECT count(*) AS count FROM coordination_claims').get().count, 1);
  const exchange = await forward(new URL('/api/auth/device/project', origin), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
    body: JSON.stringify({ mode: 'manual', projectId: project.projectId }),
  });
  assert.equal(exchange.status, 401, 'Revoked device retained project exchange authority');
  assert.equal(database.prepare('SELECT count(*) AS count FROM api_tokens WHERE revoked_at IS NULL').get().count, 0);

  const gatewayState = join(directory, 'gateway-state');
  await connectMachine({ server: origin, stateDir: gatewayState, agentOnly: true, gateway: true, machineName: 'Gateway-only smoke' }, {
    ...dependencies,
    sleep: async (ms) => {
      time += ms;
      const approved = await browser('/api/auth/device/approve', { userCode: pendingCode,
        permissions: ['gateway:read', 'gateway:manage', 'projects:create'] });
      assert.equal(approved.status, 200, 'Gateway-only browser approval failed');
      pendingCode = undefined;
    },
  });
  const gatewayAgent = readAgentState(gatewayState);
  assert.ok(!gatewayAgent.permissions.includes('coordination:write'));
  const gatewayProject = await createNativeProject({ stateDir: gatewayState, cwd: repository, name: 'Gateway smoke' }, dependencies);
  const gatewayBridge = new AgentBridge({ stateDir: gatewayState, cwd: repository, projectId: gatewayProject.projectId, fetch: forward, now: () => time });
  bridges.push(gatewayBridge);
  const gatewayCatalogue = await rpc(gatewayBridge, 'tools/list');
  assert.deepEqual(gatewayCatalogue.tools.map(({ name }) => name), ['gateway_manage'], 'Gateway-only grant must work without coordination');
  const gatewayAction = async (arguments_) => {
    const result = await rpc(gatewayBridge, 'tools/call', { name: 'gateway_manage', arguments: arguments_ });
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual(await gatewayAction({ action: 'connections.list' }), []);
  const secretFile = join(gatewayState, 'cpa-secrets.json');
  writeFileSync(secretFile, JSON.stringify({ managementSecret, catalogSecret }), { mode: 0o600 });
  const connection = await gatewayAction({ action: 'connections.create', name: 'Fixture CPA', baseUrl: 'http://127.0.0.1:8787', secretFile });
  assert.ok(connection.managementConfigured && connection.catalogConfigured);
  assert.equal((await gatewayAction({ action: 'connections.list' }))[0].id, connection.id);
  assert.deepEqual(await gatewayAction({ action: 'health', connectionId: connection.id }), { ok: true, status: 200 });
  const catalog = await gatewayAction({ action: 'catalog.refresh', connectionId: connection.id });
  assert.equal(catalog.status, 'current');
  assert.equal(catalog.models[0].modelKey, 'smoke-model');
  assert.equal(catalog.models[0].enabled, false);
  const policy = await gatewayAction({ action: 'models.policy', connectionId: connection.id, modelId: catalog.models[0].modelId, enabled: true });
  assert.equal(policy.models[0].enabled, true, 'Gateway tool did not apply model policy');
  assert.deepEqual(cpaRequests, ['/v0/management/config', '/v1/models']);
  assert.equal(database.prepare('SELECT count(*) AS count FROM coordination_sessions').get().count, 2, 'Gateway-only bridge must not start a coordination session');

  const issued = await gatewayAction({ action: 'tokens.issue', connectionId: connection.id, name: 'Fixture catalog client', client: 'generic' });
  assert.equal(statSync(issued.credentialFile).mode & 0o077, 0, 'Catalog token file must remain private');
  const catalogCredential = JSON.parse(readFileSync(issued.credentialFile, 'utf8'));
  secrets.push(catalogCredential.token);
  assert.equal((await gatewayAction({ action: 'tokens.list', connectionId: connection.id })).tokens[0].id, issued.id);
  const catalogRequest = () => forward(new URL(issued.endpoint, origin), { headers: { authorization: `Bearer ${catalogCredential.token}` } });
  const projection = await catalogRequest();
  assert.equal(projection.status, 200, 'Issued catalog token did not authorize its projection');
  exposed.push(await projection.text());
  const gatewayRevocation = await browser(`/api/auth/devices/${gatewayAgent.id}`, undefined, 'DELETE');
  assert.equal(gatewayRevocation.status, 200);
  const gatewayDenied = await gatewayBridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'gateway_manage', arguments: { action: 'connections.list' },
  } });
  assert.equal(gatewayDenied.result.isError, true, 'Revoked device retained Gateway tool authority');
  assert.equal(requests.at(-1).status, 401);
  assert.equal((await catalogRequest()).status, 401, 'Revoking a device must revoke its issued catalog token');
  assert.equal(database.prepare('SELECT count(*) AS count FROM api_tokens WHERE revoked_at IS NULL').get().count, 0);
  exposed.push(JSON.stringify(database.prepare('SELECT * FROM audit_records').all()));
  for (const secret of secrets) assert.ok(!exposed.some((text) => text.includes(secret)), 'Private authority leaked into browser, agent output, or audit');
  assert.ok(!exposed.some((text) => text.includes(repository)), 'Local checkout path leaked into public output');
  process.stdout.write('onboarding smoke: Core-only enrollment and transport -> native bootstrap -> project retry -> claim restart -> Gateway management -> private catalog token -> revocation\n');
} finally {
  await Promise.allSettled(bridges.map((bridge) => bridge.close()));
  application?.close();
  globalThis.fetch = priorFetch;
  rmSync(directory, { recursive: true, force: true });
}
