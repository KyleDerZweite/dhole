# Node enrollment and operation

Dhole nodes are outbound daemons. A node opens `ws://` or `wss://` to the
central server at `/ws/node`; the browser never connects to a node and the
server never opens an inbound connection to an execution machine.

## Enroll one machine

1. Start the server and sign in as an administrator.
2. Issue a short-lived enrollment token. The authenticated request is:

   ```http
   POST /api/fleet/enrollment-tokens
   Content-Type: application/json
   Cookie: dhole_session=...
   X-CSRF-Token: <login csrfToken>

   {"label":"builder-01","ttlMs":900000}
   ```

   `ttlMs` defaults to 900,000 ms (15 minutes), must be positive, and cannot
   exceed seven days. The response contains the opaque token and its expiry.
   Enrollment-token issuance is administrator-only and team-scoped.

3. On the target machine, consume the token exactly once:

   ```http
   POST /api/fleet/enrollment/consume
   Content-Type: application/json

   {"token":"<enrollment token>","machineName":"builder-01"}
   ```

   This intentionally unauthenticated endpoint treats possession of the
   one-time token as the capability. The response contains `machineId` and a
   replaceable device `credential`. The server stores only a hash of both the
   enrollment token and device credential. Expired, revoked, or already
   consumed tokens return an error and cannot create another machine.

4. Configure and start the node from the built workspace:

   ```sh
   export DHOLE_NODE_SERVER_URL='ws://127.0.0.1:4173/ws/node'
   export DHOLE_NODE_MACHINE_ID='<machineId from consume>'
   export DHOLE_NODE_CREDENTIAL='<credential from consume>'
   export DHOLE_NODE_STATE_DIR='./data/node-builder-01'
   export DHOLE_NODE_REPOSITORIES='{"<repositoryId>":"/absolute/path/on-this-node"}'
   pnpm --filter @dhole-control/node start
   ```

   Use `wss://` for a server reached through an HTTPS reverse proxy. The
   daemon reads environment credentials first; when either is absent it reads
   `credential.json` in `DHOLE_NODE_STATE_DIR`. The daemon does not call the
   enrollment API itself; provision the values through the environment or a
   file managed by your deployment.

Do not paste enrollment tokens or device credentials into tickets, shell
history, logs, fixtures, event payloads, or browser responses beyond the
enrollment response. Treat a returned credential as a secret and transfer it
over the operator's secure channel.

## Credential rotation and revocation

An administrator can rotate an active device credential with an operator API
token. Browser-cookie sessions are deliberately rejected because the new
credential is returned once in the response. Create an administrator Bearer
token with the `fleet:admin` permission (scoped to a project in the machine's
team), then call:

```http
POST /api/fleet/machines/<machineId>/credential/replace
Authorization: Bearer <fleet-admin-api-token>
```

Cookie-authenticated browser requests return `403 api_token_required` and
never include a credential. The response to a valid operator request contains
the new credential once. The previous credential is marked `revoked_at` and
immediately fails node authentication; update the node's
`DHOLE_NODE_CREDENTIAL` or its persisted `credential.json` before restarting
it. Device credentials are replaceable, not shared across machines.
Unused enrollment tokens expire automatically; `FleetService` also exposes
`revokeEnrollmentToken` for server-side administration. This MVP does not
expose a separate browser route to revoke an unused token or disable a machine
without replacing its credential; do not mistake a disconnected or stale
status for revocation.

## Files and permissions

The node creates `DHOLE_NODE_STATE_DIR` with mode `0700`. The state directory
contains:

- `credential.json`: the machine ID and current device credential (the exported
  `writeCredentialState` helper uses the same atomic `0600` protocol);
- `journal.json`: operation keys and command states.

Both files are written through a temporary `0600` file, `fsync`, and atomic
rename. The server database is also created as mode `0600` (with its normal
SQLite WAL sidecars). Back up and restrict the state directory as carefully as
the repository it can access.

## Connection, heartbeat, and reconnect

The daemon sends a `dhole.node.v1` `hello` frame with its machine ID, daemon
version, and journal summary. The server validates the `Authorization: Bearer`
credential from the WebSocket upgrade and the hello machine ID before sending
`welcome` and any `reconcile` operation keys. Heartbeats advertise available
slots and discovered runtime descriptors. The default heartbeat interval is
15 seconds; the server marks a node stale after roughly 60 seconds without a
heartbeat.

After a close, the node reconnects with bounded exponential backoff (defaults:
500 ms minimum and 30 seconds maximum). Reconnect sends the journal summary so
the server can reconcile incomplete commands. Server delivery is at-least-once;
the node journals `accepted` before an external side effect and never spawns a
second operation for an existing `operationKey`. Ambiguous crash windows remain
`uncertain` for reconciliation rather than being silently replayed. Fleet
redelivers queued/delivered/accepted/running commands, but deliberately does not
redeliver `uncertain` commands; those require an explicit operator decision or
runtime resume.

The node wire is `dhole.node.v1` and every frame is capped at 1 MiB. Node-to-
server frames are:

| Frame | Contents and durability |
| --- | --- |
| `hello` | Machine ID, daemon version, and up to 10,000 journal summaries used for reconnect reconciliation. |
| `heartbeat` | Available slots and current runtime descriptors; the server upserts availability and marks missing runtimes unavailable. |
| `runtime_event` | A bounded normalized adapter event with command ID, operation key, sequence (1–10,000), event ID, kind, payload, and timestamp. Sent live while a command runs; later transient events are dropped, while a later durable event makes the command uncertain. |
| `command_status` | `accepted`, `running`, `completed`, `failed`, or `uncertain`, with a bounded redacted result/error. Terminal fallback keeps durable approval/tool events within 900 KiB and drops transient events first; an unrepresentable durable overflow is uncertain, never falsely completed. |

Server-to-node frames are `welcome`, `command`, and `reconcile`. Fleet validates
the machine, command ID, operation key, and project/repository scope before
accepting a status or runtime event. Runtime deltas and turn lifecycle events
are transient app-session updates; approval and tool events are durable server
events and can be replayed idempotently from a terminal result or event
watermark. See [Runtime adapters](RUNTIME_ADAPTERS.md) for the event matrix.

Graceful `NodeClient.stop()` aborts active session controllers, closes adapters,
stops heartbeat/reconnect timers, and closes the socket. A queued session
command that never started is failed as `node stopped before execution`. If a
runtime operation started before an abort/close race, its journal state becomes
`uncertain`; it is not silently retried. On a later daemon start, persisted
`accepted`/`running` entries are converted to `uncertain` for the same reason.

The tunable node environment variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DHOLE_NODE_SERVER_URL` | `ws://127.0.0.1:4173/ws/node` | Outbound node endpoint (`ws` or `wss`) |
| `DHOLE_NODE_MACHINE_ID` | unset | Enrolled machine identity |
| `DHOLE_NODE_CREDENTIAL` | unset | Current device bearer credential |
| `DHOLE_NODE_STATE_DIR` | `~/.dhole-node` | Credential and journal directory |
| `DHOLE_NODE_DAEMON_VERSION` | `0.1.0` | Version reported in hello |
| `DHOLE_NODE_HEARTBEAT_MS` | `15000` | Heartbeat interval (2,000–120,000 ms) |
| `DHOLE_NODE_MAX_FRAME_BYTES` | `1048576` | Maximum node frame; hard maximum is 1 MiB (configurable from 16 KiB to 1 MiB) |
| `DHOLE_NODE_RECONNECT_MIN_MS` | `500` | Backoff floor (100–60,000 ms) |
| `DHOLE_NODE_RECONNECT_MAX_MS` | `30000` | Backoff ceiling (1,000–600,000 ms) |
| `DHOLE_NODE_REPOSITORIES` | `{}` | JSON map from Dhole repository IDs to absolute roots on this node |
| `DHOLE_NODE_SECRETS` | `{}` | JSON map from opaque command secret references to node-local secret values (each value 4–16,384 characters) |
| `DHOLE_NODE_ENABLE_FAKE` | `false` | Advertise the deterministic fake runtime; enable only for local fixture/demo nodes |
| `DHOLE_CODEX_EXECUTABLE` | `codex` | Optional Codex executable path |
| `DHOLE_CLAUDE_EXECUTABLE` | `claude` | Optional Claude Code executable path |
| `DHOLE_KIMI_EXECUTABLE` | `kimi` | Optional Kimi executable path |
| `DHOLE_OPENAI_BASE_URL` | unset | OpenAI-compatible HTTP base URL without embedded credentials; explicit configuration is required for availability |
| `DHOLE_OPENAI_MODEL` | `default` | Model key used by the node OpenAI-compatible adapter |

## Repository allowlists and commands

Before a node may work on a repository, an administrator authorizes its
repository ID for that machine and records the expected absolute root:

```http
POST /api/fleet/machines/<machineId>/allowlist
Cookie: dhole_session=...
X-CSRF-Token: <login csrfToken>
Content-Type: application/json

{"repositoryId":"<repositoryId>","canonicalRoot":"/srv/repos/project"}
```

The central allowlist is policy metadata; the server never sends its stored
absolute path to the node as a command argument. Configure the same repository
ID in `DHOLE_NODE_REPOSITORIES` on the node. That local mapping is the execution
authority and is canonicalized with `realpath` for each command. Missing IDs,
traversal, symlink escapes, unsafe branch names, and worktree targets outside
the mapped root are rejected. Shared `NodeCommandSchema` accepts only the
explicit command union (runtime session, message, approval, worktree,
repository, health, and related operations). Arguments are arrays and
validated with Zod; there is no generic shell command or shell endpoint.

Runtime commands carry only an opaque `secretReference`. If a runtime needs a
credential, map that reference through `DHOLE_NODE_SECRETS`; the node resolves
it in memory and passes the value to the adapter without returning it in a
command result, descriptor, heartbeat, or journal entry. Protect the process
environment as secret material. Executable and OpenAI-compatible endpoint
overrides are node-local settings shown in the table above.

Node configuration rejects secret values shorter than four characters so exact
configured values can be safely redacted. Before a `runtime_event` or
`command_status` leaves the node, obvious credentials are masked: configured
secrets (four characters or longer), bearer tokens, common `sk`/`rk`/`pk` keys,
PEM private-key blocks, and sensitive field names such as `authorization`,
`apiKey`, `password`, and `cookie`. Fleet applies additional bounded
field/string/opaque-output redaction. This is defense in depth, not permission
to place secrets in prompts, commands, fixtures, or logs.

Live Codex, Claude Code, Kimi ACP, and OpenAI-compatible provider behavior is
implemented but remains fixture-only/unverified in this repository; enrollment
and node tests do not spend model quota or mutate a live provider.
