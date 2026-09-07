# MVP status

> Archived project: Dhole is discontinued and no longer maintained. This
> document records the final implementation status for historical reference.

This records the 2026-09-05 implementation, not a deployment. The repository
contains a native-account server with closed invitations and offline sole-admin
recovery, revocable machine authorization, a local
MCP bridge, maintained client Skills, CPA catalog/administration, and
Podman/Newt release packaging. Human setup starts with signing in and
approving a machine; authorized agents then create native projects, obtain
project scope, and use approved typed Gateway operations. GitHub
linking is optional. Local and non-GitHub projects can use native manual
project authorization.

Core and Access start with `DHOLE_MODULES=none`. Core owns the master
overview, sessions, runtime/provider configuration, agent activity, and machine
transport. Coordination, Gateway, and MCP are the only optional modules.
Optional selections must satisfy declared dependencies. Memory, Lab,
orchestration, and server Skills are retired. Fleet is a separate private
project. The legacy Fleet paths and scopes remain Core machine compatibility
names. Static agent Skills are maintained in `clients/skills` with explicit
`install-skills` and `uninstall-skills` commands. Disabled modules expose no routes,
navigation, WebSocket handlers, or jobs. Packaging preparation and fixture
verification do not authorize deployment, live provider requests, machine
enrollment, or Mediation initialization.

## Current revision

The narrowed product has a Lucide navigation rail that collapses to icons,
label tooltips on hover and keyboard focus, shared styled choice controls, a
Core overview with runtime details, an Access people table with search and
role/status filters, and a Gateway workspace organized around daily operations.
The [dashboard review](reviews/dashboard-design.md) records the source research
and partial CPA dashboard parity. The [brand board](reviews/brand-board.html)
and [critique](reviews/brand-critique.md) leave the final name open.

`pnpm verify` passed on 2026-09-05 with exit code 0 after the Core moves,
retirement fixes, and Coordination scope-parser correction. It passed 486
workspace tests across 45 files: server 340 in 28 files, node 123 in 11, web 19
in 5, and shared 4 in 1. The client suite passed 32 tests and skipped its
optional installed-OpenCode test. Production builds, runtime/session smoke
checks, the onboarding smoke including Core-only enrollment and transport,
and static deployment checks all passed. The current gate did not repeat the
historical installed-OpenCode run below.

Browser checks used fixture identities and covered sign-in, the Core overview,
a session with its WebSocket connected, two Coordination claims and one
conflict, and the Agents and Devices pages with no real enrollment. Gateway's
styled model and request filters worked: Failed reduced the fixture history
to one row, and resetting restored all three. The Access role selector opened
and changed its selection inside a native dialog without submitting an account
change. Earlier checks during this revision covered the 900-pixel icon rail
and tooltips and a 390-pixel page without document overflow. The final browser
pass did not repeat those viewport checks.

The current container passed isolated no-network fresh-start, shutdown, and
named-volume recreation checks. Its static assets, animal mark, licenses,
complete Lucide notice, runtime UID, and file permissions also passed inspection.
The fixture containers and volumes were removed. The image ID is
`sha256:73995eda4846363b1619cec61aa1d501fb1f9856253d7a67f91ce9d277c979f0`.
Its frozen build-source digest is
`95fabd311a0d3cc55bf90e60a192c20d3cfa43b8018cbb7217fd9eee707d960a`,
covering 141 input files with no source drift during the build. The ignored
mode-0600 local `.env` matches the example and contains replacement markers.

No deployment, real account setup, machine enrollment, live provider request,
or Mediation initialization occurred. The older gate and image identifiers
below verify their historical baseline only.

## Historical verification baseline

Before the product narrowing and dashboard revision, `pnpm verify` passed on
2026-09-05 with exit code 0. The workspace passed
578 tests across 49 files: server 437, node 121, web 16, and shared 4. The
client catalog suite passed 32 tests and skipped its optional installed-client
test in this gate. A separate explicit run against isolated OpenCode 1.18.27
passed all 33 client tests.

Production builds and the runtime, session, and onboarding smoke checks
passed. The onboarding smoke uses the actual native application and local
bridge for pairing, idempotent project creation, restart claim recovery,
Gateway connection/catalog/policy operations, private catalog-token issuance,
and device revocation. After revocation, the issued catalog token returns
401. Static environment and Compose checks passed. Browser checks covered
native sign-in, Core-only routing/module navigation, the full UI, and a current
Gateway catalog with an enabled model.

That baseline's recovery-inclusive image passed the no-network fresh-start and
container-recreation smoke. Its image ID is
`sha256:200225da916fda256e2da9935706d1932f844de071983d199182b21adb17771f`.
The source snapshot is
`b52214ce6ae485011872825968203020ab7e1e57246b918aaedfd449ad3f5708`,
with zero source-input drift during the build.

These checks do not establish a live CPA/runtime connection or a production
deployment. No real account setup, recovery, machine enrollment, or
existing-service activation was performed.

## Implementation references

- [Module registry and lifecycle](../apps/server/src/lib/module.ts), [module host](../apps/server/src/lib/module-host.ts), and [application selection](../apps/server/src/app.ts)
- [Core accounts](../apps/server/src/modules/core/core.ts), [device authorization](../apps/server/src/modules/access/device.ts), and [local agent client](../clients/README.md)
- [Coordination service](../apps/server/src/modules/coordination/service.ts), [MCP](../apps/server/src/modules/mcp/index.ts), and [Mediation guide](MEDIATION_INTEGRATION.md)
- [Gateway catalog](../apps/server/src/modules/gateway/catalog.ts), [management](../apps/server/src/modules/gateway/management.ts), [operations](../apps/server/src/modules/gateway/operations.ts), and [Gateway UI](../apps/web/src/lib/Gateway.svelte)
- [OpenCode startup plugin](../clients/opencode/README.md), tested through isolated OpenCode 1.18.27 startup
- [Gateway agent client](../apps/node/src/gateway-client.ts) and [client setup](../clients/README.md)
- [Deployment package and local checks](DEPLOYMENT.md)
- [Auth security review](reviews/auth-security.md) and [MVP acceptance review](reviews/mvp-acceptance.md), including follow-up closure evidence for the findings at their reviewed revisions

## Issue #2 delivery items

The [issue #2 review](reviews/issue-2.md) rated 100 proposal and acceptance
rows against an earlier baseline. Its ratings remain proposal analysis. This
table gives every delivery item M1 through M8, N1 through N8, and L1 through L4
an implementation status. `Shipped locally` means the code path exists in this release;
`partial` names the narrower delivered behavior. All deliberate remaining
work and rejected proposals are maintained in [Roadmap](../ROADMAP.md).

| ID | Status | Delivered behavior and limit |
| --- | --- | --- |
| M1 | Shipped locally | Bounded Zod parsers for OpenAI `data[]` and CPA Codex-style `models[]`, including duplicate/malformed input fixtures. Catalog remains optional. |
| M2 | Shipped locally | Immutable source snapshots, canonical hashes, successful observation state, deterministic diffs, and last-known content on failure. |
| M3 | Shipped locally | One optional Gateway view covers connections, catalog policy, requests, accounts, and management using the existing provider identity. It does not require another top-level navigation group. |
| M4 | Partial | Gateway shows source, observation, diff, freshness, declared capabilities, and explicitly unverified submitted evidence. Projection compatibility is not an installed-client execution claim. |
| M5 | Shipped locally | Revision-checked connection edits, disable/archive/delete, candidate endpoint/credential checks before activation, safe history, reviewed metadata diff, and nonsecret rollback. Rollback cannot undo upstream revocation. |
| M6 | Shipped locally | Scoped, hashed catalog tokens with parent-bound expiry/revocation and versioned effective endpoints with authorization before ETag handling. Policy/freshness changes affect the representation. |
| M7 | Shipped locally | The optional catalog plugin passed the actual isolated OpenCode 1.18.27 startup fixture. It preserves native CPA inference, applies scoped policy, and handles stale, removed, empty, and rejected catalogs. |
| M8 | Partial | Overview respects module selection and shows request/capacity/cooldown summaries. Connection health and catalog freshness are in Gateway detail, not yet Overview. |
| N1 | Partial | Retained-file/push import commits sanitized records and permanent dedup receipts; collection coverage is explicit. There is no continuous durable upstream collector. |
| N2 | Rejected as proposed | A local lease cannot make CPA's consumptive queue lossless. A separate administrator-only import requires explicit data-loss acceptance; it has no delivery guarantee or automatic polling. |
| N3 | Partial | Bounded UTC hour/day usage buckets, provider/model/auth-index filters, failures, duration/TTFT, and redacted paginated export. Heatmaps, anomaly signals, and client-key identity need more evidence. |
| N4 | Partial | Safe account refresh and observed health/quota/cooldown data. Provider-specific quota windows and reset semantics remain unknown where unsupported. |
| N5 | Partial | Explicit revision/state-checked file-account enable/disable operation. No automatic account-remediation or durable review queue. |
| N6 | Partial | Bound start/status/pasted-callback/cancel flows for Codex, Anthropic, and Antigravity, with credentials staying at CPA. Other provider device flows are not included. |
| N7 | Partial | Four typed CPA settings with safe preview/history and best-effort revision checks. Raw YAML, upstream atomic CAS, and universal rollback are not provided. |
| N8 | Deferred | Current in-app status and errors exist; a durable deduplicated alert/recovery state machine does not. |
| L1 | Deferred | Projection DTOs cover three shapes; broader client integration requires a second demonstrated consumer need. |
| L2 | Partial | Native Codex discovery behavior and authentication limits were reviewed. A bounded node `model/list` operation and installed-version fixtures are not implemented. |
| L3 | Partial | Existing effective-dated manual rates and upstream estimates remain available with unknown cost separated. Provider-specific inspections and pricing fallback provenance need further work. |
| L4 | Deferred | Encrypted secrets, external keys, single-server SQLite, and backup instructions are present. External secret managers and HA require operational evidence. |

The review's acceptance rows are not all closed. AC1 through AC7 now have
local catalog and client fixture evidence under the historical verification
gate. AC4 includes the actual pinned OpenCode startup hook and server token
scope/revocation tests. S1 has verified local implementation. S4 passed the
current static artifact and isolated no-network image checks recorded above.
S2 includes native sign-in, device approval, project creation, restart claim
recovery, and typed
agent Gateway actions. The real application onboarding smoke exercises the
client/server boundary. Real operator acceptance remains separate. S3 is
partial for the same native-discovery reason as L2.

## Read the limits literally

CPA model presence is an observed advertisement, not proof of successful
inference. Catalog freshness and explicit enablement are separate. An
administrator-submitted probe is unverified evidence. Only the pinned
OpenCode startup test establishes the delivered client integration; the other
projection shapes alone do not. Local retained history is not complete
upstream traffic, and estimated spend is not an invoice.

Native-account and provider consent are also separate. One Dhole sign-in
removes repeated Dhole setup; it cannot remove a provider's required consent
or an expired runtime credential. Operator-owned runtime configuration and
provider connections remain on their normal execution path.

The [historical acceptance matrix](ACCEPTANCE_TRACEABILITY.md) records the
original fixture implementation. Its earlier test counts and UI observations
are not reused as verification of this release.
