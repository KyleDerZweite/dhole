import { hashFixture, DeterministicFakeAgentExecutor, DeterministicScorer, type BenchmarkExecutor, type BenchmarkScorer } from './executor.js';
import type { z } from 'zod';
import {
  BenchmarkCaseInputSchema,
  BenchmarkDefinitionInputSchema,
  CandidateConfigSchema,
  CapabilityProbeInputSchema,
  ModelCatalogRecordInputSchema,
  PromotionDecisionInputSchema,
  RoutingRecommendationInputSchema,
  RunBenchmarkInputSchema,
  type BenchmarkCase,
  type BenchmarkComparison,
  type BenchmarkDefinition,
  type BenchmarkDimension,
  type BenchmarkDimensionResult,
  type BenchmarkRun,
  type BenchmarkCaseRun,
  type CandidateConfig,
  type CapabilityProbeInput,
  type ModelCatalogRecordInput,
  type ModelRoutingRecommendation,
  type PromotionDecisionInput,
  type RoutingRecommendationInput,
} from './types.js';
import type { Clock, IdSource } from '../../lib/clock.js';
import type { DatabaseConnection } from '../../lib/database.js';
import type { EventStore } from '../../lib/events.js';
import { HttpError } from '../../lib/http.js';
import { redactSecrets, redactText } from '../../lib/security.js';

export interface LabContext {
  database: DatabaseConnection;
  clock: Clock;
  ids: IdSource;
  events?: EventStore;
}

export interface LabServiceOptions {
  executor?: BenchmarkExecutor;
  scorer?: BenchmarkScorer;
  judge?: { enabled: boolean; adapter?: string };
}

export interface ProviderInput {
  teamId: string;
  kind: string;
  name: string;
  baseUrl?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface ProviderRecord {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  baseUrl?: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelKey: string;
  displayName: string;
  declaredCapabilities: Record<string, boolean>;
  measuredCapabilities: Record<string, 'supported' | 'unsupported' | 'unknown'>;
  enabled: boolean;
  catalogObservedAt?: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = /secret|token|password|credential|api[_-]?key|private[_-]?key/i.test(key) ? '[REDACTED]' : redact(item);
    }
    return result;
  }
  return value;
}

function redactedRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return asRecord(redact(value ?? {}));
}

/** Audit only operation metadata; never include benchmark or review content. */
function recordLabAudit(
  context: LabContext,
  projectId: string | null | undefined,
  actorId: string | undefined,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
): void {
  context.database.prepare(`
    INSERT INTO audit_records(id, project_id, actor_type, actor_id, action, target_type, target_id, outcome, detail_json, occurred_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, 'allowed', ?, ?)
  `).run(
    context.ids.id(),
    projectId ?? null,
    actorId ?? null,
    action,
    targetType,
    targetId,
    redactText(JSON.stringify(detail), 4_096),
    context.clock.now().toISOString(),
  );
}

const BENCHMARK_CREDENTIAL_KEYS = new Set([
  'token', 'secret', 'password', 'credential', 'authorization', 'cookie', 'bearer',
  'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'privatekey',
  'clientsecret', 'clienttoken', 'managementsecret', 'managementtoken',
]);

function isBenchmarkCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return BENCHMARK_CREDENTIAL_KEYS.has(normalized)
    || /(?:apikey|apitoken|accesstoken|refreshtoken|privatekey|clientsecret|clienttoken|managementsecret|managementtoken)$/u.test(normalized);
}

function containsBenchmarkCredential(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === 'string') return redactSecrets(value, value.length) !== value;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const found = value.some((item) => containsBenchmarkCredential(item, seen));
    seen.delete(value);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isBenchmarkCredentialKey(key) && item !== '[REDACTED]') {
      seen.delete(value);
      return true;
    }
    if (containsBenchmarkCredential(item, seen)) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

function assertBenchmarkContentSafe(values: readonly unknown[]): void {
  const seen = new WeakSet<object>();
  if (values.some((value) => containsBenchmarkCredential(value, seen))) {
    throw new HttpError(422, 'credential_in_benchmark', 'Benchmark prompts, expected values, and fixtures must not contain credentials');
  }
}

const PROBE_SENSITIVE_KEY = /secret|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie/i;
const PROBE_MAX_DEPTH = 4;
const PROBE_MAX_ENTRIES = 64;
const PROBE_MAX_ARRAY_ITEMS = 64;
const PROBE_MAX_STRING_LENGTH = 2_000;
const PROBE_MAX_JSON_CHARS = 16_384;
const PROBE_SENSITIVE_ASSIGNMENT = /((?:secret|(?:access|refresh)[_-]?token|token|password|credential|api[_-]?key|private[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;\"']+)/gi;

interface ProbeBudget {
  remaining: number;
  seen: WeakSet<object>;
}

function redactProbeText(value: string, maxLength: number): string {
  return redactText(value, maxLength).replace(PROBE_SENSITIVE_ASSIGNMENT, '$1[REDACTED]');
}

function boundedProbeValue(value: unknown, depth: number, budget: ProbeBudget): unknown {
  if (depth > PROBE_MAX_DEPTH || budget.remaining <= 0) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[TRUNCATED]';
  if (typeof value === 'string') {
    const redacted = redactProbeText(value, Math.min(PROBE_MAX_STRING_LENGTH, budget.remaining));
    budget.remaining = Math.max(0, budget.remaining - redacted.length);
    return redacted;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return '[TRUNCATED]';
  if (budget.seen.has(value)) return '[CIRCULAR]';
  budget.seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.slice(0, PROBE_MAX_ARRAY_ITEMS).map((item) => boundedProbeValue(item, depth + 1, budget));
  } else {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value).slice(0, PROBE_MAX_ENTRIES)) {
      if (budget.remaining <= 0) break;
      const boundedKey = redactProbeText(key, Math.min(160, budget.remaining));
      budget.remaining = Math.max(0, budget.remaining - boundedKey.length);
      output[boundedKey] = PROBE_SENSITIVE_KEY.test(key) ? '[REDACTED]' : boundedProbeValue(item, depth + 1, budget);
    }
    result = output;
  }
  budget.seen.delete(value);
  return result;
}

function boundedProbeRecord(value: unknown): Record<string, unknown> {
  const result = boundedProbeValue(value, 0, { remaining: PROBE_MAX_JSON_CHARS, seen: new WeakSet<object>() });
  return asRecord(result);
}

function validateProviderBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(422, 'invalid_provider_url', 'Provider base URL must be a valid HTTP(S) URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new HttpError(422, 'invalid_provider_url', 'Provider base URL must use HTTP(S) without embedded credentials');
  }
  return value;
}

interface PromotionSubject {
  projectId?: string;
  teamId?: string;
}

function rowToDefinition(row: Record<string, unknown>): BenchmarkDefinition {
  const dimensions = parseJson<BenchmarkDimension[]>(String(row.dimensions_json), []);
  return {
    id: String(row.id),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    stableKey: String(row.stable_key),
    version: Number(row.version),
    kind: row.kind as BenchmarkDefinition['kind'],
    name: String(row.name),
    fixtureHash: String(row.fixture_hash),
    scorerVersion: String(row.scorer_version),
    dimensions,
    createdAt: String(row.created_at),
  };
}

function rowToCase(row: Record<string, unknown>): BenchmarkCase {
  return {
    id: String(row.id),
    benchmarkId: String(row.benchmark_id),
    caseKey: String(row.case_key),
    prompt: String(row.prompt),
    expected: parseJson(String(row.expected_json), null),
    fixture: parseJson<Record<string, unknown>>(String(row.fixture_json), {}),
    fixtureHash: String(row.fixture_hash),
    ordinal: Number(row.ordinal),
  };
}

function rowToRun(row: Record<string, unknown>): BenchmarkRun {
  return {
    id: String(row.id),
    benchmarkId: String(row.benchmark_id),
    baseline: parseJson<CandidateConfig>(String(row.baseline_config_json), { reference: 'baseline', config: {} }),
    candidate: parseJson<CandidateConfig>(String(row.candidate_config_json), { reference: 'candidate', config: {} }),
    environmentHash: String(row.environment_hash),
    seed: String(row.seed),
    state: row.state as BenchmarkRun['state'],
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function rowToCaseRun(row: Record<string, unknown>): BenchmarkCaseRun {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    caseId: String(row.case_id),
    variant: row.variant as BenchmarkCaseRun['variant'],
    attempt: Number(row.attempt),
    status: row.status as BenchmarkCaseRun['status'],
    output: parseJson(String(row.output_json), null),
    evidence: parseJson<Record<string, unknown>>(String(row.evidence_json), {}),
    durationMs: Number(row.duration_ms),
    requestCount: Number(row.request_count),
    ...(row.input_tokens === null || row.input_tokens === undefined ? {} : { inputTokens: Number(row.input_tokens) }),
    ...(row.output_tokens === null || row.output_tokens === undefined ? {} : { outputTokens: Number(row.output_tokens) }),
    ...(row.estimated_cost_microusd === null || row.estimated_cost_microusd === undefined ? {} : { estimatedCostMicrousd: Number(row.estimated_cost_microusd) }),
    createdAt: String(row.created_at),
  };
}

function rowToDimension(row: Record<string, unknown>): BenchmarkDimensionResult {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    ...(row.case_run_id ? { caseRunId: String(row.case_run_id) } : {}),
    variant: row.variant as BenchmarkDimensionResult['variant'],
    dimension: String(row.dimension),
    ...(row.numeric_value === null || row.numeric_value === undefined ? {} : { numericValue: Number(row.numeric_value) }),
    ...(row.boolean_value === null || row.boolean_value === undefined ? {} : { booleanValue: Number(row.boolean_value) === 1 }),
    ...(row.text_value === null || row.text_value === undefined ? {} : { textValue: String(row.text_value) }),
    evidence: parseJson<Record<string, unknown>>(String(row.evidence_json), {}),
    scorerVersion: String(row.scorer_version),
    createdAt: String(row.created_at),
  };
}

export class BenchmarkInvocationService {
  readonly #executor: BenchmarkExecutor;
  readonly #scorer: BenchmarkScorer;
  readonly #judge: { enabled: boolean; adapter?: string };

  constructor(private readonly context: LabContext, options: LabServiceOptions = {}) {
    this.#executor = options.executor ?? new DeterministicFakeAgentExecutor();
    this.#scorer = options.scorer ?? new DeterministicScorer();
    this.#judge = options.judge ?? { enabled: false };
  }

  createBenchmark(rawInput: z.input<typeof BenchmarkDefinitionInputSchema>, actorId?: string): BenchmarkDefinition {
    const input = BenchmarkDefinitionInputSchema.parse(rawInput);
    assertBenchmarkContentSafe([
      input.fixture,
      ...input.cases.flatMap((benchmarkCase) => [benchmarkCase.prompt, benchmarkCase.expected, benchmarkCase.fixture]),
    ]);
    const database = this.context.database;
    const now = this.context.clock.now().toISOString();
    const id = this.context.ids.id();
    const version = input.version ?? Number((database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM benchmarks WHERE project_id IS ? AND stable_key = ?').get(input.projectId ?? null, input.stableKey) as { version: number }).version) + 1;
    const fixture = input.fixture;
    const fixtureHash = hashFixture({ fixture, cases: input.cases });
    const insert = database.transaction(() => {
      database.prepare(`INSERT INTO benchmarks(id, project_id, stable_key, version, kind, name, fixture_hash, scorer_version, dimensions_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId ?? null, input.stableKey, version, input.kind, input.name, fixtureHash, input.scorerVersion, JSON.stringify(input.dimensions), now);
      const insertCase = database.prepare(`INSERT INTO benchmark_cases(id, benchmark_id, case_key, prompt, expected_json, fixture_json, fixture_hash, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      input.cases.forEach((benchmarkCase, index) => {
        const fixtureCase = benchmarkCase.fixture;
        const caseId = this.context.ids.id();
        insertCase.run(caseId, id, benchmarkCase.caseKey, benchmarkCase.prompt, JSON.stringify(benchmarkCase.expected), JSON.stringify(fixtureCase), hashFixture({ expected: benchmarkCase.expected, fixture: fixtureCase }), benchmarkCase.ordinal ?? index);
      });
      recordLabAudit(this.context, input.projectId, actorId, 'lab.benchmark.create', 'benchmark', id, { kind: input.kind, version, caseCount: input.cases.length });
    });
    insert();
    return this.getBenchmark(id) as BenchmarkDefinition;
  }

  getBenchmark(id: string): BenchmarkDefinition | undefined {
    const row = this.context.database.prepare('SELECT * FROM benchmarks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToDefinition(row) : undefined;
  }

  listBenchmarks(projectId?: string): BenchmarkDefinition[] {
    // Projectless benchmarks are installation-global catalog artifacts. The
    // HTTP creation route restricts them to administrators; they are not
    // treated as team-private records during listing.
    const rows = (projectId === undefined
      ? this.context.database.prepare('SELECT * FROM benchmarks ORDER BY created_at DESC').all()
      : this.context.database.prepare('SELECT * FROM benchmarks WHERE project_id = ? ORDER BY created_at DESC').all(projectId)) as Record<string, unknown>[];
    return rows.map(rowToDefinition);
  }

  addCase(benchmarkId: string, rawCase: z.input<typeof BenchmarkCaseInputSchema>, actorId?: string): BenchmarkCase {
    const input = BenchmarkCaseInputSchema.parse(rawCase);
    assertBenchmarkContentSafe([input.prompt, input.expected, input.fixture]);
    const benchmark = this.context.database.prepare('SELECT project_id AS projectId FROM benchmarks WHERE id = ?').get(benchmarkId) as { projectId?: string | null } | undefined;
    if (!benchmark) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
    const existing = this.context.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM benchmark_cases WHERE benchmark_id = ?').get(benchmarkId) as { ordinal: number };
    const fixture = input.fixture;
    const id = this.context.ids.id();
    this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO benchmark_cases(id, benchmark_id, case_key, prompt, expected_json, fixture_json, fixture_hash, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, benchmarkId, input.caseKey, input.prompt, JSON.stringify(input.expected), JSON.stringify(fixture), hashFixture({ expected: input.expected, fixture }), input.ordinal ?? existing.ordinal + 1);
      recordLabAudit(this.context, benchmark.projectId, actorId, 'lab.benchmark.case.add', 'benchmark_case', id, { benchmarkId, ordinal: input.ordinal ?? existing.ordinal + 1 });
    })();
    return rowToCase(this.context.database.prepare('SELECT * FROM benchmark_cases WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listCases(benchmarkId: string): BenchmarkCase[] {
    return (this.context.database.prepare('SELECT * FROM benchmark_cases WHERE benchmark_id = ? ORDER BY ordinal, id').all(benchmarkId) as Record<string, unknown>[]).map(rowToCase);
  }

  runBenchmark(rawInput: z.input<typeof RunBenchmarkInputSchema>): BenchmarkComparison {
    const input = RunBenchmarkInputSchema.parse(rawInput);
    if (input.judge.enabled || this.#judge.enabled) {
      if (!input.judge.adapter && !this.#judge.adapter) throw new Error('Model judge is disabled unless an adapter is explicitly configured');
    }
    const definition = this.getBenchmark(input.benchmarkId);
    if (!definition) throw new Error(`Unknown benchmark ${input.benchmarkId}`);
    const cases = this.listCases(input.benchmarkId);
    const runId = this.context.ids.id();
    const createdAt = this.context.clock.now().toISOString();
    const baseline = CandidateConfigSchema.parse({ ...input.baseline, config: redactedRecord(input.baseline.config) });
    const candidate = CandidateConfigSchema.parse({ ...input.candidate, config: redactedRecord(input.candidate.config) });
    this.context.database.prepare(`INSERT INTO benchmark_runs(id, benchmark_id, baseline_config_json, candidate_config_json, environment_hash, seed, state, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(runId, input.benchmarkId, JSON.stringify(baseline), JSON.stringify(candidate), input.environmentHash, input.seed, input.createdBy, createdAt);
    const startedAt = this.context.clock.now().toISOString();
    this.context.database.prepare("UPDATE benchmark_runs SET state = 'running', started_at = ? WHERE id = ?").run(startedAt, runId);
    try {
      const dimensionRows: Array<{ variant: 'baseline' | 'candidate'; caseRunId: string; dimension: string; score: ReturnType<BenchmarkScorer['score']>[number] }> = [];
      const insertCaseRun = this.context.database.prepare(`INSERT INTO benchmark_case_runs(id, run_id, case_id, variant, attempt, status, output_json, evidence_json, duration_ms, request_count, input_tokens, output_tokens, estimated_cost_microusd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const transaction = this.context.database.transaction(() => {
        for (const benchmarkCase of cases) {
          for (const [variant, config] of [['baseline', baseline], ['candidate', candidate]] as const) {
            for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
              const execution = this.#executor.execute({ benchmarkCase, variant, config, seed: input.seed });
              const caseRunId = this.context.ids.id();
              const evidence = redactedRecord(execution.evidence);
              insertCaseRun.run(caseRunId, runId, benchmarkCase.id, variant, attempt, execution.status, JSON.stringify(redact(execution.output)), JSON.stringify(evidence), execution.durationMs, execution.requestCount, execution.inputTokens ?? null, execution.outputTokens ?? null, execution.estimatedCostMicrousd ?? null, this.context.clock.now().toISOString());
              const scores = this.#scorer.score({ benchmarkCase, execution, dimensions: definition.dimensions });
              for (const score of scores) dimensionRows.push({ variant, caseRunId, dimension: score.dimension, score });
            }
          }
        }
        const insertDimension = this.context.database.prepare(`INSERT INTO benchmark_dimension_results(id, run_id, case_run_id, variant, dimension, numeric_value, boolean_value, text_value, evidence_json, scorer_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of dimensionRows) {
          insertDimension.run(this.context.ids.id(), runId, row.caseRunId, row.variant, row.dimension, row.score.numericValue ?? null, row.score.booleanValue === undefined ? null : row.score.booleanValue ? 1 : 0, row.score.textValue ?? null, JSON.stringify(redact(row.score.evidence)), definition.scorerVersion, this.context.clock.now().toISOString());
        }
        const dimensions = new Set(dimensionRows.map((row) => row.dimension));
        for (const dimension of dimensions) {
          const baselineScores = dimensionRows.filter((row) => row.variant === 'baseline' && row.dimension === dimension).map((row) => row.score);
          const candidateScores = dimensionRows.filter((row) => row.variant === 'candidate' && row.dimension === dimension).map((row) => row.score);
          const baselineNumbers = baselineScores.flatMap((score) => score.numericValue === undefined ? [] : [score.numericValue]);
          const candidateNumbers = candidateScores.flatMap((score) => score.numericValue === undefined ? [] : [score.numericValue]);
          const baselineBools = baselineScores.flatMap((score) => score.booleanValue === undefined ? [] : [score.booleanValue]);
          const candidateBools = candidateScores.flatMap((score) => score.booleanValue === undefined ? [] : [score.booleanValue]);
          const baselineValue = baselineNumbers.length ? baselineNumbers.reduce((sum, value) => sum + value, 0) / baselineNumbers.length : undefined;
          const candidateValue = candidateNumbers.length ? candidateNumbers.reduce((sum, value) => sum + value, 0) / candidateNumbers.length : undefined;
          const winner = baselineValue !== undefined && candidateValue !== undefined
            ? candidateValue === baselineValue ? 'tie' : candidateValue > baselineValue ? 'candidate' : 'baseline'
            : baselineBools[0] === candidateBools[0] ? 'tie' : candidateBools[0] ? 'candidate' : 'baseline';
          insertDimension.run(this.context.ids.id(), runId, null, 'comparison', dimension, baselineValue === undefined || candidateValue === undefined ? null : candidateValue - baselineValue, null, winner, JSON.stringify({ baseline: baselineValue ?? baselineBools, candidate: candidateValue ?? candidateBools, winner }), definition.scorerVersion, this.context.clock.now().toISOString());
        }
      });
      transaction();
      const comparison = this.compareRun(runId);
      // Keep the project-visible terminal state and its audit event in one
      // database transaction. ponytail: queued/running events stay deferred;
      // add lifecycle events if consumers need interim progress.
      const dimensionCount = comparison.dimensions.length;
      const complete = () => {
        this.context.database.prepare("UPDATE benchmark_runs SET state = 'completed', completed_at = ? WHERE id = ?").run(this.context.clock.now().toISOString(), runId);
        if (definition.projectId && this.context.events) {
          this.context.events.append({ projectId: definition.projectId, eventKind: 'benchmark.completed', aggregateType: 'benchmark_run', aggregateId: runId, actor: { type: 'user', userId: input.createdBy }, source: { kind: 'platform', adapter: 'lab' }, payload: { benchmarkId: definition.id, state: 'completed', dimensions: dimensionCount } });
        }
      };
      if (definition.projectId && this.context.events) this.context.events.transaction(complete);
      else this.context.database.transaction(complete)();
      const completed = this.getRun(runId);
      if (!completed || completed.state !== 'completed') throw new Error(`Benchmark run ${runId} did not complete`);
      return this.compareRun(runId);
    } catch (error) {
      this.context.database.prepare("UPDATE benchmark_runs SET state = 'failed', completed_at = ? WHERE id = ?").run(this.context.clock.now().toISOString(), runId);
      throw error;
    }
  }

  /** MCP-friendly name for a complete deterministic invocation. */
  invokeBenchmark(rawInput: z.input<typeof RunBenchmarkInputSchema>): BenchmarkComparison {
    return this.runBenchmark(rawInput);
  }

  getRun(runId: string): BenchmarkRun | undefined {
    const row = this.context.database.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(benchmarkId?: string): BenchmarkRun[] {
    // Runs inherit their benchmark scope: runs for projectless benchmarks are
    // installation-global evidence, not team-private state.
    const rows = (benchmarkId === undefined
      ? this.context.database.prepare('SELECT * FROM benchmark_runs ORDER BY created_at DESC').all()
      : this.context.database.prepare('SELECT * FROM benchmark_runs WHERE benchmark_id = ? ORDER BY created_at DESC').all(benchmarkId)) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  compareRun(runId: string): BenchmarkComparison {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown benchmark run ${runId}`);
    const definition = this.getBenchmark(run.benchmarkId);
    if (!definition) throw new Error(`Unknown benchmark ${run.benchmarkId}`);
    const cases = this.listCases(run.benchmarkId);
    const caseRuns = (this.context.database.prepare('SELECT * FROM benchmark_case_runs WHERE run_id = ? ORDER BY case_id, variant, attempt').all(runId) as Record<string, unknown>[]).map(rowToCaseRun);
    const dimensions = (this.context.database.prepare('SELECT * FROM benchmark_dimension_results WHERE run_id = ? ORDER BY variant, dimension').all(runId) as Record<string, unknown>[]).map(rowToDimension);
    const numeric = (variant: 'baseline' | 'candidate', names: string[]): number => {
      const values = dimensions.filter((row) => row.variant === variant && names.includes(row.dimension) && row.numericValue !== undefined).map((row) => row.numericValue as number);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    };
    const bools = (variant: 'baseline' | 'candidate', names: string[]): number => dimensions.filter((row) => row.variant === variant && names.includes(row.dimension)).reduce((sum, row) => sum + (row.booleanValue ? 1 : row.numericValue ?? 0), 0);
    const qualityBaseline = bools('baseline', ['acceptance', 'correctness', 'failure_recovery', 'documentation_quality', 'memory_quality']) - numeric('baseline', ['regression_count', 'duplicate_work', 'overlapping_claims', 'merge_conflicts', 'incorrect_delegation', 'human_intervention']);
    const qualityCandidate = bools('candidate', ['acceptance', 'correctness', 'failure_recovery', 'documentation_quality', 'memory_quality']) - numeric('candidate', ['regression_count', 'duplicate_work', 'overlapping_claims', 'merge_conflicts', 'incorrect_delegation', 'human_intervention']);
    const speedBaseline = numeric('baseline', ['duration_ms']);
    const speedCandidate = numeric('candidate', ['duration_ms']);
    const costBaseline = numeric('baseline', ['estimated_cost_microusd']);
    const costCandidate = numeric('candidate', ['estimated_cost_microusd']);
    const order = (baseline: number, candidate: number, lowerIsBetter = false): ('baseline' | 'candidate')[] => {
      if (baseline === candidate) return ['baseline', 'candidate'];
      const candidateFirst = lowerIsBetter ? candidate < baseline : candidate > baseline;
      return candidateFirst ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    };
    const quality = order(qualityBaseline, qualityCandidate);
    const speed = order(speedBaseline, speedCandidate, true);
    const cost = order(costBaseline, costCandidate, true);
    const orderings = [quality, speed, cost];
    const wins: Record<'baseline' | 'candidate', number> = { baseline: 0, candidate: 0 };
    for (const ordering of orderings) {
      const winner = ordering[0];
      if (winner) wins[winner] += 1;
    }
    const balanced: ('baseline' | 'candidate')[] = wins.candidate === wins.baseline
      ? quality
      : wins.candidate > wins.baseline ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    return { run, definitions: definition, cases, caseRuns, dimensions, ordering: { quality, speed, cost, balanced } };
  }

  private resolvePromotionSubject(subjectType: PromotionDecisionInput['subjectType'], subjectVersionId: string): PromotionSubject {
    const queries: Record<PromotionDecisionInput['subjectType'], string> = {
      skill: `SELECT s.project_id AS projectId, p.team_id AS teamId
        FROM skill_versions sv JOIN skills s ON s.id = sv.skill_id
        LEFT JOIN projects p ON p.id = s.project_id WHERE sv.id = ?`,
      memory: `SELECT mp.project_id AS projectId, p.team_id AS teamId
        FROM memory_generations mg JOIN memory_packs mp ON mp.id = mg.pack_id
        JOIN projects p ON p.id = mp.project_id WHERE mg.id = ?`,
      model: `SELECT NULL AS projectId, p.team_id AS teamId
        FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`,
      orchestration: `SELECT op.project_id AS projectId, p.team_id AS teamId
        FROM orchestration_profile_versions opv JOIN orchestration_profiles op ON op.id = opv.profile_id
        JOIN projects p ON p.id = op.project_id WHERE opv.id = ?`,
    };
    const row = this.context.database.prepare(queries[subjectType]).get(subjectVersionId) as { projectId?: string | null; teamId?: string | null } | undefined;
    if (!row) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion subject not found');
    return {
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.teamId ? { teamId: row.teamId } : {}),
    };
  }

  private projectTeam(projectId: string): string {
    const row = this.context.database.prepare('SELECT team_id AS teamId FROM projects WHERE id = ?').get(projectId) as { teamId: string } | undefined;
    if (!row) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion project not found');
    return row.teamId;
  }

  private assertPromotionActor(userId: string, teamId?: string): void {
    const row = teamId
      ? this.context.database.prepare('SELECT 1 AS ok FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE u.id = ? AND u.disabled_at IS NULL AND tm.team_id = ?').get(userId, teamId)
      : this.context.database.prepare('SELECT 1 AS ok FROM users WHERE id = ? AND disabled_at IS NULL').get(userId);
    if (!row) throw new HttpError(403, 'promotion_actor_not_allowed', 'Promotion actor is not allowed');
  }

  recordPromotionDecision(rawInput: z.input<typeof PromotionDecisionInputSchema>): { id: string; decision: PromotionDecisionInput['decision']; decidedAt: string } {
    const input = PromotionDecisionInputSchema.parse(rawInput);
    const subject = this.resolvePromotionSubject(input.subjectType, input.subjectVersionId);
    let projectId = input.projectId ?? subject.projectId;
    const projectTeamId = projectId ? this.projectTeam(projectId) : undefined;
    if (subject.projectId && projectId !== subject.projectId) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion subject is outside the requested project');
    if (subject.teamId && projectTeamId && subject.teamId !== projectTeamId) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion subject is outside the requested team');
    const benchmark = input.benchmarkRunId ? this.getRun(input.benchmarkRunId) : undefined;
    if (input.benchmarkRunId && !benchmark) throw new HttpError(404, 'promotion_subject_not_found', 'Benchmark run not found');
    const benchmarkProjectId = benchmark ? this.getBenchmark(benchmark.benchmarkId)?.projectId : undefined;
    if (benchmark && benchmarkProjectId && projectId !== benchmarkProjectId) throw new HttpError(404, 'promotion_subject_not_found', 'Benchmark run is outside the requested project');
    if (benchmark && !benchmarkProjectId && projectId) throw new HttpError(404, 'promotion_subject_not_found', 'Benchmark run is not project-scoped');
    if (!projectId && benchmarkProjectId) projectId = benchmarkProjectId;
    const benchmarkTeamId = projectId ? this.projectTeam(projectId) : undefined;
    if (subject.teamId && benchmarkTeamId && subject.teamId !== benchmarkTeamId) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion subject is outside the benchmark team');
    this.assertPromotionActor(input.decidedBy, subject.teamId ?? benchmarkTeamId);
    const id = this.context.ids.id();
    const decidedAt = this.context.clock.now().toISOString();
    const persistedReason = redactText(input.reason, 10_000);
    const eventReason = redactText(persistedReason, 2_000);
    const insert = () => {
      this.context.database.prepare(`INSERT INTO promotion_decisions(id, project_id, subject_type, subject_version_id, benchmark_run_id, decision, reason, decided_by, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId ?? null, input.subjectType, input.subjectVersionId, input.benchmarkRunId ?? null, input.decision, persistedReason, input.decidedBy, decidedAt);
      recordLabAudit(this.context, projectId, input.decidedBy, 'lab.promotion.decide', input.subjectType, input.subjectVersionId, { decision: input.decision, benchmarkRunId: input.benchmarkRunId ?? null });
      if (projectId && this.context.events) {
        this.context.events.append({ projectId, eventKind: 'candidate.decided', aggregateType: input.subjectType, aggregateId: input.subjectVersionId, actor: { type: 'user', userId: input.decidedBy }, source: { kind: 'platform', adapter: 'lab' }, payload: { decision: input.decision, reason: eventReason, benchmarkRunId: input.benchmarkRunId ?? null } });
      }
    };
    if (projectId && this.context.events) this.context.events.transaction(insert);
    else this.context.database.transaction(insert)();
    return { id, decision: input.decision, decidedAt };
  }

  listPromotionDecisions(subjectVersionId?: string, teamId?: string): Array<PromotionDecisionInput & { id: string; decidedAt: string }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (subjectVersionId !== undefined) {
      where.push('pd.subject_version_id = ?');
      values.push(subjectVersionId);
    }
    // Project-scoped decisions follow the project team; projectless model
    // decisions follow their provider team. Projectless skill decisions remain
    // visible as installation-global artifacts.
    if (teamId !== undefined) {
      where.push("(pd.project_id IS NULL AND pd.subject_type = 'skill' OR COALESCE(pr.team_id, p.team_id) = ?)");
      values.push(teamId);
    }
    const rows = this.context.database.prepare(`SELECT pd.* FROM promotion_decisions pd
      LEFT JOIN models m ON pd.subject_type = 'model' AND m.id = pd.subject_version_id
      LEFT JOIN providers p ON p.id = m.provider_id
      LEFT JOIN projects pr ON pr.id = pd.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY pd.decided_at DESC`).all(...values) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      subjectType: row.subject_type as PromotionDecisionInput['subjectType'],
      subjectVersionId: String(row.subject_version_id),
      ...(row.benchmark_run_id ? { benchmarkRunId: String(row.benchmark_run_id) } : {}),
      decision: row.decision as PromotionDecisionInput['decision'],
      reason: redactText(String(row.reason), 2_000),
      decidedBy: String(row.decided_by),
      decidedAt: String(row.decided_at),
    }));
  }

  registerProvider(rawInput: ProviderInput, actorId?: string): ProviderRecord {
    const input = { ...rawInput, baseUrl: validateProviderBaseUrl(rawInput.baseUrl), config: redactedRecord(rawInput.config) };
    const id = this.context.ids.id();
    const now = this.context.clock.now().toISOString();
    const row = this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO providers(id, team_id, kind, name, base_url, enabled, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(team_id, name) DO UPDATE SET kind = excluded.kind, base_url = excluded.base_url, config_json = excluded.config_json, updated_at = excluded.updated_at`).run(id, input.teamId, input.kind, input.name, input.baseUrl ?? null, JSON.stringify(input.config ?? {}), now, now);
      const persisted = this.context.database.prepare('SELECT * FROM providers WHERE team_id = ? AND name = ?').get(input.teamId, input.name) as Record<string, unknown>;
      recordLabAudit(this.context, null, actorId, 'lab.provider.register', 'provider', String(persisted.id), { teamId: input.teamId });
      return persisted;
    })();
    return { id: String(row.id), teamId: String(row.team_id), kind: String(row.kind), name: String(row.name), ...(row.base_url ? { baseUrl: String(row.base_url) } : {}), config: parseJson<Record<string, unknown>>(String(row.config_json), {}), enabled: Number(row.enabled) === 1 };
  }

  registerModel(rawInput: ModelCatalogRecordInput, actorId?: string): ModelRecord {
    const input = ModelCatalogRecordInputSchema.parse(rawInput);
    const id = this.context.ids.id();
    const now = this.context.clock.now().toISOString();
    return this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO models(id, provider_id, model_key, display_name, declared_capabilities_json, measured_capabilities_json, catalog_observed_at, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
        ON CONFLICT(provider_id, model_key) DO UPDATE SET display_name = excluded.display_name, declared_capabilities_json = excluded.declared_capabilities_json, catalog_observed_at = excluded.catalog_observed_at, updated_at = excluded.updated_at`).run(id, input.providerId, input.modelKey, input.displayName, JSON.stringify(input.declaredCapabilities), now, input.enabled ? 1 : 0, now, now);
      const model = this.getModelByKey(input.providerId, input.modelKey) as ModelRecord;
      recordLabAudit(this.context, null, actorId, 'lab.model.register', 'model', model.id, { providerId: input.providerId, enabled: input.enabled });
      return model;
    })();
  }

  ingestCatalog(providerId: string, catalog: unknown, actorId?: string): ModelRecord[] {
    const records = parseOpenRouterCatalog(catalog);
    return records.map((record) => this.registerModel({ providerId, ...record }, actorId));
  }

  getModel(modelId: string): ModelRecord | undefined {
    const row = this.context.database.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as Record<string, unknown> | undefined;
    return row ? this.rowToModel(row) : undefined;
  }

  private getModelByKey(providerId: string, modelKey: string): ModelRecord | undefined {
    const row = this.context.database.prepare('SELECT * FROM models WHERE provider_id = ? AND model_key = ?').get(providerId, modelKey) as Record<string, unknown> | undefined;
    return row ? this.rowToModel(row) : undefined;
  }

  private rowToModel(row: Record<string, unknown>): ModelRecord {
    return {
      id: String(row.id), providerId: String(row.provider_id), modelKey: String(row.model_key), displayName: String(row.display_name),
      declaredCapabilities: parseJson<Record<string, boolean>>(String(row.declared_capabilities_json), {}),
      measuredCapabilities: parseJson<Record<string, 'supported' | 'unsupported' | 'unknown'>>(String(row.measured_capabilities_json), {}),
      enabled: Number(row.enabled) === 1,
      ...(row.catalog_observed_at ? { catalogObservedAt: String(row.catalog_observed_at) } : {}),
    };
  }

  recordCapabilityProbe(rawInput: CapabilityProbeInput, actorId?: string): ModelRecord {
    const input = CapabilityProbeInputSchema.parse(rawInput);
    const model = this.getModel(input.modelId);
    if (!model) throw new Error(`Unknown model ${input.modelId}`);
    const observedAt = this.context.clock.now().toISOString();
    const evidence = boundedProbeRecord(input.evidence);
    return this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO model_capability_probes(id, model_id, capability, outcome, latency_ms, error_summary, evidence_json, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.context.ids.id(), input.modelId, input.capability, input.outcome, input.latencyMs ?? null, input.errorSummary === undefined ? null : redactProbeText(input.errorSummary, 500), JSON.stringify(evidence), observedAt);
      const measured = { ...model.measuredCapabilities, [input.capability]: input.outcome };
      this.context.database.prepare('UPDATE models SET measured_capabilities_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(measured), observedAt, input.modelId);
      const result = this.getModel(input.modelId) as ModelRecord;
      recordLabAudit(this.context, null, actorId, 'lab.model.probe', 'model', input.modelId, { outcome: input.outcome, latencyMs: input.latencyMs ?? null });
      return result;
    })();
  }

  routingRecommendations(rawInput: RoutingRecommendationInput = { requiredCapabilities: [], includeDisabled: true }): ModelRoutingRecommendation[] {
    const input = RoutingRecommendationInputSchema.parse(rawInput);
    const rows = (this.context.database.prepare(input.includeDisabled ? 'SELECT * FROM models ORDER BY provider_id, model_key' : 'SELECT * FROM models WHERE enabled = 1 ORDER BY provider_id, model_key').all()) as Record<string, unknown>[];
    return rows.map((row) => {
      const model = this.rowToModel(row);
      const status: Record<string, 'supported' | 'unsupported' | 'unknown'> = {};
      const rationale: string[] = [];
      for (const capability of input.requiredCapabilities) {
        const outcome = model.measuredCapabilities[capability] ?? (model.declaredCapabilities[capability] === false ? 'unsupported' : 'unknown');
        status[capability] = outcome;
        rationale.push(`${capability}: ${outcome}`);
      }
      if (!input.requiredCapabilities.length) rationale.push('No capability requirement; recommendation is informational only');
      if (!model.enabled) rationale.push('Model is disabled; recommendation does not enable it');
      return { modelId: model.id, providerId: model.providerId, modelKey: model.modelKey, displayName: model.displayName, enabled: model.enabled, capabilityStatus: status, rationale };
    }).sort((a, b) => {
      const rank = (item: ModelRoutingRecommendation): number => input.requiredCapabilities.reduce((score, capability) => score + (item.capabilityStatus[capability] === 'supported' ? 2 : item.capabilityStatus[capability] === 'unknown' ? 1 : 0), 0);
      return rank(b) - rank(a) || a.modelKey.localeCompare(b.modelKey);
    });
  }

  probeHistory(modelId: string): Array<Record<string, unknown>> {
    return (this.context.database.prepare('SELECT id, model_id AS modelId, capability, outcome, latency_ms AS latencyMs, error_summary AS errorSummary, evidence_json, observed_at AS observedAt FROM model_capability_probes WHERE model_id = ? ORDER BY observed_at DESC').all(modelId) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      modelId: row.modelId,
      capability: row.capability,
      outcome: row.outcome,
      latencyMs: row.latencyMs,
      errorSummary: row.errorSummary === null || row.errorSummary === undefined ? null : redactProbeText(String(row.errorSummary), 500),
      evidence: boundedProbeRecord(parseJson(row.evidence_json as string | null | undefined, {})),
      observedAt: row.observedAt,
    }));
  }
}

export function createBenchmarkInvocationService(context: LabContext, options?: LabServiceOptions): BenchmarkInvocationService {
  return new BenchmarkInvocationService(context, options);
}

export const createLabService = createBenchmarkInvocationService;

export function parseOpenRouterCatalog(payload: unknown): Array<Omit<ModelCatalogRecordInput, 'providerId'>> {
  const record = asRecord(payload);
  const entries = Array.isArray(payload) ? payload : Array.isArray(record.data) ? record.data : [];
  return entries.flatMap((entry) => {
    const item = asRecord(entry);
    if (typeof item.id !== 'string' || item.id.length === 0) return [];
    const capabilities = asRecord(item.capabilities);
    const declaredCapabilities: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(capabilities)) if (typeof value === 'boolean') declaredCapabilities[key] = value;
    return [{ modelKey: item.id, displayName: typeof item.name === 'string' ? item.name : item.id, declaredCapabilities, enabled: false }];
  });
}
