import type { Context } from 'hono';
import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { redactText } from '../../lib/security.js';
import { requireProjectAccess } from '../core/index.js';
import { createCoordinationService } from '../coordination/index.js';
import { createFleetService } from '../fleet/index.js';
import { OrchestrationService } from './service.js';
import type { CoordinationApi } from './types.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());
const MAX_ERROR_DETAIL = 2_000;

type SafeError = { status: 404 | 409 | 422; code: string; message: string };

const SAFE_ORCHESTRATION_ERRORS: readonly { status: SafeError['status']; code: string; pattern: RegExp; message?: string }[] = [
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown orchestration profile(?: version)?$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Profile has no active version$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown run for project$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown orchestration execution$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown parent work item$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown child work item$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown work item$/u },
  { status: 404, code: 'orchestration_not_found', pattern: /^Unknown skill$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^profileVersionId or profileId is required$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Parent work item is required$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Unknown dependency .+$/u, message: 'Unknown dependency' },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Maximum orchestration depth exceeded$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Maximum children per parent exceeded$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Maximum work item budget exceeded$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Invalid orchestration budget$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Child budget exceeds profile budget$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Child budget exceeds remaining orchestration budget$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Deprecated orchestration profile versions cannot be activated$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Orchestration budget is undeclared$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Orchestration budget exhausted$/u },
  { status: 422, code: 'orchestration_validation_failed', pattern: /^Message length is invalid$/u },
  { status: 409, code: 'orchestration_conflict', pattern: /^Work item has no assigned machine$/u },
  { status: 409, code: 'orchestration_conflict', pattern: /^Completed worktree has no durable record$/u },
  { status: 409, code: 'orchestration_conflict', pattern: /^Assigned machine has no available runtime$/u },
  { status: 409, code: 'orchestration_conflict', pattern: /^Child has no assigned machine$/u },
  { status: 409, code: 'orchestration_conflict', pattern: /^Child runtime session is not available$/u },
];

function userId(context: Context<AppEnvironment>): string {
  const user = context.get('user');
  if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return user.id;
}

function projectId(context: Context<AppEnvironment>): string {
  const value = context.req.param('projectId');
  if (!value) throw new HttpError(400, 'invalid_project', 'Project id is required');
  return value;
}

function executionId(context: Context<AppEnvironment>): string {
  const value = context.req.param('executionId') ?? context.req.param('runId');
  if (!value) throw new HttpError(400, 'invalid_execution', 'Execution id is required');
  return value;
}

function knownOrchestrationError(error: unknown): SafeError | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = SAFE_ORCHESTRATION_ERRORS.find((candidate) => candidate.pattern.test(error.message));
  if (!match) return undefined;
  return {
    status: match.status,
    code: match.code,
    message: redactText(match.message ?? error.message, MAX_ERROR_DETAIL),
  };
}

function handle<T>(context: Context<AppEnvironment>, operation: () => T, status: 200 | 201 = 200): Response {
  try {
    return context.json(operation(), status);
  } catch (error) {
    if (error instanceof HttpError) return context.json({ error: error.code, message: redactText(error.message, MAX_ERROR_DETAIL) }, error.status);
    if (error instanceof z.ZodError) return context.json({ error: 'orchestration_validation_failed', message: redactText(error.issues[0]?.message ?? 'Invalid request', MAX_ERROR_DETAIL) }, 422);
    const known = knownOrchestrationError(error);
    if (known) return context.json({ error: known.code, message: known.message }, known.status);
    return context.json({ error: 'orchestration_request_failed', message: 'Request failed' }, 500);
  }
}

function bodyRoute(
  context: Context<AppEnvironment>,
  operation: (body: Record<string, unknown>) => Response,
): Promise<Response> {
  return parseJson(context, JsonObjectSchema).then(operation).catch((error: unknown) => {
    if (error instanceof HttpError) return context.json({ error: error.code, message: redactText(error.message, MAX_ERROR_DETAIL) }, error.status);
    return context.json({ error: 'invalid_json', message: 'Invalid request body' }, 400);
  });
}

function registerRoutes(app: Hono<AppEnvironment>, service: OrchestrationService): void {
  const prefixes = ['/api/projects/:projectId/orchestration'];
  for (const prefix of prefixes) {
    app.use(`${prefix}/*`, requireProjectAccess);
    app.post(`${prefix}/profiles`, (c) => bodyRoute(c, (body) => handle(c, () => service.createProfile({ ...body, projectId: projectId(c), createdBy: userId(c) }), 201)));
    app.post(`${prefix}/profiles/:profileId/versions`, (c) => bodyRoute(c, (body) => handle(c, () => service.createProfileVersion({ ...body, projectId: projectId(c), profileId: c.req.param('profileId'), createdBy: userId(c) }), 201)));
    app.post(`${prefix}/profiles/:profileId/versions/:versionId/activate`, (c) => handle(c, () => service.activateProfileVersion(projectId(c), c.req.param('profileId'), c.req.param('versionId'), userId(c))));

    app.post(`${prefix}/runs`, (c) => bodyRoute(c, (body) => handle(c, () => service.startExecution({ ...body, projectId: projectId(c), actorUserId: userId(c) }), 201)));
    app.post(`${prefix}/executions/:executionId/pause`, (c) => handle(c, () => service.pause(projectId(c), executionId(c), userId(c))));
    app.post(`${prefix}/executions/:executionId/resume`, (c) => handle(c, () => service.resume(projectId(c), executionId(c), userId(c))));
    app.post(`${prefix}/executions/:executionId/cancel`, (c) => handle(c, () => service.cancel(projectId(c), executionId(c), userId(c))));
    app.get(`${prefix}/executions/:executionId`, (c) => handle(c, () => { userId(c); return service.getExecution(projectId(c), executionId(c)); }));

    app.post(`${prefix}/runs/:runId/pause`, (c) => handle(c, () => service.pause(projectId(c), executionId(c), userId(c))));
    app.post(`${prefix}/runs/:runId/resume`, (c) => handle(c, () => service.resume(projectId(c), executionId(c), userId(c))));
    app.post(`${prefix}/runs/:runId/cancel`, (c) => handle(c, () => service.cancel(projectId(c), executionId(c), userId(c))));
    app.get(`${prefix}/runs/:runId`, (c) => handle(c, () => { userId(c); return service.readContext(projectId(c), c.req.param('runId')); }));
    app.get(`${prefix}/runs/:runId/context`, (c) => handle(c, () => { userId(c); return service.readContext(projectId(c), c.req.param('runId')); }));

    app.get(`${prefix}/machines`, (c) => handle(c, () => { userId(c); return service.listMachines(projectId(c)); }));
    app.post(`${prefix}/tick`, (c) => handle(c, () => { userId(c); return service.tick(projectId(c)); }));

    app.post(`${prefix}/executions/:executionId/children`, (c) => bodyRoute(c, (body) => handle(c, () => service.createChild({ ...body, projectId: projectId(c), executionId: executionId(c) }), 201)));
    app.get(`${prefix}/executions/:executionId/children/:workItemId`, (c) => handle(c, () => { userId(c); return service.childStatus(projectId(c), executionId(c), c.req.param('workItemId')); }));
    app.post(`${prefix}/executions/:executionId/children/:workItemId/message`, (c) => bodyRoute(c, (body) => handle(c, () => {
      userId(c);
      if (typeof body.message !== 'string') throw new HttpError(422, 'validation_failed', 'message is required');
      return service.sendMessage(projectId(c), executionId(c), c.req.param('workItemId'), body.message);
    })));
    app.post(`${prefix}/executions/:executionId/children/:workItemId/cancel`, (c) => handle(c, () => { userId(c); return service.cancelChild(projectId(c), executionId(c), c.req.param('workItemId')); }));
    app.get(`${prefix}/executions/:executionId/children/:workItemId/output`, (c) => handle(c, () => { userId(c); return service.output(projectId(c), executionId(c), c.req.param('workItemId')); }));
  }
}

const orchestrationServices = new WeakMap<ServerContext, OrchestrationService>();

export function getOrchestrationService(context: ServerContext): OrchestrationService {
  const existing = orchestrationServices.get(context);
  if (existing) return existing;
  const nativeCoordination = createCoordinationService(context.database, context.clock, context.ids, { events: context.events });
  const coordination: CoordinationApi = {
    reserveClaim: (projectId, input) => nativeCoordination.reserveClaim(projectId, input as unknown as Parameters<typeof nativeCoordination.reserveClaim>[1]),
    releaseClaim: (projectId, claimId, capability) => nativeCoordination.releaseClaim(projectId, claimId, capability),
    completeClaim: (projectId, claimId, input) => nativeCoordination.completeClaim(projectId, claimId, input as unknown as Parameters<typeof nativeCoordination.completeClaim>[2]),
  };
  const service = new OrchestrationService(context, {
    coordination,
    fleet: createFleetService(context),
  });
  orchestrationServices.set(context, service);
  return service;
}

export const orchestrationModule: DholeModule = {
  id: 'orchestration',
  register(app: DholeApp, context: ServerContext): void {
    registerRoutes(app, getOrchestrationService(context));
  },
};

export { registerRoutes };
