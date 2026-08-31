import { z } from 'zod';

export const SkillLifecycleSchema = z.enum(['draft', 'benchmarked', 'canary', 'active', 'deprecated']);
export type SkillLifecycle = z.infer<typeof SkillLifecycleSchema>;

export const SkillManifestSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1_024),
  stableKey: z.string().trim().min(1).max(120).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  license: z.string().trim().max(160).optional(),
  compatibility: z.string().trim().max(500).optional(),
  allowedTools: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
  references: z.array(z.string().min(1).max(1_024)).max(64).optional(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillProposalActorSchema = z.union([
  z.object({ type: z.literal('user'), userId: z.string().min(1).max(160) }),
  z.object({ type: z.literal('activation'), activationId: z.string().min(1).max(160) }),
]);
export type SkillProposalActor = z.infer<typeof SkillProposalActorSchema>;

export const SkillProposalInputSchema = z.object({
  projectId: z.string().min(1).max(160).nullable().optional(),
  stableKey: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  markdown: z.string().min(1).max(500_000),
  directory: z.string().min(1).max(1_024).optional(),
  references: z.array(z.string().min(1).max(1_024)).max(64).optional(),
});
export type SkillProposalInput = z.infer<typeof SkillProposalInputSchema>;

export const SkillLifecycleInputSchema = z.object({
  lifecycle: SkillLifecycleSchema,
});

export interface Skill {
  id: string;
  projectId?: string;
  stableKey: string;
  name: string;
  activeVersionId?: string;
  createdAt: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  lifecycle: SkillLifecycle;
  markdown: string;
  manifest: SkillManifest;
  contentHash: string;
  proposedByUserId?: string;
  proposedByActivationId?: string;
  createdAt: string;
}
