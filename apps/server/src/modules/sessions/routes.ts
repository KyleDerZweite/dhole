import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnvironment, AuthenticatedUser, DholeApp, ServerContext } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { SessionsError, SessionsService } from './service.js';
import type { SessionsFleetApi } from './service.js';
import {
  ActivationStateInputSchema,
  AddParticipantInputSchema,
  AnswerApprovalInputSchema,
  CreateAgentInputSchema,
  CreateRunInputSchema,
  CreateSessionInputSchema,
  LeaseInputSchema,
  ProgressInputSchema,
  QueueMessageInputSchema,
  ResumeActivationInputSchema,
  StartTurnInputSchema,
  SteerInputSchema,
} from './types.js';

const ApprovalCreateSchema = z.object({
  kind: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(240),
  detail: z.record(z.string(), z.unknown()).optional(),
  runId: z.string().min(1).max(160).optional(),
  turnId: z.string().min(1).max(160).optional(),
  expiresAt: z.string().datetime({ offset: true }).max(80).optional(),
  runtimeApprovalId: z.string().max(240).optional(),
});

const services = new WeakMap<ServerContext, SessionsService>();

export function getSessionsService(context: ServerContext): SessionsService | undefined { return services.get(context); }
export function configureSessionsFleet(context: ServerContext, fleet: SessionsFleetApi): void { services.get(context)?.setFleet(fleet); }
export class SessionsModule {
  readonly id = 'sessions';

  register(app: DholeApp, context: ServerContext): void {
    const service = new SessionsService(context);
    services.set(context, service);
    const user = (c: Context<AppEnvironment>): AuthenticatedUser => {
      const value = c.get('user');
      if (!value) throw new SessionsError(401, 'authentication_required', 'Authentication is required');
      return value;
    };
    const call = async <T>(c: Context<AppEnvironment>, operation: () => T): Promise<Response> => {
      try {
        return c.json(operation());
      } catch (error) {
        if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
        throw error;
      }
    };
    const callAsync = async <T>(c: Context<AppEnvironment>, operation: () => Promise<T>): Promise<Response> => {
      try {
        return c.json(await operation());
      } catch (error) {
        if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
        throw error;
      }
    };

    app.post('/api/projects/:projectId/sessions', async (c, next) => {
      // The Mediation compatibility surface intentionally retains this route.
      // Its payload is identified by `agent`/`agentLabel` and delegated to the
      // Coordination module registered after Sessions.
      const candidate = await peekJson(c.req.raw.clone());
      if (candidate && (typeof candidate.agent === 'string' || typeof candidate.agentLabel === 'string')) return next();
      if (c.get('credential')) {
        return call(c, () => { throw new SessionsError(403, 'token_scope_denied', 'Bearer tokens may only register compatibility sessions'); });
      }
      return callAsync(c, async () => service.createSession(user(c), c.req.param('projectId'), await parseJson(c, CreateSessionInputSchema)));
    });
    app.get('/api/projects/:projectId/sessions', (c) => call(c, () => {
      const sessions = service.listSessions(user(c), c.req.param('projectId'));
      const runId = c.get('credential')?.runId;
      if (!runId) return { sessions };
      const row = context.database.prepare('SELECT s.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND s.project_id = ?').get(runId, c.req.param('projectId')) as { id: string } | undefined;
      return { sessions: row ? sessions.filter((session) => session.id === row.id) : [] };
    }));
    app.get('/api/projects/:projectId/runtime-registrations', (c) => call(c, () => {
      if (c.get('credential')?.runId) throw new SessionsError(403, 'token_scope_denied', 'A run-scoped token cannot list runtime registrations');
      return { registrations: service.listRuntimeRegistrations(user(c), c.req.param('projectId')) };
    }));
    app.get('/api/sessions/:sessionId', (c) => call(c, () => service.getSnapshot(user(c), c.req.param('sessionId'), readAfter(c))));
    app.get('/api/sessions/:sessionId/snapshot', (c) => call(c, () => service.getSnapshot(user(c), c.req.param('sessionId'), readAfter(c))));
    app.get('/api/sessions/:sessionId/events', (c) => call(c, () => {
      const snapshot = service.getSnapshot(user(c), c.req.param('sessionId'), readAfter(c));
      return { watermark: snapshot.watermark, events: snapshot.events };
    }));
    app.post('/api/sessions/:sessionId/participants', (c) => callAsync(c, async () => service.addParticipant(user(c), c.req.param('sessionId'), (await parseJson(c, AddParticipantInputSchema)).userId)));
    app.post('/api/sessions/:sessionId/messages', (c) => callAsync(c, async () => service.queueMessage(user(c), c.req.param('sessionId'), await parseJson(c, QueueMessageInputSchema))));
    app.post('/api/sessions/:sessionId/runs', (c) => callAsync(c, async () => service.createRun(user(c), c.req.param('sessionId'), await parseJson(c, CreateRunInputSchema))));
    app.post('/api/runs/:runId/start', (c) => call(c, () => service.startRun(user(c), c.req.param('runId'))));
    app.post('/api/sessions/:sessionId/turns', (c) => callAsync(c, async () => service.startTurnForSession(user(c), c.req.param('sessionId'), await parseJson(c, StartTurnInputSchema))));
    app.post('/api/runs/:runId/turns', (c) => callAsync(c, async () => {
      const body = await parseJson(c, StartTurnInputSchema.omit({ runId: true }));
      return service.startTurn(user(c), { ...body, runId: c.req.param('runId') });
    }));
    app.post('/api/turns/:turnId/complete', (c) => call(c, () => service.completeTurn(user(c), c.req.param('turnId'), 'completed')));
    app.post('/api/turns/:turnId/fail', (c) => call(c, () => service.completeTurn(user(c), c.req.param('turnId'), 'failed')));
    app.post('/api/turns/:turnId/cancel', (c) => call(c, () => service.completeTurn(user(c), c.req.param('turnId'), 'cancelled')));
    app.post('/api/sessions/:sessionId/steering/lease', (c) => callAsync(c, async () => {
      const body = await parseJson(c, LeaseInputSchema);
      return service.acquireSteeringLease(user(c), c.req.param('sessionId'), body.leaseToken);
    }));
    app.post('/api/sessions/:sessionId/steering/renew', (c) => callAsync(c, async () => {
      const body = await parseJson(c, LeaseInputSchema.required({ leaseToken: true }));
      return service.renewSteeringLease(user(c), c.req.param('sessionId'), body.leaseToken);
    }));
    app.post('/api/sessions/:sessionId/steer', (c) => callAsync(c, async () => service.steer(user(c), c.req.param('sessionId'), await parseJson(c, SteerInputSchema))));
    app.post('/api/sessions/:sessionId/cancel', (c) => call(c, () => service.cancelSession(user(c), c.req.param('sessionId'), c.req.query('turnId'))));
    app.post('/api/sessions/:sessionId/approvals', (c) => callAsync(c, async () => {
      const input = await parseJson(c, ApprovalCreateSchema);
      return service.createApproval(user(c), c.req.param('sessionId'), input);
    }));
    app.post('/api/sessions/:sessionId/approvals/:approvalId/answer', (c) => callAsync(c, async () => service.answerApproval(user(c), c.req.param('sessionId'), c.req.param('approvalId'), await parseJson(c, AnswerApprovalInputSchema))));
    app.post('/api/runs/:runId/agents', (c) => callAsync(c, async () => service.createAgent(user(c), c.req.param('runId'), await parseJson(c, CreateAgentInputSchema))));
    app.get('/api/runs/:runId/agents', (c) => call(c, () => ({ tree: service.getTree(user(c), c.req.param('runId')) })));
    app.post('/api/runs/:runId/state', (c) => callAsync(c, async () => {
      const input = await parseJson(c, z.object({ state: z.enum(['queued', 'running', 'paused', 'cancelling', 'settled', 'failed', 'cancelled']) }));
      return service.setRunState(user(c), c.req.param('runId'), input.state);
    }));
    app.post('/api/agents/:logicalAgentId/resume', (c) => callAsync(c, async () => service.resumeActivation(user(c), c.req.param('logicalAgentId'), await parseJson(c, ResumeActivationInputSchema))));
    app.post('/api/activations/:activationId/start', (c) => call(c, () => service.startActivation(user(c), c.req.param('activationId'))));
    app.post('/api/activations/:activationId/state', (c) => callAsync(c, async () => service.updateActivationState(user(c), c.req.param('activationId'), (await parseJson(c, ActivationStateInputSchema)).state)));
    app.post('/api/activations/:activationId/progress', (c) => callAsync(c, async () => service.upsertProgress(user(c), c.req.param('activationId'), await parseJson(c, ProgressInputSchema))));
    app.get('/api/activations/:activationId/progress', (c) => call(c, () => ({ progress: service.getProgress(user(c), c.req.param('activationId')) })));
  }
}

export const sessionsModule = new SessionsModule();

function readAfter(c: Context<AppEnvironment>): number {
  const raw = c.req.query('after') ?? c.req.query('afterSequence') ?? '0';
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function peekJson(request: Request, maxBytes = 512 * 1024): Promise<Record<string, unknown> | undefined> {
  const stream = request.body;
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) { try { await reader.cancel(); } catch { /* best effort */ } return undefined; }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
