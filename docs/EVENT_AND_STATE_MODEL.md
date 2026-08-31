# Event and state model

## Authority

SQLite operational rows are the source of current Dhole state. A realtime or replay-visible transition and its normalized event are committed in the same transaction. Setup/configuration mutations without a normalized event kind—such as project, repository, memory-pack, skill, and benchmark-definition changes—commit an immutable `audit_records` row instead. The append-only event log is the ordered source for replay to clients, adapter evidence, and integrations; it is not used to rebuild every operational table.

Each project owns a strictly increasing sequence. The event envelope contains event ID, project sequence, aggregate and optional parent, actor, provenance, schema version, idempotency key, timestamp, and a versioned payload. Provider-native identifiers remain server-side references and are redacted before persistence.

An event row doubles as the outbox. It is offered to live subscribers after commit and then marked delivered. Subscribers deduplicate by project sequence. A crash can cause a repeated live event, never a committed state transition without a catch-up row.

## Reconnect

1. Authorize the requested project or session object.
2. Return a current snapshot and its project watermark.
3. Register the live subscription.
4. Query and deliver durable events after the watermark.
5. Continue with post-commit live events, dropping duplicate sequences.

Token deltas and noisy repeated progress are not durable. Completed messages, tool calls, approvals, state transitions, summaries, and important progress changes are durable. Current progress is an upsert keyed by activation and activity.

## Sessions and turns

A session is a persistent collaborative conversation. A run is one root human objective and its descendants. A session permits one running normal turn. Human messages receive an atomic per-session sequence; messages submitted while busy remain FIFO queued follow-ups. Steering, cancellation, and approval answers are separate idempotent actions.

A steering lease is short, renewable, and exclusive. It does not prevent other participants from watching or queueing. The server gates steering on both the lease and runtime capability. Claude Code and Kimi ACP do not advertise active steering.

Approval answers are one-shot transitions from pending. Expiry, identity, decision, and audit actor are recorded.

## Agent lineage

A logical agent persists across activations. An activation is exactly one create or resume. A resume appends the next activation ordinal and never rewrites an earlier activation. An edge records platform, provider, hook, or heuristic evidence plus full, observe-only, or uncertain control.

Aggregate activation states are queued, running, waiting on children, needs input, needs approval, blocked, settled, failed, cancelled, and stale. A parent cannot settle while a reachable descendant remains queued, running, waiting, needs input, or needs approval.

## Node commands

The server delivers node commands at least once. Every command has a stable operation key and durable server state. Before a side effect, the node atomically journals accepted with mode 0600. Repeated accepted, running, completed, failed, or uncertain keys never re-execute a spawn. A crash ambiguity is surfaced as uncertain for reconciliation.

Command states are queued, delivered, accepted, running, completed, failed, uncertain, cancelled, and expired. Network delivery never implies execution.

## Orchestration

Orchestration execution states are queued, running, paused, cancelling, settled, failed, and cancelled. Work items have explicit dependencies and transition through claim acquisition before scheduling. Scheduler leases and timestamps permit restart recovery. Pause stops new placement; cancel propagates. Claims are released or settled on every terminal path.

Interactive coordination conflicts are warnings. Dhole-managed scheduling atomically rejects blocking overlap before spawn.

## Schema evolution

Envelope schema version 1 is immutable. New optional fields require tolerant readers. Breaking payload changes use a new schema version and an explicit reader. Database migrations are additive and checksum-protected; applied migrations are never edited.
