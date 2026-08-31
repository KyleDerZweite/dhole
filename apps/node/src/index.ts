#!/usr/bin/env node
import { createNodeClient, NodeClient } from './client.js';
import { loadNodeConfig } from './config.js';

export * from './client.js';
export * from './config.js';
export * from './fake.js';
export * from './git.js';
export * from './journal.js';

/** Start the daemon when invoked as `dhole-node`; imports remain side-effect free in tests. */
export function startNode(): NodeClient {
  const client = createNodeClient({ config: loadNodeConfig() });
  client.start();
  return client;
}

if (process.argv[1]?.endsWith('/dist/index.js') || process.argv[1]?.endsWith('/src/index.ts')) {
  startNode();
}
