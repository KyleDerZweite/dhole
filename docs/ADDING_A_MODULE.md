# Adding a module

A Dhole module is trusted code compiled into the central server. It owns a
policy and a user-facing responsibility. Modules may declare dependencies on
other modules. Core and Access must start with every optional module disabled.
Read [Architecture](ARCHITECTURE.md), [ADR 0001](adr/0001-architecture-lock.md),
[ADR 0002](adr/0002-modules-and-deployment.md),
[ADR 0003](adr/0003-core-and-product-focus.md), [Access control](ACCESS_CONTROL.md),
[Event/state model](EVENT_AND_STATE_MODEL.md), and `AGENTS.md` first.

Keep domain modules in `apps/server/src/modules`. The package boundaries remain
server, web, node, and shared wire contracts. Adding a table or a helper does
not justify a new module or package. Production containers are the Dhole
server and optional Newt; a module does not add a service or runtime loader.

## Contract and selection

The contract lives in `apps/server/src/lib/module.ts`. A module declares its
`id`, optional `dependencies`, and optional static `contributions` for
navigation, WebSocket paths, and job names. `register(app, context)` registers
routes and services. The optional `start(context)` hook returns maintenance
and close callbacks for the module host.

The explicit `availableModules` registry in `apps/server/src/app.ts` owns the
compiled set. `DHOLE_MODULES=all` enables it, `none` leaves Core and Access,
and comma-separated IDs select an explicit set. Selection validates all IDs,
duplicates, missing dependencies, and cycles before registration. It orders
enabled modules by their dependencies and adds Core and Access automatically.
It does not silently add other omitted dependencies.

| Module | Declared dependencies |
| --- | --- |
| `core` | None |
| `access` | `core` |
| `coordination`, `gateway`, `mcp` | `core`, `access` |

For example, `DHOLE_MODULES=gateway` selects Gateway with Core and Access.
`DHOLE_MODULES=coordination,mcp` adds agent coordination and its protocol
boundary. Core sessions, runtime configuration, and machine transport are
available in either selection. Retired module IDs such as `fleet`, `sessions`,
and `runtime` are rejected rather than silently accepted.

Authenticated `GET /api/modules` exposes only enabled IDs, dependencies, and
safe static contributions. The browser uses that response to hide disabled
navigation and avoid requests to unavailable modules. MCP filters tools by
their owning module. Disabled API and WebSocket paths return 404 rather than
the web application's HTML fallback.

## Lifecycle and storage

`register` must not open a listener, start a timer, spawn a process, or create
another database. Use injected configuration, clock, ID source, database, and
event store from `ServerContext`. Keep authentication and authorization in the
server; the web application consumes the resulting capabilities.

The module host starts enabled `start` hooks in dependency order, calls bounded
maintenance callbacks, and closes them in reverse order. A disabled module
must create no workers or upstream traffic. Core owns `/ws/node`, `/ws/app`,
and the machine/session maintenance jobs. A job declaration names a contribution; the owning lifecycle
hook must implement the actual work.

Add numbered SQL migrations in `apps/server/migrations`. All checked-in
migrations run even when the module is disabled. Dhole records checksums and
refuses changed applied migrations. Disabling a module preserves its rows and
immutable history; it is not an uninstall operation.

Domain records and private SQL stay with their owner. Depend on another
module's narrow public service, not private storage helpers. Put schemas in
`packages/shared` only when a process boundary needs them. Keep event schema
versions and tolerant readers when extending contracts.

## Authorization and events

Validate every external boundary with Zod. Authorize the authenticated actor
against the team, project, run, session, or machine before using supplied IDs.
A request body never grants scope. Reuse the same service and checks for HTTP
and MCP so one transport cannot bypass the other's policy.

Credentials belong in the encrypted secret store or private machine state.
Return safe DTOs, never upstream configuration objects. Redact values and
credential-bearing object keys from errors, logs, events, fixtures, and
exports. Commands use the closed shared union and secret references. Do not
add generic shell commands or arbitrary upstream request forwarding.

Mutate current state and append its versioned event in one transaction.
Broadcast after commit. Preserve command idempotency, immutable history,
explicit provenance, and bounded payloads. Keep transient token deltas out of
the durable history.

## Verification and documentation

Test the module's meaningful failure boundaries with local fixtures: malformed
input, cross-object access, revocation, changed dependencies, transaction
failure, redaction, and retries where relevant. Test Core-only startup and the
module's smallest valid selected set. A hidden navigation item is not proof
that a worker or WebSocket handler stopped.

Describe the delivered routes and permissions in the owning guide. Record
intentional omissions only in [Roadmap](../ROADMAP.md), and link them from the
status record. Keep UI detail optional and avoid new top-level navigation
unless it serves a separate task. Run `pnpm verify` before completing a change;
local checks do not authorize live provider tests or deployment.
