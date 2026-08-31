import type { DholeModule, DholeApp, ServerContext } from '../../lib/module.js';
import { CoordinationService, createCoordinationService } from './service.js';
import { registerCoordinationRoutes } from './routes.js';

export * from './overlap.js';
export * from './service.js';
export * from './routes.js';

/** Compile-time Dhole module registration; no runtime plugin loading. */
export const coordinationModule: DholeModule = {
  id: 'coordination',
  register(app: DholeApp, context: ServerContext): void {
    const service = new CoordinationService(context.database, context.clock, context.ids, { events: context.events });
    registerCoordinationRoutes(app, service);
  },
};

export { createCoordinationService };
