# MVP delivery record

The initial implementation established shared contracts, SQLite migrations,
authentication, fixture sessions and nodes, coordination, Gateway request
history, runtime adapters, orchestration, memory, skills, and Lab comparisons.
The historical acceptance matrix is in
[Acceptance traceability](ACCEPTANCE_TRACEABILITY.md).

The 2026-09-05 release work adds selectable modules, optional GitHub identity,
machine authorization and a local agent bridge, stronger coordination
lifecycle behavior, optional CPA catalog and administration, and Podman/Newt
packaging. ADR 0003 then narrows the active product to Core and Access with
optional Coordination, Gateway, and MCP. Core owns the master overview,
sessions, runtime/provider configuration, agent activity, and machine transport.
Memory, Lab, orchestration, and server Skills are removed; client Skills remain
in `clients/skills`. Fleet is a separate private project. [MVP status](MVP_STATUS.md) records the delivered behavior against
the issue #2 implementation items. [Roadmap](../ROADMAP.md) is the sole ledger
for deliberate deferrals.

Release work finishes when `pnpm verify` passes, deployment artifacts pass
their local checks, and documentation distinguishes fixtures from external
acceptance. Those checks do not authorize deployment, provider calls, machine
enrollment, or initialization of live Mediation.
