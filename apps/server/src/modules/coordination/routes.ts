import { z } from 'zod';
import type { Context } from 'hono';
import type { DholeApp, ServerContext } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { requireProjectAccess } from '../core/index.js';
import { CoordinationError, BlockingOverlapError, CoordinationService, type AgentEventInput, type CreateClaimInput, type StartSessionInput, type PatchClaimInput, type CompleteClaimInput } from './service.js';
import type { WorkScope } from './overlap.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const files = z.array(z.string().min(1).max(1_024)).max(500).optional();

const sessionCreateSchema = z.object({
  agent: text(120).optional(), agentLabel: text(120).optional(), developer: nullableText(160), developerLabel: nullableText(160),
  machine: nullableText(160), machineId: nullableText(160), worktree: nullableText(1_024), capability: z.string().min(8).max(256).optional(),
  userId: nullableText(160), runId: nullableText(160),
}).refine((value) => Boolean(value.agent ?? value.agentLabel), { message: 'agent is required', path: ['agent'] });

const heartbeatSchema = z.object({
  activity: z.string().max(500).nullable().optional(), branch: nullableText(240), revision: nullableText(240), dirtyFiles: files,
  agentTask: z.string().max(500).nullable().optional(), agentState: z.string().max(40).nullable().optional(), agentStateReason: z.string().max(500).nullable().optional(),
  runId: nullableText(160),
});

const repoSchema = z.object({ branch: nullableText(240), revision: nullableText(240), dirtyFiles: z.array(z.string().min(1).max(1_024)).max(500).default([]), runId: nullableText(160) });

const claimCreateSchema = z.object({
  sessionId: text(160), intent: text(2_000), task: nullableText(500), files: z.array(z.string().min(1).max(1_024)).max(500).default([]),
  components: z.array(text(120)).max(100).default([]), branch: nullableText(240), baseRevision: nullableText(240), worktree: nullableText(1_024),
  runId: nullableText(160), workItemId: nullableText(160), status: z.enum(['investigating', 'in-progress', 'testing', 'blocked']).default('investigating'),
  blockedOn: nullableText(160), mode: z.enum(['advisory', 'enforced']).optional(), enforce: z.boolean().optional(),
});

const claimPatchSchema = z.object({
  runId: nullableText(160),
  intent: text(2_000).optional(), task: nullableText(500), files, components: z.array(text(120)).max(100).optional(),
  branch: nullableText(240), baseRevision: nullableText(240), worktree: nullableText(1_024),
  status: z.enum(['investigating', 'in-progress', 'testing', 'blocked']).optional(), blockedOn: nullableText(160),
  finding: text(2_000).optional(), findingFiles: files, findingKind: z.enum(['root-cause', 'gotcha', 'decision', 'api-change']).optional(),
});

const completeSchema = z.object({ runId: nullableText(160), commits: z.array(text(240)).max(100).default([]), prs: z.array(text(500)).max(100).default([]), summary: nullableText(2_000), status: z.enum(['done', 'abandoned']).default('done') });

const eventSchema = z.object({
  eventId: text(160), runId: text(160), agentId: text(160), parentAgentId: nullableText(160), harness: text(64), name: nullableText(80), role: nullableText(64),
  task: nullableText(280), state: z.enum(['starting', 'active', 'waiting', 'blocked', 'needs-input', 'completed', 'failed', 'cancelled']),
  stateReason: nullableText(280), occurredAt: z.union([z.string().min(1).max(80), z.number().int().nonnegative()]), sessionId: text(160).optional(),
});

function capability(context: Context): string | undefined {
  const direct = context.req.header('x-mediation-session') ?? context.req.header('x-session-capability') ?? context.req.header('x-mediation-session-capability');
  if (direct) return direct;
  return undefined;
}

async function body<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  try {
    return await parseJson(context as Parameters<typeof parseJson>[0], schema);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'invalid_json') {
      throw new CoordinationError(422, 'invalid_json', 'Request body must be valid JSON');
    }
    throw error;
  }
}

function jsonError(context: Context, error: unknown): Response {
  if (error instanceof BlockingOverlapError) return context.json({ error: { code: error.code, message: error.message, conflicts: error.conflicts } }, 409);
  if (error instanceof CoordinationError) return context.json({ error: { code: error.code, message: error.message, details: error.details } }, error.statusCode);
  if (error instanceof HttpError) return context.json({ error: { code: error.code, message: error.message } }, error.status);
  return context.json({ error: { code: 'coordination_failed', message: 'Coordination request failed' } }, 500);
}

async function run<T>(context: Context, operation: () => T | Promise<T>): Promise<Response> {
  try { return context.json(await operation()); } catch (error) { return jsonError(context, error); }
}

function project(context: Context): string {
  const value = context.req.param('projectId') ?? context.req.param('p');
  if (!value) throw new CoordinationError(404, 'project_not_found', 'Project not found');
  return value;
}

function tokenRun(context: Context): string | undefined {
  const credential = (context.get as (key: string) => unknown)('credential') as { runId?: string } | undefined;
  return credential?.runId;
}

function actor(context: Context): { userId: string } {
  const credential = (context.get as (key: string) => unknown)('credential') as { userId?: string } | undefined;
  const user = (context.get as (key: string) => unknown)('user') as { id?: string } | undefined;
  const userId = credential?.userId ?? user?.id;
  if (!userId) throw new CoordinationError(401, 'authentication_required', 'Authentication required');
  return { userId };
}

function scopedRun(context: Context, requested?: string | null): string | undefined {
  const tokenRunId = tokenRun(context);
  if (tokenRunId && requested != null && requested !== tokenRunId) {
    throw new CoordinationError(403, 'run_scope_denied', 'The API token is not valid for this run');
  }
  // Cookie/project-scoped callers may request a narrower read filter; only a
  // credential carrying runId turns that filter into an authorization scope.
  return tokenRunId ?? (requested ?? undefined);
}

function queryList(context: Context, key: string): string[] {
  return context.req.query(key)?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
}

export function registerCoordinationRoutes(app: DholeApp, service: CoordinationService): void {
  app.use('/api/projects/:projectId/*', requireProjectAccess);
  app.use('/api/projects/:projectId/*', async (context, next) => {
    // Validate a run query parameter on every coordination endpoint, including
    // mutation routes whose runId normally arrives in the JSON body.
    scopedRun(context, context.req.query('runId'));
    await next();
  });

  app.post('/api/projects/:projectId/sessions', async (context) => run(context, async () => {
    const input = await body(context, sessionCreateSchema);
    scopedRun(context, input.runId);
    // The authenticated identity owns the session; body labels never grant access.
    const user = (context.get as (key: string) => unknown)('user') as { id?: string; displayName?: string } | undefined;
    const credential = (context.get as (key: string) => unknown)('credential') as { userId?: string; ownerDisplayName?: string } | undefined;
    const attributed = ({
      ...(input as StartSessionInput),
      ...(user?.displayName || credential?.ownerDisplayName ? { developerLabel: credential?.ownerDisplayName ?? user?.displayName } : {}),
      ...actor(context),
    }) as StartSessionInput;
    delete attributed.capability;
    const session = service.startSession(project(context), attributed);
    return { ...session };
  }));

  app.post('/api/projects/:projectId/sessions/:id/heartbeat', async (context) => run(context, async () => {
    const input = await body(context, heartbeatSchema);
    scopedRun(context, input.runId);
    const sessionId = context.req.param('id');
    if (!sessionId) throw new CoordinationError(404, 'session_not_found', 'Session not found');
    const cap = capability(context);
    const { runId: _runId, ...heartbeat } = input;
    return service.heartbeat(project(context), sessionId, { ...heartbeat, ...actor(context), ...(cap ? { capability: cap } : {}) } as Parameters<CoordinationService['heartbeat']>[2], tokenRun(context));
  }));

  app.post('/api/projects/:projectId/sessions/:id/repo', async (context) => run(context, async () => {
    const input = await body(context, repoSchema);
    scopedRun(context, input.runId);
    const sessionId = context.req.param('id');
    if (!sessionId) throw new CoordinationError(404, 'session_not_found', 'Session not found');
    const cap = capability(context);
    const { runId: _runId, ...repo } = input;
    const report = service.reportRepo(project(context), sessionId, { ...repo, ...actor(context), ...(cap ? { capability: cap } : {}) } as Parameters<CoordinationService['reportRepo']>[2], tokenRun(context));
    return report;
  }));

  app.delete('/api/projects/:projectId/sessions/:id', async (context) => run(context, () => {
    scopedRun(context, context.req.query('runId'));
    const sessionId = context.req.param('id');
    if (!sessionId) throw new CoordinationError(404, 'session_not_found', 'Session not found');
    return service.endSession(project(context), sessionId, capability(context), undefined, tokenRun(context), actor(context).userId);
  }));

  app.post('/api/projects/:projectId/claims', async (context) => run(context, async () => {
    const input = await body(context, claimCreateSchema);
    const cap = capability(context);
    const runId = scopedRun(context, input.runId);
    return service.createClaim(project(context), { ...input, ...actor(context), ...(runId ? { runId } : {}), ...(cap ? { capability: cap } : {}) } as CreateClaimInput, tokenRun(context));
  }));

  app.patch('/api/projects/:projectId/claims/:id', async (context) => run(context, async () => {
    const input = await body(context, claimPatchSchema);
    const runId = scopedRun(context, input.runId);
    const claimId = context.req.param('id');
    if (!claimId) throw new CoordinationError(404, 'claim_not_found', 'Claim not found');
    const cap = capability(context);
    const { runId: _runId, ...patch } = input;
    return service.updateClaim(project(context), claimId, { ...patch, ...actor(context), ...(runId ? { runId } : {}), ...(cap ? { capability: cap } : {}) } as PatchClaimInput, tokenRun(context));
  }));

  app.post('/api/projects/:projectId/claims/:id/revive', async (context) => run(context, async () => {
    const input = await body(context, claimPatchSchema);
    scopedRun(context, input.runId);
    const cap = capability(context);
    return service.reviveClaim(project(context), context.req.param('id'), {
      ...input, ...actor(context), ...(cap ? { capability: cap } : {}),
    } as PatchClaimInput, tokenRun(context));
  }));

  app.post('/api/projects/:projectId/claims/:id/complete', async (context) => run(context, async () => {
    const input = await body(context, completeSchema);
    const runId = scopedRun(context, input.runId);
    const claimId = context.req.param('id');
    if (!claimId) throw new CoordinationError(404, 'claim_not_found', 'Claim not found');
    const cap = capability(context);
    const { runId: _runId, ...complete } = input;
    return service.completeClaim(project(context), claimId, { ...complete, ...actor(context), ...(runId ? { runId } : {}), ...(cap ? { capability: cap } : {}) } as CompleteClaimInput, tokenRun(context));
  }));

  app.post('/api/projects/:projectId/claims/:id/release', async (context) => run(context, () => {
    scopedRun(context, context.req.query('runId'));
    const claimId = context.req.param('id');
    if (!claimId) throw new CoordinationError(404, 'claim_not_found', 'Claim not found');
    return service.releaseClaim(project(context), claimId, capability(context), tokenRun(context), actor(context).userId);
  }));

  const check = async (context: Context, proposed?: WorkScope): Promise<Response> => run(context, () => {
    const runId = scopedRun(context, context.req.query('runId'));
    return { conflicts: service.check(project(context), proposed ?? {
      files: queryList(context, 'files'), components: queryList(context, 'components'), task: context.req.query('task') ?? null, intent: context.req.query('intent') ?? '',
      worktree: context.req.query('worktree') ?? null, sessionId: context.req.query('sessionId') ?? null,
    }, runId, capability(context), actor(context).userId) };
  });
  app.get('/api/projects/:projectId/check', (context) => check(context));
  app.post('/api/projects/:projectId/check', async (context) => run(context, async () => {
    const input = await body(context, claimCreateSchema.partial().extend({ intent: text(2_000) }));
    const runId = scopedRun(context, input.runId);
    return { conflicts: service.check(project(context), { files: input.files ?? [], components: input.components ?? [], task: input.task ?? null, intent: input.intent, worktree: input.worktree ?? null, sessionId: input.sessionId ?? null }, runId, capability(context), actor(context).userId) };
  }));

  app.get('/api/projects/:projectId/state', (context) => run(context, () => service.getState(project(context), scopedRun(context, context.req.query('runId')))));
  app.post('/api/projects/:projectId/agent-events', async (context) => run(context, async () => {
    const input = await body(context, eventSchema);
    const cap = capability(context);
    const runId = tokenRun(context);
    const event: AgentEventInput = { ...input, ...actor(context), ...(cap ? { capability: cap } : {}) } as AgentEventInput;
    return service.recordAgentEvent(project(context), event, runId);
  }));
}

export function createCoordinationRoutes(context: ServerContext): { service: CoordinationService; register: (app: DholeApp) => void } {
  const service = new CoordinationService(context.database, context.clock, context.ids, { events: context.events });
  return { service, register: (app) => registerCoordinationRoutes(app, service) };
}
