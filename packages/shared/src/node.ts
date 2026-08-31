import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, IsoDateSchema, RelativePathSchema } from './ids.js';
import { RuntimeDescriptorSchema } from './runtime.js';

const CommandBaseSchema = z.object({
  commandId: IdSchema,
  operationKey: IdempotencyKeySchema,
  issuedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

const RepositoryCommandSchema = z.object({
  repositoryId: IdSchema,
  workspaceId: IdSchema.optional(),
});

export const NodeCommandSchema = z.discriminatedUnion('kind', [
  CommandBaseSchema.extend({ kind: z.literal('discover_runtimes') }),
  CommandBaseSchema.extend({ kind: z.literal('list_repositories') }),
  CommandBaseSchema.merge(RepositoryCommandSchema).extend({
    kind: z.literal('create_runtime_session'),
    runtimeId: IdSchema,
    runtimeSessionKey: IdempotencyKeySchema,
    cwd: RelativePathSchema,
    secretReference: IdSchema.optional(),
  }),
  CommandBaseSchema.merge(RepositoryCommandSchema).extend({
    kind: z.literal('resume_runtime_session'),
    runtimeId: IdSchema,
    runtimeSessionId: IdSchema,
    secretReference: IdSchema.optional(),
  }),
  CommandBaseSchema.extend({
    kind: z.literal('send_message'),
    runtimeSessionId: IdSchema,
    message: z.string().min(1).max(200_000),
  }),
  CommandBaseSchema.extend({
    kind: z.literal('steer'),
    runtimeSessionId: IdSchema,
    turnId: IdSchema,
    message: z.string().min(1).max(200_000),
  }),
  CommandBaseSchema.extend({ kind: z.literal('cancel'), runtimeSessionId: IdSchema, turnId: IdSchema.optional() }),
  CommandBaseSchema.extend({
    kind: z.literal('answer_approval'),
    runtimeSessionId: IdSchema,
    approvalId: IdSchema,
    decision: z.enum(['approve_once', 'approve_session', 'deny', 'cancel']),
  }),
  CommandBaseSchema.merge(RepositoryCommandSchema).extend({
    kind: z.literal('create_worktree'),
    branch: z.string().min(1).max(240),
    baseRevision: z.string().min(1).max(240).optional(),
    relativeTarget: RelativePathSchema,
  }),
  CommandBaseSchema.merge(RepositoryCommandSchema).extend({
    kind: z.literal('remove_worktree'),
    relativeTarget: RelativePathSchema,
  }),
  CommandBaseSchema.merge(RepositoryCommandSchema).extend({
    kind: z.literal('read_session_artifact'),
    relativePath: RelativePathSchema,
    maxBytes: z.number().int().positive().max(1_048_576),
  }),
  CommandBaseSchema.extend({ kind: z.literal('report_health') }),
]);

export const NodeHelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal('dhole.node.v1'),
  machineId: IdSchema,
  daemonVersion: z.string().min(1).max(80),
  journalOperations: z.array(
    z.object({
      operationKey: IdempotencyKeySchema,
      state: z.enum(['accepted', 'running', 'completed', 'failed', 'uncertain']),
      updatedAt: IsoDateSchema,
    }),
  ).max(10_000),
});

export const NodeHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  protocol: z.literal('dhole.node.v1'),
  sentAt: IsoDateSchema,
  availableSlots: z.number().int().nonnegative().max(1_000),
  runtimes: z.array(RuntimeDescriptorSchema).max(100),
});

export const NodeCommandStatusSchema = z.object({
  type: z.literal('command_status'),
  protocol: z.literal('dhole.node.v1'),
  commandId: IdSchema,
  operationKey: IdempotencyKeySchema,
  state: z.enum(['accepted', 'running', 'completed', 'failed', 'uncertain']),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(2_000).optional(),
  occurredAt: IsoDateSchema,
});

export const NodeRuntimeEventSchema = z.object({
  type: z.literal('runtime_event'),
  protocol: z.literal('dhole.node.v1'),
  commandId: IdSchema,
  operationKey: IdempotencyKeySchema,
  sequence: z.number().int().positive().max(10_000),
  eventId: IdSchema,
  eventKind: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: IsoDateSchema,
});

export const NodeClientMessageSchema = z.discriminatedUnion('type', [
  NodeHelloSchema,
  NodeHeartbeatSchema,
  NodeCommandStatusSchema,
  NodeRuntimeEventSchema,
]);

export const NodeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), protocol: z.literal('dhole.node.v1'), heartbeatIntervalMs: z.number().int().min(2_000).max(120_000) }),
  z.object({ type: z.literal('command'), protocol: z.literal('dhole.node.v1'), command: NodeCommandSchema }),
  z.object({ type: z.literal('reconcile'), protocol: z.literal('dhole.node.v1'), operationKeys: z.array(IdempotencyKeySchema).max(10_000) }),
]);

export type NodeCommand = z.infer<typeof NodeCommandSchema>;
export type NodeClientMessage = z.infer<typeof NodeClientMessageSchema>;
export type NodeRuntimeEvent = z.infer<typeof NodeRuntimeEventSchema>;
export type NodeServerMessage = z.infer<typeof NodeServerMessageSchema>;
