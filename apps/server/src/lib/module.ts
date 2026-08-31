import type { Hono } from 'hono';
import type { AppConfig } from './config.js';
import type { Clock, IdSource } from './clock.js';
import type { DatabaseConnection } from './database.js';
import type { EventStore } from './events.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: 'administrator' | 'member';
  teamId: string;
}

export interface AppVariables {
  requestId: string;
  user?: AuthenticatedUser | undefined;
  credential?: AuthenticatedCredential | undefined;
}

export interface AuthenticatedCredential {
  tokenId: string;
  projectId: string;
  runId?: string | undefined;
  userId?: string | undefined;
  permissions: readonly string[];
}

export type AppEnvironment = { Variables: AppVariables };
export type DholeApp = Hono<AppEnvironment>;

export interface ServerContext {
  config: AppConfig;
  database: DatabaseConnection;
  clock: Clock;
  ids: IdSource;
  events: EventStore;
}

export interface DholeModule {
  readonly id: string;
  register(app: DholeApp, context: ServerContext): void;
}

export function registerModules(app: DholeApp, context: ServerContext, modules: readonly DholeModule[]): void {
  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.id)) throw new Error(`Duplicate module id ${module.id}`);
    names.add(module.id);
    module.register(app, context);
  }
}
