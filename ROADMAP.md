# Roadmap

Deliberately deferred until the MVP has production evidence:

- Hardware-backed or external secret manager integration and guided key rotation.
- Multiple central-server replicas and a shared distributed rate limiter.
- Full CLIProxy OAuth/account onboarding and destructive credential management.
- Provider-native live conformance suites that consume paid quota.
- Durable runtime-session rehydration across node restarts; the MVP mapping is process-local and requires an explicit resume.
- End-to-end provider usage telemetry for exact orchestration token/cost accounting; the MVP enforces declared budgets as conservative reservations and uses measured result fields only when available.
- Operator recovery/cleanup for isolated worktrees when a runtime cancel command fails or expires; automatic removal waits for confirmed cancellation.
- A session-specific artifact namespace; the current bounded artifact command is repository-relative and its server result is reduced to metadata.
- Rich GitHub issue and pull-request synchronization.
- Optional model-judge benchmark scorers, GEPA or DSPy proposal generators, and controlled canaries.
- Embedding search only if FTS5 quality measurements justify the added service.
- Discord, Slack, RustFS, artifact-generation pipelines, and other workload modules.
- Public multi-tenant billing, plugin marketplace, mobile/native clients, remote desktop, and general shell access remain non-goals unless product scope changes explicitly.
