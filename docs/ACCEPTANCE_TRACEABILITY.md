# Acceptance traceability

## Historical baseline

This matrix preserves the original MVP acceptance record before the
2026-09-05 module, authentication, agent-client, Gateway, and packaging work.
Its test counts and UI observations are historical evidence, not a new run.
The latest delivery scope is in [MVP status](MVP_STATUS.md). Criterion 44
concerns the local fixture workflow; ADR 0002 now permits production Podman
and optional Newt packaging.

This matrix maps each acceptance criterion in the implementation brief to the
route, service, test, or manual command at that historical revision. Some
referenced modules have since been retired under ADR 0003. `implemented`
means the local path is present and covered by code or a deterministic test;
`fixture` means the criterion is demonstrated with the fake node/runtime or
checked-in fixture; `external-unverified` means the real external dependency
was deliberately not contacted.

| # | Criterion | Evidence (exact route, service, test, or command) | Status |
| ---: | --- | --- | --- |
| 1 | Install and start locally without containers | `package.json` engines/scripts; `pnpm install --frozen-lockfile`; `pnpm dev` | implemented |
| 2 | Database initializes through migrations | `openDatabase`/`migrateDatabase`; `apps/server/src/lib/database.test.ts` (`migrates an empty database...`) | implemented |
| 3 | Administrator creates a second user | `POST /api/admin/users`; `apps/server/src/modules/core/core.test.ts` (`bootstraps an administrator...`) | implemented |
| 4 | Both users authenticate separately | `POST /api/auth/bootstrap`, `POST /api/auth/login`; Core authentication test | implemented |
| 5 | Project links a local repository | `POST /api/projects/:projectId/repositories`; Core repository boundary test | implemented |
| 6 | Fake node enrolls, connects, heartbeats, disconnects, reconnects | `POST /api/fleet/enrollment-tokens`, `POST /api/fleet/enrollment/consume`, `/ws/node`; `FleetService` + `FakeNode`; `fleet.test.ts` disconnect/reconnect coverage | fixture |
| 7 | Connected-machine capabilities appear in Capacity | `FleetService.heartbeat`, `GET /api/fleet/machines`, `GET /api/runtime/registrations`; `pnpm demo` Capacity view | fixture |
| 8 | Runtime session is created on fake node | `SessionsService.queueMessage` + maintenance reconciliation; `scripts/session-runtime-smoke.mjs` (`pnpm smoke:session`) | fixture |
| 9 | Two users view one live session | `GET /api/sessions/:sessionId/snapshot`; `/ws/app` subscription hub; demo participants `demo-user-admin` and `demo-user-member`; `pnpm demo` | fixture |
| 10 | Messages show human attribution | `POST /api/sessions/:sessionId/messages`; `SessionsService.queueMessage`; `sessions.test.ts` two-participant snapshot | implemented |
| 11 | Busy messages queue FIFO | `SessionsService.queueMessage` sequence allocation and runtime follow-up resume/send; `sessions.test.ts` (`keeps queued runtime follow-ups FIFO...`) | implemented |
| 12 | Steering is capability-gated and lease-protected | `POST /api/sessions/:sessionId/steering/lease`, `/steer`; `sessions.test.ts` (`enforces steering capability...`) | implemented |
| 13 | Authorized participant answers approvals | `POST /api/sessions/:sessionId/approvals/:approvalId/answer`; `SessionsService.answerApproval` (state transition and runtime `answer_approval` enqueue); `sessions.test.ts` (`answers an approval once...`, rollback on enqueue failure) and `routes.test.ts` malformed-expiry validation | implemented |
| 14 | Platform/provider children render as one tree | `SessionsService.getTree`, `GET /api/runs/:runId/agents`; `seedDemo` platform/provider/heuristic edges | fixture |
| 15 | Controlled/observed/heuristic lineage is distinct | `apps/web/src/lib/Tree.svelte` control labels/classes; `pnpm demo` | fixture |
| 16 | Parent waits for active descendants | `SessionsService.updateActivationState`; `sessions.test.ts` (`keeps parents waiting...`) | implemented |
| 17 | Resume creates a new activation and preserves history | `POST /api/agents/:logicalAgentId/resume`; `SessionsService.resumeActivation`; lineage test | implemented |
| 18 | Mediation-derived claim lifecycle works | `POST/PATCH /api/projects/:p/claims/:id`, `/complete`, `/release`; `CoordinationService`; `coordination.test.ts` settlement coverage | implemented |
| 19 | Overlapping claim produces actionable conflict | `POST /api/projects/:p/check` and `/claims`; `BlockingOverlapError`; `coordination.test.ts` enforced-overlap test | implemented |
| 20 | Mediation-style MCP compatibility is documented | `POST /mcp`; `MCP_LEGACY_COMPATIBILITY`; `apps/server/src/modules/mcp/README.md`; `app.test.ts` compatibility route and `mcp/index.test.ts` | implemented |
| 21 | Gateway ingests CLIProxy-compatible fixtures | `POST /api/gateway/connections/:id/ingest`; `parseCliProxyRecords`; `gateway/index.test.ts` JSONL ingestion/dedup test | fixture |
| 22 | Gateway exposes requests, usage, cost, failures, health, quota | `GET /api/gateway/requests`, `/summary`, `/accounts`; `GatewayService.summary`; gateway fixture tests and `pnpm demo` | fixture |
| 23 | Secrets and sensitive fields are redacted | `encryptSecret`, `redactText`, `redactGatewayMetadata`; `security.test.ts` and `gateway/index.test.ts` redaction assertions | implemented |
| 24 | Session/proxy correlation is stable where available | `GatewayService.ingest` event hash/correlation fields; gateway test (`records approximate project correlation`) | implemented |
| 25 | Explicit orchestration spawns at least two fake children | `POST /api/projects/:projectId/orchestration/runs`; `OrchestrationService`; `orchestration.test.ts` (`spawns two deterministic fake children...`) | fixture |
| 26 | Scheduler respects concurrency and coordination claims | `OrchestrationService.tick` claim-before-placement and limits; orchestration test profile `maxConcurrency: 1` | implemented |
| 27 | Orchestration aggregates child outcomes | `OrchestrationService.startExecution` result/work items; orchestration aggregation test | fixture |
| 28 | User can pause or cancel an orchestration run | `POST /api/projects/:projectId/orchestration/executions/:executionId/pause`, `/cancel`; `orchestration.test.ts` pause/resume | implemented |
| 29 | Skill baseline and candidate can be benchmarked | `GET /api/lab/fixtures/skill`, `POST /api/lab/benchmarks/:benchmarkId/runs`; `lab.test.ts` skill baseline/candidate | fixture |
| 30 | Benchmark dimensions and comparisons persist | `GET /api/lab/runs/:runId/comparison`; `BenchmarkInvocationService`; `lab.test.ts` dimension rows/repeatability | implemented |
| 31 | Human promotes or rejects a candidate | `POST /api/lab/promotions`; append-only promotion test in `lab.test.ts` | implemented |
| 32 | Human approves a memory proposal | `POST /api/memory/proposals/:proposalId/decision`; `MemoryService.decideProposal`; `memory/service.test.ts` | implemented |
| 33 | Memory folds into an immutable generation | `POST /api/memory/packs/:packId/fold`; `MemoryService.fold`; memory generation test | implemented |
| 34 | Memory clears without deleting history | `POST /api/memory/packs/:packId/clear`; `MemoryService.clear`; memory generation test | implemented |
| 35 | Generic provider/model registry needs no kernel edit | `POST /api/runtime/providers`, `/api/runtime/providers/:providerId/models/import`, `GET /api/runtime/models`; `runtimeModule` | implemented |
| 36 | Codex, Claude Code, and Kimi capability surfaces exist | Compile-time `RuntimeRegistry` and adapters in `apps/node/src/runtimes/{codex,claude,kimi}.ts`; `runtimes/index.test.ts`; `pnpm smoke:runtime` exercises the fake path; live credentials/executables not used | external-unverified |
| 37 | Demo explains the complete dashboard offline | `pnpm demo`; `seedDemo`; `demo/demo.test.ts` idempotent complete data-shape test | fixture |
| 38 | Initial dashboard exposes Needs attention, Running, Capacity | `apps/web/src/App.svelte` sections `Needs attention`, `Running`, `Capacity`; `pnpm demo` | implemented |
| 39 | Detail is progressively revealed through project/session/agent/Gateway/Lab/Memory/admin | `App.svelte` routes `/projects`, `/sessions`, `/agents`, `/gateway`, `/lab`, `/memory`, `/admin`; `pnpm demo` | implemented |
| 40 | Desktop and phone-width layouts are usable | `apps/web/src/app.css` `min-width: 320px` and `@media (max-width: 1050px/720px)`; manual `pnpm demo` browser check | implemented |
| 41 | Production build passes | `pnpm build` (web, server, node, shared) | implemented |
| 42 | High-value tests pass | `pnpm verify` / `pnpm test:run`: server 23 files/254 tests, node 7 files/51 tests, shared 1 file/4 tests; web has no test files (`--passWithNoTests`) | implemented |
| 43 | License and third-party notices are complete | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/PRIOR_ART_AND_DONORS.md`; `pnpm format:check` | implemented |
| 44 | No container is required or invoked | Root/app scripts contain no container step; local `pnpm verify`/`pnpm demo` workflow | implemented |
| 45 | No external hardware or production service is touched | Verification uses in-memory/temp SQLite, fake node/runtime, and checked-in CLIProxy fixtures; no live credentials or external endpoints | implemented |

Criteria 6–9, 14–15, 21–22, 25, 27, 29, and 37 are intentionally marked
`fixture`: they exercise the complete local path but do not claim a real
machine, provider, or external runtime. Criterion 36 remains
`external-unverified` until an operator supplies and approves live runtime
executables and credentials. No criterion is evidence of a production
deployment or external reverse-proxy configuration.


## Historical integration evidence before product narrowing

`pnpm verify` passed on 2026-09-05 with exit code 0. It passed 578 workspace
tests across 49 files: server 437, node 121, web 16, and shared 4. The client
hook suite passed 32 tests with one optional installed-OpenCode test skipped.
A separate explicit isolated OpenCode 1.18.27 run passed all 33 client tests.
Production builds, all three runtime/session/onboarding smoke checks, and
static environment/Compose checks passed. The final recovery-inclusive image
also passed isolated no-network fresh-start and container-recreation checks
with zero source-input drift. The historical baseline in [MVP status](MVP_STATUS.md) records its exact
image and source-snapshot IDs. No live provider, real account recovery,
external machine enrollment, existing-service activation, or production
deployment is part of this result.

| Area | Evidence at that revision | Verification boundary |
| --- | --- | --- |
| Optional modules | `lib/module.test.ts`, `lib/module-host.test.ts`, static contributions and lifecycle in `app.ts` | Core/Access with optional modules disabled; invalid dependencies and disabled route/worker behavior |
| Native accounts and device scope | `recover-account.test.ts`, Core/access tests, device approval/project derivation, current native project authorization | Fixture identities and temporary-database recovery grants only; production setup remains operator-owned |
| Node and agent onboarding | `apps/node/src/onboarding.test.ts`, `bridge.test.ts`, `installer.test.ts`, `scripts/onboarding-smoke.mjs` | Actual application approval/poll, private state, MCP headers, native project creation and restart claim recovery; no real machine setup |
| Coordination parity | Coordination/MCP tests and migration `012_coordination_integrity.sql` | Ownership, same-checkout overlap, capability proof, revival, idempotent completion and native lifecycle |
| Gateway catalog | `gateway/catalog.test.ts`, migrations `008_gateway_catalog.sql` and `015_gateway_catalog_authority.sql`, `clients/opencode/catalog.test.mjs` | Both response envelopes, scope/policy/freshness, and actual isolated OpenCode 1.18.27 startup; no provider inference |
| Gateway administration | `gateway/management.test.ts`, `gateway/index.test.ts`, migration `010_gateway_management.sql` | Bounded typed settings/account/consent fixtures, revision checks and redaction; no live CPA call |
| Gateway operations | `gateway/operations.test.ts`, migration `011_gateway_operations.sql` | Deduplicated import/export, bounded UTC aggregation and local retention; no continuous upstream completeness claim |
| Typed Gateway agent client | `apps/node/src/gateway-client.test.ts`, `gateway-client.ts`, `bridge.test.ts` | 25 fixed operations; actual application smoke covers private catalog-token issuance and catalog 401 after device revocation; no generic URL or queue action |
| Browser UI | Local browser checks by the integration owner | Native sign-in, Core-only routing and module/navigation gating, and full UI; no live setup |
| Deployment artifacts | `scripts/deployment-check.mjs`, `Containerfile`, `compose.yaml`, `.env.example` | Static checks and final image fresh-start/recreation smoke passed without network; no deployment or existing-service activation |

The [auth security review](reviews/auth-security.md) records resolved
revocation and request-race findings. The [MVP acceptance
review](reviews/mvp-acceptance.md) preserves the first reviewed failures and
its follow-up closure evidence. Initial findings are historical once the
corresponding client-to-application fixture closes them; neither report
substitutes for the release gate.

Those verification and image results belong to the earlier integration
baseline. [MVP status](MVP_STATUS.md) owns the current product scope and new
verification result; this record does not reuse a previous gate for changed code.
