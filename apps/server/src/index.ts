import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApplication } from './app.js';
import type { AuthenticatedUser } from './lib/module.js';
import { hashToken } from './lib/security.js';
import { createFleetService, handleNodeConnection } from './modules/fleet/index.js';
import { getOrchestrationService } from './modules/orchestration/index.js';
import { configureSessionsFleet, createSessionsWebSocketHandler, getSessionsService } from './modules/sessions/index.js';

const application = createApplication();
const { app, context } = application;
const fleet = createFleetService(context);
configureSessionsFleet(context, fleet);
fleet.setRuntimeEventHandler((input) => getSessionsService(context)?.handleRuntimeEvent(input));
const orchestration = getOrchestrationService(context);
const sessions = createSessionsWebSocketHandler(context, getSessionsService(context));
getSessionsService(context)?.setTransientEventHandler((sessionId, payload) => {
  sessions.hub.publishTransient(sessionId, { ...payload, type: 'runtime_event' });
});
const webSockets = new WebSocketServer({ noServer: true, clientTracking: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });

const server = serve({
  fetch: app.fetch,
  hostname: context.config.host,
  port: context.config.port,
}, (info) => {
  process.stdout.write(`Dhole listening on ${context.config.publicOrigin.origin} (${info.address}:${info.port})\n`);
}) as HttpServer;

server.on('upgrade', (request, socket, head) => {
  const host = request.headers.host?.split(':')[0]?.toLowerCase() ?? '';
  const origin = request.headers.origin;
  if (!context.config.allowedHosts.has(host) || (origin && origin !== context.config.publicOrigin.origin)) return rejectUpgrade(socket, 403, 'Forbidden');
  const url = new URL(request.url ?? '/', context.config.publicOrigin);
  if (url.pathname === '/ws/app') {
    if (origin !== context.config.publicOrigin.origin) return rejectUpgrade(socket, 403, 'Origin required');
    const user = websocketUser(request.headers.cookie);
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    webSockets.handleUpgrade(request, socket, head, (webSocket) => sessions.handle(webSocket, user));
    return;
  }
  if (url.pathname === '/ws/node') {
    const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
    if (!authorization) return rejectUpgrade(socket, 401, 'Unauthorized');
    webSockets.handleUpgrade(request, socket, head, (webSocket) => handleNodeConnection(webSocket, fleet, { authorization }));
    return;
  }
  rejectUpgrade(socket, 404, 'Not Found');
});

const maintenance = setInterval(() => {
  try {
    context.events.flushOutbox();
    fleet.markStale();
    getSessionsService(context)?.maintenance();
    orchestration.tick();
    const machines = context.database.prepare("SELECT id FROM machines WHERE status = 'connected'").all() as Array<{ id: string }>;
    for (const machine of machines) fleet.deliverPending(machine.id);
  } catch {
    // The next bounded maintenance tick retries. Request paths expose failures.
  }
}, 1_000);
maintenance.unref();

function websocketUser(cookieHeader: string | undefined): AuthenticatedUser | undefined {
  const token = cookie(cookieHeader, 'dhole_session');
  if (!token) return undefined;
  const row = context.database.prepare(`
    SELECT u.id, u.email, u.display_name, tm.role, tm.team_id
    FROM web_sessions ws
    JOIN users u ON u.id = ws.user_id
    JOIN team_members tm ON tm.user_id = u.id
    WHERE ws.token_hash = ? AND ws.revoked_at IS NULL AND ws.expires_at > ? AND u.disabled_at IS NULL
    ORDER BY tm.created_at LIMIT 1
  `).get(hashToken(token), context.clock.now().toISOString()) as {
    id: string;
    email: string;
    display_name: string;
    role: AuthenticatedUser['role'];
    team_id: string;
  } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role, teamId: row.team_id } : undefined;
}

function cookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join('=')); } catch { return undefined; }
  }
  return undefined;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function shutdown(): void {
  clearInterval(maintenance);
  sessions.hub.close();
  for (const client of webSockets.clients) (client as WebSocket).close(1001, 'server shutting down');
  webSockets.close();
  server.close(() => {
    application.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
