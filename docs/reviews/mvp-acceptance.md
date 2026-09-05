# MVP acceptance review

This review preserves the implementation before the final ADR 0003 product
narrowing. Fleet-disabled behavior and optional Sessions references describe
that historical revision. Core now owns both machine transport and sessions;
see [current MVP status](../MVP_STATUS.md) for the latest scope and verification.

Reviewed the shared working tree on 2026-09-05. This is a product-path source
review, not deployment acceptance. No live account, machine, CPA, provider, or
Mediation connection was used. The integration owner owns the final
`pnpm verify` gate. Concurrent fixes may supersede the findings below; close
them with a real client-to-application fixture, not a mock of each side.

The original findings below remain as an audit record. The follow-up table at
the end records their current disposition and supersedes the baseline claims
about missing implementation.

The sections before "Follow-up resolution" preserve the initial reviewed
baseline. Their open findings and pending checks are historical; the follow-up
records the delivered fixes and final validation.

## Blockers found during review

| ID | Priority | User-visible failure and evidence | Minimum acceptance check |
| --- | --- | --- | --- |
| P1 | High | Fresh machine authorization cannot finish. `connectMachine` polls `/api/auth/device/token` in `apps/node/src/onboarding.ts`, but `apps/server/src/modules/access/device.ts` registers `/api/auth/device/poll`. A human can approve successfully and then receive a client 404. | Use the shipped client against `createApplication` in a fixture. Start, approve, poll, and save the resulting private machine state. Assert that no credential enters client output. |
| P2 | High | The local bridge cannot obtain a tool list from the real MCP boundary. `AgentBridge.rpc` uses `requestJson`, which sends neither `Origin` nor `MCP-Protocol-Version`. The server rejects missing Origin and requires the protocol header for `tools/list` and `tools/call`. The bridge turns this rejection into an empty tool list. Its mocked tests do not enforce either server requirement. | From an authorized fixture machine, list tools and create, check, and complete a claim through the actual application. Add the required headers only to MCP requests, because machine authorization routes reject Origin. |
| P3 | High | Native manual project mode loses claim recovery on transport restart. The bridge computes a worktree identity only while selecting a GitHub remote. Explicit `--project` therefore registers no worktree. `CoordinationService.authorizeClaim` requires matching nonempty old and new worktree identities when adopting work from an ended or expired session. The same user in the same local checkout cannot complete, release, or revive the previous claim. | With a non-GitHub or local repository and explicit project, create a claim, close the bridge, start another bridge in the same checkout, and complete the original claim. Preserve the original terminal history on revival. |
| P4 | Medium | The command shown by the browser requests execution enrollment even when Fleet is disabled. `Devices.svelte` always shows plain `dhole-node connect`, the client requests `fleet:admin`, and an administrator approves it by default. `/api/auth/device/enroll` then returns 404 for a Gateway-only or Coordination-only deployment. `--agent-only` is documented but absent from that first-run instruction. | On a server with `coordination,mcp` and on a server with no optional modules, follow the browser's displayed command through approval. Agent authorization should finish without trying to enroll an unavailable execution node. |

The pairing route, MCP headers, and manual worktree findings were sent to the
node client owner during review. They should be resolved before describing
the native sign-in and machine approval path as ready for operator acceptance.

## Agent administration scope

The shipped browser has a concrete CPA administration workflow. It can create
a connection, check its management endpoint, refresh and enable catalog
models, inspect stored usage and accounts, change supported account state,
preview and apply four typed settings, and conduct the three supported
provider consent flows. The Gateway guide documents the corresponding HTTP
API and the deliberate upstream limits.

The stronger claim that an approved machine lets agents perform that
administration still lacks a shipped client path. `connectMachine` requests
project reading, coordination, project creation, and optional Fleet authority.
It does not request Gateway scopes. The local MCP bridge exposes seven
coordination tools and derives default coordination scope. It has no Gateway
commands, credential-safe token exchange command, or documented agent
administration client. An agent would have to write its own HTTP credential
handling around the private machine state.

If agent CPA administration is part of the release bar, provide one bounded
typed client workflow that requests the required authority during machine
approval, retains credentials privately, and uses the existing Gateway API.
Test an authorized safe read and a supported fixture mutation, plus denial
after revocation. Otherwise the status must name browser administration as
the delivered path and track agent CPA administration as deferred.

## Acceptable later work

At the initial review, the status document separated implementation from a
live deployment and the final verification gate had not run. It did not claim
all 100 issue review rows were closed. The following limits do not justify expanding
this release on their own:

- Continuous lossless CPA collection cannot be promised by a consumer of the
  inspected destructive queue. Retained import and explicit coverage are an
  honest initial path. Richer trends and alerts can follow useful coverage.
- Provider-specific quota semantics, additional provider consent flows,
  broader configuration editing, atomic upstream rollback, external secret
  managers, and multiple server replicas remain documented later work.
- GitHub linking is optional for native accounts. Explicit native projects
  are a valid first release path once pairing and claim recovery work.
- Mediation history migration and live cutover require their own authorized
  operation. Keeping old history read-only is an acceptable release limit.
- Pinned OpenCode catalog startup integration is owned by a concurrent task.
  M7 and AC4 should remain open until its actual client fixture is accepted.
  A projection response or MCP installer alone does not close either item.

No source changes, builds, complete verification run, installation, service
start, or real machine enrollment were performed for this review.

## Follow-up resolution

Reinspected the source on 2026-09-05 after the integration fixes. This reviewer
checked the implementation and maintained fixture coverage. The integration
owner reported the successful core-only browser check and final `pnpm verify`,
which exited 0. This reviewer did not independently rerun them. The gate passed
578 workspace tests across 49 files: 437 server, 121 node, 16 web, and 4 shared. Its client
suite passed 32 tests and skipped the optional installed-client test; a
separate run passed all 33 with OpenCode 1.18.27. Runtime, session, and expanded
onboarding smokes all passed. The final recovery-inclusive image passed
no-network fresh-start and container-recreation checks with zero source-input
drift. [MVP status](../MVP_STATUS.md) records the exact image and source snapshot.
The integration owner also reported the final browser catalog showing current
state and an enabled model after legacy capability records were normalized to
unknown. The additional offline recovery fixture covers only temporary data.

| Item | Current disposition | Resolution and evidence |
| --- | --- | --- |
| P1, pairing route | Closed by local integration evidence | [Onboarding client](../../apps/node/src/onboarding.ts) now polls `/api/auth/device/poll`. The successful first native flow reported by the integration owner used the real client and `createApplication`, including native bootstrap, machine approval, private state, and idempotent native project creation. [Maintained smoke](../../scripts/onboarding-smoke.mjs). |
| P2, MCP headers | Closed by local integration evidence | [Bridge RPC](../../apps/node/src/bridge.ts) selects MCP transport explicitly. The [JSON transport](../../apps/node/src/onboarding.ts) adds the central Origin and shared MCP protocol version only in that mode. The same real application smoke listed tools and created and completed a claim; machine credential exchange retains its separate header requirements. |
| P3, manual claim recovery | Closed by local integration evidence | [Local worktree identity](../../apps/node/src/bridge.ts) hashes the canonical Git root or the current directory independently of remote selection. Explicit native project mode sends that identity during registration. The real application smoke closes the first bridge, starts another, checks matching nonempty worktree hashes, and completes the prior claim through the new session. |
| P4, disabled Fleet | Closed by local fixture verification | [Machine connection](../../apps/node/src/onboarding.ts) now retains approved authorization and returns successfully when enrollment reports `module_unavailable`. Its [focused fixture](../../apps/node/src/onboarding.test.ts), included in the passing final gate, checks that result and confirms no node credential is saved. The client guide documents this fallback. Execution enrollment remains unavailable when Fleet is disabled. |
| Agent CPA administration | Closed by local integration evidence | `connect --gateway` requests explicit Gateway authority. The [typed client](../../apps/node/src/gateway-client.ts) implements 25 fixed actions through the existing Gateway API and is exposed by both `dhole-node gateway` and the local `gateway_manage` MCP tool. Secrets and issued catalog credentials stay in private files. The passing [expanded application smoke](../../scripts/onboarding-smoke.mjs) covers a Gateway-only grant, connection creation, management health, catalog refresh, model policy, private catalog token issuance, and unapproved authority denial. It checks that parent device revocation denies both catalog access and the Gateway bridge. Gateway-only operation creates no Coordination session. |
| Sole-administrator recovery | Closed by local fixture verification | The [offline recovery command](../../apps/server/src/recover-account.ts) issues a one-hour private reset link only for the sole active native administrator in an explicit existing private database. Six [temporary-database tests](../../apps/server/src/recover-account.test.ts) pass, including single-use consumption and rollback after output-file creation. No real recovery was performed. |
| Core-only browser | Closed by reported browser evidence | The [application UI](../../apps/web/src/App.svelte) uses the reactive enabled-module list for navigation and Overview conditions. The integration owner corrected the browser module-state bug and reported native sign-in with optional navigation hidden under `DHOLE_MODULES=none`. Core and Access remain available. |
| M7 and AC4, OpenCode startup | Closed for the pinned local client | The [OpenCode integration](../../clients/opencode/README.md) now has an actual isolated OpenCode 1.18.27 startup fixture. The integration owner reported 33 passing client tests including that startup. The [test](../../clients/opencode/catalog.test.mjs) checks the installed version, discovers the fixture model through the config hook, preserves unrelated client configuration, keeps inference pointed at CPA, and asserts that only the scoped catalog endpoint was requested. This closes the earlier missing-consumer limitation for that version, not every client or live inference configuration. |

The [current MVP status](../MVP_STATUS.md) now describes native project creation,
restart recovery, approved agent Gateway actions, and the pinned OpenCode
integration. The earlier continuous collection, quota, broader configuration,
HA, and live migration limits remain valid. None of this local evidence
authorizes or establishes a production deployment or real provider operation.

All original acceptance findings in this report now have local closure
evidence. The review found no remaining blocker in those paths after the
reported final gate. Real operator setup, deployment, and live provider
acceptance remain separate work.
