# Dhole contributor instructions

Dhole is a TypeScript modular monolith. Keep the browser connected only to the central server; execution nodes connect outward to that server.

- Read the root architecture and ADR documents before changing shared contracts.
- Keep packages limited to real runtime boundaries: server, web, node, and shared wire contracts.
- Do not add containers, a generic shell endpoint, runtime plugin loading, or another persistent service.
- Validate every external boundary with Zod. Treat provider, runtime, model, executor, skill, memory, and orchestration profile as distinct concepts.
- Preserve event schema versions, command idempotency, authorization checks, redaction, and immutable history.
- Never place provider, node, or management credentials in browser responses, logs, events, fixtures, or command bodies.
- Use local fixtures for provider verification. Do not consume live model quota or change running services.
- Track deliberate deferrals in ROADMAP.md, not scattered TODO comments.
- Run pnpm verify before completing a change.

This checkout is not configured for live Mediation. Do not initialize it unless the user explicitly asks.
