# Dhole

## Public archive

Dhole is discontinued. This repository is a public archive for reference
and is no longer maintained. No further releases, bug fixes, or security
updates are planned, and issues and pull requests are no longer accepted.

I am replacing Dhole with another self-hosted solution. The documentation
below describes the final archived code and remains available for anyone
who wants to inspect or fork it.

Dhole is a self-hosted server for shared agent work and CPA administration.
Sign in, authorize a machine, and let its agents use scoped project access.
Core includes the master overview, conversations, agent activity, runtimes,
provider configuration, and machine execution. Access manages users and
approved machines. Optional Coordination and Gateway add work claims and
CPA catalog, account, and request-history management. Dhole MCP connects
authorized agents to work tools; maintained Dhole Skills guide those clients.

The browser connects only to Dhole. Execution nodes connect outward to the
server and run on their hosts. CPA remains the inference service. Dhole is a
TypeScript modular monolith with four runtime boundaries: server, web, node,
and shared wire contracts.

## Try it locally

Use Node.js `>=24.15 <25`, pnpm 10.x, and Git. The lockfile uses pnpm 10.29.2.
`better-sqlite3` may require a C/C++ toolchain on platforms without a prebuilt
binary.

```sh
pnpm install --frozen-lockfile
pnpm demo
```

The demo builds the workspace and starts a local server and fake execution
node at [http://127.0.0.1:4173](http://127.0.0.1:4173). Its data includes shared
sessions, approvals, agent activity, claims, and request history.
It uses fixtures and does not call a live model. Stop it with Ctrl-C.

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@demo.dhole.local` | `DholeDemoAdmin!2026` |
| Member | `member@demo.dhole.local` | `DholeDemoMember!2026` |

Use a separate demo database and port when another local server exists. Do
not load production credentials into a preview shell. See
[Development and production](docs/DEVELOPMENT_AND_PRODUCTION.md) for isolation
and the empty-database development flow.

## Prepare a release

[Deployment](docs/DEPLOYMENT.md) describes the Podman `compose.yaml` package:
one Dhole container with its web build and persistent SQLite, plus optional
Pangolin Newt. Nodes stay on their execution hosts. The example environment
contains replacement markers for the public origin, encryption keys, native
bootstrap secret, and Newt. GitHub configuration is optional. These markers cannot start a production server.

Native Dhole sign-in is the primary account path. GitHub linking is optional
and separate from repository authorization. After signing in, the machine
command prints an approval code and saves the granted credentials privately
on that machine:

```sh
node apps/node/dist/index.js connect --server https://DHOLE_HOST
```

An approved agent can create a private native project with
`node apps/node/dist/index.js create-project --name 'Local project'` and use
its ID with `mcp --project PROJECT_ID`. Add `--gateway` during connection when
the machine should request administrator-approved CPA management. The helper
keeps credentials in private files and exposes typed actions.

These are operator-run examples, not requests to connect this checkout.
[Node enrollment](docs/NODE_ENROLLMENT.md) covers repository allowlists,
agent-only access, the outbound daemon, and reversible client configuration.
Preparing or verifying the release does not deploy services, initialize live
Mediation, or enroll a real machine.

## Select modules

`DHOLE_MODULES=all` enables the compiled module set. `DHOLE_MODULES=none` starts
Core and Access with every optional module disabled. Shared sessions, runtime
configuration, agent activity, and machine connections remain available. A comma-separated list
selects `coordination`, `gateway`, or `mcp` and must include their declared dependencies.
Disabled modules contribute no routes, navigation, WebSocket handlers, or
background work. Migrations and immutable history remain available.

Modules may depend on other modules. They are trusted code compiled with the
server, not separately deployed services or runtime plugins. See
[Architecture](docs/ARCHITECTURE.md) and
[Adding a module](docs/ADDING_A_MODULE.md).

## Verify

```sh
pnpm verify
```

This runs formatting, lint, type checks, deterministic tests, production
builds, client catalog tests, fixture runtime/session/onboarding smoke checks,
and deployment artifact checks. Tests do not consume live
model quota or modify existing services. The adapters for Codex, Claude Code,
Kimi ACP, and OpenAI-compatible HTTP still require the appropriate installed
runtime or endpoint for real use. Local fixture success is not a production
or live-provider acceptance result.

## Documentation

- [Current MVP status](docs/MVP_STATUS.md), [acceptance traceability](docs/ACCEPTANCE_TRACEABILITY.md), and [roadmap](ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md), [event/state model](docs/EVENT_AND_STATE_MODEL.md), and [access control](docs/ACCESS_CONTROL.md)
- [Deployment](docs/DEPLOYMENT.md), [development](docs/DEVELOPMENT_AND_PRODUCTION.md), and [node operation](docs/NODE_ENROLLMENT.md)
- [Mediation integration](docs/MEDIATION_INTEGRATION.md) and [Gateway administration](docs/GATEWAY_AND_CPAMP_REPLACEMENT.md)
- [Runtime adapters](docs/RUNTIME_ADAPTERS.md), [adding a runtime](docs/ADDING_A_RUNTIME.md), and [adding a model](docs/ADDING_A_MODEL.md)
- [Agent client setup](clients/README.md), [adding a module](docs/ADDING_A_MODULE.md), and [product scope decision](docs/adr/0003-core-and-product-focus.md)
- [Threat model](docs/THREAT_MODEL.md), [MCP boundary](apps/server/src/modules/mcp/README.md), and [third-party notices](THIRD_PARTY_NOTICES.md)
- [Dashboard research](docs/reviews/dashboard-design.md), [brand comparison](docs/reviews/brand-board.html), and [name critique](docs/reviews/brand-critique.md)
- [Issue #2 review](docs/reviews/issue-2.md) and [prior art](docs/PRIOR_ART_AND_DONORS.md)
