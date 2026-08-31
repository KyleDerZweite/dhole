# Improvement Lab

Improvement Lab is a bounded, server-side comparison harness for skills,
orchestration profiles, models, and memory. It stores reproducible evidence;
it is not a workflow engine, a live-provider proxy, or an automatic deployment
system. Benchmark configuration is data (never executable code), and all
unknown fixture/evidence fields are redacted before persistence.

## Deterministic fixtures first

The MVP ships two local fixtures so a run can be repeated without provider
credentials, network access, model quota, or a node process:

| Fixture route | Comparison | Dimensions in the fixture |
| --- | --- | --- |
| `GET /api/lab/fixtures/skill` | `skill-deterministic-answer`: baseline returns `{ "answer": 41 }`; candidate returns `{ "answer": 42 }`. Baseline/candidate duration is 24/18 ms, request count 1/1, estimated cost 12/10 microusd. | `acceptance`, `correctness`, `regression_count`, `duration_ms`, `request_count`, `estimated_cost_microusd` |
| `GET /api/lab/fixtures/orchestration` | `orchestration-deterministic-workers`: single agent (120 ms, one request) versus director plus two workers (72 ms, three requests). Both are accepted with zero duplicate work, overlap, and incorrect delegation. | `acceptance`, `duplicate_work`, `overlapping_claims`, `incorrect_delegation`, `duration_ms`, `request_count` |

`DeterministicFakeAgentExecutor` reads only the case fixture and candidate
configuration. It never starts a process or calls a network endpoint. The
`seed` is retained in run evidence so repeated runs with the same fixture,
candidate data, and seed are comparable. Fixture and case hashes bind the
definition to the exact inputs that were evaluated.

Create a benchmark from a fixture (optionally adding project scope), then run
baseline and candidate variants. Each case/variant/attempt is retained as a
`benchmark_case_run`; each requested dimension is retained independently as a
`benchmark_dimension_result`. Attempts are bounded to 1–10. Baseline and
candidate references are immutable human-readable identifiers such as
`skill:v1`, `model:provider/key`, or `orchestration:profile-v2`.

## Dimensions and views

The schema deliberately keeps dimensions separate:

`acceptance`, `correctness`, `regression_count`, `duplicate_work`,
`overlapping_claims`, `merge_conflicts`, `incorrect_delegation`,
`human_intervention`, `failure_recovery`, `duration_ms`, `request_count`,
`input_tokens`, `output_tokens`, `estimated_cost_microusd`,
`documentation_quality`, and `memory_quality`.

The comparison endpoint exposes four explicit orderings, not a universal score:

- **Quality** adds boolean/numeric values for `acceptance`, `correctness`,
  `failure_recovery`, `documentation_quality`, and `memory_quality`, then
  subtracts `regression_count`, `duplicate_work`, `overlapping_claims`,
  `merge_conflicts`, `incorrect_delegation`, and `human_intervention`.
- **Speed** compares average `duration_ms`; lower wins.
- **Cost** compares average `estimated_cost_microusd`; lower wins.
- **Balanced** counts the winner of quality, speed, and cost. A tie falls back
  to the quality ordering. A tie within a dimension is represented as
  `["baseline", "candidate"]`.

Numeric case scores are averaged per variant. The comparison row stores the
candidate-minus-baseline delta; boolean dimensions store a winner in evidence.
Missing token/cost values are treated as zero by the deterministic scorer.
These views are lenses for a human decision, not permission to mutate a skill,
model, memory pack, or orchestration profile.

## Human decisions and the no-promotion guarantee

`POST /api/lab/promotions` appends a `promote`, `reject`, or `canary` decision
with the deciding user, reason, optional benchmark run, and timestamp. Rows in
`promotion_decisions` are append-only; recording a second decision does not
rewrite the first. A project-scoped decision emits `candidate.decided` in the
same event/outbox model used elsewhere.

Lab does **not** activate a skill, alter an active memory generation, enable a
model, or activate an orchestration profile. A benchmark can pass every
dimension and still require a human decision. Promotion subjects are references
(`subjectType` + `subjectVersionId`), so the Lab cannot manufacture a version as
a side effect of evaluation.

An optional external judge is disabled by default. Setting `judge.enabled` in
the run request or service configuration requires an explicit adapter name;
there is no implicit hosted judge and no fallback to a live model. The local
deterministic executor/scorer remains the reproducible baseline. A future judge
adapter must preserve the same bounded, redacted-evidence boundary; enabling a
flag alone never invokes a provider.

## Model intake, probes, and recommendations

Provider and model records are catalog data, separate from runtime adapters.
Provider configuration is redacted before it is stored; keys matching secret,
token, password, credential, API-key, or private-key patterns become
`[REDACTED]`. A provider registration does not make a network request.

Models carry declared capabilities and measured outcomes. A capability probe
records `supported`, `unsupported`, or `unknown`, optional latency/error, and
redacted evidence in `model_capability_probes`; the latest outcome is copied to
the model's measured map. Recommendations are informational and never enable a
disabled model. For each requested capability, measured data wins; otherwise a
declared `false` is `unsupported` and every other unknown is `unknown`.
Ranking awards two points for supported and one for unknown, then sorts by model
key. `includeDisabled` defaults to true so an operator can see why a disabled
model was not selected. OpenRouter-shaped catalogs (`[{ id, name?,
capabilities? }]` or `{ data: [...] }`) are parsed into disabled model records;
unknown fields are ignored.

## Lab API

Mutating routes require an authenticated user and parse the listed Zod input at
the HTTP boundary. Read routes return stored, redacted evidence. Project
authorization should be applied by the caller before exposing project-scoped
benchmarks or decisions.

| Method and path | Body/query | Result |
| --- | --- | --- |
| `GET /api/lab/fixtures/skill` | — | Deterministic skill benchmark definition. |
| `GET /api/lab/fixtures/orchestration` | — | Deterministic orchestration benchmark definition. |
| `GET /api/lab/benchmarks` | Optional `projectId` | Benchmark definitions newest first. |
| `POST /api/lab/benchmarks` | Definition: `{ projectId?, stableKey, version?, kind, name, dimensions, fixture?, scorerVersion?, cases? }` | `201` definition; cases are inserted atomically. |
| `GET /api/lab/benchmarks/:benchmarkId` | — | `{ benchmark, cases }`. |
| `POST /api/lab/benchmarks/:benchmarkId/cases` | `{ caseKey, prompt, expected, fixture?, ordinal? }` | `201` case. |
| `POST /api/lab/benchmarks/:benchmarkId/runs` | `{ baseline, candidate, environmentHash?, seed?, attempts?, judge? }` | `201` completed comparison for the deterministic executor, or a bounded failure. |
| `GET /api/lab/runs` | Optional `benchmarkId` | Benchmark run summaries. |
| `GET /api/lab/runs/:runId` | — | Full comparison. |
| `GET /api/lab/runs/:runId/comparison` | — | Alias for the full comparison. |
| `POST /api/lab/promotions` | `{ projectId?, subjectType, subjectVersionId, benchmarkRunId?, decision, reason, decidedBy? }` | `201` append-only human decision (`decidedBy` is taken from the session user). |
| `GET /api/lab/promotions` | Optional `subjectVersionId` | Decision history. |
| `POST /api/lab/providers` | `{ teamId, kind, name, baseUrl?, config? }` | `201` redacted provider record. |
| `POST /api/lab/models` | `{ providerId, modelKey, displayName, declaredCapabilities?, enabled? }` | `201` catalog model; disabled by default. |
| `POST /api/lab/models/catalog` | `{ providerId, catalog }` | `201` models parsed from a local/catalog payload. |
| `POST /api/lab/providers/:providerId/catalog` | Raw catalog or `{ catalog }` | `201` models for that provider. |
| `POST /api/lab/models/probes` | `{ modelId, capability, outcome, latencyMs?, errorSummary?, evidence? }` | `201` model with updated measured capability. |
| `GET /api/lab/models/:modelId/probes` | — | Probe history newest first. |
| `GET /api/lab/models/recommendations` | `requiredCapabilities=a,b`, `includeDisabled=false` optional | Capability-ranked, recommendation-only model list. |

Run records move through `queued`, `running`, `completed`, `failed`, and
`cancelled`. A failure marks the run failed before the error is returned; a
successful project run emits `benchmark.completed`. No route accepts executable
prompts, shell commands, provider secrets, or a browser-to-node connection.

## Verification

The Lab tests prove deterministic skill and orchestration results, independent
dimensions, repeatability for a fixed seed, secret redaction, recommendation-
only model intake, and append-only human decisions:

```sh
pnpm --filter @dhole-control/server test:run -- src/modules/lab/lab.test.ts
pnpm format:check
```

Use `pnpm verify` for the complete format, lint, typecheck, test, and build
matrix before shipping a benchmark or a decision UI.
