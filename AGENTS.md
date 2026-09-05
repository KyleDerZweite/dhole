# Dhole contributor instructions

Dhole is a TypeScript modular monolith. Keep the browser connected only to the central server; execution nodes connect outward to that server.

- Read the root architecture and ADR documents before changing shared contracts.
- Keep packages limited to real runtime boundaries: server, web, node, and shared wire contracts.
- Production packaging uses one Dhole container and Pangolin Newt through `compose.yaml`; execution nodes run on their hosts. Keep local development fixture-backed. Do not add a generic shell endpoint, runtime plugin loading, or another persistent service.
- Validate every external boundary with Zod. Treat provider, runtime, model, machine, executor, session, and static agent skill as distinct concepts.
- Preserve event schema versions, command idempotency, authorization checks, redaction, and immutable history.
- Never place provider, node, or management credentials in browser responses, logs, events, fixtures, or command bodies.
- Use local fixtures for provider verification. Do not consume live model quota or change running services.
- Track deliberate deferrals in ROADMAP.md, not scattered TODO comments.
- Run pnpm verify before completing a change.

This checkout is not configured for live Mediation. Do not initialize it unless the user explicitly asks.

Core owns sessions, runtime/provider configuration, agent activity, and machine transport. Coordination, Gateway, and MCP are optional; modules may depend on declared modules. Read `docs/adr/0002-modules-and-deployment.md` and `docs/adr/0003-core-and-product-focus.md` before changing module selection, product scope, authentication, or deployment packaging. Preparing and verifying deployment files does not authorize deploying services or enrolling a real machine.
