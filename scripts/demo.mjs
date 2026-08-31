import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const origin = process.env.DHOLE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4173';

function child(command, args, environment = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...environment } });
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Dhole did not become ready at ${origin}`);
}

async function waitFor(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

const build = child('pnpm', ['build']);
const buildCode = await new Promise((resolve) => build.once('exit', (code) => resolve(code ?? 1)));
if (buildCode !== 0) process.exit(buildCode);

const server = child(process.execPath, ['apps/server/dist/index.js'], {
  DHOLE_DEMO: 'true',
  DHOLE_DATABASE: process.env.DHOLE_DATABASE ?? './data/dhole-demo.db',
  DHOLE_PUBLIC_ORIGIN: origin,
});

let node;
try {
  await waitForServer();
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.dhole.local', password: 'DholeDemoAdmin!2026' }),
  });
  if (!login.ok) throw new Error(`Demo login failed (${login.status})`);
  const loginBody = await login.json();
  const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''];
  const cookie = setCookies.flatMap((value) => value.split(/,(?=\s*dhole_)/u)).map((value) => value.split(';')[0]).join('; ');
  const authorization = { cookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken };
  const tokenResponse = await fetch(`${origin}/api/fleet/enrollment-tokens`, {
    method: 'POST', headers: authorization,
    body: JSON.stringify({ label: `Demo live node ${process.pid}`, ttlMs: 300_000 }),
  });
  if (!tokenResponse.ok) throw new Error(`Demo enrollment-token issue failed (${tokenResponse.status})`);
  const enrollment = await tokenResponse.json();
  const consumeResponse = await fetch(`${origin}/api/fleet/enrollment/consume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: enrollment.token, machineName: `Demo live node ${process.pid}` }),
  });
  if (!consumeResponse.ok) throw new Error(`Demo enrollment failed (${consumeResponse.status})`);
  const device = await consumeResponse.json();
  const allowlistResponse = await fetch(`${origin}/api/fleet/machines/${encodeURIComponent(device.machineId)}/allowlist`, {
    method: 'POST', headers: authorization,
    body: JSON.stringify({ repositoryId: 'demo-repository', canonicalRoot: root }),
  });
  if (!allowlistResponse.ok) throw new Error(`Demo repository allowlist failed (${allowlistResponse.status})`);
  node = child(process.execPath, ['apps/node/dist/index.js'], {
    DHOLE_NODE_SERVER_URL: origin.replace(/^http/u, 'ws') + '/ws/node',
    DHOLE_NODE_MACHINE_ID: device.machineId,
    DHOLE_NODE_CREDENTIAL: device.credential,
    DHOLE_NODE_STATE_DIR: `./data/demo-node-${process.pid}`,
    DHOLE_NODE_REPOSITORIES: JSON.stringify({ 'demo-repository': root }),
    DHOLE_NODE_ENABLE_FAKE: 'true',
  });
  await waitFor(async () => {
    const response = await fetch(`${origin}/api/fleet/machines`, { headers: authorization });
    if (!response.ok) throw new Error(`Demo machine query failed (${response.status})`);
    const machines = await response.json();
    return Array.isArray(machines) && machines.some((machine) => machine.id === device.machineId && machine.status === 'connected');
  }, 'Demo node did not connect');

  const commandId = `demo-discover-${process.pid}-${Date.now()}`;
  const commandResponse = await fetch(`${origin}/api/fleet/machines/${encodeURIComponent(device.machineId)}/commands`, {
    method: 'POST', headers: authorization,
    body: JSON.stringify({ command: {
      commandId,
      operationKey: commandId,
      kind: 'discover_runtimes',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    } }),
  });
  if (!commandResponse.ok) throw new Error(`Demo command dispatch failed (${commandResponse.status})`);
  await waitFor(async () => {
    const response = await fetch(`${origin}/api/fleet/machines/${encodeURIComponent(device.machineId)}/commands`, { headers: authorization });
    if (!response.ok) throw new Error(`Demo command query failed (${response.status})`);
    const commands = await response.json();
    const command = Array.isArray(commands) ? commands.find((item) => item.id === commandId) : undefined;
    if (command?.state === 'failed' || command?.state === 'uncertain') throw new Error(`Demo runtime discovery ${command.state}: ${command.error ?? 'unknown error'}`);
    return command?.state === 'completed' && Array.isArray(command.result?.runtimes)
      && command.result.runtimes.some((runtime) => runtime.kind === 'fake' && runtime.availability?.available === true);
  }, 'Demo node did not complete fake-runtime discovery');
  process.stdout.write(`\nDhole demo: ${origin}\nAdministrator: admin@demo.dhole.local / DholeDemoAdmin!2026\nMember: member@demo.dhole.local / DholeDemoMember!2026\n\n`);
} catch (error) {
  server.kill('SIGTERM');
  throw error;
}

function shutdown(signal) {
  node?.kill(signal);
  server.kill(signal);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));
const code = await new Promise((resolve) => server.once('exit', (value) => resolve(value ?? 1)));
node?.kill('SIGTERM');
process.exitCode = code;
