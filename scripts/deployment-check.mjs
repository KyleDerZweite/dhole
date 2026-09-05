import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/server/dist/lib/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--image' && !process.argv[3].startsWith('-')), 'Usage: node scripts/deployment-check.mjs [--image LOCAL_IMAGE]');
const example = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
assert.throws(() => loadConfig({ ...example, NODE_ENV: 'production', DHOLE_AUTH_MODE: 'password' }), 'Example credentials must not start production');
assert.equal(readFileSync(new URL('../.containerignore', import.meta.url), 'utf8'), readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8'), 'Build context exclusions must match');

// A clean environment and an explicit example file prevent loading local secrets.
const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
const check = (envFile, override = false, optionalEnvironment = {}) => spawnSync('podman-compose', ['--env-file', envFile, '-f', 'compose.yaml', ...(override ? ['-f', 'compose.github.yaml'] : []), 'config', '--quiet'], {
  cwd: root,
  env: { ...environment, ...optionalEnvironment },
  encoding: 'utf8',
  timeout: 30_000,
});
const configured = check('.env.example');
if (configured.error?.code === 'ENOENT') {
  process.stdout.write('Deployment example fails closed. Compose syntax check skipped: podman-compose is not installed.\n');
} else {
  assert.equal(configured.status, 0, 'Compose syntax check failed; use podman-compose with --env-file .env.example config --quiet to diagnose');
  const missing = check('/dev/null');
  assert.notEqual(missing.status, 0, 'Compose must reject missing required deployment configuration');
  const github = check('.env.example', true, {
    DHOLE_GITHUB_CLIENT_ID: 'fixture-client',
    DHOLE_GITHUB_CLIENT_SECRET: 'fixture-secret',
    DHOLE_GITHUB_APP_ID: '1',
    DHOLE_GITHUB_APP_PRIVATE_KEY_PATH: './secrets/fixture-only.pem',
  });
  assert.equal(github.status, 0, 'Optional GitHub Compose override must parse');
  assert.notEqual(check('.env.example', true).status, 0, 'Optional GitHub override must reject missing GitHub configuration');
  process.stdout.write('Deployment example fails closed; Compose syntax and required settings passed. No services were started.\n');
}

if (process.argv[2] === '--image') {
  const image = process.argv[3];
  const name = `dhole-fixture-${randomUUID()}`;
  const volume = `${name}-data`;
  const healthCommand = "node -e \"require('node:http').get('http://127.0.0.1:4173/api/health', { headers: { host: new URL(process.env.DHOLE_PUBLIC_ORIGIN).host }, timeout: 4000 }, r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)).on('timeout', () => process.exit(1))\"";
  const podman = (args, input) => {
    const result = spawnSync('podman', args, { cwd: root, input, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `Fixture Podman ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  const imageId = podman(['image', 'inspect', '--format={{.Id}}', image]);
  const smoke = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, statSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { get } from 'node:http';
    const request = (path, host = 'fixture.invalid') => new Promise((resolve, reject) => {
      const req = get('http://127.0.0.1:4173' + path, { headers: { host }, timeout: 1000 }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
    });
    let healthy = false;
    let lastHealth = 'not requested';
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const response = await request('/api/health'); healthy = response.ok; lastHealth = String(response.status); } catch (error) { lastHealth = error.message; }
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'Server did not become healthy: ' + lastHealth);
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), 1000);
    const rootMount = readFileSync('/proc/mounts', 'utf8').split('\n').map(line => line.split(' ')).find(fields => fields[1] === '/');
    assert.ok(rootMount[3].split(',').includes('ro'));
    assert.throws(() => writeFileSync('/app/read-only-check', 'fixture'));
    writeFileSync('/tmp/writable-check', 'fixture');
    const html = await (await request('/')).text();
    assert.match(html, /<html/);
    const asset = html.match(/(?:src|href)="(\/assets\/[^\"]+)"/)[1];
    assert.equal((await request(asset)).status, 200);
    assert.equal((await request('/LICENSE')).status, 200);
    assert.equal((await request('/THIRD_PARTY_NOTICES.md')).status, 200);
    assert.equal((await request('/api/health', 'untrusted.invalid')).status, 403);
    assert.equal((await request('/api/auth/me')).status, 401);
    const methods = await (await request('/api/auth/methods')).json();
    assert.equal(methods.password, true);
    assert.equal(methods.githubLink, false);
    assert.equal(methods.bootstrapTokenRequired, true);
    const require = createRequire('/app/apps/server/package.json');
    const Database = require('better-sqlite3');
    const database = new Database('/app/data/dhole.db', { readonly: true });
    assert.equal(database.prepare('SELECT count(*) AS total FROM users').get().total, 0);
    const migrations = database.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all();
    assert.ok(migrations.length > 0);
    assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(statSync('/app/data/dhole.db').mode & 0o777, 0o600);
    assert.equal(statSync('/app/data').mode & 0o777, 0o700);
    database.close();
    const state = JSON.stringify(migrations);
    if (process.argv[2] === 'first') writeFileSync('/app/data/fixture-migrations.json', state, { mode: 0o600 });
    else assert.equal(readFileSync('/app/data/fixture-migrations.json', 'utf8'), state, 'Named volume did not preserve the migrated database');
    console.log('Fixture ' + process.argv[2] + ': native SQLite, migrations, empty users, static assets, auth, host checks, and filesystem permissions passed');
  `;
  try {
    for (const pass of ['first', 'recreated']) {
      podman(['run', '--detach', '--pull=never', '--name', name, '--network=none', '--read-only', '--user=1000:1000', '--userns=keep-id:uid=1000,gid=1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--volume', `${volume}:/app/data:U`, '--health-cmd', healthCommand, '--health-timeout=5s',
        '--env=NODE_ENV=production', '--env=DHOLE_AUTH_MODE=password', '--env=DHOLE_PUBLIC_ORIGIN=https://fixture.invalid', '--env=DHOLE_ALLOWED_HOSTS=fixture.invalid', '--env=DHOLE_MASTER_KEY_ID=fixture', `--env=DHOLE_MASTER_KEYS=${JSON.stringify({ fixture: Buffer.alloc(32, 7).toString('base64') })}`, '--env=DHOLE_BOOTSTRAP_TOKEN=fixture-only-bootstrap-token-never-use-in-production', '--env=DHOLE_GATEWAY_ALLOWED_HOSTS=', imageId]);
      process.stdout.write(`${podman(['exec', '--interactive', name, 'node', '--input-type=module', '-', pass], smoke)}\n`);
      podman(['healthcheck', 'run', name]);
      podman(['stop', '--time=20', name]);
      assert.equal(podman(['inspect', '--format={{.State.ExitCode}}', name]), '0', 'SIGTERM must exit cleanly');
      podman(['rm', name]);
    }
    process.stdout.write('Fixture image passed healthcheck, SIGTERM shutdown, and named-volume recreation. No network or account setup was used.\n');
  } finally {
    podman(['rm', '--force', '--ignore', name]);
    const exists = spawnSync('podman', ['volume', 'exists', volume], { encoding: 'utf8', timeout: 30_000 });
    if (exists.status === 0) podman(['volume', 'rm', volume]);
    else assert.equal(exists.status, 1, 'Could not check fixture volume cleanup');
  }
}
