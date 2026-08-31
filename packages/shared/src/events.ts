import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, IsoDateSchema } from './ids.js';

export const EventKindSchema = z.enum([
  'session.created',
  'run.started',
  'human.message.queued',
  'human.message.delivered',
  'agent.message.completed',
  'tool.call.started',
  'tool.call.completed',
  'approval.requested',
  'approval.answered',
  'child.discovered',
  'child.started',
  'child.activation.resumed',
  'child.state.changed',
  'progress.changed',
  'claim.created',
  'claim.updated',
  'claim.settled',
  'conflict.detected',
  'machine.connected',
  'machine.disconnected',
  'command.queued',
  'command.acknowledged',
  'command.completed',
  'orchestration.paused',
  'orchestration.resumed',
  'run.settled',
  'run.failed',
  'memory.proposed',
  'memory.decided',
  'memory.activated',
  'benchmark.completed',
  'candidate.decided',
]);

export const EventActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: IdSchema }),
  z.object({ type: z.literal('node'), machineId: IdSchema }),
  z.object({ type: z.literal('runtime'), runtimeId: IdSchema }),
  z.object({ type: z.literal('system') }),
]);

export const EventSourceSchema = z.object({
  kind: z.enum(['platform', 'provider', 'hook', 'heuristic', 'import']),
  adapter: z.string().min(1).max(80).optional(),
  nativeEventId: z.string().min(1).max(256).optional(),
  rawReference: z.string().min(1).max(256).optional(),
});

export const EventEnvelopeSchema = z.object({
  protocol: z.literal('dhole.event'),
  schemaVersion: z.literal(1),
  eventId: IdSchema,
  eventKind: EventKindSchema,
  projectId: IdSchema,
  projectSequence: z.number().int().positive(),
  aggregateType: z.string().min(1).max(80),
  aggregateId: IdSchema,
  parentAggregateId: IdSchema.optional(),
  actor: EventActorSchema,
  source: EventSourceSchema,
  idempotencyKey: IdempotencyKeySchema.optional(),
  occurredAt: IsoDateSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
