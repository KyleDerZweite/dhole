# Focused Core regression review

Reviewed on 2026-09-05 against ADR 0003. This pass covers product retirement, Core execution, and authorization after the module moves.

Two command-delivery regressions were reproduced and fixed in `apps/server/src/modules/core/machines/index.ts`:

- One hundred historical accepted orchestration commands filled the pending batch and prevented newer Core commands from being delivered. The query now excludes dispatched retired commands from that batch. Their recorded states remain unchanged.
- A node reconnect could report a completed or failed orchestration operation while its server row was still queued. Retirement cancelled that row before the full result could be replayed. The journal summary now keeps it uncertain until the node supplies its full terminal status. Maintenance neither cancels nor redelivers it.

All three regression cases failed before their fixes. The final focused command, `pnpm --filter @dhole-control/server exec vitest run src/modules/core/machines/machines.test.ts`, passed all 33 tests. Existing cases also cover queued retirement, preservation of dispatched and uncertain outcomes, operation-key identity, team authorization, credential replacement, and audit rollback.

Source inspection confirmed:

- The module registry contains Core, Access, Coordination, Gateway, and MCP. Core execution routes register immediately after Access middleware, including when optional selection is empty. Core owns machine and session maintenance plus both WebSocket endpoints.
- Canonical Machines routes and Fleet compatibility aliases share handlers and authorization checks. Credential replacement checks the same team and bearer scope for either path.
- The overview loads project-authorized sessions and runtime registrations. It does not call the administrator-only runtime configuration endpoints. Machines and Gateway summaries retain team filtering, and the overview skips Gateway requests when that module is disabled.
- Active source has no imports from the deleted module directories, no retired MCP tool registrations, and no retired module jobs. Historical orchestration operation keys in the former implementation use the `orchestration:` prefix handled by retirement.

The previous review's broader tests were not repeated. Root verification owns the final `pnpm verify` run. No live service, provider, enrollment, or deployment was used. The stale static-module text in `docs/ARCHITECTURE.md` was reported to the documentation owner separately.
