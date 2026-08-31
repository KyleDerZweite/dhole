# Adding a Dhole module

Dhole is a TypeScript modular monolith. A module is a compile-time slice of
the central server that owns a distinct policy and a user-facing boundary. A
new table, a helper, or a second name for an existing route is not enough
reason to add one. First ask whether the behavior belongs in Access, Core,
Fleet, Sessions, Coordination, Gateway, Runtime, Orchestration, Memory, Skills,
Lab, or MCP. These are the complete MVP module boundaries; keep new behavior
in the existing owner unless it introduces a distinct policy and user-facing
surface.

The runtime boundaries are fixed:

- `apps/server`: Hono routes, services, migrations, events, and module registry.
- `apps/web`: browser UI and API client; it talks only to the server.
- `apps/node`: outbound daemon, runtime adapters, repository/workspace policy,
  and local idempotency journal.
- `packages/shared`: versioned Zod wire schemas and types shared across a
  process boundary.

Do not create a package for each domain concept. A module normally remains a
directory under `apps/server/src/modules`; a new package is justified only by
a real runtime or compatibility boundary. The MVP does not add containers,
microservices, a persistent sidecar, a generic shell endpoint, a workflow
engine, or runtime plugin loading.

## Before editing

Read `docs/ARCHITECTURE.md`, `docs/adr/0001-architecture-lock.md`,
`docs/EVENT_AND_STATE_MODEL.md`, `docs/ACCESS_CONTROL.md`, `docs/THREAT_MODEL.md`,
and this repository's `AGENTS.md`. Check existing routes, migrations, shared
schemas, and event kinds for overlap. Preserve the authority split: Git owns
issues/branches/commits/accepted documentation and project-stored skills;
SQLite owns current Dhole state; the append-only event/outbox log owns ordered
external notification history.

Write a short boundary note before implementation:

1. The policy and user-facing surface this module owns.
2. The tables, events, commands, and external references it owns.
3. The existing module that was considered and why it is insufficient.
4. The authorization actor and object scope for every route.
5. The fixture and verification path, including deliberate deferrals in
   `ROADMAP.md` rather than scattered TODO comments.

## The module contract and registry

The only server module contract is intentionally small:

```ts
export interface DholeModule {
  readonly id: string;
  register(app: DholeApp, context: ServerContext): void;
}

export interface ServerContext {
  config: AppConfig;
  database: DatabaseConnection;
  clock: Clock;
  ids: IdSource;
  events: EventStore;
}
```

`DholeApp` is the Hono app with typed request variables (`requestId`,
authenticated user, and credential). `register` wires routes and constructs
services; it must not start a listener, spawn a process, or open another
database. Use the injected clock and ID source so service tests are
deterministic. Use the shared event store for transitions that need an
event/outbox row in the same transaction.

The registry is an explicit array in `apps/server/src/app.ts`:

```ts
registerModules(app, context, [
  coreModule, accessModule, fleetModule, runtimeModule, sessionsModule,
  coordinationModule, gatewayModule, orchestrationModule, memoryModule,
  skillsModule, labModule, mcpModule,
]);
```

`registerModules` rejects duplicate IDs before the second module is registered.
Export one `DholeModule` (and, when useful, a `create…Module` factory) from
`apps/server/src/modules/<id>/index.ts`. Add it to the static list deliberately;
there is no discovery directory, dynamic import, marketplace, or runtime
plugin manifest.

## Storage and contract ownership

Server-only domain records belong to the module and `apps/server/migrations`.
For a schema change, add the next numbered migration (for example,
`005_<module>.sql`) with additive DDL, foreign keys, bounded text, and useful
indexes. Current migrations are `001_core.sql`, `002_fleet_sessions.sql`,
`003_coordination_gateway_orchestration.sql`, and
`004_memory_skills_lab.sql`, `005_integrity.sql`, and
`006_append_only_history.sql`. Never edit an applied migration: Dhole hashes SQL
and fails startup when a stored checksum changes. Keep deletes and updates
explicit; use immutable rows/triggers where the policy requires history.

Put a type in `packages/shared` only when browser/server/node or another
process boundary must agree on it. Shared contracts are versioned Zod schemas
and wire types (`events`, `node`, `runtime`, `sessions`, `coordination`, `mcp`,
and IDs); they are not a place for server SQL rows or private service helpers.
Validate every external boundary with Zod, including JSON bodies, WebSocket
frames, MCP requests, provider records, runtime descriptors, fixture payloads,
and imported history. Breaking event payloads require a new schema version;
new optional fields must have tolerant readers.

Do not import another module's private storage helper. Depend on a narrow public
service type, a shared schema, or a server infrastructure utility. If two
modules need a new policy, make the policy explicit and assign one owner
instead of creating a convenience “common” module.

## Routes, authorization, events, and redaction

Every route should have a clear path prefix owned by the module and a matching
Zod input schema. Enforce authentication and object-level authorization before
using path/query/body IDs; arguments never grant project, run, session, machine,
or token scope. Use Core's authenticated user/administrator middleware and the
access module's scoped MCP/API credentials where appropriate. Return a safe
404/403 shape that does not reveal another team's object.

Treat credentials as references, never as command or response data. Redact
secret/token/password/API-key/private-key fields before writing fixtures,
events, audit details, logs, or browser responses. Provider secrets belong in
the encrypted secret store. Nodes receive closed, structured command unions,
not arbitrary shell text. Browser code must never connect directly to a node or
provider.

For an externally visible state transition, mutate the operational row and
append a versioned event through `EventStore` in one SQLite transaction. Include
aggregate/parent IDs, actor, provenance (`platform`, `provider`, `hook`,
`heuristic`, or `import`), idempotency where a retry is possible, and a
redacted, bounded payload. Broadcast only after commit. Do not turn noisy token
deltas or repeated progress into an unbounded durable stream; upsert current
progress and retain important changes.

## Tests and UI hand-off

Keep tests beside the module. At minimum add:

- Service tests with an in-memory database, fixed clock/IDs, authorization
  failures, boundary-size and malformed Zod inputs, transaction/conflict paths,
  and redaction assertions.
- Route tests for unauthenticated and cross-object access, response shape,
  status codes, CSRF/origin behavior where state changes, and event/audit
  effects.
- Migration smoke coverage proving a fresh database and an existing database
  both migrate, with checksums unchanged.
- Reconnect/idempotency or fixture tests when the module emits events, sends
  node commands, imports provider data, or participates in MCP.

Use local deterministic fixtures. Never consume live model quota or change a
running service to test a module. If a module exposes an MCP tool, route it
through the same service and authorization boundary as HTTP; do not create a
second implementation.

If the module is visible in the product, add the smallest web change needed:
typed API calls in `apps/web/src/lib/api.ts`, response types in
`apps/web/src/lib/types.ts`, a route/area in `App.svelte`, and accessible,
progressively disclosed detail. Keep dense monitoring readable on mobile and
keyboard navigable. Document the route, permission, provenance, and fixture in
the module doc and update the relevant architecture/threat/acceptance notes.
The UI is a client of the server, not a second policy implementation.

## YAGNI checks

Before adding code, try the existing boundary:

- A new model or endpoint is usually provider/model data plus an existing
  adapter, not a new module.
- A new runtime implements the locked adapter contract and is registered
  statically; it does not add a runtime loader.
- A new memory scope, skill lifecycle state, benchmark dimension, or event
  payload is an additive contract change, not a new package.
- A new table without distinct authorization, policy, and UI ownership stays in
  its current module.

Reject abstractions that only save a few call sites, speculative extension
points, generic repositories/ORMs, and “temporary” side services. Record a
real future boundary in `ROADMAP.md` if it is intentionally deferred.

## Delivery checklist

```text
[ ] Boundary note names the policy, actor, objects, and owning module.
[ ] Architecture/ADR/event/access/threat docs and AGENTS.md were read.
[ ] Module exports DholeModule and is added once to apps/server/src/app.ts.
[ ] Routes parse Zod input and enforce object authorization.
[ ] Credentials are encrypted/referenced and redacted from output/evidence.
[ ] Migrations are additive, numbered, foreign-keyed, and checksum-safe.
[ ] State transitions and events share one transaction; idempotency is explicit.
[ ] Service, route, migration, and fixture tests cover failure paths.
[ ] Web API/UI and module docs are updated when user-facing.
[ ] pnpm format:check and pnpm verify pass.
```

Run the focused package checks while iterating, then the full workspace gate:

```sh
pnpm --filter @dhole-control/server test:run
pnpm format:check
pnpm verify
```
