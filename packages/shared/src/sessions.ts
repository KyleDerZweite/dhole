import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './ids.js';

export const AggregateAgentStateSchema = z.enum([
  'queued',
  'running',
  'waiting_on_children',
  'needs_input',
  'needs_approval',
  'blocked',
  'settled',
  'failed',
  'cancelled',
  'stale',
]);

export const LineageEvidenceSchema = z.enum(['platform', 'provider', 'hook', 'heuristic']);
export const AgentControlSchema = z.enum(['full', 'observe_only', 'uncertain']);

export interface AgentTreeNode {
  id: string;
  activationId: string;
  parentId?: string | undefined;
  name: string;
  state: z.infer<typeof AggregateAgentStateSchema>;
  evidence: z.infer<typeof LineageEvidenceSchema>;
  control: z.infer<typeof AgentControlSchema>;
  machineId?: string | undefined;
  runtimeId: string;
  startedAt: string;
  children: AgentTreeNode[];
}

export const AgentTreeNodeSchema: z.ZodType<AgentTreeNode> = z.object({
  id: IdSchema,
  activationId: IdSchema,
  parentId: IdSchema.optional(),
  name: z.string().min(1).max(160),
  state: AggregateAgentStateSchema,
  evidence: LineageEvidenceSchema,
  control: AgentControlSchema,
  machineId: IdSchema.optional(),
  runtimeId: IdSchema,
  startedAt: IsoDateSchema,
  children: z.lazy(() => z.array(AgentTreeNodeSchema)),
});

export const SessionCapabilitySchema = z.object({
  canQueue: z.boolean(),
  canSteer: z.boolean(),
  canCancel: z.boolean(),
  canAnswerApproval: z.boolean(),
});

export type AggregateAgentState = z.infer<typeof AggregateAgentStateSchema>;
