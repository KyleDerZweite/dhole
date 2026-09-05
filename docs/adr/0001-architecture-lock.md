# ADR 0001: MVP architecture lock

Status: accepted on 2026-08-30. Product scope and orchestration are superseded by [ADR 0003](0003-core-and-product-focus.md); the remaining runtime, event, and security decisions still apply.

## Decision

Dhole is one pnpm workspace with four boundaries: a Hono central server, a Svelte web client, an outbound node daemon, and shared versioned wire schemas. The server is a modular monolith and the only browser endpoint. SQLite in WAL mode is the only database. Nodes maintain outbound authenticated WebSockets.

Node.js 24 LTS is required. The minimum is 24.15 because that is the first release in which the bundled SQLite API reached release-candidate stability; the application nevertheless uses better-sqlite3 13.0.3 because the brief requires a stable driver. This accepts a documented native-build fallback risk and avoids treating release-candidate node:sqlite as stable. Vite 7.1.12 with `@sveltejs/vite-plugin-svelte` 6.2.1 avoids Vite 8's mandatory MPL-licensed CSS dependency.

No ORM, router, chart package, Markdown renderer, workflow engine, cache service, or runtime plugin loader is introduced. Compile-time registration and direct SQL are sufficient.

## State and events

Operational tables are authoritative for current state. Every externally visible transition appends a versioned event in the same transaction. The event row is also the outbox: it is broadcast only after commit and remains queryable by project sequence. This is not full event sourcing; projections are not rebuilt from events.

Reconnect uses snapshot, watermark, catch-up, then live delivery. Provider token deltas are transient. Completed messages, tool calls, approvals, important progress, and state transitions are durable.

## Protocols

- App WebSocket: Dhole protocol v1, cookie-authenticated, object-authorized subscriptions, bounded frames, project sequence catch-up.
- Node WebSocket: Dhole node protocol v1, replaceable device bearer credential, durable command journal, at-least-once delivery and idempotent execution.
- MCP: specification 2026-07-28 over stateless Streamable HTTP at /mcp, plus the prior Mediation tool names and HTTP compatibility routes.
- Codex: Codex app-server newline-delimited JSON-RPC over stdio.
- Claude Code: installed Claude Code CLI streaming JSON input/output; no bundled proprietary Agent SDK. Queue-next and interrupt are exposed, active steering is not.
- Kimi Code: ACP v1 over newline-delimited stdio. Active steering and native child observation are not advertised where ACP lacks them.
- Generic API runtime: OpenAI-compatible Chat Completions with a bounded controlled tool loop and AbortSignal cancellation.

Missing executables or credentials produce an unavailable capability state. Fixture adapters never masquerade as live adapters.

## Durability and historical scheduling

Node delivery is at least once. Before a spawn, the node atomically writes an operation journal entry with mode 0600. A repeated accepted/running/completed operation key never spawns again; an ambiguous crash is reported as uncertain for reconciliation.

The following orchestration decision describes the original scope, retired by ADR 0003. Orchestration was explicit and durable. A database state machine owns leases, claims, placement, concurrency, depth, children, retries, pause, resume, cancel, and restart recovery. A director can request bounded actions but cannot schedule processes or bypass claims directly.

## Security

Production requires HTTPS/WSS at the trusted reverse proxy, strict host/origin configuration, secure cookies, object-level authorization, bounded payloads, and redacted logging. Passwords use parameterized scrypt. Enrollment and API tokens are random, hashed, expiring, scoped, revocable, and rate limited. Secrets use AES-256-GCM envelopes with external versioned keys, random nonces, and record-bound associated data. Commands contain secret references, never provider secrets.

Repository and worktree operations canonicalize allowed real paths for every operation and use argument-array process execution. The central server exposes no generic shell.

## Rejected alternatives

Microservices, external queues, PostgreSQL, Redis, runtime plugins, a browser-to-node path, screen scraping, arbitrary remote commands, node:sqlite before stable status, Vite 8 for this MVP, and embedding/vector search all add cost without satisfying an acceptance criterion.
