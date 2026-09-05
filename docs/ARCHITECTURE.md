# Architecture

Dhole has one central server and outbound connections from execution machines.

```text
Browser -> central server <- execution node
                       ^-- local agent MCP bridge
Runtime -> configured provider or CPA
```

The server owns authentication, object authorization, SQLite, selected modules,
session scheduling, normalized events, and the production web build. Nodes own runtime
processes, repository allowlists, and a durable local operation journal. The
local MCP bridge uses device-derived project access to call the central
server. Provider configuration and runtime configuration are separate.

## Runtime boundaries

| Boundary | Responsibility |
| --- | --- |
| `apps/server` | Hono HTTP API, WebSockets, migrations, domain modules, static web serving, MCP boundary |
| `apps/web` | Svelte application with no direct machine or provider connection |
| `apps/node` | Machine authorization, local MCP bridge, outbound daemon, runtime adapters, repository policy, operation journal |
| `packages/shared` | Versioned Zod schemas and wire types shared across processes |

Production packages the server and web in one Dhole container with optional
Pangolin Newt through `compose.yaml`. SQLite remains the only database. CPA is
an existing external inference service; execution nodes run on their hosts.
Local development and verification use fixtures. Preparing deployment files
does not authorize starting a deployment or connecting a machine.

## Static modules

Core and Access always start. Core owns shared sessions, agent activity, the
master dashboard, runtime/provider configuration, and machine transport.
Coordination, Gateway, and MCP are the only optional compiled modules.
`DHOLE_MODULES` accepts `all`, `none`, or comma-separated IDs. An explicit set
must satisfy declared dependencies. The registry rejects unknown or duplicate
IDs, missing dependencies, and cycles before registering routes or services.

Modules may depend on declared modules and use their public services. Core
must start with every optional module disabled. Disabled modules contribute no
HTTP routes, navigation, WebSocket handlers, or lifecycle jobs. Global
checksum-protected migrations still run, preserving data and immutable
history for later re-enablement. `GET /api/modules` returns the authenticated
client's enabled module list and safe static contributions.

The module host starts enabled lifecycle hooks in dependency order. It runs
bounded maintenance work and closes hooks in reverse order. Core owns both
`/ws/node` and `/ws/app`, including their session and machine maintenance.
Machine administration uses `/api/machines` and its typed child routes.
The legacy `/api/fleet/*` paths and `fleet:admin` scope remain wire
compatibility names for Core machine operations. Fleet is a separate private
project, not a Dhole module. Static agent Skills live in `clients/skills` and
are installed into clients explicitly. See [Adding a module](ADDING_A_MODULE.md)
and [ADR 0003](adr/0003-core-and-product-focus.md).

## Identity and authority

Native Dhole accounts are the primary human identity. Optional GitHub linking
binds an immutable GitHub user ID; it does not itself grant repository access.
A signed-in human approves a short-lived machine code. The machine then holds
revocable authorization privately and obtains narrower project credentials for
its agents. Manual projects support local and non-GitHub work. The GitHub
repository path separately verifies write access before granting project scope.

Git remains authoritative for issues, branches, commits, pull requests,
accepted documentation, and project-stored skills. Dhole records references
and execution evidence. SQLite operational rows own current Dhole state. The
append-only event/outbox log owns ordered external notification history.

## Reconnection and delivery

App clients fetch an authorized snapshot and watermark, subscribe, replay
later rows, and then receive post-commit live events. Authentication remains
subject to expiry and revocation on open WebSockets.

Nodes authenticate again, report journal state and capabilities, and receive
incomplete commands. A repeated operation key is reconciled instead of
blindly spawning again. Ambiguous crash outcomes remain uncertain until
reconciled. Native runtime process handles are not durable session storage.

## Extension rule

Add compatible models through provider/model data. Add a runtime by
implementing the adapter contract and registering it statically. Add a module
only when it owns a distinct policy and user-facing responsibility. A new
table alone is not a module, and a module is not a reason to add a package or
persistent service.
