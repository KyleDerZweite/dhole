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

  it('requires an explicit HTTPS corresponding-source URL in production', () => {
    const missing = productionEnvironment('https://dhole.example');
    delete missing.DHOLE_SOURCE_URL;
    expect(() => loadConfig(missing)).toThrow(/DHOLE_SOURCE_URL/);
    expect(() => loadConfig({ ...productionEnvironment('https://dhole.example'), DHOLE_SOURCE_URL: 'http://example.test/source' })).toThrow(/DHOLE_SOURCE_URL/);
  });

  it('preserves the SQLite in-memory sentinel', () => {
    expect(loadConfig({ NODE_ENV: 'test', DHOLE_DATABASE: ':memory:' }).databasePath).toBe(':memory:');
  });
});
