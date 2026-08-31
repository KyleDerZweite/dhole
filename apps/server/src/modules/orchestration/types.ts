import { z } from 'zod';
import type { NodeCommand } from '@dhole-control/shared';

const BoundedChildJsonSchema = z.unknown().refine((value) => {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && encoded.length <= 200_000;
  } catch {
    return false;
  }
}, { message: 'Value is too large or not JSON-serializable' });

const BoundedChildBudgetSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    return JSON.stringify(value).length <= 50_000;
  } catch {
    return false;
  }
}, { message: 'Budget is too large or not JSON-serializable' });

/**
 * The profile is deliberately data-only.  Runtime and provider identifiers are
 * references, never credentials or executable commands.
 */
export const OrchestrationProfileConfigSchema = z
  .object({
    director: z
      .object({ runtime: z.string().min(1).max(120).optional(), model: z.string().min(1).max(160).optional() })
      .default(() => ({})),
    workerRoles: z
      .array(
        z.object({
          role: z.string().min(1).max(120),
          runtimeKinds: z.array(z.string().min(1).max(80)).max(16).default([]),
          modelIds: z.array(z.string().min(1).max(160)).max(32).default([]),
          requiredCapabilities: z.record(z.string(), z.boolean()).default({}),
        }),
      )
      .max(64)
      .default([]),
    reviewer: z
      .object({
        enabled: z.boolean().default(false),
        runtime: z.string().min(1).max(120).optional(),
        model: z.string().min(1).max(160).optional(),
      })
      .default({ enabled: false }),
    eligibleMachineIds: z.array(z.string().min(1).max(160)).max(500).default([]),
    limits: z
      .object({
        maxConcurrency: z.number().int().min(1).max(128).optional(),
        maxDepth: z.number().int().min(0).max(16).optional(),
        maxChildrenPerParent: z.number().int().min(0).max(100).optional(),
        maxRetries: z.number().int().min(0).max(10).optional(),
        maxWorkItems: z.number().int().min(1).max(10_000).optional(),
        budget: z.object({ maxTokens: z.number().int().nonnegative().optional(), maxCostMicrousd: z.number().int().nonnegative().optional() }).optional(),
      })
      .default({})
      .transform((value) => ({
        maxConcurrency: value.maxConcurrency ?? 2,
        maxDepth: value.maxDepth ?? 4,
        maxChildrenPerParent: value.maxChildrenPerParent ?? 8,
        maxRetries: value.maxRetries ?? 1,
        maxWorkItems: value.maxWorkItems ?? 1_000,
        budget: value.budget ?? {},
      })),
    claimBehavior: z.enum(['enforced', 'advisory']).default('enforced'),
    workspacePolicy: z.enum(['isolated', 'shared', 'none']).default('isolated'),
    completion: z
      .object({ requireAllChildren: z.boolean().default(true), failFast: z.boolean().default(false) })
      .default({ requireAllChildren: true, failFast: false }),
    memoryPackVersion: z.string().max(160).optional(),
    skillVersions: z.array(z.string().min(1).max(160)).max(100).default([]),
    /** The fake runtime uses this to make demo/test execution deterministic. */
    fake: z.boolean().default(false),
    initialChildren: z.number().int().min(0).max(100).optional(),
  })
  .strip();

export type OrchestrationProfileConfig = z.infer<typeof OrchestrationProfileConfigSchema>;

export const CreateProfileInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  stableKey: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(240),
  config: OrchestrationProfileConfigSchema,
  createdBy: z.string().min(1).max(160),
});
export type CreateProfileInput = z.infer<typeof CreateProfileInputSchema>;

export const CreateProfileVersionInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  profileId: z.string().min(1).max(160),
  config: OrchestrationProfileConfigSchema,
  createdBy: z.string().min(1).max(160),
  lifecycle: z.enum(['draft', 'active', 'deprecated']).default('draft'),
});
export type CreateProfileVersionInput = z.infer<typeof CreateProfileVersionInputSchema>;

export const StartOrchestrationInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  runId: z.string().min(1).max(160),
  profileVersionId: z.string().min(1).max(160).optional(),
  profileId: z.string().min(1).max(160).optional(),
  actorUserId: z.string().min(1).max(160).optional(),
  autoTick: z.boolean().default(true),
  initialChildren: z.number().int().min(0).max(100).optional(),
});
export type StartOrchestrationInput = z.infer<typeof StartOrchestrationInputSchema>;

export const ChildWorkItemInputSchema = z.object({
  projectId: z.string().min(1).max(160),
  executionId: z.string().min(1).max(160),
  parentWorkItemId: z.string().min(1).max(160).optional(),
  objective: z.string().min(1).max(200_000),
  deliverables: BoundedChildJsonSchema.default([]),
  acceptance: BoundedChildJsonSchema.default([]),
  requiredCapabilities: z.record(z.string(), z.boolean()).default({}),
  claimScope: z
    .object({
      files: z.array(z.string().min(1).max(1024)).max(500).default([]),
      components: z.array(z.string().min(1).max(120)).max(100).default([]),
      task: z.string().max(500).optional(),
      intent: z.string().max(2_000).optional(),
      worktree: z.string().max(300).optional(),
    })
    .default({ files: [], components: [] }),
  workspacePolicy: z.enum(['isolated', 'shared', 'none']).default('isolated'),
  budget: BoundedChildBudgetSchema.default({}),
  dependsOnWorkItemIds: z.array(z.string().min(1).max(160)).max(100).default([]),
});
export type ChildWorkItemInput = z.infer<typeof ChildWorkItemInputSchema>;

export interface SchedulerOptions {
  schedulerId?: string;
  leaseMs?: number;
  maxExecutionsPerTick?: number;
}

export interface CoordinationClaimInput {
  projectId: string;
  runId: string;
  workItemId: string;
  scope: ChildWorkItemInput['claimScope'];
  intent: string;
  actorUserId?: string;
}

export interface CoordinationClaimResult {
  claimId: string;
  conflict?: { claimId: string; severity: 'info' | 'warning' | 'blocking'; reasons: string[] };
}

/** Optional first-party Coordination integration.  The DB fallback is used in tests/demo. */
export interface CoordinationApi {
  claim?(input: CoordinationClaimInput): CoordinationClaimResult;
  reserveClaim?(projectId: string, input: Record<string, unknown>): { claim: { id: string }; conflicts?: Array<{ claimId: string; severity?: string; reasons?: unknown[] }> };
  release?(input: { claimId: string; reason?: string }): void;
  releaseClaim?(projectId: string, claimId: string, capability?: string): unknown;
  settle?(input: { claimId: string; summary?: string }): void;
  completeClaim?(projectId: string, claimId: string, input: Record<string, unknown>): unknown;
  list?(input: { projectId: string; runId?: string }): unknown[];
}

export interface FleetCommandInput {
  machineId: string;
  projectId: string;
  command: NodeCommand;
}

/** Optional first-party Fleet integration.  The durable node_commands row remains authoritative. */
export interface FleetApi {
  enqueueCommand(input: FleetCommandInput): Record<string, unknown>;
  deliverPending?(machineId: string): void;
}

export interface MachineCapability {
  machineId: string;
  name: string;
  availableSlots: number;
  status: string;
  runtime: {
    id: string;
    kind: string;
    label: string;
    capabilities: Record<string, unknown>;
  }[];
}

export interface WorkItemView {
  id: string;
  executionId: string;
  parentWorkItemId?: string;
  objective: string;
  state: string;
  depth: number;
  ordinal: number;
  attempt: number;
  machineId?: string;
  claimId?: string;
  result?: Record<string, unknown> | undefined;
  errorSummary?: string;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}
