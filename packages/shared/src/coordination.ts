import { z } from 'zod';
import { IdSchema, IsoDateSchema, RelativePathSchema } from './ids.js';

export const ClaimStatusSchema = z.enum([
  'investigating',
  'in-progress',
  'testing',
  'blocked',
  'done',
  'abandoned',
  'expired',
  'released',
]);

export const ClaimScopeSchema = z.object({
  files: z.array(RelativePathSchema).max(500).default([]),
  components: z.array(z.string().min(1).max(120)).max(100).default([]),
  task: z.string().max(500).optional(),
  intent: z.string().min(1).max(2_000),
  worktree: z.string().max(300).optional(),
});

export const ClaimSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  coordinationSessionId: IdSchema,
  runId: IdSchema.optional(),
  workItemId: IdSchema.optional(),
  status: ClaimStatusSchema,
  scope: ClaimScopeSchema,
  blockedOn: IdSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

export const ConflictReasonSchema = z.object({
  type: z.enum(['files', 'components', 'task']),
  detail: z.string().min(1).max(1_000),
});

export const ConflictSchema = z.object({
  id: IdSchema,
  claimId: IdSchema,
  conflictingClaimId: IdSchema,
  severity: z.enum(['info', 'warning', 'blocking']),
  reasons: z.array(ConflictReasonSchema).min(1),
  createdAt: IsoDateSchema,
  resolvedAt: IsoDateSchema.optional(),
});

export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimScope = z.infer<typeof ClaimScopeSchema>;
export type Conflict = z.infer<typeof ConflictSchema>;
