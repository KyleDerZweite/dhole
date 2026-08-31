# Threat model

Reviewed for the MVP architecture on 2026-08-31. This model covers the central server, browser, node daemon, local runtime subprocesses, SQLite, Git workspaces, Gateway connector, and MCP boundary.

## Assets

- User credentials, session cookies, CSRF tokens, device credentials, enrollment tokens, API tokens, provider and CLIProxy management secrets.
- Private session transcripts, tool results, approvals, repository paths and diffs, memory, skills, benchmark fixtures, audit history, and provider usage.
- Integrity of commands, claims, agent lineage, scheduler placement, worktrees, pricing, promotions, and event ordering.

## Trust boundaries

The browser is untrusted and communicates only with the central server. A node is a separately authenticated device and may be compromised. Runtime and provider output is untrusted. Configured provider/Gateway endpoints are remote network boundaries. Repositories and logs contain untrusted text and symlinks. MCP clients receive only token-scoped project/run capabilities. The reverse proxy terminates production TLS and must preserve the configured host and scheme.

## Threats and controls

| Threat | Primary controls | Verification |
| --- | --- | --- |
| Credential theft or fixation | Parameterized scrypt; opaque hashed sessions; rotation/revocation/expiry; HttpOnly Secure SameSite=Strict cookies; login rate limit | Password/session tests |
| Browser request forgery | Strict Origin/Host checks; session-bound CSRF header; SameSite cookie; no state-changing GET | CSRF/origin route tests |
| IDOR or transcript disclosure | Deny-by-default role, project, participant, run and scope checks at every HTTP/WS/MCP object | Cross-user/project tests |
| WebSocket hijack or replay gap | Upgrade authentication, exact Origin, per-subscription authorization, bounded frame/queue, snapshot watermark catch-up | Unauthorized/reconnect/slow-client tests |
| Node impersonation | One-use expiring enrollment; random hashed replaceable device credentials; heartbeat/revocation | Enrollment/reconnect tests |
| Duplicate command side effects | Stable operation key; server receipt; node journal fsync before spawn; uncertain reconciliation | Duplicate/crash-window tests |
| Secret disclosure | AES-256-GCM with external versioned 32-byte keys, random nonce and record AAD; opaque secret references in commands; redaction before persistence/logging | Crypto/redaction/browser-shape tests |
| Arbitrary execution | Closed command union; no server shell; safe argument arrays; runtime and repo capability checks | Contract rejection tests |
| Repository escape or worktree attack | Allowlisted canonical realpaths on every operation; traversal/symlink rejection; one writer; bounded Git args | Temporary repo/path tests |
| Malicious provider/runtime output | Bounded protocol and normalized-frame validation, size/time/tool-round limits, plain-text UI, no raw HTML, redacted unknown events | Adapter/UI tests |
| SSRF through Gateway | Administrator-only config, http/https URL parsing, explicit allowed hosts, no browser proxy or CLIProxy /api-call, bounded fetch and redirects | URL rejection tests |
| Usage import poisoning | Size/page limits, event hashes, schema validation, redaction before storage, exact/approximate correlation labels | Fixture/fuzzed-record tests |
| Orchestration bypass or resource exhaustion | Explicit action, scoped director tools, atomic claim-before-spawn, durable leases, depth/child/concurrency/retry/budget limits | Scheduler tests |
| Memory/skill prompt injection | Source provenance, human approval, immutable generations, active-only explicit injection, size delimiters, bounded references/no traversal | Memory/skill tests |
| Automatic unsafe promotion | Append-only benchmark evidence and human decision; no automatic skill/model promotion | Lab tests |
| Database or local state theft | Mode 0600 database/node files, external master key, no raw provider credentials, minimized private fields | Startup/file-mode tests |

## Security profile

Production fails to start without a current key ID present in DHOLE_MASTER_KEYS. HTTPS/WSS is mandatory outside loopback development. Allowed hosts, public origin, Gateway hosts, retention, and repository roots are explicit configuration. HTTP JSON bodies default to a 512 KiB cap unless a route sets a narrower limit; the authenticated node WebSocket protocol permits at most 1 MiB frames, while app WebSocket frames are limited to 256 KiB. Logs contain method, path template, status, request ID, and redacted summaries only—not bodies, cookies, headers, environment, tool arguments, or private paths.

Known demo passwords are seeded only when DHOLE_DEMO is enabled outside production. Demo mode never enables live provider calls.

### Operator-only credential bootstrap exception

The node enrollment capability is intentionally a one-time bootstrap channel:
the administrator's enrollment-token issuance response contains a one-use
enrollment token,
`POST /api/fleet/enrollment/consume` returns a replaceable device credential
only to the caller that presents the unexpired, single-use enrollment token.
Credential rotation likewise returns the replacement only to an administrator
API-token request carrying `fleet:admin`; cookie-authenticated dashboard calls
are rejected. The administrator token-creation endpoint also returns a newly
created bearer token once so an operator can provision a non-browser client.
These responses are for an operator or provisioning tool, not the web
dashboard, and must be transferred over the operator's secure channel and
never copied into browser-visible logs, events, fixtures, or tickets. All
normal browser responses continue to omit node, provider, and management
credentials.

## Residual risk and hardening

The single-process in-memory rate limiter does not coordinate across replicas; the MVP has one server by design. An administrator can deliberately configure a permitted local Gateway endpoint, so operator trust remains material. A compromised node can read repositories and local credentials already granted to that node; server scoping cannot repair host compromise. better-sqlite3 may require a native build on an unsupported platform. Full key rotation tooling, external audit export, hardware-backed secrets, and proxy-aware client-IP enforcement are post-MVP hardening items.
