import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const require = createRequire(new URL('../../apps/node/package.json', import.meta.url));
const zodDirectory = dirname(require.resolve('zod/package.json'));
const execute = promisify(execFile);
const observedAt = '2026-09-05T10:00:00.000Z';
const projection = (overrides = {}) => ({
  schemaVersion: 1, client: 'opencode', connectionId: 'connection-1', providerId: 'provider-1',
  observedAt, lastAttemptAt: observedAt, lastSuccessAt: observedAt,
  stale: false, status: 'current', sourceMatchesConnection: true,
  snapshotId: 'snapshot-1', contentHash: 'a'.repeat(64), error: null,
  models: {
    'fixture-model': {
      id: 'fixture-model', name: 'Fixture model', limit: { context: 200_000, output: 32_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  },
  ...overrides,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dhole-opencode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'node_modules'));
  await symlink(zodDirectory, join(directory, 'node_modules/zod'), 'dir');
  const pluginPath = join(directory, 'catalog.mjs');
  await copyFile(new URL('./catalog.mjs', import.meta.url), pluginPath);
  const { default: plugin } = await import(pathToFileURL(pluginPath).href);
  const settingsPath = join(directory, 'catalog-private.json');
  const settings = {
    schemaVersion: 1, provider: 'dhole-cpa', connectionId: 'connection-1',
    endpoint: 'https://dhole.invalid/api/gateway/catalog/v1/connection-1/opencode',
    token: randomBytes(32).toString('base64url'),
  };
  const saveSettings = (changes = {}) => writeFile(settingsPath, JSON.stringify({ ...settings, ...changes }), { mode: 0o600 });
  await saveSettings();
  const previous = process.env.DHOLE_OPENCODE_CATALOG_CONFIG;
  process.env.DHOLE_OPENCODE_CATALOG_CONFIG = settingsPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DHOLE_OPENCODE_CATALOG_CONFIG;
    else process.env.DHOLE_OPENCODE_CATALOG_CONFIG = previous;
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const config = {
    model: 'other/unchanged',
    provider: {
      'dhole-cpa': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://inference.invalid/v1', apiKey: randomBytes(32).toString('base64url') }, models: { removed: { name: 'Removed model' } } },
      other: { npm: '@ai-sdk/anthropic', models: { unchanged: { name: 'Unchanged model' } } },
    },
  };
  return { directory, pluginPath, settingsPath, settings, saveSettings, warnings, config, hooks: await plugin() };
}

test('OpenCode config hook replaces only models, strips untrusted fields, and keeps inference credentials private', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.config);
  const malicious = projection();
  malicious.options = { apiKey: f.settings.token };
  malicious.models['fixture-model'].options = { apiKey: f.settings.token };
  malicious.models['fixture-model'].provider = { api: 'https://attacker.invalid', npm: 'untrusted-package' };
  malicious.models['fixture-model'].headers = { authorization: f.settings.token };
  const requests = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, f.settings.endpoint);
    assert.equal(options.headers.authorization, `Bearer ${f.settings.token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(options).includes(before.provider['dhole-cpa'].options.apiKey));
    return Response.json(malicious);
  });
  assert.deepEqual(Object.keys(f.hooks), ['config']);
  await f.hooks.config(f.config);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, projection().models);
  before.provider['dhole-cpa'].models = projection().models;
  assert.deepEqual(f.config, before);
  assert.equal(requests.mock.callCount(), 1);
  assert.ok(!JSON.stringify(f.config).includes(f.settings.token));
  assert.deepEqual(f.warnings, []);
  assert.equal(JSON.parse(await readFile(f.settingsPath, 'utf8')).token, f.settings.token);
});

test('startup refresh applies additions, removals, and valid empty selection without saving a catalog', async (t) => {
  const f = await fixture(t);
  let body = projection();
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  await f.hooks.config(f.config);
  body = projection({ models: { added: { id: 'added', name: 'Added model' } } });
  await f.hooks.config(f.config);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, body.models);
  body = projection({ models: {} });
  await f.hooks.config(f.config);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
  assert.match(f.warnings.at(-1), /no selectable models/u);
});

test('server last-known metadata uses current policy and reports staleness with observation time', async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json(projection({ stale: true, status: 'error', error: { code: 'upstream_timeout', message: 'Upstream refresh failed' } })));
  await f.hooks.config(f.config);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, projection().models);
  assert.match(f.warnings[0], /stale/u);
  assert.ok(f.warnings[0].includes(observedAt));
});

test('reflected catalog credentials never become model metadata or a warning', async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json(projection({ models: { reflected: { id: 'reflected', name: f.settings.token } } })));
  await f.hooks.config(f.config);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
  assert.ok(!f.warnings.join().includes(f.settings.token));
});

test('unobserved or changed source never installs last-source metadata', async (t) => {
  for (const change of [{ sourceMatchesConnection: false }, { observedAt: null, status: 'unobserved' }]) {
    await t.test(JSON.stringify(change), async (t) => {
      const f = await fixture(t);
      t.mock.method(globalThis, 'fetch', async () => Response.json(projection(change)));
      await f.hooks.config(f.config);
      assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
      assert.match(f.warnings[0], /no observation/u);
    });
  }
});

test('bad responses clear controlled selection and never print transport bodies, tokens, or provider secrets', async (t) => {
  const cases = [
    ['unauthorized or revoked', () => new Response('secret-bearing upstream error', { status: 401 })],
    ['forbidden scope', () => new Response(null, { status: 403 })],
    ['unavailable', () => new Response(null, { status: 503 })],
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } })],
    ['malformed JSON', () => new Response('{')],
    ['wrong connection', () => Response.json(projection({ connectionId: 'other-team' }))],
    ['wrong client', () => Response.json(projection({ client: 'generic' }))],
    ['wrong version', () => Response.json(projection({ schemaVersion: 2 }))],
    ['ID mismatch', () => Response.json(projection({ models: { alias: { id: 'different', name: 'Invalid alias' } } }))],
    ['prototype key', () => Response.json(projection({ models: { constructor: { id: 'constructor', name: 'bad' } } }))],
    ['oversized stream', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); controller.close(); } }))],
    ['unbounded model list', () => Response.json(projection({ models: Object.fromEntries(Array.from({ length: 2_049 }, (_, i) => [`m${i}`, { id: `m${i}`, name: 'Model' }])) }))],
  ];
  for (const [label, response] of cases) await t.test(label, async (t) => {
    const f = await fixture(t);
    t.mock.method(globalThis, 'fetch', async () => response());
    await f.hooks.config(f.config);
    assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
    assert.match(f.warnings[0], /unavailable/u);
    for (const secret of [f.settings.token, f.config.provider['dhole-cpa'].options.apiKey, 'secret-bearing']) assert.ok(!f.warnings.join().includes(secret));
  });
});

test('private settings require owner-only regular files, exact scoped paths, and encrypted nonlocal transport', async (t) => {
  const cases = [
    ['public file', async (f) => chmod(f.settingsPath, 0o644)],
    ['symlink', async (f) => { const link = join(f.directory, 'link'); await symlink(f.settingsPath, link); process.env.DHOLE_OPENCODE_CATALOG_CONFIG = link; }],
    ['relative path', async () => { process.env.DHOLE_OPENCODE_CATALOG_CONFIG = 'relative.json'; }],
    ['HTTP nonlocal', async (f) => f.saveSettings({ endpoint: f.settings.endpoint.replace('https:', 'http:') })],
    ['wrong endpoint', async (f) => f.saveSettings({ endpoint: 'https://dhole.invalid/api/gateway/connections/connection-1' })],
    ['query credential', async (f) => f.saveSettings({ endpoint: `${f.settings.endpoint}?token=unsafe` })],
    ['embedded credentials', async (f) => f.saveSettings({ endpoint: f.settings.endpoint.replace('https://', 'https://user:password@') })],
    ['native provider', async (f) => f.saveSettings({ provider: 'openai' })],
  ];
  for (const [label, change] of cases) await t.test(label, async (t) => {
    const f = await fixture(t);
    const before = structuredClone(f.config);
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not run'); });
    await change(f);
    await f.hooks.config(f.config);
    assert.equal(request.mock.callCount(), 0);
    assert.deepEqual(f.config, before);
    assert.match(f.warnings[0], /unavailable/u);
  });
});

test('absent private settings do not affect OpenCode startup', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.config);
  delete process.env.DHOLE_OPENCODE_CATALOG_CONFIG;
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not run'); });
  await f.hooks.config(f.config);
  assert.deepEqual(f.config, before);
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(f.warnings, []);
});

test('whole-body deadline aborts a stalled local response', async (t) => {
  const f = await fixture(t);
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await f.saveSettings({ endpoint: `http://127.0.0.1:${server.address().port}/api/gateway/catalog/v1/connection-1/opencode` });
  const started = Date.now();
  await f.hooks.config(f.config);
  assert.ok(Date.now() - started < 7_000);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
  assert.match(f.warnings[0], /unavailable/u);
});

test('redirects never forward the catalog credential to an inference destination', async (t) => {
  const f = await fixture(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(302, { location: '/inference/v1/models' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await f.saveSettings({ endpoint: `http://127.0.0.1:${server.address().port}/api/gateway/catalog/v1/connection-1/opencode` });
  await f.hooks.config(f.config);
  assert.deepEqual(requests, ['/api/gateway/catalog/v1/connection-1/opencode']);
  assert.deepEqual(f.config.provider['dhole-cpa'].models, {});
  assert.match(f.warnings[0], /unavailable/u);
});

test('pinned OpenCode 1.18.27 loads the plugin and lists fixture metadata without inference', { skip: !process.env.DHOLE_TEST_OPENCODE }, async (t) => {
  const f = await fixture(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(projection()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/gateway/catalog/v1/connection-1/opencode`;
  await f.saveSettings({ endpoint });
  const configDirectory = join(f.directory, 'xdg-config/opencode');
  await mkdir(join(configDirectory, 'node_modules'), { recursive: true });
  const dependencies = { '@opencode-ai/plugin': '1.18.27' };
  await writeFile(join(configDirectory, 'package.json'), JSON.stringify({ dependencies }));
  await writeFile(join(configDirectory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies } } }));
  const config = { $schema: 'https://opencode.ai/config.json', ...f.config, plugin: [pathToFileURL(f.pluginPath).href], enabled_providers: ['dhole-cpa'], autoupdate: false };
  config.provider['dhole-cpa'].options.baseURL = `http://127.0.0.1:${server.address().port}/inference/v1`;
  const configPath = join(configDirectory, 'opencode.json');
  const serializedConfig = JSON.stringify(config);
  await writeFile(configPath, serializedConfig);
  const modelsPath = join(f.directory, 'models.json');
  await writeFile(modelsPath, '{}');
  const env = {
    PATH: process.env.PATH, XDG_CONFIG_HOME: join(f.directory, 'xdg-config'), XDG_DATA_HOME: join(f.directory, 'xdg-data'),
    XDG_CACHE_HOME: join(f.directory, 'xdg-cache'), XDG_STATE_HOME: join(f.directory, 'xdg-state'),
    OPENCODE_TEST_HOME: f.directory, OPENCODE_CONFIG: configPath, OPENCODE_MODELS_PATH: modelsPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_FFF: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', npm_config_offline: 'true',
    DHOLE_OPENCODE_CATALOG_CONFIG: f.settingsPath,
  };
  const options = { cwd: f.directory, env, timeout: 25_000, maxBuffer: 1024 * 1024 };
  const version = await execute(process.env.DHOLE_TEST_OPENCODE, ['--version'], options);
  assert.equal(version.stdout.trim(), '1.18.27');
  const result = await execute(process.env.DHOLE_TEST_OPENCODE, ['models', 'dhole-cpa', '--verbose'], options);
  assert.match(result.stdout, /dhole-cpa\/fixture-model/u);
  assert.match(result.stdout, /"context": 200000/u);
  assert.match(result.stdout, /"output": 32000/u);
  assert.ok(!result.stdout.includes('Removed model'));
  assert.ok(!result.stdout.includes(f.settings.token));
  assert.ok(!result.stderr.includes(f.settings.token));
  assert.deepEqual(requests, [{ path: '/api/gateway/catalog/v1/connection-1/opencode', authorization: `Bearer ${f.settings.token}` }]);
  assert.equal(await readFile(configPath, 'utf8'), serializedConfig);
});
