import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => text(max).nullable().optional();
const files = z.array(text(1_024)).max(500).optional();
const scope = { projectId: text(160).optional(), runId: text(160).optional() };
const session = { coordinationSessionId: text(160).optional(), sessionId: text(160).optional() };
const claim = {
  ...scope, ...session, claimId: text(160).optional(), intent: text(2_000).optional(), task: nullableText(500), files,
  components: z.array(text(120)).max(100).optional(), branch: nullableText(240), baseRevision: nullableText(240),
  worktree: nullableText(1_024), worktreeHash: text(256).optional(), workItemId: text(160).optional(),
  status: z.enum(['investigating', 'in-progress', 'testing', 'blocked']).optional(), blockedOn: nullableText(160),
  finding: text(2_000).optional(), findingFiles: files, findingKind: z.enum(['root-cause', 'gotcha', 'decision', 'api-change']).optional(),
  mode: z.enum(['advisory', 'enforced']).optional(), enforce: z.boolean().optional(),
};
const complete = {
  ...scope, ...session, claimId: text(160), commits: z.array(text(240)).max(100).optional(),
  prs: z.array(text(500)).max(100).optional(), summary: nullableText(2_000), status: z.enum(['done', 'abandoned']).optional(),
};
const repo = { ...scope, ...session, branch: nullableText(240), revision: nullableText(240), dirtyFiles: files };

/** Session capability belongs in the HTTP header, never in model tool arguments. */
export const coordinationToolSchemas: Record<string, z.ZodType> = {
  coordination_session_register: z.strictObject({ ...scope, agentLabel: text(120), developerLabel: nullableText(160), worktree: nullableText(1_024), worktreeHash: text(256).optional() }),
  coordination_session_heartbeat: z.strictObject({ ...repo, activity: z.string().max(500).nullable().optional() }),
  coordination_session_end: z.strictObject({ ...scope, ...session }),
  coordination_repo_report: z.strictObject(repo),
  coordination_claim: z.strictObject(claim),
  coordination_complete: z.strictObject(complete),
  coordination_release: z.strictObject({ ...scope, ...session, claimId: text(160) }),
  coordination_revive: z.strictObject({ ...claim, claimId: text(160) }),
  coordination_check: z.strictObject({ ...scope, ...session, files, components: z.array(text(120)).max(100).optional(), task: nullableText(500), intent: z.string().max(2_000).optional(), worktree: nullableText(1_024) }),
  coordination_state: z.strictObject(scope),
  coordination_agent_event: z.strictObject({
    ...scope, ...session, eventId: text(160), runId: text(160), agentId: text(160), parentAgentId: nullableText(160), harness: text(64),
    name: nullableText(80), role: nullableText(64), task: nullableText(280),
    state: z.enum(['starting', 'active', 'waiting', 'blocked', 'needs-input', 'completed', 'failed', 'cancelled']),
    stateReason: nullableText(280), occurredAt: z.union([text(80), z.number().int().nonnegative()]),
  }),
};
