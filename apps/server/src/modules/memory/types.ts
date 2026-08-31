import { z } from 'zod';

export const MemoryScopeSchema = z.enum(['project', 'role', 'phase']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySourceTypeSchema = z.string().trim().min(1).max(80);
export const MemorySourceReferenceSchema = z.string().trim().min(1).max(512);

export const MemoryPackInputSchema = z.object({
  stableKey: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(240),
  scope: MemoryScopeSchema,
  scopeKey: z.string().trim().max(160).optional(),
});
export type MemoryPackInput = z.infer<typeof MemoryPackInputSchema>;

export const MemoryEntryInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(100_000),
  sourceType: MemorySourceTypeSchema,
  sourceReference: MemorySourceReferenceSchema,
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type MemoryEntryInput = z.input<typeof MemoryEntryInputSchema>;

export const MemoryProposalInputSchema = MemoryEntryInputSchema.extend({
  baseGenerationId: z.string().min(1).max(160).optional(),
});
export type MemoryProposalInput = z.input<typeof MemoryProposalInputSchema>;

export const MemoryProposalActorSchema = z.union([
  z.object({ type: z.literal('user'), userId: z.string().min(1).max(160) }),
  z.object({ type: z.literal('activation'), activationId: z.string().min(1).max(160) }),
]);
export type MemoryProposalActor = z.infer<typeof MemoryProposalActorSchema>;

export const MemoryDecisionInputSchema = z.object({
  decision: z.enum(['approve', 'approved', 'reject', 'rejected']),
  reason: z.string().trim().max(2_000).optional(),
});
export type MemoryDecisionInput = z.infer<typeof MemoryDecisionInputSchema>;

export const MemoryFoldInputSchema = z.object({
  baseGenerationId: z.string().min(1).max(160).optional(),
  entryIds: z.array(z.string().min(1).max(160)).max(2_000).optional(),
  proposalIds: z.array(z.string().min(1).max(160)).max(2_000).optional(),
  reason: z.string().trim().max(2_000).optional(),
});
export type MemoryFoldInput = z.infer<typeof MemoryFoldInputSchema>;

export const MemoryReadOptionsSchema = z.object({
  generationId: z.string().min(1).max(160).optional(),
  includeArchived: z.boolean().default(false),
  entryIds: z.array(z.string().min(1).max(160)).max(2_000).optional(),
  maxEntries: z.number().int().positive().max(2_000).default(200),
  maxChars: z.number().int().positive().max(500_000).default(100_000),
});
export type MemoryReadOptions = z.input<typeof MemoryReadOptionsSchema>;

export interface MemoryPack {
  id: string;
  projectId: string;
  stableKey: string;
  name: string;
  scope: MemoryScope;
  scopeKey?: string;
  activeGenerationId?: string;
  createdAt: string;
}

export interface MemoryGeneration {
  id: string;
  packId: string;
  parentGenerationId?: string;
  generation: number;
  contentHash: string;
  state: 'draft' | 'approved' | 'active' | 'archived';
  foldReason?: string;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  archivedAt?: string;
  entries: MemoryEntry[];
}

export interface MemoryEntry {
  id: string;
  generationId: string;
  ordinal: number;
  title: string;
  body: string;
  sourceType: string;
  sourceReference: string;
  evidence: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface MemoryProposal {
  id: string;
  packId: string;
  baseGenerationId?: string;
  proposedByUserId?: string;
  proposedByActivationId?: string;
  title: string;
  body: string;
  sourceType: string;
  sourceReference: string;
  state: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decisionReason?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface MemoryContext {
  pack: MemoryPack;
  generation: MemoryGeneration;
  entries: MemoryEntry[];
  truncated: boolean;
}
