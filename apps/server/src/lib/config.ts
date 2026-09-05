import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
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
  DHOLE_MODULES: z.string().default('all'),
  DHOLE_AUTH_MODE: z.literal('password').default('password'),
  DHOLE_BOOTSTRAP_TOKEN: z.string().min(43).max(256).optional(),
  DHOLE_BOOTSTRAP_TOKEN_FILE: z.string().min(1).optional(),
  DHOLE_GITHUB_CLIENT_ID: z.string().min(1).max(200).optional(),
  DHOLE_GITHUB_CLIENT_SECRET: z.string().min(1).max(4096).optional(),
  DHOLE_GITHUB_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  DHOLE_GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  DHOLE_GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  DHOLE_GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
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
  enabledModules?: readonly string[] | undefined;
  authMode?: 'password' | undefined;
  passwordBootstrapToken?: string | undefined;
  githubAuth?: { clientId: string; clientSecret: string } | undefined;
  githubApp?: { appId: string; privateKey: string } | undefined;
}

function readSecret(value: string | undefined, file: string | undefined, name: string): string | undefined {
  if (value && file) throw new Error(`Configure only one of ${name} and ${name}_FILE`);
  if (!file) return value;
  try {
    const secret = readFileSync(file, 'utf8');
    if (Buffer.byteLength(secret) > 65_536 || !secret.trim()) throw new Error('invalid secret file');
    return secret.trim();
  } catch { throw new Error(`Could not read a valid ${name}_FILE`); }
}

function parseMasterKeys(raw: string | undefined): ReadonlyMap<string, Buffer> {
  if (!raw) return new Map();
  let parsed: Record<string, string>;
  try { parsed = z.record(z.string(), z.string()).parse(JSON.parse(raw)); }
  catch { throw new Error('DHOLE_MASTER_KEYS must contain a JSON object of base64-encoded keys'); }
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(parsed)) {
    const key = Buffer.from(encoded, 'base64');
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id) || !/^[a-zA-Z0-9+/]{43}=$/u.test(encoded) || key.byteLength !== 32) throw new Error('Master keys require a safe key ID and a base64-encoded 32-byte value');
    keys.set(id, key);
  }
  return keys;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvironmentSchema.safeParse(environment);
  if (!result.success) throw new Error(`Invalid server configuration: ${[...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'environment')))].join(', ')}`);
  const raw = result.data;
  const masterKeys = parseMasterKeys(raw.DHOLE_MASTER_KEYS);
  const publicOrigin = new URL(raw.DHOLE_PUBLIC_ORIGIN);
  const sourceUrl = raw.DHOLE_SOURCE_URL ? new URL(raw.DHOLE_SOURCE_URL) : undefined;
  if (!['http:', 'https:'].includes(publicOrigin.protocol) || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
    throw new Error('DHOLE_PUBLIC_ORIGIN must be an http(s) origin without credentials, path, query, or fragment');
  }
  const modules = raw.DHOLE_MODULES.trim();
  const enabledModules = modules === 'all' ? undefined : modules === 'none' || !modules ? [] : modules.split(',').map((id) => id.trim()).filter(Boolean);
  const clientSecret = readSecret(raw.DHOLE_GITHUB_CLIENT_SECRET, raw.DHOLE_GITHUB_CLIENT_SECRET_FILE, 'DHOLE_GITHUB_CLIENT_SECRET');
  if (Boolean(raw.DHOLE_GITHUB_CLIENT_ID) !== Boolean(clientSecret)) throw new Error('Optional GitHub linking requires both DHOLE_GITHUB_CLIENT_ID and DHOLE_GITHUB_CLIENT_SECRET');
  const passwordBootstrapToken = readSecret(raw.DHOLE_BOOTSTRAP_TOKEN, raw.DHOLE_BOOTSTRAP_TOKEN_FILE, 'DHOLE_BOOTSTRAP_TOKEN');
  if (passwordBootstrapToken && (passwordBootstrapToken.length < 43 || passwordBootstrapToken.length > 256 || /\s/u.test(passwordBootstrapToken))) throw new Error('DHOLE_BOOTSTRAP_TOKEN must contain at least 43 characters from 32 random bytes');
  const privateKey = readSecret(raw.DHOLE_GITHUB_APP_PRIVATE_KEY, raw.DHOLE_GITHUB_APP_PRIVATE_KEY_FILE, 'DHOLE_GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n');
  if (Boolean(raw.DHOLE_GITHUB_APP_ID) !== Boolean(privateKey)) throw new Error('GitHub repository authorization requires both DHOLE_GITHUB_APP_ID and DHOLE_GITHUB_APP_PRIVATE_KEY or its file');
  if (privateKey) {
    try { if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('RSA required'); }
    catch { throw new Error('DHOLE_GITHUB_APP_PRIVATE_KEY must be a valid RSA private key'); }
  }
  if (sourceUrl && (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password)) {
    throw new Error('DHOLE_SOURCE_URL must be an http(s) URL without credentials');
  }
  if (raw.NODE_ENV === 'production' && (!raw.DHOLE_MASTER_KEY_ID || !masterKeys.has(raw.DHOLE_MASTER_KEY_ID))) {
    throw new Error('Production requires DHOLE_MASTER_KEY_ID and a matching key in DHOLE_MASTER_KEYS');
  }
  if (raw.NODE_ENV === 'production' && publicOrigin.protocol !== 'https:') {
    throw new Error('Production requires an HTTPS DHOLE_PUBLIC_ORIGIN');
  }
  if (raw.NODE_ENV === 'production' && sourceUrl && sourceUrl.protocol !== 'https:') {
    throw new Error('Production DHOLE_SOURCE_URL must use HTTPS');
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
    enabledModules,
    authMode: raw.DHOLE_AUTH_MODE,
    passwordBootstrapToken,
    ...(raw.DHOLE_GITHUB_CLIENT_ID && clientSecret ? { githubAuth: { clientId: raw.DHOLE_GITHUB_CLIENT_ID, clientSecret } } : {}),
    ...(raw.DHOLE_GITHUB_APP_ID && privateKey ? { githubApp: { appId: raw.DHOLE_GITHUB_APP_ID, privateKey } } : {}),
  };
}
