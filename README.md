# Dhole

**Coordinated agent work.**

Dhole is a self-hosted control plane for shared human/agent sessions, outbound
execution nodes, coordination claims, provider observability, orchestration,
skills, memory, and a small Improvement Lab. It is a TypeScript modular
monolith: one central server, one Svelte dashboard, one outbound node daemon
per execution machine, and shared versioned wire contracts. The browser talks
only to the server; nodes connect outward to it.

## Requirements

- Node.js **24.15 through 24.x** (`>=24.15 <25`)
- pnpm **10.x** (`>=10 <11`); the lockfile was generated with pnpm **10.29.2**
- Git for repository/worktree features

The server uses SQLite through `better-sqlite3`; platforms that need a native
build must have the usual C/C++ toolchain available. No container runtime is
needed or used.

## Install and run locally

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

`pnpm dev` builds all workspaces and starts the production-shaped server from
`apps/server/dist`. Open <http://127.0.0.1:4173>. On a fresh database, use the
**First run? Create the administrator** link, or bootstrap through the API:

```sh
curl -i -X POST http://127.0.0.1:4173/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.test","displayName":"Administrator","password":"change-this-password","teamName":"Dhole"}'
```

The bootstrap password must be at least 12 characters. After login, an
administrator can create members at `POST /api/admin/users`, link projects and
repositories, and enroll nodes. See [Node enrollment](docs/NODE_ENROLLMENT.md)
for the node flow.

Useful workspace commands:

```sh
pnpm format:check       # whitespace/format guard used in CI
pnpm lint               # all workspace TypeScript checks
pnpm typecheck          # all workspace type checks
pnpm test:run           # deterministic unit/function tests
pnpm build              # web, server, node, and shared production builds
pnpm verify             # all checks, production build, and runtime/session smoke checks
```

## Offline demo

The demo is local and fixture-backed. It builds the workspace, starts one
server with `DHOLE_DEMO=true`, enrolls a temporary node, and starts the node
over an outbound WebSocket:

```sh
pnpm demo
```

The command prints the demo URL and credentials:

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@demo.dhole.local` | `DholeDemoAdmin!2026` |
| Member | `member@demo.dhole.local` | `DholeDemoMember!2026` |

Demo data is deterministic and idempotent. It includes a fake runtime, a
two-person session, controlled/observed/heuristic lineage, a pending approval,
coordination conflict, CLIProxy-compatible request records, benchmark results,
and memory generations. Demo mode is rejected in production and never makes
live provider calls. Stop it with Ctrl-C.

## Configuration and security

Use `.env.example` as a reference and export the values (the server does not
load a `.env` file by itself). The most important server settings are:

- `NODE_ENV=development|test|production`
- `DHOLE_HOST`, `DHOLE_PORT`, `DHOLE_DATABASE`
- `DHOLE_PUBLIC_ORIGIN` and `DHOLE_ALLOWED_HOSTS` (the browser origin and Host
  header allowlist)
- `DHOLE_SOURCE_URL` (required in production; the public, version-matched
  corresponding-source URL used by the AGPL source link)
- `DHOLE_GATEWAY_ALLOWED_HOSTS` (administrator-configured Gateway destinations)
- `DHOLE_MASTER_KEY_ID` and `DHOLE_MASTER_KEYS` (required in production; a JSON
  object of base64-encoded 32-byte AES-GCM keys)
- `DHOLE_DEMO` (development/test only; keep false in production)

Provider secrets are encrypted at rest and never returned to the browser or
placed in commands. Passwords, sessions, enrollment credentials, and scoped
MCP tokens are hashed or opaque. Commands are a closed Zod-validated union;
there is no generic shell endpoint. Read [Threat model](docs/THREAT_MODEL.md)
and [Architecture](docs/ARCHITECTURE.md) before exposing the service.

## Production shape

Build and run the single server process (the server serves `apps/web/dist`):

```sh
pnpm install --frozen-lockfile
NODE_ENV=production pnpm build
NODE_ENV=production pnpm --filter @dhole-control/server start
```

Put a trusted reverse proxy in front of it for HTTPS. Preserve the configured
`Host`/origin, forward WebSocket upgrades for `/ws/app` and `/ws/node`, and set
`DHOLE_PUBLIC_ORIGIN=https://your-host` plus a matching
`DHOLE_ALLOWED_HOSTS`. The dashboard selects `wss://` automatically on an
HTTPS page. Nodes use `wss://your-host/ws/node`; they are never exposed as a
browser-facing service. Production key, backup, migration, proxy, and shutdown
guidance is in [Development and production](docs/DEVELOPMENT_AND_PRODUCTION.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) and [event/state model](docs/EVENT_AND_STATE_MODEL.md)
- [Node enrollment and operation](docs/NODE_ENROLLMENT.md)
- [Development and production operations](docs/DEVELOPMENT_AND_PRODUCTION.md)
- [Acceptance traceability](docs/ACCEPTANCE_TRACEABILITY.md)
- [Runtime adapters](docs/RUNTIME_ADAPTERS.md), [adding a model](docs/ADDING_A_MODEL.md), and [adding a runtime](docs/ADDING_A_RUNTIME.md)
- [Mediation integration](docs/MEDIATION_INTEGRATION.md) and [Gateway/CPAMP replacement](docs/GATEWAY_AND_CPAMP_REPLACEMENT.md)
- [Skills and memory](docs/SKILLS_AND_MEMORY.md), [Improvement Lab](docs/IMPROVEMENT_LAB.md), and [adding a module](docs/ADDING_A_MODULE.md)
- [Access control](docs/ACCESS_CONTROL.md), [threat model](docs/THREAT_MODEL.md), and [MCP boundary](apps/server/src/modules/mcp/README.md)
- [Prior art and donor record](docs/PRIOR_ART_AND_DONORS.md), [name-collision scan](docs/NAME_COLLISION_SCAN.md), and [third-party notices](THIRD_PARTY_NOTICES.md)

## External-live testing caveat

The checked-in verification uses local fakes and fixtures only. Runtime
adapters for Codex App Server, Claude Code, Kimi ACP, and OpenAI-compatible
HTTP are implemented; the installed-CLI adapters report unavailable
capabilities when their executables are absent, while the HTTP adapter still
needs an operator-configured endpoint and credential for live use. This
checkout does not validate a live provider, CLIProxyAPI deployment, external
node, hardware, or production reverse proxy.
Run any live test separately with operator-approved credentials and quota; do
not put those credentials in logs, fixtures, browser responses, events, or
commands.
