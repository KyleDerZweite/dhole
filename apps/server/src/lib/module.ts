import type { Hono } from 'hono';
import { z } from 'zod';
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
  assertAuthorizationCurrent?: (() => void) | undefined;
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
  enabledModules?: ReadonlySet<string>;
}

export interface ModuleLifecycle {
  /** A bounded synchronous step; the host retries on the next one-second tick. */
  maintenance?(): void;
  close?(): void;
}

export interface DholeModule {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly contributions?: {
    readonly navigation?: readonly { id: string; label: string; path: string }[];
    readonly webSockets?: readonly string[];
    readonly jobs?: readonly string[];
  };
  register(app: DholeApp, context: ServerContext): void;
  start?(context: ServerContext): ModuleLifecycle;
}

const ModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u);
const ContributionPathSchema = z.string().max(160).regex(/^\/(?!\/)[a-zA-Z0-9/_-]*$/u);

export const ModuleCatalogSchema = z.strictObject({
  enabledModules: z.array(ModuleIdSchema).max(64),
  modules: z.array(z.strictObject({
    id: ModuleIdSchema,
    dependencies: z.array(ModuleIdSchema).max(64),
    contributions: z.strictObject({
      navigation: z.array(z.strictObject({ id: ModuleIdSchema, label: z.string().min(1).max(80), path: ContributionPathSchema })).max(32),
      webSockets: z.array(ContributionPathSchema).max(16),
      jobs: z.array(ModuleIdSchema).max(32),
    }),
  })).max(64),
});

export function moduleCatalog(modules: readonly DholeModule[]): z.infer<typeof ModuleCatalogSchema> {
  return ModuleCatalogSchema.parse({
    enabledModules: modules.map((module) => module.id),
    modules: modules.map((module) => ({
      id: module.id,
      dependencies: module.dependencies ?? [],
      contributions: {
        navigation: module.contributions?.navigation ?? [],
        webSockets: module.contributions?.webSockets ?? [],
        jobs: module.contributions?.jobs ?? [],
      },
    })),
  });
}

/** Resolve trusted static modules completely before registering any routes or services. */
export function selectModules(modules: readonly DholeModule[], enabledIds?: readonly string[]): readonly DholeModule[] {
  const available = new Map<string, DholeModule>();
  for (const module of modules) {
    if (available.has(module.id)) throw new Error(`Duplicate module id ${module.id}`);
    available.set(module.id, module);
  }
  const enabled = new Set(enabledIds ?? available.keys());
  for (const id of enabled) if (!available.has(id)) throw new Error(`Unknown module id ${id}`);
  const ordered: DholeModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (module: DholeModule): void => {
    if (visited.has(module.id)) return;
    if (visiting.has(module.id)) throw new Error(`Circular module dependency involving ${module.id}`);
    visiting.add(module.id);
    for (const dependency of module.dependencies ?? []) {
      const required = available.get(dependency);
      if (!required || !enabled.has(dependency)) throw new Error(`Module ${module.id} requires enabled module ${dependency}`);
      visit(required);
    }
    visiting.delete(module.id);
    visited.add(module.id);
    ordered.push(module);
  };
  for (const module of modules) if (enabled.has(module.id)) visit(module);
  return ordered;
}

export function registerModules(app: DholeApp, context: ServerContext, modules: readonly DholeModule[]): void {
  for (const module of selectModules(modules)) module.register(app, context);
}
