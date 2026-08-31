import { resolve } from 'node:path';
import { z } from 'zod';

const BooleanStringSchema = z
  .enum(['0', '1', 'false', 'true'])
  .optional()
  .transform((value) => value === '1' || value === 'true');

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DHOLE_HOST: z.string().default('127.0.0.1'),
  DHOLE_PORT: z.coerce.number().int().min(1).max(65_535).default(4173),
  DHOLE_DATABASE: z.string().default('./data/dhole.db'),
  DHOLE_PUBLIC_ORIGIN: z.url().default('http://127.0.0.1:4173'),
  DHOLE_SOURCE_URL: z.url().optional(),
  DHOLE_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
  DHOLE_DEMO: BooleanStringSchema,
  DHOLE_MASTER_KEYS: z.string().optional(),
  DHOLE_MASTER_KEY_ID: z.string().min(1).max(80).optional(),
  DHOLE_GATEWAY_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
});

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  publicOrigin: URL;
  sourceUrl?: URL | undefined;
  allowedHosts: ReadonlySet<string>;
  demo: boolean;
  masterKeys: ReadonlyMap<string, Buffer>;
  currentMasterKeyId?: string | undefined;
  gatewayAllowedHosts: ReadonlySet<string>;
}

function parseMasterKeys(raw: string | undefined): ReadonlyMap<string, Buffer> {
  if (!raw) return new Map();
  const parsed = z.record(z.string(), z.string()).parse(JSON.parse(raw));
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(parsed)) {
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) throw new Error(`Master key ${id} must decode to exactly 32 bytes`);
    keys.set(id, key);
  }
  return keys;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = EnvironmentSchema.parse(environment);
  const masterKeys = parseMasterKeys(raw.DHOLE_MASTER_KEYS);
  const publicOrigin = new URL(raw.DHOLE_PUBLIC_ORIGIN);
  const sourceUrl = raw.DHOLE_SOURCE_URL ? new URL(raw.DHOLE_SOURCE_URL) : undefined;
  if (sourceUrl && (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password)) {
    throw new Error('DHOLE_SOURCE_URL must be an http(s) URL without credentials');
  }
  if (raw.NODE_ENV === 'production' && (!raw.DHOLE_MASTER_KEY_ID || !masterKeys.has(raw.DHOLE_MASTER_KEY_ID))) {
    throw new Error('Production requires DHOLE_MASTER_KEY_ID and a matching key in DHOLE_MASTER_KEYS');
  }
  if (raw.NODE_ENV === 'production' && publicOrigin.protocol !== 'https:') {
    throw new Error('Production requires an HTTPS DHOLE_PUBLIC_ORIGIN');
  }
  if (raw.NODE_ENV === 'production' && (!sourceUrl || sourceUrl.protocol !== 'https:')) {
    throw new Error('Production requires an HTTPS DHOLE_SOURCE_URL for corresponding source');
  }
  return {
    environment: raw.NODE_ENV,
    host: raw.DHOLE_HOST,
    port: raw.DHOLE_PORT,
    databasePath: raw.DHOLE_DATABASE === ':memory:' ? ':memory:' : resolve(raw.DHOLE_DATABASE),
    publicOrigin,
    ...(sourceUrl ? { sourceUrl } : {}),
    allowedHosts: new Set(raw.DHOLE_ALLOWED_HOSTS.split(',').map((value) => value.trim()).filter(Boolean)),
    demo: raw.DHOLE_DEMO,
    masterKeys,
    currentMasterKeyId: raw.DHOLE_MASTER_KEY_ID,
    gatewayAllowedHosts: new Set(raw.DHOLE_GATEWAY_ALLOWED_HOSTS.split(',').map((value) => value.trim()).filter(Boolean)),
  };
}
