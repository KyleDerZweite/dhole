# Mediation integration and cutover

## Position

Dhole implements Mediation's useful coordination behavior in the native
`coordination` module. It is not an iframe, a proxy to a second service, or a
runtime plugin. The server owns the project, repository references, SQLite
rows, authorization, events, and retention. `packages/shared` owns the
versioned wire types. A Dhole deployment therefore needs one central server;
it does not need a running Mediation instance.

The implementation was checked against the repository's Coordination, MCP,
access, session, and orchestration modules and their tests, and against the
public Mediation `main` tree (package version 0.5.1 at the time of review).
No live Dhole, Mediation, CLIProxyAPI, or CPAMP instance was contacted or
changed while preparing this document. The remote source review was
read-only.

## Concept mapping

| Mediation concept | Native Dhole representation |
| --- | --- |
| Project/repository identity | A server-owned `projects` row and optional `repositories` rows. Coordination calls use the project path parameter `:p`; a model cannot create a project by choosing a free-form project id. |
| Session | `coordination_sessions`, created with a short-lived capability and renewed by heartbeat. The capability hash, not the capability, is persisted. |
| Claim | `coordination_claims` plus normalized file and component rows. A claim can carry a run/work-item id, branch, base revision, task, blocker, findings, commits, and PR references. |
| Overlap | `coordination/overlap.ts`: file exact/prefix, case-insensitive component, then two-significant-token task similarity. |
| Lifecycle/crew | `coordination_agent_executions` and idempotent `coordination_agent_events`; native ids are hashed before storage and shared state exposes only a server execution id and `parentAvailable`. |
| Findings/blockers | A claim finding is a bounded, redacted append-only row. `blockedOn` references another claim in the same project. |
| Bug reporting | There is no native Dhole bug table or `/bugs` compatibility route. Record a bug in the project's authoritative issue tracker, then use a claim for actionable work. The `mediation_bug` MCP call returns this guidance. |

The operational database is authoritative for current state. Coordination
transitions append versioned Dhole events in the same transaction when the
event store is available; this is not an external Mediation event stream.

## Authentication and session capability

Humans use the normal Dhole cookie session. Agent and MCP clients use a
project-scoped API token. An administrator creates one with the authenticated
administration route:

```http
POST /api/admin/tokens
Content-Type: application/json
Cookie: dhole_session=...; dhole_csrf=...
X-CSRF-Token: ...

{"projectId":"PROJECT_ID","permissions":["project:read","coordination:write"],"expiresInSeconds":86400}
```

`projectId` must be an administrator's team project. `runId` is optional and,
when present, is checked against that project. Permissions are one or more of
`project:read`, `coordination:write`, `children:write`, `memory:read`,
`memory:propose`, `skills:read`, `skills:propose`, `benchmarks:run`, and
`fleet:admin`. The last permission is administrator-only, cannot be run-scoped,
and is used only for operator credential rotation; browser-cookie callers are
rejected so a node credential is never returned to the dashboard.
Expiry is 300 seconds through 30 days (default one day). The response contains
the random bearer token once; only its hash is stored. Revoke it with
`DELETE /api/admin/tokens/:tokenId` (administrator only). Never put a token in
a repository, command body, event, or log.

The compatibility API accepts `Authorization: Bearer <token>`. The access
module requires `project:read` for GET compatibility routes and
`coordination:write` for mutating compatibility routes. The authenticated
user on a token, rather than body labels, supplies attribution where the
server has an identity.

`POST /api/projects/:p/sessions` is intentionally dual-purpose. A body with
`agent` or `agentLabel` is dispatched to Coordination; a body with the normal
session `title` is handled by the Sessions module. The Coordination body is:

```json
{
  "agent": "codex",
  "developer": "optional display label",
  "machine": "optional machine label",
  "worktree": "repository-relative checkout identity"
}
```

`agent` (or `agentLabel`) is required. The server generates a random
capability and returns it in the response. A client-supplied `capability` is
discarded on this route; do not depend on choosing one. The returned secret is
used in the `x-mediation-session` header on subsequent calls. The aliases
`x-session-capability` and `x-mediation-session-capability` are accepted too.
Capabilities are short-lived with the session and are never returned by state
reads.

Clients should always send the capability when naming a session or claim. In
the current compatibility implementation, the heartbeat, repository report,
and session DELETE handlers also accept a valid project bearer without the
header; claim ownership and claim adoption still require capability checks.
This permissive transport behavior is a known deviation from the stricter
upstream Mediation client contract and should not be used as a reason to omit
the header.

## Exact HTTP compatibility surface

All paths below are relative to the Dhole origin and use `:p` for the project
id. JSON request bodies are Zod-validated and bounded.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects/:p/sessions` | Register a Coordination session; response includes the generated capability. |
| `POST` | `/api/projects/:p/sessions/:id/heartbeat` | Renew a session TTL and optionally report activity, branch, revision, and dirty files. |
| `POST` | `/api/projects/:p/sessions/:id/repo` | Store the latest branch, revision, and dirty-file report. |
| `DELETE` | `/api/projects/:p/sessions/:id` | End the transport session. Claims are not deleted by transport end. |
| `POST` | `/api/projects/:p/claims` | Create a claim; returns the claim and overlap warnings. `mode: "advisory"` is the default. |
| `PATCH` | `/api/projects/:p/claims/:id` | Update scope/status/blocker or append a finding (`root-cause`, `gotcha`, `decision`, `api-change`). |
| `POST` | `/api/projects/:p/claims/:id/complete` | Settle with `done` or `abandoned`, optional commits/PRs, and a summary. |
| `POST` | `/api/projects/:p/claims/:id/release` | Mark a claim `released` (server-side terminal state). |
| `GET` | `/api/projects/:p/check` | Check query parameters `files`, `components`, `task`, `intent`, `worktree`, and `sessionId`; files/components are comma-separated. |
| `POST` | `/api/projects/:p/check` | Check a JSON scope with the same fields and a required `intent`. |
| `GET` | `/api/projects/:p/state` | Return bounded project coordination state: sessions, active/terminal claims, conflicts, recent files, and agent execution views. |
| `POST` | `/api/projects/:p/agent-events` | Record an idempotent lifecycle event (`eventId`, `runId`, `agentId`, `harness`, `state`, `occurredAt`, and optional parent/name/role/task/reason/session). |

The normal Dhole project/repository routes remain available to authorized
human members: `GET /api/projects`, `POST /api/projects`,
`GET /api/projects/:projectId`, `GET /api/projects/:projectId/repositories`,
and `POST /api/projects/:projectId/repositories` (also
`POST .../repository`). There is deliberately no Dhole equivalent of the
upstream Mediation client's GitHub-only
`POST /api/repositories/github/session`; create or bind the project and
repository through Dhole administration, then use the project id above.

## Claims, overlap, and status

An active claim has status `investigating`, `in-progress`, `testing`, or
`blocked`. Terminal rows are `done`, `abandoned`, `expired`, and `released`.
Terminal rows are retained in the state history; they are not silently
deleted. The default idle claim TTL is 45 minutes. `sweep` runs as part of
state/check/create paths, expires idle claims, and resolves their open
conflicts. A session expires after 120 seconds without heartbeat by default.

Overlap is intentionally explainable:

1. File paths are slash-normalized and overlap on an exact path or a
   directory prefix (`src/api` overlaps `src/api/route.ts`).
2. Components compare case-insensitively.
3. Task/intent text is the weakest signal: after stop-word removal it needs at
   least two shared significant tokens, and it is considered only when no
   file/component reason exists.

Claims from the proposed session are excluded. Two non-empty equal worktree
   hashes are also excluded because they are the same checkout. A claim's
   overlap scope is widened at read time with the latest dirty files reported
   by its session. Worktree values are stored as `wt_` plus a SHA-256 digest;
   clients should send repository-relative file names and must not send an
   absolute private path.

Normal interactive claims are advisory. A conflict warning is returned and
   persisted with severity `blocking` for file/component evidence or `warning`
   for task evidence, but an advisory create still succeeds. Dhole-managed
   orchestration uses the separate enforced path (`reserveClaim`, or
   `mode: "enforced"`/`enforce: true` internally): a blocking overlap is
   rejected atomically before a child is scheduled. The scheduler associates
   every child work item with its claim and releases or settles it on every
   terminal path. Task-only similarity never blocks an enforced reservation.

### Session end and adoption

Transport loss is not proof that work finished. Ending a session leaves its
unsettled claims in place so other agents continue to see the reservation. A
new session may touch an ended owner's active claim only when its capability
identifies a session with the same developer label and the same non-empty
worktree hash. The claim's `coordinationSessionId` is then moved to the new
session. A live owner's claim requires that owner's capability. Mismatched
developer or worktree values are denied. Terminal claims remain history and
should be treated as closed rather than reopened.

## Agent lifecycle events and idempotency

`POST /api/projects/:p/agent-events` stores one logical execution per
project/run/agent hash and one retry record per `(project,eventId)`. Retrying an
`eventId` with identical content is idempotent; reusing it with different
content returns a conflict. Execution states are `starting`, `active`,
`waiting`, `blocked`, `needs-input`, `completed`, `failed`, and `cancelled`.
The server marks provenance `harness-reported`; the caller cannot choose it.
Raw run, agent, and parent identifiers are hashed. The shared state view gives
the server execution id and only a `parentAvailable` boolean. Retry event rows
are bounded to seven days while the execution row remains.

## Privacy boundary

Coordination state is project-authorized, not public. It contains bounded
labels, intent/task summaries, normalized relative file names, opaque ids,
status, and conflict reasons. It does not contain session transcripts, model
prompts, tool arguments/results, provider credentials, or raw capability
secrets. Text is trimmed and redacted before durable writes; common
`api-key=`, `access-token=`, `refresh-token=`, `secret=`, and `password=`
forms are masked. Findings and event payloads receive the same treatment.

The narrower MCP `project_state` and `mediation_state` views redact project
and session text and return only token-scoped project/run data. A token's
arguments cannot widen its project or run scope. `agent-events` can be sent
with a device/project token and does not require a transport capability when
no `sessionId` is supplied; this is intentional for lifecycle reporting, but
the event body must still be treated as project-member-visible metadata.

## MCP compatibility

Dhole exposes stateless MCP 2026-07-28 JSON-RPC at `POST /mcp`. Requests must
use an allowed `Origin`, `Accept: application/json`,
`Content-Type: application/json`, and a project-scoped hashed Bearer token.
Bodies are capped at 512 KiB. Responses do not open an SSE/resumable session.
`initialize` is accepted without the version header for older clients when its
requested protocol is `2026-07-28`; all other methods need
`MCP-Protocol-Version: 2026-07-28`.

The exact modern catalogue is sorted and contains:

```text
benchmark_invoke
child_cancel
child_collect
child_create
child_message
child_status
child_wait
coordination_check
coordination_claim
coordination_release
coordination_session_register
memory_propose
memory_read
mediation_bug
mediation_claim
mediation_init
mediation_setup
mediation_state
project_state
skill_propose
skill_read
```

The legacy direct-method compatibility set is exactly:

```text
mediation_setup
mediation_init
mediation_claim
mediation_bug
mediation_state
```

They can also be invoked through normal `tools/call`. Their current meaning is
narrow and explicit:

- `mediation_setup` explains that an administrator must create a Dhole
  project-scoped token; credentials are never accepted as MCP arguments.
- `mediation_init` explains that Coordination is initialized by Dhole's
  migration and a session is registered with `coordination_session_register`;
  no external Mediation project is created.
- `mediation_claim` aliases `coordination_claim`; when a `claimId` is supplied
  with `status: "released"`, it aliases `coordination_release`.
- `mediation_bug` explains that Dhole does not create external issue records.
- `mediation_state` combines the redacted project/run/session/claim view with a
  bounded coordination view.

The modern `coordination_claim` tool is token-scoped and supports
`claimId`, `coordinationSessionId`/`sessionId`, `intent`, `task`, `files`,
`components`, `status`, `runId`, and `summary`. The MCP boundary intentionally
does not expose a shell, arbitrary RPC, credentials, or an external Mediation
store. For exact overlap proof and per-session capability behavior, use the
HTTP compatibility routes.

## Migration and cutover

1. **Inventory and back up.** Export the Mediation SQLite database and retain
   the old service URL during a read-only comparison window. Do not copy
   credentials into the export or repository.
2. **Create Dhole identity.** Start Dhole, create/approve human users, create a
   project, and register its repository under the project. Mediation's
   GitHub-owner/repository initialization is not used by Dhole.
3. **Issue a scoped token.** An administrator calls `POST /api/admin/tokens`
   with `project:read` and `coordination:write` (and an optional `runId`), then
   delivers the bearer through a protected secret channel.
4. **Point one canary client at Dhole.** Set the client's base URL to the
   Dhole origin, call `POST /api/projects/:p/sessions` with `agent` and
   `worktree`, save the returned session id/capability in process memory, and
   send `x-mediation-session` on every session/claim call. Start heartbeat at
   roughly one quarter of the published TTL.
5. **Re-publish active work.** For each still-active Mediation claim, create a
   Dhole claim with the same intent/task/files/components, then append any
   findings through the patch route. Preserve old claim ids in your own
   migration ledger; Dhole ids are independent. Re-report branch/revision and
   dirty files with the repo route.
6. **Move lifecycle reporting.** Post native Dhole `agent-events` with a
   stable event id. Do not replay raw prompts, tool payloads, or old device
   tokens. Existing Mediation `/bugs` records need an issue-tracker decision;
   Dhole provides no bug-row importer.
7. **Switch MCP clients.** Change the MCP endpoint to `/mcp`, request
   `initialize`, then use `tools/list`/`tools/call`. Legacy clients can use the
   five direct method names above while they are being upgraded.
8. **Verify and cut over.** Compare claim counts, overlap warnings, and agent
   state for one heartbeat interval. Revoke the old Mediation device token,
   switch remaining clients, and keep the old database read-only for audit.
   Roll back by restoring the old URL and credentials; this does not mutate
   Dhole state.

There is no automatic database backfill or live dual-write bridge in Dhole's
MVP. A deliberate migration must be bounded, redacted, and owned by the
operator.

## Known deviations and provenance

- Dhole has no `/api/projects/:p/bugs` create/patch/delete routes, GitHub bug
  synchronization, or bug-specific MCP behavior; use the issue tracker and a
  claim instead.
- Dhole does not expose Mediation's `/api/repositories/github/session` or
  automatic GitHub App/device setup. Project/repository membership and Dhole
  API token creation are server administration concerns.
- Dhole keeps claims after transport end, but server-side `expired` and
  `released` are terminal history. It does not promise upstream Mediation's
  claim-revival notes.
- The HTTP service's exact overlap engine is used by Coordination routes;
  MCP's compact `coordination_check` view intentionally returns bounded
  warnings rather than reproducing every file-prefix detail.
- Heartbeat/repo/end routes currently tolerate a missing capability when a
  project bearer is valid (noted above); clients should still send the header.
- No external Mediation service is a runtime dependency. The upstream
  Mediation `package.json` declares MIT, but the reviewed repository revision
  had no `LICENSE` file. Treat that as unresolved provenance risk: do not copy
  Mediation source until an authoritative license file, exact commit, and
  copyright holders are obtained and preserved. Dhole's implementation is a
  clean native reimplementation and copies no Mediation source.
