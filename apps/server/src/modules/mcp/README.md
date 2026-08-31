# MCP boundary

`mcpModule` exposes MCP 2026-07-28 stateless Streamable HTTP JSON-RPC at
`POST /mcp`. It depends only on the public `ServerContext` (`database`,
`clock`, `ids`, `events`, and `config`) and the locked shared
`McpRequestSchema`/`McpScopeSchema`; no MCP SDK or runtime service is required.

Every request requires an allowed `Origin`, `Accept: application/json`,
`Content-Type: application/json`, a project-scoped hashed Bearer API token, and
is bounded to 512 KiB. The token's stored scope selects project/run authority;
request arguments cannot widen it. Responses are JSON (SSE and resumable
sessions are intentionally not implemented in this stateless boundary).

The compatibility exports document the only legacy surface:
`MCP_LEGACY_COMPATIBILITY` enables `initialize`, direct calls for listed tool
names, and the five `mediation_*` guidance/alias tools. No generic shell or
arbitrary RPC endpoint exists. `child_wait` returns an immediate snapshot,
while benchmark invocation runs a bounded fixture-compatible comparison
through the Lab module.
