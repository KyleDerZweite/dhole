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
import { moduleCatalog, selectModules, type DholeApp, type DholeModule, type ServerContext } from './lib/module.js';
import { accessModule } from './modules/access/index.js';
import { coordinationModule } from './modules/coordination/index.js';
import { coreModule, requireUser } from './modules/core/index.js';
import { registerMachineRoutes } from './modules/core/machines/index.js';
import { gatewayModule } from './modules/gateway/index.js';
import { mcpModule } from './modules/mcp/index.js';
import { registerRuntimeRoutes } from './modules/core/runtime/index.js';
import { registerSessionRoutes } from './modules/core/sessions/index.js';

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
  modules: readonly DholeModule[];
  close(): void;
}

const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The deployment chooses from this trusted, compile-time registry. */
export const availableModules: readonly DholeModule[] = [
  { ...coreModule, contributions: {
    navigation: [{ id: 'dashboard', label: 'Overview', path: '/' }, { id: 'projects', label: 'Projects', path: '/projects' }, { id: 'agents', label: 'Agents', path: '/agents' }],
    webSockets: ['/ws/node', '/ws/app'], jobs: ['event-outbox', 'machine-maintenance', 'session-maintenance'],
  } },
  { ...accessModule, dependencies: ['core'] },
  { ...coordinationModule, dependencies: ['core', 'access'] },
  { ...gatewayModule, dependencies: ['core', 'access'], contributions: { navigation: [{ id: 'gateway', label: 'Gateway', path: '/gateway' }], jobs: ['gateway-retention'] } },
  { ...mcpModule, dependencies: ['core', 'access'] },
];

export function createApplication(options: CreateApplicationOptions = {}): DholeApplication {
  const config = options.config ?? loadConfig();
  const modules = selectModules(availableModules, config.enabledModules === undefined ? undefined : ['core', 'access', ...config.enabledModules]);
  const catalog = moduleCatalog(modules);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? secureIds;
  const database = options.database ?? openDatabase(config.databasePath, clock);
  const events = new EventStore(database, clock, ids);
  const context: ServerContext = { config, database, clock, ids, events, enabledModules: new Set(modules.map((module) => module.id)) };
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

  for (const module of modules) {
    module.register(app, context);
    // Core execution routes follow Access so bearer scope checks run first.
    if (module.id === 'access') {
      registerMachineRoutes(app, context);
      registerRuntimeRoutes(app, context);
      registerSessionRoutes(app, context);
    }
  }
  app.get('/api/modules', requireUser, (requestContext) => requestContext.json(catalog));

  // API and WebSocket misses must not fall through to the browser's HTML shell.
  app.all('/api/*', (requestContext) => requestContext.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));
  app.all('/mcp', (requestContext) => requestContext.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));
  app.all('/ws/*', (requestContext) => requestContext.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

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
    modules,
    close: () => {
      events.flushOutbox();
      database.close();
    },
  };
}
