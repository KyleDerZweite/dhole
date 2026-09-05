# Mediation integration

Dhole implements coordination in its compiled `coordination` module. It needs
no running Mediation instance, iframe, runtime plugin, or second database.
The optional `mcp` module exposes those services to agents. Select
`DHOLE_MODULES=coordination,mcp` for this server capability without the other
optional modules.

This guide describes the local implementation. No live Mediation setup,
service cutover, or machine enrollment is part of repository verification.

## Agent setup

The normal flow is native Dhole sign-in followed by machine approval through
`dhole-node connect`. The machine keeps its authorization privately. Its
local `dhole-node mcp` bridge obtains project scope and owns the transport
session and capability. Agents can create a private local project through
`dhole-node create-project` when the machine holds `projects:create`. The
model sees these work tools:

- `coordination_check`
- `coordination_claim`
- `coordination_release`
- `coordination_complete`
- `coordination_revive`
- `coordination_state`
- `coordination_agent_event`

The bridge handles project binding, short-lived token renewal, registration,
quiet heartbeats, and session end. Credentials, capabilities, and setup fields
are removed from model-visible arguments. Use an explicit `--project` for an
existing authorized local or non-GitHub project. Manual mode keeps a stable worktree identity for claim recovery after bridge
restart. Automatic push-remote binding uses the optional GitHub authorization
path. See
[Node operation](NODE_ENROLLMENT.md) and [Client setup](../clients/README.md).

A temporarily unavailable coordination service produces a bounded warning.
An unconfirmed action is not reported as accepted. The bridge does not block
ordinary work indefinitely or silently switch to another project.

A machine approved with `connect --gateway` can also expose `gateway_manage`
through the local bridge. It uses a separate typed HTTP client and scoped
project authorization, so it works without a Coordination session. Its fixed
operations administer Gateway; they do not add arbitrary HTTP or shell access.
See [Gateway administration](GATEWAY_AND_CPAMP_REPLACEMENT.md).

## Identity and state

| Concept | Dhole representation |
| --- | --- |
| Project and repository | Server-owned project/repository rows; request IDs do not grant access |
| Transport session | `coordination_sessions` with a generated short-lived capability; only its hash persists |
| Claim | Scoped intent, files/components, task, branch/revision, blocker, findings, commits, and PR references |
| Overlap | File exact/prefix overlap, normalized component overlap, and bounded task similarity |
| Agent lifecycle | Idempotent lifecycle events and execution rows with hashed native IDs and authenticated ownership |
| Findings | Bounded, redacted append-only findings on claims |
| Issues | References to the project's authoritative issue tracker |

An authenticated native user supplies ownership. Display labels do not prove
identity. Claim adoption requires the same immutable user and a matching,
nonempty worktree. Sharing a checkout does not hide another session's overlap.

Operational rows own current state. Versioned events record changes in the
same transaction. Transport end does not delete claims or history. Terminal
claim states are `done`, `abandoned`, `expired`, and `released`.

## HTTP compatibility

All routes are relative to Dhole and use a team-authorized project `:p`.
Project API credentials require `project:read` for reads and
`coordination:write` for mutations. Session and claim mutations require the
session capability in `x-mediation-session`, alongside authenticated project
access. A session-specific check also proves session ownership. Capabilities
are never accepted as model arguments or returned by state reads.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/projects/:p/sessions` | Register with `agent` or `agentLabel`; return a generated capability once |
| `POST` | `/api/projects/:p/sessions/:id/heartbeat` | Renew TTL and optionally report activity and repository state |
| `POST` | `/api/projects/:p/sessions/:id/repo` | Report branch, revision, and dirty files |
| `DELETE` | `/api/projects/:p/sessions/:id` | End transport without deleting claims |
| `POST` | `/api/projects/:p/claims` | Create an owned claim and return overlap warnings |
| `PATCH` | `/api/projects/:p/claims/:id` | Change scope/status/blocker or append a finding |
| `POST` | `/api/projects/:p/claims/:id/revive` | Create a replacement for an expired/released claim, preserving recovery provenance |
| `POST` | `/api/projects/:p/claims/:id/complete` | Settle as `done` or `abandoned` with commits, PRs, and summary |
| `POST` | `/api/projects/:p/claims/:id/release` | Mark released while retaining history |
| `GET`, `POST` | `/api/projects/:p/check` | Check bounded files/components/task/intent scope |
| `GET` | `/api/projects/:p/state` | Read bounded sessions, claims, conflicts, recent files, and agent state |
| `POST` | `/api/projects/:p/agent-events` | Append an idempotent native lifecycle event |

The session creation path is shared with Core conversations.
Coordination registration has an `agent` or `agentLabel`; a normal shared
session has a `title`. The body shape chooses the domain operation and does
not bypass its authorization.

## Claims and lifecycle

Claims use `investigating`, `in-progress`, `testing`, or `blocked` while active.
Advisory claims return warnings. An explicit enforced reservation rejects
blocking overlap atomically. The same overlap service handles HTTP and MCP.
There is no active orchestration scheduler.

Claim creation requires an owned coordination session. Patches support
intent, files, components, task, branch, base revision, blockers, and findings.
Finding kinds are `root-cause`, `gotcha`, `decision`, and `api-change`.

Revival creates a new claim with `recoveredFromClaimId`; it preserves the old
terminal row and inherited findings. Completion retries preserve the original
summary and completion time, merge new commits/PRs, and append evidence only
when it changes. Completing an expired or released claim follows its recovery
reference rather than rewriting terminal history.

Lifecycle `runId` is an opaque native identifier, separate from the Dhole run
scope granted by an API credential. Authenticated ownership participates in
its hashed identity. Duplicate events are idempotent; stale state reports do
not overwrite newer state. Fresh later activity can resume a terminal
execution with an appended event.

## Direct MCP clients and aliases

`POST /mcp` supports MCP initialization, `tools/list`, and `tools/call` with
project-scoped credentials. Enabled modules determine the tool list.
Coordination also exposes `coordination_session_register`,
`coordination_session_heartbeat`, `coordination_repo_report`, and
`coordination_session_end` to native protocol clients. Such clients must keep
the returned capability outside model context and send it in the header.
The local bridge automates these transport calls.

The five legacy aliases remain:

| Alias | Behavior |
| --- | --- |
| `mediation_auth` | Guidance to use Dhole authorization; does not accept credentials as arguments |
| `mediation_init` | Guidance for native Coordination; creates no external Mediation project |
| `mediation_claim` | Native claim create/update, with release compatibility |
| `mediation_bug` | Guidance to use the authoritative issue tracker; creates no issue |
| `mediation_state` | Bounded redacted project coordination state |

The server exposes no shell, generic RPC, automatic external issue creation,
or second Mediation store. Deliberate integration gaps and migration work are
tracked in [Roadmap](../ROADMAP.md).

## Operator cutover boundary

A real cutover requires its own authorized operation. Preserve an old database
backup, create or select the Dhole project, authorize a machine, and try one
client before switching others. Re-publish only active claims through the
validated API, retaining old identifiers in a migration ledger. Compare scope,
conflicts, and lifecycle behavior before revoking old access.

There is no automatic backfill or live dual-write path. Retain old history
read-only rather than importing raw credentials, prompts, or tool payloads.
Changing a client URL back does not reverse Dhole history.

Dhole's implementation is native and copies no Mediation source. The earlier
source review found an MIT declaration in Mediation's package metadata but no
license file at the reviewed revision. Copying upstream code requires verified
license and attribution evidence; see [Prior art](PRIOR_ART_AND_DONORS.md).
