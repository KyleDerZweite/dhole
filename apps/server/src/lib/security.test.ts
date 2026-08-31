import { describe, expect, it } from 'vitest';
import type { AppConfig } from './config.js';
import { decryptSecret, encryptSecret, hashPassword, redactSecrets, redactText, verifyPassword } from './security.js';

describe('security primitives', () => {
  it('hashes passwords with scrypt and verifies in constant-shape output', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('incorrect horse battery staple', encoded)).toBe(false);
  });

  it('binds encrypted secrets to their record context', () => {
    const key = Buffer.alloc(32, 7);
    const config: AppConfig = {
      environment: 'test',
      host: '127.0.0.1',
      port: 4173,
      databasePath: ':memory:',
      publicOrigin: new URL('http://127.0.0.1:4173'),
      allowedHosts: new Set(['127.0.0.1']),
      demo: false,
      masterKeys: new Map([['v1', key]]),
      currentMasterKeyId: 'v1',
      gatewayAllowedHosts: new Set(['127.0.0.1']),
    };
    const encrypted = encryptSecret(config, 'secret-value', 'providers:p1:credential');
    expect(decryptSecret(config, encrypted, 'providers:p1:credential')).toBe('secret-value');
    expect(() => decryptSecret(config, encrypted, 'providers:p2:credential')).toThrow();
  });

  it('redacts common credentials and email addresses', () => {
    const redacted = redactText('Authorization: Bearer abc.def api_key="sk-secretsecret" user@example.com');
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('sk-secretsecret');
    expect(redacted).not.toContain('user@example.com');
  });

  it('redacts credentials without altering ordinary email addresses', () => {
    const input = 'contact user@example.test api_key=plain-secret\n-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----';
    const redacted = redactSecrets(input, input.length);
    expect(redacted).toContain('user@example.test');
    expect(redacted).not.toContain('plain-secret');
    expect(redacted).not.toContain('private material');
  });
});
