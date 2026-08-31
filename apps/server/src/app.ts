import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { seedDemo } from './demo/index.js';
import { secureIds, systemClock, type Clock, type IdSource } from './lib/clock.js';
import { loadConfig, type AppConfig } from './lib/config.js';
import { openDatabase, type DatabaseConnection } from './lib/database.js';
import { EventStore } from './lib/events.js';
import { HttpError } from './lib/http.js';
import { baseSecurityMiddleware } from './lib/middleware.js';
import { registerModules, type DholeApp, type ServerContext } from './lib/module.js';
import { accessModule } from './modules/access/index.js';
import { coordinationModule } from './modules/coordination/index.js';
import { coreModule } from './modules/core/index.js';
import { fleetModule } from './modules/fleet/index.js';
import { gatewayModule } from './modules/gateway/index.js';
import { labModule } from './modules/lab/index.js';
import { mcpModule } from './modules/mcp/index.js';
import { memoryModule } from './modules/memory/index.js';
import { orchestrationModule } from './modules/orchestration/index.js';
import { runtimeModule } from './modules/runtime/index.js';
import { sessionsModule } from './modules/sessions/index.js';
import { skillsModule } from './modules/skills/index.js';

export interface CreateApplicationOptions {
  config?: AppConfig;
  database?: DatabaseConnection;
  clock?: Clock;
  ids?: IdSource;
  webRoot?: string | undefined;
  seed?: boolean;
}

export interface DholeApplication {
  app: DholeApp;
  context: ServerContext;
  close(): void;
}

const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function createApplication(options: CreateApplicationOptions = {}): DholeApplication {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? secureIds;
  const database = options.database ?? openDatabase(config.databasePath, clock);
  const events = new EventStore(database, clock, ids);
  const context: ServerContext = { config, database, clock, ids, events };
  if (options.seed ?? config.demo) seedDemo(context);

  const app = new Hono() as DholeApp;
  app.use('*', baseSecurityMiddleware(config, ids));
  app.onError((error, requestContext) => {
    if (error instanceof HttpError) return requestContext.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof ZodError) return requestContext.json({ error: { code: 'validation_failed', message: error.issues[0]?.message ?? 'Request validation failed' } }, 422);
    const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    const safeStatus = status >= 400 && status <= 599 ? status : 500;
    return requestContext.json({
      error: {
        code: typeof candidate.code === 'string' ? candidate.code : 'internal_error',
        message: safeStatus < 500 && typeof candidate.message === 'string' ? candidate.message : 'An internal error occurred',
      },
    }, safeStatus as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503);
  });

  registerModules(app, context, [
    coreModule,
    accessModule,
    fleetModule,
    runtimeModule,
    sessionsModule,
    coordinationModule,
    gatewayModule,
    orchestrationModule,
    memoryModule,
    skillsModule,
    labModule,
    mcpModule,
  ]);

  app.get('/source', (requestContext) => requestContext.redirect(config.sourceUrl?.href ?? 'https://github.com/KyleDerZweite/dhole', 302));
  app.get('/LICENSE', (requestContext) => {
    requestContext.header('Cache-Control', 'public, max-age=3600');
    return requestContext.text(readFileSync(resolve(repositoryRoot, 'LICENSE'), 'utf8'));
  });
  app.get('/THIRD_PARTY_NOTICES.md', (requestContext) => {
    requestContext.header('Cache-Control', 'public, max-age=3600');
    return requestContext.text(readFileSync(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
  });

  const webRoot = options.webRoot ?? defaultWebRoot;
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use('/assets/*', serveStatic({ root: webRoot, onFound: (_path, foundContext) => foundContext.header('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.get('*', serveStatic({ root: webRoot, rewriteRequestPath: () => '/index.html', onFound: (_path, foundContext) => foundContext.header('Cache-Control', 'no-cache') }));
  } else {
    app.get('/', (requestContext) => requestContext.json({ service: 'dhole', web: 'not_built', build: 'Run pnpm build' }, 503));
  }

  return {
    app,
    context,
    close: () => {
      events.flushOutbox();
      database.close();
    },
  };
}
