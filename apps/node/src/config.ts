import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  DHOLE_NODE_SERVER_URL: z.string().default('ws://127.0.0.1:4173/ws/node'),
  DHOLE_NODE_MACHINE_ID: z.string().min(1).max(160).optional(),
  DHOLE_NODE_CREDENTIAL: z.string().min(1).max(512).optional(),
  DHOLE_NODE_STATE_DIR: z.string().default(join(homedir(), '.dhole-node')),
  DHOLE_NODE_DAEMON_VERSION: z.string().min(1).max(80).default('0.1.0'),
  DHOLE_NODE_HEARTBEAT_MS: z.coerce.number().int().min(2_000).max(120_000).default(15_000),
  DHOLE_NODE_MAX_FRAME_BYTES: z.coerce.number().int().min(16_384).max(1_048_576).default(1_048_576),
  DHOLE_NODE_RECONNECT_MIN_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  DHOLE_NODE_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).max(10 * 60_000).default(30_000),
  DHOLE_NODE_REPOSITORIES: z.string().default('{}'),
  DHOLE_NODE_SECRETS: z.string().default('{}'),
});

const NodeSecretsSchema = z.record(
  z.string().min(1).max(160),
  z.string().min(4, 'Node secret values must be at least 4 characters for safe redaction').max(16_384),
);

export interface NodeConfig {
  serverUrl: URL;
  machineId?: string;
  credential?: string;
  stateDir: string;
  credentialPath: string;
  journalPath: string;
  daemonVersion: string;
  heartbeatIntervalMs: number;
  maxFrameBytes: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  repositories: ReadonlyMap<string, string>;
  secrets: ReadonlyMap<string, string>;
}

const CredentialStateSchema = z.object({
  machineId: z.string().min(1).max(160), credential: z.string().min(1).max(512), updatedAt: z.iso.datetime().optional(),
});
export type CredentialState = z.infer<typeof CredentialStateSchema>;

const ConnectionSchema = z.object({
  serverUrl: z.string().max(2048),
  repositories: z.record(z.string().min(1).max(160), z.string().min(1).max(4096)).default({}),
});

export function readConnectionState(stateDir: string): z.infer<typeof ConnectionSchema> | undefined {
  const path = join(stateDir, 'connection.json');
  if (!existsSync(path)) return undefined;
  return ConnectionSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function loadNodeConfig(environment: NodeJS.ProcessEnv = process.env): NodeConfig {
  const stateDir = resolve(environment.DHOLE_NODE_STATE_DIR ?? join(homedir(), '.dhole-node'));
  const connected = readConnectionState(stateDir);
  const raw = EnvironmentSchema.parse({
    ...(connected ? { DHOLE_NODE_SERVER_URL: connected.serverUrl, DHOLE_NODE_REPOSITORIES: JSON.stringify(connected.repositories) } : {}),
    ...environment,
  });
  const serverUrl = new URL(raw.DHOLE_NODE_SERVER_URL);
  if (serverUrl.protocol !== 'ws:' && serverUrl.protocol !== 'wss:') throw new Error('DHOLE_NODE_SERVER_URL must use ws:// or wss://');
  if (serverUrl.username || serverUrl.password) throw new Error('DHOLE_NODE_SERVER_URL must not include credentials');
  if (serverUrl.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname.toLowerCase())) {
    throw new Error('DHOLE_NODE_SERVER_URL must use wss:// for non-loopback hosts');
  }
  let repositoryInput: unknown;
  try {
    repositoryInput = JSON.parse(raw.DHOLE_NODE_REPOSITORIES) as unknown;
  } catch {
    throw new Error('DHOLE_NODE_REPOSITORIES must be a JSON object');
  }
  const repositoryRecord = z.record(z.string().min(1).max(160), z.string().min(1).max(4096)).parse(repositoryInput);
  const repositories = new Map<string, string>();
  for (const [repositoryId, root] of Object.entries(repositoryRecord)) {
    if (!isAbsolute(root)) throw new Error(`Repository ${repositoryId} must map to an absolute path`);
    repositories.set(repositoryId, resolve(root));
  }
  let secretInput: unknown;
  try {
    secretInput = JSON.parse(raw.DHOLE_NODE_SECRETS) as unknown;
  } catch {
    throw new Error('DHOLE_NODE_SECRETS must be a JSON object');
  }
  const secrets = new Map(Object.entries(NodeSecretsSchema.parse(secretInput)));
  return {
    serverUrl,
    ...(raw.DHOLE_NODE_MACHINE_ID === undefined ? {} : { machineId: raw.DHOLE_NODE_MACHINE_ID }),
    ...(raw.DHOLE_NODE_CREDENTIAL === undefined ? {} : { credential: raw.DHOLE_NODE_CREDENTIAL }),
    stateDir,
    credentialPath: join(stateDir, 'credential.json'),
    journalPath: join(stateDir, 'journal.json'),
    daemonVersion: raw.DHOLE_NODE_DAEMON_VERSION,
    heartbeatIntervalMs: raw.DHOLE_NODE_HEARTBEAT_MS,
    maxFrameBytes: raw.DHOLE_NODE_MAX_FRAME_BYTES,
    reconnectMinMs: Math.min(raw.DHOLE_NODE_RECONNECT_MIN_MS, raw.DHOLE_NODE_RECONNECT_MAX_MS),
    reconnectMaxMs: Math.max(raw.DHOLE_NODE_RECONNECT_MIN_MS, raw.DHOLE_NODE_RECONNECT_MAX_MS),
    repositories,
    secrets,
  };
}

function ensureStateDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* best effort on Windows */ }
}

/** Read persisted node credentials. Environment credentials take precedence. */
export function readCredentialState(path: string): CredentialState | undefined {
  if (!existsSync(path)) return undefined;
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const result = CredentialStateSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Persist credentials using a 0600 temporary file + rename + fsync protocol. */
export function writeCredentialState(path: string, state: CredentialState): void {
  writePrivateJson(path, { machineId: state.machineId, credential: state.credential, updatedAt: state.updatedAt ?? new Date().toISOString() });
}

export function writePrivateJson(path: string, value: unknown): void {
  ensureStateDir(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(value);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeSync(fd, payload, undefined, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The file may have been renamed already. */ }
    throw error;
  }
  try {
    const directoryFd = openSync(dirname(path), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch { /* directory fsync is unavailable on some platforms */ }
  chmodSync(path, 0o600);
}

export function resolveCredential(config: NodeConfig): CredentialState | undefined {
  if (config.machineId && config.credential) return { machineId: config.machineId, credential: config.credential };
  const persisted = readCredentialState(config.credentialPath);
  if (!persisted) return undefined;
  const machineId = config.machineId ?? persisted.machineId;
  const credential = config.credential ?? persisted.credential;
  return machineId && credential ? { machineId, credential } : undefined;
}
