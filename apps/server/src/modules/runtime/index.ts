import { z } from 'zod';
import type { Context } from 'hono';
import { RuntimeDescriptorSchema } from '@dhole-control/shared';
import { encryptSecret, redactText } from '../../lib/security.js';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, AuthenticatedUser, DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { auditAllowed, requireAdministrator } from '../core/index.js';

const ProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().min(1).max(80),
  baseUrl: providerBaseUrlSchema().optional(),
  enabled: z.boolean().optional().default(true),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  secret: z.string().min(1).max(100_000).optional(),
  secretLabel: z.string().min(1).max(120).optional().default('default'),
});
const ProviderPatchSchema = ProviderInputSchema.partial();
const SecretInputSchema = z.object({ label: z.string().min(1).max(120), value: z.string().min(1).max(100_000) });
const ModelInputSchema = z.object({
  modelKey: z.string().min(1).max(240),
  displayName: z.string().min(1).max(240).optional(),
  declaredCapabilities: z.record(z.string(), z.boolean()).optional().default({}),
  enabled: z.boolean().optional().default(false),
});
const ModelImportSchema = z.object({ providerId: z.string().min(1).max(160), models: z.array(ModelInputSchema).max(10_000) });
const ProbeSchema = z.object({
  capabilities: z.record(z.string(), z.enum(['supported', 'unsupported', 'unknown'])).optional().default({}),
  latencyMs: z.number().int().nonnegative().max(86_400_000).optional(),
  errorSummary: z.string().max(500).optional(),
  evidence: z.record(z.string(), z.unknown()).optional().default({}),
});
const RegistrationSchema = z.object({ machineId: z.string().min(1).max(160), descriptor: RuntimeDescriptorSchema });

type UserContext = Context<AppEnvironment>;

function userOf(context: UserContext): AuthenticatedUser {
  const user = context.get('user');
  if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return user;
}

function sanitizeConfig(value: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /(?:secret|token|password|authorization|api[-_]?key|credential|private[-_]?key)/i;
  const sanitize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((entry) => sanitize(entry));
    if (item && typeof item === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
        if (sensitive.test(key)) continue;
        output[key] = sanitize(nested);
      }
      return output;
    }
    if (typeof item === 'string') return redactConfigString(item);
    return item;
  };
  return sanitize(value) as Record<string, unknown>;
}

function redactConfigString(value: string): string {
  // Config values may contain endpoint URLs under arbitrary keys. Remove URL
  // userinfo before returning or persisting configuration metadata.
  const withoutCredentials = value.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, '$1');
  return redactText(withoutCredentials, 2_000);
}

const sensitiveRegistrationAssignment = /((?:secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;"']+)/giu;

function redactRegistrationText(value: string, maxLength: number): string {
  return redactConfigString(value).replace(sensitiveRegistrationAssignment, '$1[REDACTED]').slice(0, maxLength);
}

function configFromJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return sanitizeConfig(parsed as Record<string, unknown>);
  } catch {
    // Corrupt legacy config is treated as empty metadata until replaced.
  }
  return {};
}

function providerBaseUrlSchema(): z.ZodType<string> {
  return z.string().trim().max(500).superRefine((value, issueContext) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      issueContext.addIssue({ code: 'custom', message: 'Provider base URL must be a valid URL' });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      issueContext.addIssue({ code: 'custom', message: 'Provider base URL must use HTTP or HTTPS' });
    }
    if (parsed.username || parsed.password) {
      issueContext.addIssue({ code: 'custom', message: 'Provider base URL must not include credentials' });
    }
  });
}

function publicProviderBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.username && !parsed.password) return value.trim();
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function iso(context: ServerContext): string { return context.clock.now().toISOString(); }

function auditRuntimeMutation(
  context: ServerContext,
  user: AuthenticatedUser,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
): void {
  // Runtime audit details are metadata only. Recursively sanitize as a final
  // guard so a future caller cannot place credentials, URLs with userinfo, or
  // evidence bodies into immutable audit history.
  auditAllowed(context, user, action, targetType, targetId, sanitizeConfig(detail));
}

function providerRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: publicProviderBaseUrl(row.base_url),
    enabled: Boolean(row.enabled),
    config: configFromJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelKey: row.model_key,
    displayName: row.display_name,
    declaredCapabilities: JSON.parse(String(row.declared_capabilities_json ?? '{}')) as Record<string, unknown>,
    measuredCapabilities: JSON.parse(String(row.measured_capabilities_json ?? '{}')) as Record<string, unknown>,
    catalogObservedAt: row.catalog_observed_at,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function machineInTeam(context: ServerContext, machineId: string, teamId: string): boolean {
  return Boolean(context.database.prepare('SELECT 1 FROM machines WHERE id = ? AND team_id = ?').get(machineId, teamId));
}

function providerInTeam(context: ServerContext, providerId: string, teamId: string): boolean {
  return Boolean(context.database.prepare('SELECT 1 FROM providers WHERE id = ? AND team_id = ?').get(providerId, teamId));
}

function modelInTeam(context: ServerContext, modelId: string, teamId: string): boolean {
  return Boolean(context.database.prepare('SELECT 1 FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND p.team_id = ?').get(modelId, teamId));
}

export const runtimeModule: DholeModule = {
  id: 'runtime',
  register(app: DholeApp, context: ServerContext): void {
    // Every endpoint in this module mutates or reveals provider/runtime configuration.
    // Core owns cookie/session parsing and the administrator role check.
    app.use('/api/runtime/*', requireAdministrator());

    app.get('/api/runtime/providers', (c) => {
      const user = userOf(c);
      const rows = context.database.prepare('SELECT * FROM providers WHERE team_id = ? ORDER BY name').all(user.teamId) as Record<string, unknown>[];
      return c.json({ providers: rows.map(providerRow) });
    });

    app.post('/api/runtime/providers', async (c) => {
      const user = userOf(c);
      const input = await parseJson(c, ProviderInputSchema);
      const id = context.ids.id();
      const now = iso(context);
      const config = sanitizeConfig(input.config);
      const row = context.database.transaction(() => {
        context.database.prepare('INSERT INTO providers(id, team_id, kind, name, base_url, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.teamId, input.kind, input.name, input.baseUrl ?? null, input.enabled ? 1 : 0, JSON.stringify(config), now, now);
        const secretId = input.secret ? saveSecret(context, id, input.secretLabel, input.secret) : undefined;
        auditRuntimeMutation(context, user, 'runtime.provider.create', 'provider', id, { kind: input.kind, enabled: input.enabled, secretStored: Boolean(secretId), baseUrlConfigured: Boolean(input.baseUrl) });
        if (secretId) auditRuntimeMutation(context, user, 'runtime.provider_secret.store', 'provider_secret', secretId, { providerId: id });
        return context.database.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
      })();
      return c.json(providerRow(row), 201);
    });

    app.patch('/api/runtime/providers/:providerId', async (c) => {
      const user = userOf(c);
      const providerId = c.req.param('providerId');
      if (!providerInTeam(context, providerId, user.teamId)) throw new HttpError(404, 'not_found', 'Provider not found');
      const input = await parseJson(c, ProviderPatchSchema);
      const current = context.database.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as Record<string, unknown>;
      const config = input.config ? sanitizeConfig(input.config) : configFromJson(current.config_json);
      const baseUrl = input.baseUrl === undefined ? publicProviderBaseUrl(current.base_url) : input.baseUrl;
      const now = iso(context);
      const row = context.database.transaction(() => {
        context.database.prepare('UPDATE providers SET kind = ?, name = ?, base_url = ?, enabled = ?, config_json = ?, updated_at = ? WHERE id = ?').run(input.kind ?? current.kind, input.name ?? current.name, baseUrl, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, JSON.stringify(config), now, providerId);
        const secretLabel = input.secretLabel ?? 'default';
        const priorSecret = input.secret ? context.database.prepare('SELECT id FROM provider_secrets WHERE provider_id = ? AND machine_id IS NULL AND label = ?').get(providerId, secretLabel) as { id: string } | undefined : undefined;
        const secretId = input.secret ? saveSecret(context, providerId, secretLabel, input.secret) : undefined;
        auditRuntimeMutation(context, user, 'runtime.provider.update', 'provider', providerId, { kind: input.kind ?? current.kind, enabled: input.enabled ?? Boolean(current.enabled), secretUpdated: Boolean(secretId), baseUrlConfigured: input.baseUrl !== undefined });
        if (secretId) auditRuntimeMutation(context, user, priorSecret ? 'runtime.provider_secret.rotate' : 'runtime.provider_secret.store', 'provider_secret', secretId, { providerId });
        return context.database.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as Record<string, unknown>;
      })();
      return c.json(providerRow(row));
    });

    app.post('/api/runtime/providers/:providerId/secrets', async (c) => {
      const user = userOf(c);
      const providerId = c.req.param('providerId');
      if (!providerInTeam(context, providerId, user.teamId)) throw new HttpError(404, 'not_found', 'Provider not found');
      const input = await parseJson(c, SecretInputSchema);
      const id = context.database.transaction(() => {
        const prior = context.database.prepare('SELECT id FROM provider_secrets WHERE provider_id = ? AND machine_id IS NULL AND label = ?').get(providerId, input.label) as { id: string } | undefined;
        const secretId = saveSecret(context, providerId, input.label, input.value);
        auditRuntimeMutation(context, user, prior ? 'runtime.provider_secret.rotate' : 'runtime.provider_secret.store', 'provider_secret', secretId, { providerId });
        return secretId;
      })();
      return c.json({ id, label: input.label, stored: true }, 201);
    });

    app.get('/api/runtime/providers/:providerId/secrets', (c) => {
      const user = userOf(c);
      const providerId = c.req.param('providerId');
      if (!providerInTeam(context, providerId, user.teamId)) throw new HttpError(404, 'not_found', 'Provider not found');
      const rows = context.database.prepare('SELECT id, label, created_at, rotated_at, revoked_at FROM provider_secrets WHERE provider_id = ? ORDER BY label').all(providerId) as Record<string, unknown>[];
      return c.json({ secrets: rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, rotatedAt: row.rotated_at, revoked: Boolean(row.revoked_at) })) });
    });

    app.get('/api/runtime/models', (c) => {
      const user = userOf(c);
      const rows = context.database.prepare('SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id WHERE p.team_id = ? ORDER BY p.name, m.model_key').all(user.teamId) as Record<string, unknown>[];
      return c.json({ models: rows.map(modelRow) });
    });

    app.post('/api/runtime/models/import', async (c) => {
      const user = userOf(c);
      const input = await parseJson(c, ModelImportSchema);
      if (!providerInTeam(context, input.providerId, user.teamId)) throw new HttpError(404, 'not_found', 'Provider not found');
      const imported = importModels(context, input.providerId, input.models, () => auditRuntimeMutation(context, user, 'runtime.models.import', 'provider', input.providerId, { count: input.models.length }));
      return c.json({ models: imported.map(modelRow) }, 201);
    });

    app.post('/api/runtime/providers/:providerId/models/import', async (c) => {
      const user = userOf(c);
      const providerId = c.req.param('providerId');
      if (!providerInTeam(context, providerId, user.teamId)) throw new HttpError(404, 'not_found', 'Provider not found');
      const body = await parseJson(c, z.object({ models: z.array(ModelInputSchema).max(10_000) }));
      return c.json({ models: importModels(context, providerId, body.models, () => auditRuntimeMutation(context, user, 'runtime.models.import', 'provider', providerId, { count: body.models.length })).map(modelRow) }, 201);
    });

    app.post('/api/runtime/models/:modelId/probe', async (c) => {
      const user = userOf(c);
      const modelId = c.req.param('modelId');
      if (!modelInTeam(context, modelId, user.teamId)) throw new HttpError(404, 'not_found', 'Model not found');
      const input = await parseJson(c, ProbeSchema);
      const observedAt = iso(context);
      const model = context.database.prepare('SELECT measured_capabilities_json FROM models WHERE id = ?').get(modelId) as { measured_capabilities_json: string };
      const measured = JSON.parse(model.measured_capabilities_json || '{}') as Record<string, string>;
      const capabilities = Object.keys(input.capabilities).length ? input.capabilities : { toolCalling: 'unknown', structuredOutput: 'unknown', imageInput: 'unknown' };
      const evidence = sanitizeConfig(input.evidence);
      const errorSummary = input.errorSummary === undefined ? null : redactConfigString(input.errorSummary);
      const insert = context.database.prepare('INSERT INTO model_capability_probes(id, model_id, capability, outcome, latency_ms, error_summary, evidence_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      context.database.transaction(() => {
        for (const [capability, outcome] of Object.entries(capabilities)) {
          measured[capability] = outcome;
          insert.run(context.ids.id(), modelId, capability, outcome, input.latencyMs ?? null, errorSummary, JSON.stringify({ ...evidence, source: 'probe', verified: false }), observedAt);
        }
        context.database.prepare('UPDATE models SET measured_capabilities_json = ?, catalog_observed_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(measured), observedAt, observedAt, modelId);
        auditRuntimeMutation(context, user, 'runtime.model.probe', 'model', modelId, { capabilities: Object.keys(capabilities), evidenceProvided: Object.keys(input.evidence).length > 0, errorSummaryProvided: input.errorSummary !== undefined });
      })();
      return c.json({ model: modelRow(context.database.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as Record<string, unknown>), probes: capabilities });
    });

    app.get('/api/runtime/registrations', (c) => {
      const user = userOf(c);
      const machineId = c.req.query('machineId');
      const rows = context.database.prepare(`SELECT r.* FROM runtime_registrations r JOIN machines m ON m.id = r.machine_id WHERE m.team_id = ? ${machineId ? 'AND m.id = ?' : ''} ORDER BY m.name, r.label`).all(...(machineId ? [user.teamId, machineId] : [user.teamId])) as Record<string, unknown>[];
      return c.json({ registrations: rows.map(registrationRow) });
    });

    app.post('/api/runtime/registrations', async (c) => {
      const user = userOf(c);
      const input = await parseJson(c, RegistrationSchema);
      if (!machineInTeam(context, input.machineId, user.teamId)) throw new HttpError(404, 'not_found', 'Machine not found');
      const now = iso(context);
      const id = context.ids.id();
      const registration = input.descriptor;
      const row = context.database.transaction(() => {
        context.database.prepare(`INSERT INTO runtime_registrations(id, machine_id, kind, label, protocol_version, capabilities_json, executable_reference, observed_version, available, unavailable_reason, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(machine_id, kind, label) DO UPDATE SET protocol_version = excluded.protocol_version, capabilities_json = excluded.capabilities_json, executable_reference = excluded.executable_reference, observed_version = excluded.observed_version, available = excluded.available, unavailable_reason = excluded.unavailable_reason, observed_at = excluded.observed_at`).run(id, input.machineId, registration.kind, registration.label, registration.protocolVersion, JSON.stringify(registration.capabilities), registration.availability.executable ?? null, registration.availability.version ?? null, registration.availability.available ? 1 : 0, registration.availability.reason ?? null, now);
        const result = context.database.prepare('SELECT * FROM runtime_registrations WHERE machine_id = ? AND kind = ? AND label = ?').get(input.machineId, registration.kind, registration.label) as Record<string, unknown>;
        auditRuntimeMutation(context, user, 'runtime.registration.upsert', 'runtime_registration', String(result.id), { machineId: input.machineId, kind: registration.kind, available: registration.availability.available });
        return result;
      })();
      return c.json(registrationRow(row), 201);
    });
  },
};

function saveSecret(context: ServerContext, providerId: string, label: string, value: string): string {
  const encrypted = encryptSecret(context.config, value, `providers:${providerId}:${label}`);
  const now = iso(context);
  const existing = context.database.prepare('SELECT id FROM provider_secrets WHERE provider_id = ? AND machine_id IS NULL AND label = ?').get(providerId, label) as { id: string } | undefined;
  if (existing) {
    context.database.prepare('UPDATE provider_secrets SET key_id = ?, nonce = ?, ciphertext = ?, auth_tag = ?, rotated_at = ? WHERE id = ?').run(encrypted.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, existing.id);
    return existing.id;
  }
  const id = context.ids.id();
  context.database.prepare('INSERT INTO provider_secrets(id, provider_id, machine_id, label, key_id, nonce, ciphertext, auth_tag, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(id, providerId, label, encrypted.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now);
  return id;
}

function importModels(context: ServerContext, providerId: string, models: z.infer<typeof ModelInputSchema>[], afterImport?: () => void): Record<string, unknown>[] {
  const now = iso(context);
  const upsert = context.database.prepare(`INSERT INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    ON CONFLICT(provider_id, model_key) DO UPDATE SET display_name = excluded.display_name, declared_capabilities_json = excluded.declared_capabilities_json, catalog_observed_at = excluded.catalog_observed_at, enabled = excluded.enabled, updated_at = excluded.updated_at`);
  context.database.transaction(() => {
    for (const model of models) upsert.run(context.ids.id(), providerId, model.modelKey, model.displayName ?? model.modelKey, JSON.stringify(model.declaredCapabilities), now, model.enabled ? 1 : 0, now, now);
    afterImport?.();
  })();
  return context.database.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY model_key').all(providerId) as Record<string, unknown>[];
}

function registrationRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    machineId: row.machine_id,
    kind: row.kind,
    label: row.label,
    protocolVersion: row.protocol_version,
    capabilities: JSON.parse(String(row.capabilities_json ?? '{}')) as Record<string, unknown>,
    availability: {
      available: Boolean(row.available),
      // Executable references are node-local paths and must never cross the
      // server/browser response boundary. Keep them in SQLite for placement
      // and diagnostics, but omit them from every public registration shape.
      ...(row.observed_version ? { version: redactRegistrationText(String(row.observed_version), 120) } : {}),
      ...(row.unavailable_reason ? { reason: redactRegistrationText(String(row.unavailable_reason), 500) } : {}),
    },
    observedAt: row.observed_at,
  };
}
