import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_BYTES = 512 * 1024;
const Key = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const Time = z.iso.datetime().nullable();
const Count = z.number().int().min(1).max(100_000_000);
const Modality = z.enum(['text', 'image', 'audio', 'video']);
const Model = z.object({
  id: Key,
  name: z.string().trim().min(1).max(240),
  limit: z.object({ context: Count.optional(), output: Count.optional() }).optional(),
  modalities: z.object({
    input: z.array(Modality).max(4).optional(),
    output: z.array(Modality).max(4).optional(),
  }).optional(),
});
const Projection = z.object({
  schemaVersion: z.literal(1), client: z.literal('opencode'),
  connectionId: Key, providerId: Key,
  observedAt: Time, lastAttemptAt: Time, lastSuccessAt: Time,
  stale: z.boolean(), status: z.enum(['current', 'stale', 'error', 'unobserved']),
  sourceMatchesConnection: z.boolean(),
  snapshotId: Key.nullable(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  error: z.object({ code: z.string().max(120), message: z.string().max(500) }).nullable(),
  models: z.record(Key, Model).refine((models) => Object.keys(models).length <= 2_048)
    .refine((models) => Object.entries(models).every(([key, model]) => key === model.id)),
});
const Settings = z.object({
  schemaVersion: z.literal(1),
  provider: z.string().regex(/^dhole-[a-z0-9][a-z0-9-]{0,79}$/u),
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,240}$/u),
  endpoint: z.url().max(2_048),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,160}$/u),
}).strict().refine((settings) => {
  const url = new URL(settings.endpoint);
  return !url.username && !url.password && !url.search && !url.hash
    && url.pathname === `/api/gateway/catalog/v1/${settings.connectionId}/opencode`
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
});

async function readSettings(path) {
  if (!isAbsolute(path)) throw new Error('Invalid private settings');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8_192
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid private settings');
    const buffer = Buffer.alloc(8_193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8_192) throw new Error('Invalid private settings');
    return Settings.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await file.close();
  }
}

async function fetchProjection(settings) {
  const response = await fetch(settings.endpoint, {
    headers: { authorization: `Bearer ${settings.token}`, accept: 'application/json' },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Catalog unavailable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Catalog too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const catalog = Projection.parse(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  if (catalog.connectionId !== settings.connectionId || JSON.stringify(catalog).includes(settings.token)) {
    throw new Error('Invalid catalog scope');
  }
  return catalog;
}

// OpenCode 1.18.27 invokes this hook before it reads provider configuration.
export default async function DholeCatalogPlugin() {
  return {
    async config(config) {
      const path = process.env.DHOLE_OPENCODE_CATALOG_CONFIG;
      if (!path) return;
      let provider;
      try {
        const settings = await readSettings(path);
        provider = config?.provider?.[settings.provider];
        if (!z.object({ npm: z.literal('@ai-sdk/openai-compatible') }).safeParse(provider).success) {
          provider = undefined;
          throw new Error('Configure a dedicated Dhole provider');
        }
        // This provider's selection is owned by the current scoped projection.
        provider.models = {};
        const catalog = await fetchProjection(settings);
        if (!catalog.sourceMatchesConnection || !catalog.observedAt || catalog.status === 'unobserved') {
          console.warn('Dhole catalog has no observation for the current source; its model selection is empty.');
          return;
        }
        provider.models = catalog.models;
        if (catalog.stale || catalog.status !== 'current') {
          console.warn(`Dhole catalog is stale; model metadata was observed at ${catalog.observedAt}. Restart OpenCode after refreshing Dhole.`);
        } else if (Object.keys(catalog.models).length === 0) {
          console.warn('Dhole catalog has no selectable models. Check the connection and model policy in Dhole.');
        }
      } catch {
        if (provider) provider.models = {};
        console.warn(provider
          ? 'Dhole catalog unavailable; its model selection is empty. Check the scoped token and server status.'
          : 'Dhole catalog unavailable. Check private settings, owner-only file permissions, and the dedicated provider configuration.');
      }
    },
  };
}
