# Roadmap

This is the sole ledger for deliberate deferrals. The current delivered scope
is in [MVP status](docs/MVP_STATUS.md). Issue IDs below refer to the rated
[issue #2 review](docs/reviews/issue-2.md), which remains historical proposal
analysis rather than a release checklist.

## Product focus

- Memory, Improvement Lab, orchestration, and server-managed Skills are removed
  from the active product. Revisit them only after the Core, Access, Coordination,
  Gateway, MCP, and client Skills workflows justify the additional scope.
  Historical tables and events remain for compatibility.
- Fleet is the user's separate private project and is not a future public Dhole
  module. Core retains the machine transport needed to execute sessions.
- A final brand name remains open. The [comparison board](docs/reviews/brand-board.html)
  and [critique](docs/reviews/brand-critique.md) compare the researched names and
  animal directions. The current product remains Dhole.

## Client and catalog evidence

- L1, A10: add other catalog consumers only after a second concrete client
  requires one. A safe projection shape does not establish installed-client
  compatibility.
- L2, S3, C8: add bounded native Codex `model/list` discovery on the execution
  node, including pagination and installed-version/authentication fixtures.
  Codex discovery is conditional on configuration. Do not generate a second
  authoritative list or assume an environment API key refreshes like the
  native backend or command-auth path.

## CPA operations

- N1, G5, H17: implement continuous collection only when upstream supplies a
  safe transfer contract with retained replay or commit-before-ack delivery.
  Local imports are durable and deduplicated but do not establish complete
  upstream coverage.
- N2, NG6: reject the claim that a local single-consumer lease can make CPA's
  destructive queue lossless. The inspected upstream queue/subscription has
  no durable cursor/ack transfer contract. Cursor, retry, and backpressure
  code cannot recover an already popped record. The delivered administrator
  opt-in queue import explicitly accepts that loss and is not a collector.
- N3, H18, H19: extend current bounded time/provider/model/auth-index queries
  with stable safe client-key identities, richer trends, heatmaps, and anomaly
  signals only after collection coverage supports them.
- N4, H6, H20: add provider-specific quota windows, reset times, and cooldown
  interpretation with source/time/coverage. Current safe account observations
  leave absent fields unknown.
- N5: add an evidence-bound account action queue only if repeated operational
  failures justify it. Current account status changes are explicit typed
  administration, not an automatic remediation queue.
- N6, H4: add Kimi/xAI device consent and other provider flows after verifying
  authoritative authorization URL and expiry contracts. Current consent
  supports Codex, Anthropic, and Antigravity. Credential-file upload/download,
  destructive account deletion, and broad account administration are outside
  the delivered workflow.
- N7, H1: raw CPA YAML editing and atomic multi-client rollback remain out of
  scope. The current four-setting editor has sanitized previews and best-effort
  conflict checks; CPA has no upstream compare-and-swap precondition. Do not
  label a Dhole revision as upstream atomic protection.
- N8, H15: add durable deduplicated alerts and recovery transitions through the
  existing transaction/event outbox. Current in-app status and errors are not
  a persistent alert state machine. External notification delivery needs a
  demonstrated destination and authorization.
- L3, H21: add provider-specific pricing sources, provenance, effective dates,
  currencies, and cached-token conformance. Current manual overrides and
  upstream estimates remain estimates; unpriced requests remain unknown.

## Product and integration

- M8: extend Overview with connection health and catalog freshness linked to
  the responsible connection/observation. The Gateway detail view already
  provides those observations; Overview currently shows request/capacity and
  cooldown summaries.
- I3, I4, I6, H2, H9, H11, H13, H14: broader administration search, alias and
  reasoning editors, governance dashboards, sharing roles, and release
  rollback UX wait for actual workflows. Keep the initial navigation small and
  preserve current native team/project authorization.
- H10: client-configuration restore tooling beyond the managed-entry
  installer/uninstaller requires a demonstrated edit need and verified
  private backup semantics.
- Mediation database backfill, live dual-write migration, bug-specific routes,
  and rich GitHub issue/PR synchronization need a separately authorized
  integration. Git remains the authority for issue and repository history.
- Maintain an offline common/compromised-password blocklist before adding
  public registration. The current private deployment keeps registration
  closed and enforces a 15-character minimum, scrypt hashing, and request
  rate limits. Those controls are not a NIST compliance claim.
- Native account lifecycle expansion, such as MFA/passkeys, email delivery,
  enterprise federation, and cross-team identity management, requires a
  concrete deployment need. Keep the current closed native account and
  machine-grant flow without a mandatory external authentication service.

## Runtime and operations

- Durable runtime-session rehydration across node restarts. Current runtime
  process mappings require explicit resume after restart.
- Operator recovery/cleanup for isolated worktrees when runtime cancellation
  fails or expires. Automatic removal waits for confirmed cancellation.
- A session-specific artifact namespace. The current bounded artifact command
  is repository-relative and its server result is reduced to metadata.
- L4: hardware-backed/external secret management, guided key re-encryption,
  multiple server replicas, and distributed rate limiting wait for production
  evidence. Keep one server, SQLite backups, and external key material first.
- Provider-native conformance tests that use real accounts or paid quota need
  separate authorization; fixture checks never substitute for them.
- Discord, Slack, RustFS, artifact-generation pipelines, and other workload
  modules are separate product work.

Public billing, a plugin marketplace, runtime plugin loading, a generic shell,
remote desktop, Docker socket lifecycle control, extra persistent data
services, and browser-to-node/provider connections remain non-goals unless
scope changes explicitly. Podman plus optional Newt packaging is approved;
that approval does not deploy services or enroll a machine.
