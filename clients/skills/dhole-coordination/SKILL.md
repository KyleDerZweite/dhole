---
name: dhole-coordination
description: Coordinate shared repository work through Dhole. Use before editing a shared checkout, when another agent's claim overlaps your work, when recovering unfinished work, or when reporting completion.
---

# Dhole coordination

Use the installed Dhole MCP work tools. The local bridge selects the authorized
project, registers a session, and renews it. Keep that transport's credentials
and session proof out of tool arguments and output.

1. Call `coordination_check` with the repository-relative `files` or `components`
   you expect to change. Read matching claims and warnings before editing.
2. Call `coordination_claim` with a concrete `intent`, the known scope, and
   `status: "in-progress"`. Retain its returned claim ID. An advisory overlap
   calls for inspecting the other claim and choosing a disjoint scope or
   coordinating with its owner. An enforced rejection means the claim was not
   acquired; do not report ownership or edit the protected scope.
3. Patch the same claim with `coordination_claim` and `claimId` when its files,
   status, blocker, or findings change. Use `finding`, `findingKind` and
   `findingFiles` for evidence another agent needs. A new scope needs another
   overlap check.
4. After the requested change and its checks finish, call
   `coordination_complete` with `claimId`, a short `summary`, and actual `commits`
   or `prs` when they exist. Use `status: "abandoned"` for work deliberately
   stopped. Completion is done when the result confirms the recorded state.

Use `coordination_state` to inspect active and terminal claims. To resume a
released or expired claim, call `coordination_revive` with its `claimId` and
read the returned replacement ID. `coordination_release` gives up an active
claim. Terminal records remain history.

For lifecycle reporting, `coordination_agent_event` accepts an idempotent
`eventId`, the harness's actual `runId` and `agentId`, `harness`, `state`, and
`occurredAt`. Reuse the event ID only when retrying the same event. These IDs
report a running agent; they do not create or schedule one.

A missing tool, offline response, or rejected claim is not successful
coordination. Report the limitation once and continue independent work that
does not depend on ownership. Read `clients/README.md` in the Dhole checkout
when the user asks to connect or install Dhole. Installation alone does not
authorize pairing a
machine or starting an execution daemon.

<!-- DHOLE MANAGED SKILL: dhole-coordination -->
