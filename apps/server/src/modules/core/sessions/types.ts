import { z } from 'zod';
import type { EventEnvelope } from '@dhole-control/shared';
import { AgentControlSchema, AggregateAgentStateSchema, LineageEvidenceSchema } from '@dhole-control/shared';

export const SessionStateSchema = z.enum(['idle', 'busy', 'needs_input', 'needs_approval', 'failed', 'cancelled', 'closed']);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const RunStateSchema = z.enum(['queued', 'running', 'paused', 'cancelling', 'settled', 'failed', 'cancelled']);
export type RunState = z.infer<typeof RunStateSchema>;

export const TurnStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const MessageStatusSchema = z.enum(['queued', 'delivered', 'completed', 'failed', 'cancelled']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const ApprovalDecisionSchema = z.enum(['approve_once', 'approve_session', 'deny', 'cancel']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  runtimeRegistrationId: z.string().min(1).max(160).optional(),
  modelId: z.string().min(1).max(160).optional(),
  workspaceId: z.string().min(1).max(160).optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const AddParticipantInputSchema = z.object({ userId: z.string().min(1).max(160) });
export type AddParticipantInput = z.infer<typeof AddParticipantInputSchema>;

export const QueueMessageInputSchema = z.object({
  body: z.string().min(1).max(200_000),
  runId: z.string().min(1).max(160).optional(),
  turnId: z.string().min(1).max(160).optional(),
  includeHumanIdentity: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type QueueMessageInput = z.infer<typeof QueueMessageInputSchema>;

export const CreateRunInputSchema = z.object({
  rootObjective: z.string().min(1).max(200_000),
  issueReference: z.string().max(500).optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export const StartTurnInputSchema = z.object({
  runId: z.string().min(1).max(160),
  runtimeTurnId: z.string().max(240).optional(),
});
export type StartTurnInput = z.infer<typeof StartTurnInputSchema>;

export const SteerInputSchema = z.object({
  message: z.string().min(1).max(200_000),
  turnId: z.string().min(1).max(160),
  leaseToken: z.string().min(8).max(512),
});
export type SteerInput = z.infer<typeof SteerInputSchema>;

export const LeaseInputSchema = z.object({ leaseToken: z.string().min(8).max(512).optional() });
export type LeaseInput = z.infer<typeof LeaseInputSchema>;

export const AnswerApprovalInputSchema = z.object({
  decision: ApprovalDecisionSchema,
  expectedVersion: z.number().int().positive().optional(),
});
export type AnswerApprovalInput = z.infer<typeof AnswerApprovalInputSchema>;

export const CreateAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  role: z.string().max(160).optional(),
  objective: z.string().max(200_000).optional(),
  parentLogicalAgentId: z.string().min(1).max(160).optional(),
  evidence: LineageEvidenceSchema.default('platform'),
  control: AgentControlSchema.optional(),
  sourceReference: z.string().max(256).optional(),
  confidence: z.number().min(0).max(1).optional(),
  machineId: z.string().min(1).max(160).optional(),
  runtimeRegistrationId: z.string().min(1).max(160).optional(),
  workspaceId: z.string().min(1).max(160).optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const ResumeActivationInputSchema = z.object({
  machineId: z.string().min(1).max(160).optional(),
  runtimeRegistrationId: z.string().min(1).max(160).optional(),
  workspaceId: z.string().min(1).max(160).optional(),
  nativeSessionId: z.string().max(240).optional(),
});
export type ResumeActivationInput = z.infer<typeof ResumeActivationInputSchema>;

export const ActivationStateInputSchema = z.object({
  state: AggregateAgentStateSchema,
});
export type ActivationStateInput = z.infer<typeof ActivationStateInputSchema>;

export const ProgressInputSchema = z.object({
  activityKey: z.string().min(1).max(160),
  label: z.string().min(1).max(240),
  currentValue: z.number().finite().optional(),
  totalValue: z.number().finite().optional(),
  unit: z.string().max(80).optional(),
  important: z.boolean().optional(),
});
export type ProgressInput = z.infer<typeof ProgressInputSchema>;

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  runtimeRegistrationId?: string;
  modelId?: string;
  workspaceId?: string;
  state: SessionState;
  activeTurnId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRegistration {
  id: string;
  machineId: string;
  kind: string;
  label: string;
  available: boolean;
  capabilities: Record<string, unknown>;
}

export interface SessionParticipant {
  userId: string;
  displayName: string;
  joinedAt: string;
  leftAt?: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  runId?: string;
  turnId?: string;
  sequence: number;
  role: 'human' | 'agent' | 'tool' | 'system';
  authorUserId?: string;
  logicalAgentId?: string;
  body: string;
  status: MessageStatus;
  createdAt: string;
  deliveredAt?: string;
  completedAt?: string;
  includeHumanIdentity: boolean;
}

export interface SessionRun {
  id: string;
  sessionId: string;
  rootObjective: string;
  issueReference?: string;
  state: RunState;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface SessionTurn {
  id: string;
  sessionId: string;
  runId: string;
  runtimeTurnId?: string;
  state: TurnState;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface SessionApproval {
  id: string;
  sessionId: string;
  runId?: string;
  turnId?: string;
  runtimeApprovalId?: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  state: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
  requestedAt: string;
  expiresAt?: string;
  answeredBy?: string;
  answeredAt?: string;
  decision?: ApprovalDecision;
  version: number;
}

export interface SessionProgress {
  activationId: string;
  activityKey: string;
  label: string;
  currentValue?: number;
  totalValue?: number;
  unit?: string;
  important: boolean;
  updatedAt: string;
}

export interface SessionSnapshot {
  session: SessionSummary;
  participants: SessionParticipant[];
  runs: SessionRun[];
  turns: SessionTurn[];
  messages: SessionMessage[];
  approvals: SessionApproval[];
  tree: AgentTreeNode[];
  progress: SessionProgress[];
  watermark: number;
  events: EventEnvelope[];
}

export interface AgentTreeNode {
  id: string;
  activationId: string;
  parentId?: string;
  name: string;
  state: z.infer<typeof AggregateAgentStateSchema>;
  evidence: z.infer<typeof LineageEvidenceSchema>;
  control: z.infer<typeof AgentControlSchema>;
  machineId?: string;
  runtimeId: string;
  startedAt: string;
  children: AgentTreeNode[];
}
