import { describe, expect, it } from 'vitest';
import { loadNodeConfig } from './config.js';

describe('node transport configuration', () => {
  it('permits cleartext websocket only for loopback endpoints', () => {
    expect(loadNodeConfig({ DHOLE_NODE_SERVER_URL: 'ws://127.0.0.1:4173/ws/node' }).serverUrl.protocol).toBe('ws:');
    expect(loadNodeConfig({ DHOLE_NODE_SERVER_URL: 'ws://[::1]:4173/ws/node' }).serverUrl.protocol).toBe('ws:');
    expect(loadNodeConfig({ DHOLE_NODE_SERVER_URL: 'wss://node.example.test/ws/node' }).serverUrl.protocol).toBe('wss:');
  });

  it('rejects cleartext websocket to non-loopback hosts', () => {
    expect(() => loadNodeConfig({ DHOLE_NODE_SERVER_URL: 'ws://node.example.test/ws/node' })).toThrow('wss://');
  });

  it('rejects websocket URLs carrying inline credentials', () => {
    expect(() => loadNodeConfig({ DHOLE_NODE_SERVER_URL: 'wss://user:password@node.example.test/ws/node' })).toThrow('credentials');
  });

  it('rejects one- to three-character node secrets so every configured secret is redactable', () => {
    for (const secret of ['a', 'ab', 'abc']) {
      expect(() => loadNodeConfig({ DHOLE_NODE_SECRETS: JSON.stringify({ 'provider-secret': secret }) })).toThrow('at least 4 characters');
    }
  });

  it('accepts a four-character node secret at the redaction boundary', () => {
    expect(loadNodeConfig({ DHOLE_NODE_SECRETS: JSON.stringify({ 'provider-secret': 'abcd' }) }).secrets.get('provider-secret')).toBe('abcd');
  });

  it('rejects node frame sizes above the server\'s one-megabyte cap', () => {
    expect(() => loadNodeConfig({ DHOLE_NODE_MAX_FRAME_BYTES: String(1_048_577) })).toThrow();
    expect(loadNodeConfig({ DHOLE_NODE_MAX_FRAME_BYTES: String(1_048_576) }).maxFrameBytes).toBe(1_048_576);
  });
});
