import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DholeApplication } from '../app.js';
import { createMachineService, handleNodeConnection } from '../modules/core/machines/index.js';
import { configureSessionMachines, createSessionsWebSocketHandler, getSessionsService } from '../modules/core/sessions/index.js';
import type { SessionSocket } from '../modules/core/sessions/ws.js';
import { getSessionAuthentication, loadSessionUser, subscribeSessionAuthorizationChanges } from './session-auth.js';
import type { ModuleLifecycle } from './module.js';

/** Start only the jobs and socket endpoints contributed by enabled static modules. */
export function createModuleHost(application: DholeApplication, server: HttpServer): { maintenance(): void; close(): void } {
  const { context } = application;
  const lifecycles: ModuleLifecycle[] = [];
  const closeLifecycles = (): void => {
    for (const lifecycle of [...lifecycles].reverse()) {
      try { lifecycle.close?.(); } catch { /* Finish closing the other modules. */ }
    }
  };
  for (const module of application.modules) {
    try {
      if (module.start) lifecycles.push(module.start(context));
    } catch {
      closeLifecycles();
      throw new Error(`Module ${module.id} failed to start`);
    }
  }
  const machines = createMachineService(context);
  const sessionService = getSessionsService(context);
  const sessions = sessionService ? createSessionsWebSocketHandler(context, sessionService) : undefined;
  if (machines && sessionService) {
    configureSessionMachines(context, machines);
    machines.setRuntimeEventHandler((input) => sessionService.handleRuntimeEvent(input));
  }
  if (sessions && sessionService) sessionService.setTransientEventHandler((sessionId, payload) => {
    sessions.hub.publishTransient(sessionId, { ...payload, type: 'runtime_event' });
  });

  const webSockets = new WebSocketServer({ noServer: true, clientTracking: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const active = new Map<WebSocket, { authentication: NonNullable<ReturnType<typeof getSessionAuthentication>>; adapter: SessionSocket }>();
  let closed = false;

  function authorized(socket: WebSocket): boolean {
    const current = active.get(socket);
    if (!current) return false;
    let user: ReturnType<typeof loadSessionUser>;
    try { user = loadSessionUser(context, current.authentication.tokenHash); } catch { /* Authentication failures close the socket. */ }
    const prior = current.authentication.user;
    if (user && user.id === prior.id && user.role === prior.role && user.teamId === prior.teamId) return true;
    active.delete(socket);
    sessions?.hub.unsubscribeAll(current.adapter);
    socket.close(1008, 'authentication expired');
    return false;
  }

  function revalidate(): void {
    for (const socket of active.keys()) authorized(socket);
  }

  const stopAuthorization = subscribeSessionAuthorizationChanges(context, revalidate);
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const host = request.headers.host?.split(':')[0]?.toLowerCase() ?? '';
    const origin = request.headers.origin;
    if (!context.config.allowedHosts.has(host) || (origin && origin !== context.config.publicOrigin.origin)) return rejectUpgrade(socket, 403, 'Forbidden');
    let url: URL;
    try { url = new URL(request.url ?? '/', context.config.publicOrigin); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    if (url.pathname === '/ws/app' && sessions) {
      if (origin !== context.config.publicOrigin.origin) return rejectUpgrade(socket, 403, 'Origin required');
      let authentication: ReturnType<typeof getSessionAuthentication>;
      try { authentication = getSessionAuthentication(context, request.headers.cookie); } catch { return rejectUpgrade(socket, 503, 'Service Unavailable'); }
      if (!authentication) return rejectUpgrade(socket, 401, 'Unauthorized');
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const adapter: SessionSocket = {
          get readyState() { return webSocket.readyState; },
          get bufferedAmount() { return webSocket.bufferedAmount; },
          send(data) { if (authorized(webSocket)) webSocket.send(data); },
          close(code, reason) { webSocket.close(code, reason); },
          on(event, listener) { webSocket.on(event, (...args: unknown[]) => { if (event !== 'message' || authorized(webSocket)) listener(...args); }); },
        };
        active.set(webSocket, { authentication, adapter });
        webSocket.once('close', () => { active.delete(webSocket); });
        webSocket.on('error', () => { webSocket.terminate(); });
        sessions.handle(adapter, authentication.user);
      });
      return;
    }
    if (url.pathname === '/ws/node' && machines) {
      const authorization = request.headers.authorization;
      if (!authorization) return rejectUpgrade(socket, 401, 'Unauthorized');
      webSockets.handleUpgrade(request, socket, head, (webSocket) => handleNodeConnection(webSocket, machines, { authorization }));
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  };
  server.on('upgrade', handleUpgrade);

  const maintenanceJobs: Array<() => void> = [
    revalidate,
    () => { context.events.flushOutbox(); },
    () => { machines?.markStale(); },
    () => { sessionService?.maintenance(); },
    () => {
      const connectedMachines = context.database.prepare("SELECT id FROM machines WHERE status = 'connected'").all() as Array<{ id: string }>;
      for (const machine of connectedMachines) machines.deliverPending(machine.id);
    },
    ...lifecycles.map((lifecycle) => () => { lifecycle.maintenance?.(); }),
  ];
  function maintenance(): void {
    if (closed) return;
    for (const job of maintenanceJobs) {
      try { job(); } catch {
        // Durable work stays pending; other jobs proceed and the next tick retries.
      }
    }
  }

  const timer = setInterval(maintenance, 1_000);
  timer.unref();

  return {
    maintenance,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stopAuthorization();
      server.off('upgrade', handleUpgrade);
      closeLifecycles();
      sessions?.hub.close();
      active.clear();
      for (const client of webSockets.clients) {
        client.close(1001, 'server shutting down');
        client.terminate();
      }
      webSockets.close();
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
