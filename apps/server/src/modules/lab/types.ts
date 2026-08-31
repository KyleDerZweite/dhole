import { z } from 'zod';

/** Dimensions are deliberately independent; the Lab never collapses them into one score. */
export const BenchmarkDimensionSchema = z.enum([
  'acceptance',
  'correctness',
  'regression_count',
  'duplicate_work',
  'overlapping_claims',
  'merge_conflicts',
  'incorrect_delegation',
  'human_intervention',
  'failure_recovery',
  'duration_ms',
  'request_count',
  'input_tokens',
  'output_tokens',
  'estimated_cost_microusd',
  'documentation_quality',
  'memory_quality',
]);
export type BenchmarkDimension = z.infer<typeof BenchmarkDimensionSchema>;

export const BenchmarkKindSchema = z.enum(['skill', 'orchestration', 'model', 'memory']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

/** Optional external judge boundary; disabled unless explicitly enabled and configured. */
export const JudgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.string().trim().min(1).max(120).optional(),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

export const BenchmarkStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type BenchmarkStatus = z.infer<typeof BenchmarkStatusSchema>;

export const CandidateConfigSchema = z.object({
  /** Human-readable immutable candidate reference (skill/version, model, profile, etc.). */
  reference: z.string().min(1).max(240),
  /** Configuration is data, never executable code. */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CandidateConfig = z.infer<typeof CandidateConfigSchema>;

export const BenchmarkCaseInputSchema = z.object({
  caseKey: z.string().trim().min(1).max(160),
  prompt: z.string().max(200_000),
  expected: z.unknown(),
  fixture: z.record(z.string(), z.unknown()).default({}),
  ordinal: z.number().int().nonnegative().optional(),
});
export type BenchmarkCaseInput = z.infer<typeof BenchmarkCaseInputSchema>;

export const BenchmarkDefinitionInputSchema = z.object({
  projectId: z.string().min(1).max(160).optional(),
  stableKey: z.string().trim().min(1).max(160),
  version: z.number().int().positive().optional(),
  kind: BenchmarkKindSchema,
  name: z.string().trim().min(1).max(240),
  dimensions: z.array(BenchmarkDimensionSchema).min(1),
  fixture: z.record(z.string(), z.unknown()).default({}),
  scorerVersion: z.string().trim().min(1).max(80).default('deterministic-v1'),
  cases: z.array(BenchmarkCaseInputSchema).default([]),
});
export type BenchmarkDefinitionInput = z.infer<typeof BenchmarkDefinitionInputSchema>;

export const RunBenchmarkInputSchema = z.object({
  benchmarkId: z.string().min(1).max(160),
  baseline: CandidateConfigSchema,
  candidate: CandidateConfigSchema,
  environmentHash: z.string().min(1).max(256).default('fixture'),
  seed: z.string().min(1).max(256).default('dhole-fixture-seed'),
  createdBy: z.string().min(1).max(160),
  attempts: z.number().int().min(1).max(10).default(1),
  judge: z.object({ enabled: z.boolean().default(false), adapter: z.string().max(120).optional() }).default({ enabled: false }),
});
export type RunBenchmarkInput = z.infer<typeof RunBenchmarkInputSchema>;

export const PromotionDecisionInputSchema = z.object({
  projectId: z.string().min(1).max(160).optional(),
  subjectType: z.enum(['skill', 'memory', 'model', 'orchestration']),
  subjectVersionId: z.string().min(1).max(160),
  benchmarkRunId: z.string().min(1).max(160).optional(),
  decision: z.enum(['promote', 'reject', 'canary']),
  reason: z.string().trim().min(1).max(10_000),
  decidedBy: z.string().min(1).max(160),
});
export type PromotionDecisionInput = z.infer<typeof PromotionDecisionInputSchema>;

export const ModelCatalogRecordInputSchema = z.object({
  providerId: z.string().min(1).max(160),
  modelKey: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  declaredCapabilities: z.record(z.string(), z.boolean()).default({}),
  enabled: z.boolean().default(false),
});
export type ModelCatalogRecordInput = z.infer<typeof ModelCatalogRecordInputSchema>;

export const CapabilityProbeInputSchema = z.object({
  modelId: z.string().min(1).max(160),
  capability: z.string().trim().min(1).max(160),
  outcome: z.enum(['supported', 'unsupported', 'unknown']),
  latencyMs: z.number().int().nonnegative().optional(),
  errorSummary: z.string().max(500).optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityProbeInput = z.infer<typeof CapabilityProbeInputSchema>;

export const RoutingRecommendationInputSchema = z.object({
  requiredCapabilities: z.array(z.string().min(1).max(160)).default([]),
  includeDisabled: z.boolean().default(true),
});
export type RoutingRecommendationInput = z.infer<typeof RoutingRecommendationInputSchema>;

export interface BenchmarkDefinition {
  id: string;
  projectId?: string;
  stableKey: string;
  version: number;
  kind: BenchmarkKind;
  name: string;
  fixtureHash: string;
  scorerVersion: string;
  dimensions: BenchmarkDimension[];
  createdAt: string;
}

export interface BenchmarkCase {
  id: string;
  benchmarkId: string;
  caseKey: string;
  prompt: string;
  expected: unknown;
  fixture: Record<string, unknown>;
  fixtureHash: string;
  ordinal: number;
}

export interface BenchmarkCaseRun {
  id: string;
  runId: string;
  caseId: string;
  variant: 'baseline' | 'candidate';
  attempt: number;
  status: 'passed' | 'failed' | 'error';
  output: unknown;
  evidence: Record<string, unknown>;
  durationMs: number;
  requestCount: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostMicrousd?: number;
  createdAt: string;
}

export interface BenchmarkDimensionResult {
  id: string;
  runId: string;
  caseRunId?: string;
  variant: 'baseline' | 'candidate' | 'comparison';
  dimension: BenchmarkDimension | string;
  numericValue?: number;
  booleanValue?: boolean;
  textValue?: string;
  evidence: Record<string, unknown>;
  scorerVersion: string;
  createdAt: string;
}

export interface BenchmarkRun {
  id: string;
  benchmarkId: string;
  baseline: CandidateConfig;
  candidate: CandidateConfig;
  environmentHash: string;
  seed: string;
  state: BenchmarkStatus;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BenchmarkComparison {
  run: BenchmarkRun;
  definitions: BenchmarkDefinition;
  cases: BenchmarkCase[];
  caseRuns: BenchmarkCaseRun[];
  dimensions: BenchmarkDimensionResult[];
  /** Explicit orderings, not a universal score. */
  ordering: {
    quality: ('baseline' | 'candidate')[];
    speed: ('baseline' | 'candidate')[];
    cost: ('baseline' | 'candidate')[];
    balanced: ('baseline' | 'candidate')[];
  };
}

export interface ModelRoutingRecommendation {
  modelId: string;
  providerId: string;
  modelKey: string;
  displayName: string;
  enabled: boolean;
  capabilityStatus: Record<string, 'supported' | 'unsupported' | 'unknown'>;
  rationale: string[];
}

/** Stable local fixture used by tests and demo mode. */
export function createSkillBenchmarkFixture(): BenchmarkDefinitionInput {
  return {
    stableKey: 'skill-deterministic-answer',
    kind: 'skill',
    name: 'Deterministic skill baseline vs candidate',
    dimensions: ['acceptance', 'correctness', 'regression_count', 'duration_ms', 'request_count', 'estimated_cost_microusd'],
    scorerVersion: 'deterministic-v1',
    fixture: { fixtureKind: 'skill-fake-agent', task: 'return 42' },
    cases: [{
      caseKey: 'answer-42',
      prompt: 'Return the number 42 as JSON.',
      expected: { answer: 42 },
      fixture: {
        fixtureKind: 'skill-fake-agent',
        baselineOutput: { answer: 41 },
        candidateOutput: { answer: 42 },
        baselineDurationMs: 24,
        candidateDurationMs: 18,
        baselineRequestCount: 1,
        candidateRequestCount: 1,
        baselineEstimatedCostMicrousd: 12,
        candidateEstimatedCostMicrousd: 10,
      },
    }],
  };
}

/** Stable local fixture for comparing a single agent with a director and two workers. */
export function createOrchestrationBenchmarkFixture(): BenchmarkDefinitionInput {
  return {
    stableKey: 'orchestration-deterministic-workers',
    kind: 'orchestration',
    name: 'Deterministic single agent vs director and two workers',
    dimensions: ['acceptance', 'duplicate_work', 'overlapping_claims', 'incorrect_delegation', 'duration_ms', 'request_count'],
    scorerVersion: 'deterministic-orchestration-v1',
    fixture: { fixtureKind: 'orchestration-fake-agents', workerCount: 2 },
    cases: [{
      caseKey: 'two-worker-task',
      prompt: 'Complete two independent deliverables and report acceptance.',
      expected: { accepted: true },
      fixture: {
        fixtureKind: 'orchestration-fake-agents',
        baseline: { topology: 'single-agent', accepted: true, duplicateWork: 0, overlappingClaims: 0, incorrectDelegation: 0, durationMs: 120, requestCount: 1 },
        candidate: { topology: 'director+two-workers', workerCount: 2, accepted: true, duplicateWork: 0, overlappingClaims: 0, incorrectDelegation: 0, durationMs: 72, requestCount: 3 },
      },
    }],
  };
}
