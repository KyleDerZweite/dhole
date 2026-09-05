import { afterEach, describe, expect, it } from 'vitest';
import { createApplication, type DholeApplication } from '../../../app.js';
import type { AppConfig } from '../../../lib/config.js';
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, DEMO_IDS } from '../../../demo/index.js';

const applications: DholeApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

function config(): AppConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 4173,
    databasePath: ':memory:',
    publicOrigin: new URL('http://127.0.0.1:4173'),
    sourceUrl: new URL('https://github.com/KyleDerZweite/dhole'),
    allowedHosts: new Set(['127.0.0.1']),
    demo: true,
    masterKeys: new Map([['v1', Buffer.alloc(32, 4)]]) as ReadonlyMap<string, Buffer>,
    currentMasterKeyId: 'v1',
    gatewayAllowedHosts: new Set(['127.0.0.1', 'localhost']),
  };
}

async function authenticated(application: DholeApplication): Promise<{ cookie: string; csrf: string }> {
  const response = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
    method: 'POST',
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  return {
    csrf: body.csrfToken,
    cookie: values.flatMap((value) => value.split(/,(?=\s*dhole_)/u)).map((value) => value.split(';')[0]).join('; '),
  };
}

function auditRows(application: DholeApplication, action: string): Array<Record<string, unknown>> {
  return application.context.database.prepare('SELECT actor_id, action, target_type, target_id, outcome, detail_json FROM audit_records WHERE action = ? ORDER BY occurred_at').all(action) as Array<Record<string, unknown>>;
}

describe('runtime provider boundaries', () => {
  it('rejects credentialed and non-http provider base URLs before persistence', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const headers = { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };

    for (const baseUrl of ['https://alice:secret@example.invalid/v1', 'ftp://example.invalid/provider']) {
      const response = await application.app.request('http://127.0.0.1:4173/api/runtime/providers', {
        method: 'POST', headers, body: JSON.stringify({ name: `Invalid ${baseUrl}`, kind: 'openai-compatible', baseUrl }),
      });
      expect(response.status).toBe(422);
    }
    expect(application.context.database.prepare('SELECT count(*) AS count FROM providers WHERE name LIKE ?').get('Invalid %')).toEqual({ count: 0 });
    expect(auditRows(application, 'runtime.provider.create')).toHaveLength(0);
  });

  it('accepts normal provider URLs and redacts config and legacy URL credentials in responses', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const headers = { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };
    const response = await application.app.request('http://127.0.0.1:4173/api/runtime/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Local Fixture',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9999/v1',
        config: {
          apiKey: 'do-not-return',
          endpoint: 'https://alice:secret@example.invalid/v1',
          nested: [{ password: 'also-secret', label: 'ok' }],
        },
      }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; baseUrl: string; config: Record<string, unknown> };
    expect(created.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(JSON.stringify(created)).not.toContain('do-not-return');
    expect(JSON.stringify(created)).not.toContain('alice:secret');
    expect(JSON.stringify(created)).not.toContain('also-secret');
    const providerAudit = auditRows(application, 'runtime.provider.create').at(-1);
    expect(providerAudit).toMatchObject({ actor_id: 'demo-user-admin', action: 'runtime.provider.create', target_type: 'provider', target_id: created.id, outcome: 'allowed' });
    expect(String(providerAudit?.detail_json)).not.toContain('do-not-return');
    expect(String(providerAudit?.detail_json)).not.toContain('alice:secret');

    const now = application.context.clock.now().toISOString();
    application.context.database.prepare('INSERT INTO providers(id, team_id, kind, name, base_url, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(
      'legacy-provider', 'demo-team', 'openai-compatible', 'Legacy Provider', 'https://legacy-user:legacy-pass@example.invalid/v1', JSON.stringify({ endpoint: 'https://legacy-user:legacy-pass@example.invalid', token: 'legacy-token' }), now, now,
    );
    const patched = await application.app.request('http://127.0.0.1:4173/api/runtime/providers/legacy-provider', {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Legacy Provider Updated' }),
    });
    expect(patched.status).toBe(200);
    const providerUpdateAudit = auditRows(application, 'runtime.provider.update').at(-1);
    expect(providerUpdateAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'provider', target_id: 'legacy-provider', outcome: 'allowed' });
    const persisted = application.context.database.prepare('SELECT base_url, config_json FROM providers WHERE id = ?').get('legacy-provider') as { base_url: string | null; config_json: string };
    expect(persisted.base_url).toBe('https://example.invalid/v1');
    expect(persisted.base_url).not.toContain('legacy-user');
    expect(persisted.config_json).not.toContain('legacy-user');
    expect(persisted.config_json).not.toContain('legacy-token');
    const listed = await application.app.request('http://127.0.0.1:4173/api/runtime/providers', { headers: { host: '127.0.0.1', cookie: auth.cookie } });
    expect(listed.status).toBe(200);
    const payload = await listed.json() as { providers: Array<{ name: string; baseUrl: string | null; config: Record<string, unknown> }> };
    const legacy = payload.providers.find((provider) => provider.name === 'Legacy Provider Updated');
    expect(legacy).toMatchObject({ baseUrl: 'https://example.invalid/v1' });
    expect(JSON.stringify(legacy)).not.toContain('legacy-user');
    expect(JSON.stringify(legacy)).not.toContain('legacy-pass');
    expect(JSON.stringify(legacy)).not.toContain('legacy-token');
  });

  it('redacts model probe evidence and error summaries before persistence', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const response = await application.app.request(`http://127.0.0.1:4173/api/runtime/models/${DEMO_IDS.modelOpenAI}/probe`, {
      method: 'POST',
      headers: { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: { toolCalling: 'supported' },
        errorSummary: 'Bearer probe-secret https://probe-user:probe-pass@example.invalid',
        evidence: {
          apiKey: 'evidence-secret',
          endpoint: 'https://evidence-user:evidence-pass@example.invalid/v1',
          nested: [{ token: 'nested-secret', note: 'safe' }],
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('probe-secret');
    expect(body).not.toContain('probe-user');
    expect(body).not.toContain('evidence-secret');
    expect(body).not.toContain('evidence-user');
    expect(body).not.toContain('nested-secret');

    const row = application.context.database.prepare('SELECT error_summary, evidence_json FROM model_capability_probes WHERE model_id = ? ORDER BY observed_at DESC LIMIT 1').get(DEMO_IDS.modelOpenAI) as { error_summary: string | null; evidence_json: string };
    expect(row.error_summary).not.toContain('probe-secret');
    expect(row.error_summary).not.toContain('probe-user');
    expect(row.evidence_json).not.toContain('evidence-secret');
    expect(row.evidence_json).not.toContain('evidence-user');
    expect(row.evidence_json).not.toContain('nested-secret');
    const probeAudit = auditRows(application, 'runtime.model.probe').at(-1);
    expect(probeAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'model', target_id: DEMO_IDS.modelOpenAI, outcome: 'allowed' });
    expect(String(probeAudit?.detail_json)).not.toContain('probe-secret');
    expect(String(probeAudit?.detail_json)).not.toContain('evidence-secret');
    expect(String(probeAudit?.detail_json)).not.toContain('probe-user');
  });

  it('audits provider secret rotation and model import without sensitive detail', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const headers = { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };
    const secret = await application.app.request(`http://127.0.0.1:4173/api/runtime/providers/${DEMO_IDS.providerOpenAI}/secrets`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'primary', value: 'initial-provider-secret' }),
    });
    expect(secret.status).toBe(201);
    const secretId = (await secret.json() as { id: string }).id;
    const storedCiphertext = (application.context.database.prepare('SELECT ciphertext FROM provider_secrets WHERE id = ?').get(secretId) as { ciphertext: string }).ciphertext;
    const storedAudit = auditRows(application, 'runtime.provider_secret.store').at(-1);
    expect(storedAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'provider_secret', target_id: secretId, outcome: 'allowed' });
    expect(String(storedAudit?.detail_json)).not.toContain('initial-provider-secret');
    expect(String(storedAudit?.detail_json)).not.toContain(storedCiphertext);

    const rotated = await application.app.request(`http://127.0.0.1:4173/api/runtime/providers/${DEMO_IDS.providerOpenAI}/secrets`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'primary', value: 'rotated-provider-secret' }),
    });
    expect(rotated.status).toBe(201);
    expect((await rotated.json() as { id: string }).id).toBe(secretId);
    const rotatedAudit = auditRows(application, 'runtime.provider_secret.rotate').at(-1);
    expect(rotatedAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'provider_secret', target_id: secretId, outcome: 'allowed' });
    expect(String(rotatedAudit?.detail_json)).not.toContain('rotated-provider-secret');

    const imported = await application.app.request('http://127.0.0.1:4173/api/runtime/models/import', {
      method: 'POST', headers, body: JSON.stringify({ providerId: DEMO_IDS.providerOpenAI, models: [{ modelKey: 'audit-model', displayName: 'Audit model', declaredCapabilities: { text: true }, enabled: false }] }),
    });
    expect(imported.status).toBe(201);
    const importAudit = auditRows(application, 'runtime.models.import').at(-1);
    expect(importAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'provider', target_id: DEMO_IDS.providerOpenAI, outcome: 'allowed' });
    expect(String(importAudit?.detail_json)).toContain('"count":1');
    expect(String(importAudit?.detail_json)).not.toContain('audit-model');
  });

  it('rolls back runtime mutations when the immutable audit append fails', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const headers = { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' };
    application.context.database.exec("CREATE TRIGGER runtime_audit_failure BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT, 'runtime audit failure'); END");
    const response = await application.app.request('http://127.0.0.1:4173/api/runtime/providers', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Rolled back provider', kind: 'openai-compatible', baseUrl: 'https://example.invalid/v1' }),
    });
    expect(response.status).toBe(500);
    expect(application.context.database.prepare('SELECT count(*) AS count FROM providers WHERE name = ?').get('Rolled back provider')).toEqual({ count: 0 });
  });

  it('does not serialize node-local executable paths in registration responses', async () => {
    const application = createApplication({ config: config(), seed: true });
    applications.push(application);
    const auth = await authenticated(application);
    const privateExecutable = '/home/demo/.local/bin/codex';
    application.context.database.prepare('UPDATE runtime_registrations SET executable_reference = ? WHERE id = ?').run(privateExecutable, DEMO_IDS.runtimeCodex);

    const listed = await application.app.request('http://127.0.0.1:4173/api/runtime/registrations', {
      headers: { host: '127.0.0.1', cookie: auth.cookie },
    });
    expect(listed.status).toBe(200);
    const listedBody = JSON.stringify(await listed.json());
    expect(listedBody).not.toContain(privateExecutable);
    expect(listedBody).not.toContain('executable');

    const created = await application.app.request('http://127.0.0.1:4173/api/runtime/registrations', {
      method: 'POST',
      headers: { host: '127.0.0.1', cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: DEMO_IDS.machine,
        descriptor: {
          id: 'path-runtime-registration',
          kind: 'openai-compatible',
          label: 'Path Runtime',
          protocolVersion: 'fixture.v1',
          capabilities: {
            sessionCreation: true,
            sessionResume: true,
            nextTurnMessage: true,
            activeTurnSteering: false,
            cancellation: true,
            approvalResponses: true,
            historyReplay: true,
            structuredToolEvents: true,
            nativeSubagentObservation: false,
            imageInput: false,
            structuredOutput: true,
            repositoryEditing: true,
            terminalTools: true,
          },
          availability: { available: true, executable: privateExecutable, version: 'Bearer version-secret', reason: 'Authorization=reason-secret' },
        },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = JSON.stringify(await created.json());
    expect(createdBody).not.toContain(privateExecutable);
    expect(createdBody).not.toContain('executable');
    expect(createdBody).not.toContain('version-secret');
    expect(createdBody).not.toContain('reason-secret');
    const registrationRow = application.context.database.prepare('SELECT id, executable_reference FROM runtime_registrations WHERE machine_id = ? AND label = ?').get(DEMO_IDS.machine, 'Path Runtime') as { id: string; executable_reference: string };
    expect(registrationRow.executable_reference).toBe(privateExecutable);
    const registrationAudit = auditRows(application, 'runtime.registration.upsert').at(-1);
    expect(registrationAudit).toMatchObject({ actor_id: 'demo-user-admin', target_type: 'runtime_registration', target_id: registrationRow.id, outcome: 'allowed' });
    expect(String(registrationAudit?.detail_json)).not.toContain(privateExecutable);
  });
});
