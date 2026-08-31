import { createHash } from 'node:crypto';
import type { BenchmarkCase, BenchmarkDimension, CandidateConfig } from './types.js';

export interface BenchmarkExecutionResult {
  status: 'passed' | 'failed' | 'error';
  output: unknown;
  evidence: Record<string, unknown>;
  durationMs: number;
  requestCount: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostMicrousd?: number;
}

export interface DimensionScore {
  dimension: BenchmarkDimension | string;
  numericValue?: number;
  booleanValue?: boolean;
  textValue?: string;
  evidence: Record<string, unknown>;
}

export interface BenchmarkExecutor {
  execute(input: {
    benchmarkCase: BenchmarkCase;
    variant: 'baseline' | 'candidate';
    config: CandidateConfig;
    seed: string;
  }): BenchmarkExecutionResult;
}

export interface BenchmarkScorer {
  score(input: {
    benchmarkCase: BenchmarkCase;
    execution: BenchmarkExecutionResult;
    dimensions: readonly (BenchmarkDimension | string)[];
  }): DimensionScore[];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function hashFixture(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A pure fake-agent executor. It only reads fixture/config data and never starts a
 * process or makes a network request, which makes benchmark runs reproducible.
 */
export class DeterministicFakeAgentExecutor implements BenchmarkExecutor {
  execute(input: {
    benchmarkCase: BenchmarkCase;
    variant: 'baseline' | 'candidate';
    config: CandidateConfig;
    seed: string;
  }): BenchmarkExecutionResult {
    const fixture = input.benchmarkCase.fixture;
    const kind = typeof fixture.fixtureKind === 'string' ? fixture.fixtureKind : 'generic-fake-agent';
    const variantFixture = asRecord(fixture[input.variant]);
    const configRecord = asRecord(input.config.config);
    let output: unknown;
    let durationMs = 10;
    let requestCount = 1;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let estimatedCostMicrousd: number | undefined;
    const evidence: Record<string, unknown> = { executor: 'deterministic-fake-agent', seed: input.seed, variant: input.variant, kind };

    if (kind === 'skill-fake-agent') {
      output = fixture[`${input.variant}Output`];
      durationMs = numberValue(fixture[`${input.variant}DurationMs`], durationMs);
      requestCount = numberValue(fixture[`${input.variant}RequestCount`], requestCount);
      estimatedCostMicrousd = numberValue(fixture[`${input.variant}EstimatedCostMicrousd`], 0);
    } else if (kind === 'orchestration-fake-agents') {
      output = variantFixture.output ?? { accepted: variantFixture.accepted === true };
      durationMs = numberValue(variantFixture.durationMs, durationMs);
      requestCount = numberValue(variantFixture.requestCount, requestCount);
      evidence.topology = variantFixture.topology;
      evidence.workerCount = variantFixture.workerCount ?? (input.variant === 'candidate' ? 2 : 0);
      evidence.duplicateWork = numberValue(variantFixture.duplicateWork, 0);
      evidence.overlappingClaims = numberValue(variantFixture.overlappingClaims, 0);
      evidence.incorrectDelegation = numberValue(variantFixture.incorrectDelegation, 0);
    } else {
      output = fixture[`${input.variant}Output`] ?? configRecord.output ?? configRecord.result ?? { accepted: true };
      durationMs = numberValue(fixture[`${input.variant}DurationMs`], durationMs);
      requestCount = numberValue(fixture[`${input.variant}RequestCount`], requestCount);
      inputTokens = numberValue(fixture[`${input.variant}InputTokens`], 0);
      outputTokens = numberValue(fixture[`${input.variant}OutputTokens`], 0);
      estimatedCostMicrousd = numberValue(fixture[`${input.variant}EstimatedCostMicrousd`], 0);
    }

    if (inputTokens === undefined && typeof fixture[`${input.variant}InputTokens`] === 'number') inputTokens = numberValue(fixture[`${input.variant}InputTokens`], 0);
    if (outputTokens === undefined && typeof fixture[`${input.variant}OutputTokens`] === 'number') outputTokens = numberValue(fixture[`${input.variant}OutputTokens`], 0);
    const status = output === undefined ? 'error' : 'passed';
    return {
      status,
      output: output ?? null,
      evidence,
      durationMs: Math.max(0, Math.trunc(durationMs)),
      requestCount: Math.max(0, Math.trunc(requestCount)),
      ...(inputTokens === undefined ? {} : { inputTokens: Math.max(0, Math.trunc(inputTokens)) }),
      ...(outputTokens === undefined ? {} : { outputTokens: Math.max(0, Math.trunc(outputTokens)) }),
      ...(estimatedCostMicrousd === undefined ? {} : { estimatedCostMicrousd: Math.max(0, Math.trunc(estimatedCostMicrousd)) }),
    };
  }
}

export class DeterministicScorer implements BenchmarkScorer {
  score(input: {
    benchmarkCase: BenchmarkCase;
    execution: BenchmarkExecutionResult;
    dimensions: readonly (BenchmarkDimension | string)[];
  }): DimensionScore[] {
    const expected = input.benchmarkCase.expected;
    const accepted = input.execution.status === 'passed' && deepEqual(input.execution.output, expected);
    const evidenceBase = { scorer: 'deterministic-v1', expected, output: input.execution.output };
    const dimensions = new Set(input.dimensions);
    const values: DimensionScore[] = [];
    const addBoolean = (dimension: string, value: boolean): void => {
      if (dimensions.has(dimension)) values.push({ dimension, booleanValue: value, evidence: evidenceBase });
    };
    const addNumber = (dimension: string, value: number): void => {
      if (dimensions.has(dimension)) values.push({ dimension, numericValue: value, evidence: evidenceBase });
    };
    addBoolean('acceptance', accepted);
    addNumber('correctness', accepted ? 1 : 0);
    addNumber('regression_count', accepted ? 0 : 1);
    addNumber('duration_ms', input.execution.durationMs);
    addNumber('request_count', input.execution.requestCount);
    addNumber('input_tokens', input.execution.inputTokens ?? 0);
    addNumber('output_tokens', input.execution.outputTokens ?? 0);
    addNumber('estimated_cost_microusd', input.execution.estimatedCostMicrousd ?? 0);
    for (const dimension of ['duplicate_work', 'overlapping_claims', 'merge_conflicts', 'incorrect_delegation', 'human_intervention', 'failure_recovery']) {
      if (dimensions.has(dimension)) addNumber(dimension, numberValue(input.execution.evidence[dimension], 0));
    }
    for (const dimension of ['documentation_quality', 'memory_quality']) {
      if (dimensions.has(dimension)) addNumber(dimension, numberValue(input.execution.evidence[dimension], accepted ? 1 : 0));
    }
    return values;
  }
}
