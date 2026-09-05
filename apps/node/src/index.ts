#!/usr/bin/env node
import { createNodeClient, NodeClient } from './client.js';
import { loadNodeConfig } from './config.js';
import { runCli } from './cli.js';
import { ClientError } from './onboarding.js';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';

export * from './client.js';
export * from './config.js';
export * from './fake.js';
export * from './git.js';
export * from './journal.js';
export * from './onboarding.js';
export * from './bridge.js';
export * from './installer.js';
export * from './cli.js';

/** Start the daemon when invoked as `dhole-node`; imports remain side-effect free in tests. */
export function startNode(): NodeClient {
  const client = createNodeClient({ config: loadNodeConfig() });
  client.start();
  return client;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`dhole-node: ${error instanceof ClientError ? error.code : 'invalid_configuration_or_request'}\n`);
    process.exitCode = 1;
  });
}
