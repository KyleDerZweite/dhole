# MCP boundary

`mcpModule` exposes MCP 2026-07-28 stateless Streamable HTTP JSON-RPC at
`POST /mcp`. It uses the shared `McpRequestSchema`/`McpScopeSchema` and the
public Coordination service. No MCP SDK or separate runtime service is required.

Every request requires an allowed `Origin`, `Accept: application/json`,
`Content-Type: application/json`, a project-scoped hashed Bearer API token, and
is bounded to 512 KiB. The token's stored scope selects project/run authority;
request arguments cannot widen it. Responses are JSON (SSE and resumable
sessions are intentionally not implemented in this stateless boundary).

The catalog and dispatcher honor enabled modules and current permissions.
Coordination and the legacy Mediation aliases belong to Coordination.
`project_state` reads Core sessions and runs even when optional modules are
disabled. Its claims list is empty when Coordination is disabled. The retired
child, memory, skill-proposal and benchmark tools are absent from the catalog
and dispatcher.

The local bridge in `apps/node` exposes agent work tools plus `gateway_manage`
when the machine has Gateway permission. Gateway actions use its fixed local
schema and private credential files. Maintained agent instructions live in
[`clients/skills`](../../../../../clients/skills); they are installed files,
not a selectable server module.

`coordination_claim` creates claims and patches active scope, status, blockers,
and findings. `coordination_complete` appends commit/PR evidence and settles
work. `coordination_release` and `coordination_revive` preserve terminal
history. `coordination_check` and `coordination_state` use the same overlap,
ownership, redaction, and recovery policy as HTTP. A checkout can contain
several agents, so matching worktree hashes do not suppress peer overlap.

Protocol clients register with `coordination_session_register`, retain its
one-time capability, and supply it in `x-mediation-session` on subsequent
session and claim calls. Session capabilities are rejected in tool arguments
and never appear in state, heartbeat, or end results. The local agent bridge
handles registration over HTTP and retains its capability outside model
context. The heartbeat, repository report, session end, and idempotent agent
event tools support native protocol clients. Lifecycle `runId` is a native
correlation identity, separate from an API token's Dhole run restriction.

Every request checks the native user's current project permission. Viewer
access allows only read scopes, including when a token was issued earlier
with write scopes; inaccessible projects reject the token. The catalog also
omits tools outside those effective scopes. Derived project tokens remain
valid only while their parent device authorization and native user remain
active. Linking or unlinking GitHub does not control ordinary project access.

The compatibility exports document the only legacy surface:
`MCP_LEGACY_COMPATIBILITY` enables `initialize`, direct calls for listed tool
names, and the five `mediation_*` guidance/alias tools. No generic shell or
arbitrary RPC endpoint exists.
