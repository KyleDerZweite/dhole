import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { createApplication } from './app.js';
import { createModuleHost } from './lib/module-host.js';

const application = createApplication();
const { app, context } = application;
const server = serve({
  fetch: app.fetch,
  hostname: context.config.host,
  port: context.config.port,
}, (info) => {
  process.stdout.write(`Dhole listening on ${context.config.publicOrigin.origin} (${info.address}:${info.port})\n`);
}) as HttpServer;
const host = createModuleHost(application, server);

function shutdown(): void {
  host.close();
  server.close(() => {
    application.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
