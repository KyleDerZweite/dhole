import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1_024) throw new Error('Password must contain 12 to 1024 characters');
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, SCRYPT_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !nText || !rText || !pText || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  if (expected.byteLength !== SCRYPT_LENGTH) return false;
  const actual = await derivePassword(
    password,
    Buffer.from(saltText, 'base64url'),
    expected.byteLength,
    Number(nText),
    Number(rText),
    Number(pText),
  );
  return timingSafeEqual(expected, actual);
}

function derivePassword(password: string, salt: Buffer, length: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, { N, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export interface EncryptedValue {
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export function encryptSecret(config: AppConfig, plaintext: string, associatedData: string): EncryptedValue {
  const keyId = config.currentMasterKeyId;
  if (!keyId) throw new Error('No current encryption key configured');
  const key = config.masterKeys.get(keyId);
  if (!key) throw new Error(`Encryption key ${keyId} is unavailable`);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptSecret(config: AppConfig, value: EncryptedValue, associatedData: string): string {
  const key = config.masterKeys.get(value.keyId);
  if (!key) throw new Error(`Encryption key ${value.keyId} is unavailable`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64url'));
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const secretPatterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization)"?\s*[:=]\s*")([^"]+)(")/gi,
  /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|cookie|authorization|private[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
];

export function redactSecrets(input: string, maxLength = 4_096): string {
  let output = input.slice(0, maxLength);
  output = output.replace(secretPatterns[0]!, '[REDACTED]');
  output = output.replace(secretPatterns[1]!, '[REDACTED]');
  output = output.replace(secretPatterns[2]!, '$1[REDACTED]$3');
  output = output.replace(secretPatterns[3]!, '$1[REDACTED]');
  output = output.replace(secretPatterns[4]!, '[REDACTED_PRIVATE_KEY]');
  return output;
}

export function redactText(input: string, maxLength = 4_096): string {
  return redactSecrets(input, maxLength).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
}
