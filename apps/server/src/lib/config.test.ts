import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const productionKeys = JSON.stringify({ v1: Buffer.alloc(32, 1).toString('base64') });

function productionEnvironment(publicOrigin: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DHOLE_DATABASE: ':memory:',
    DHOLE_PUBLIC_ORIGIN: publicOrigin,
    DHOLE_SOURCE_URL: 'https://github.com/example/dhole/tree/v0.1.0',
    DHOLE_MASTER_KEYS: productionKeys,
    DHOLE_MASTER_KEY_ID: 'v1',
  };
}

describe('server configuration', () => {
  it('accepts an HTTPS public origin in production', () => {
    const config = loadConfig(productionEnvironment('https://dhole.example'));
    expect(config.publicOrigin.protocol).toBe('https:');
    expect(config.sourceUrl?.href).toBe('https://github.com/example/dhole/tree/v0.1.0');
  });

  it('rejects an HTTP public origin in production', () => {
    expect(() => loadConfig(productionEnvironment('http://dhole.example'))).toThrow(/HTTPS/);
  });

  it('keeps HTTP public origins available outside production', () => {
    const config = loadConfig({ NODE_ENV: 'test', DHOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' });
    expect(config.publicOrigin.protocol).toBe('http:');
  });

  it('keeps the source-code URL optional and HTTPS in production', () => {
    const missing = productionEnvironment('https://dhole.example');
    delete missing.DHOLE_SOURCE_URL;
    expect(loadConfig(missing).sourceUrl).toBeUndefined();
    expect(() => loadConfig({ ...productionEnvironment('https://dhole.example'), DHOLE_SOURCE_URL: 'http://example.test/source' })).toThrow(/DHOLE_SOURCE_URL/);
  });

  it('preserves the SQLite in-memory sentinel', () => {
    expect(loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:' }).databasePath).toBe(':memory:');
  });

  it('supports an explicit core-only module configuration', () => {
    expect(loadConfig({ DHOLE_MODULES: 'none' }).enabledModules).toEqual([]);
    expect(loadConfig({ DHOLE_MODULES: 'gateway, coordination,mcp' }).enabledModules).toEqual(['gateway', 'coordination', 'mcp']);
    expect(loadConfig({}).enabledModules).toBeUndefined();
  });

  it('keeps native accounts available without GitHub and rejects partial link configuration', () => {
    expect(loadConfig({}).authMode).toBe('password');
    expect(loadConfig({}).githubAuth).toBeUndefined();
    expect(() => loadConfig({ DHOLE_GITHUB_CLIENT_ID: 'fixture-client' })).toThrow(/GitHub linking requires/);
    const configured = loadConfig({
      DHOLE_GITHUB_CLIENT_ID: 'fixture-client', DHOLE_GITHUB_CLIENT_SECRET: 'fixture-only-secret',
    });
    expect(configured.authMode).toBe('password');
    expect(configured.githubAuth?.clientId).toBe('fixture-client');
  });

  it('requires a sufficiently long operator bootstrap secret when configured', () => {
    expect(loadConfig({ DHOLE_BOOTSTRAP_TOKEN: 'a'.repeat(64) }).passwordBootstrapToken).toBe('a'.repeat(64));
    expect(() => loadConfig({ DHOLE_BOOTSTRAP_TOKEN: 'REPLACE_ME' })).toThrow(/DHOLE_BOOTSTRAP_TOKEN/);
  });

  it('does not include secret material in invalid configuration errors', () => {
    expect(() => loadConfig({ DHOLE_GITHUB_APP_ID: '123', DHOLE_GITHUB_APP_PRIVATE_KEY: 'sensitive-invalid-fixture' }))
      .toThrow('DHOLE_GITHUB_APP_PRIVATE_KEY must be a valid RSA private key');
    expect(() => loadConfig({ DHOLE_GITHUB_CLIENT_SECRET: 'value', DHOLE_GITHUB_CLIENT_SECRET_FILE: '/not/read' }))
      .toThrow(/only one/);
    expect(() => loadConfig({ DHOLE_MASTER_KEYS: 'sensitive-invalid-fixture' }))
      .toThrow('DHOLE_MASTER_KEYS must contain a JSON object of base64-encoded keys');
    expect(() => loadConfig({ DHOLE_AUTH_MODE: 'sensitive-invalid-fixture' }))
      .toThrow('Invalid server configuration: DHOLE_AUTH_MODE');
  });

  it('rejects origins containing credentials or URL paths', () => {
    for (const origin of ['https://name:pass@example.test', 'https://example.test/callback', 'https://example.test?redirect=x', 'ftp://example.test']) {
      expect(() => loadConfig({ DHOLE_PUBLIC_ORIGIN: origin })).toThrow(/origin/);
    }
  });
});
