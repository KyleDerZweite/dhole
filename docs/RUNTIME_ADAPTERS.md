# Runtime adapters

Dhole keeps runtime processes on an outbound node. The browser talks to the
central server; the server queues a versioned `NodeCommand`; and the node
selects a statically registered adapter. A runtime is not a provider or a
model: it is the process or API protocol that owns a session and turns.

The adapter contract lives in `apps/node/src/runtimes/types.ts` and the wire
types live in `packages/shared/src/runtime.ts` and `packages/shared/src/node.ts`.
Every descriptor has a protocol version, a complete capability map, and an
availability record. Capability values describe this adapter implementation;
they are not a claim that every installed model supports every feature.

## Implemented adapters

The registry in `apps/node/src/runtimes/index.ts` is compile-time only. The
factory includes the fake fixture unless `includeFake: false`; the daemon's
exported process registry includes it only when `DHOLE_NODE_ENABLE_FAKE=true`.
Codex, Claude Code, Kimi Code, and the generic OpenAI-compatible adapter are
always statically registered.

| Kind | Descriptor protocol | Transport and executable | Steering | Approval answer | Native child observation | Repository editing |
| --- | --- | --- | --- | --- | --- | --- |
| `codex` | `codex.app-server.jsonrpc.v1` | Newline-delimited JSON-RPC over `codex app-server` | Yes (`turn/steer`) | No; approval observation is read-only | No; this adapter does not normalize native child-agent lifecycle | Yes |
| `claude-code` | `claude.stream-json.v1` | Claude Code CLI, `claude -p --input-format stream-json --output-format stream-json` | No; queue the next message | No; approval observation is read-only | No | Yes |
| `kimi-code` | `acp.v1` | Newline-delimited JSON-RPC over `kimi acp` | No; ACP adapter rejects `steer` | No; permission observation is read-only | No; not advertised by this ACP adapter | No; ACP client filesystem access is disabled |
| `openai-compatible` | `openai.chat-completions.v1` | HTTP `POST {baseUrl}/chat/completions` with `stream: false` | No | No | No | No (the API tool executor is opt-in) |
| `fake` | `fixture.v1` | In-memory deterministic fixture; no process or provider | Yes (fixture event) | Yes (fixture event) | Yes (fixture event) | Yes (fixture claim only) |

The full descriptor capability map is below. `Y` means the adapter currently
sets the corresponding `RuntimeCapabilities` field to `true`; `N` means it
sets it to `false`.

| Capability | Codex | Claude Code | Kimi ACP | OpenAI-compatible | Fake |
| --- | :---: | :---: | :---: | :---: | :---: |
| `sessionCreation` | Y | Y | Y | Y | Y |
| `sessionResume` | Y | Y | N† | N | Y |
| `nextTurnMessage` | Y | Y | Y | Y | Y |
| `activeTurnSteering` | Y | N | N | N | Y |
| `cancellation` | Y | Y | Y | Y | Y |
| `approvalResponses` | N | N | N | N | Y |
| `historyReplay` | Y | Y | N† | N | Y* |
| `structuredToolEvents` | Y | Y | Y | Y | Y* |
| `nativeSubagentObservation` | N | N | N | N | Y* |
| `imageInput` | N | N | N | N | Y* |
| `structuredOutput` | N | N | N | N | Y* |
| `repositoryEditing` | Y | Y | N | N | Y* |
| `terminalTools` | Y | Y | N | N | Y* |

An asterisk marks a fixture or local-memory behavior, not provider evidence.
The dagger marks ACP capability negotiation: Kimi starts with both values
`false` and sets them to `true` only when `initialize` advertises
`session/load` support. A descriptor observed after initialization is the
authoritative value. All live adapters currently accept text prompts only;
none sends image attachments or a structured-output request. Kimi's ACP client
also advertises no filesystem or terminal capability, and the generic API
adapter has no built-in repository or terminal executor.
The fake adapter intentionally reports all capabilities so session, approval,
lineage, and steering paths can be tested deterministically. It must not be
used to infer live runtime support.

An adapter with `approvalResponses: false` may still emit
`approval.requested`/`permission` events for display and durable recording, but
`answer_approval` is rejected. Codex, Claude Code, and Kimi ACP are therefore
read-only approval paths in this MVP; OpenAI-compatible has no approval
operation. Only the fake fixture accepts an approval answer, and that answer is
an in-memory test event.

## Operation and protocol details

The shared command names are `create_runtime_session`,
`resume_runtime_session`, `send_message`, `steer`, `cancel`, and
`answer_approval`. Adapters emit bounded normalized events while handling a
command. Unrecognized native data is retained rather than discarded: adapters
either preserve the native type as a bounded `runtime.<type>` event or use
`runtime.raw` with `nativeMethod`, `nativeType`, `params`, or `raw` fields.

## Core session execution path

The normal interactive path is server-owned and durable:

1. A participant queues a message through Sessions. For an idle session bound
   to a runtime registration, Sessions validates team/project membership,
   runtime availability, repository allowlisting, and placement. It creates
   the run, root activation, and turn, marks the human message delivered, and
   derives the operation key
   `session:<sessionId>:run:<runId>:create` for `create_runtime_session`.
2. Sessions hands that command to Core machine transport. Core machine transport validates the Zod command,
   project/team and repository scope, and the operation-key payload. It stores
   one durable `node_commands` row in `queued` state and delivers it over the
   authenticated `dhole.node.v1` WebSocket when the node is connected.
3. The node journals the operation before spawning, serializes commands for a
   runtime session, and reports `accepted` then `running`. On completion it
   reports one terminal `command_status` containing the bounded, redacted
   result (including adapter events where the adapter returned them).
4. A one-second server maintenance tick calls Sessions maintenance, Core machine transport
   stale/retry handling, outbox flushing, and pending delivery. Sessions reads
   the durable create row, records the returned `runtimeSessionId` on the
   activation, and derives a stable `...:resume` key for later turns before
   deriving `...:send`. A completed send with text settles the turn and
   materializes the agent message; failed, expired, or cancelled commands fail
   the turn/run/session. Existing operation rows are reused, never duplicated.

On reconnect, the node's hello includes journal operation summaries. Core machine transport
reconciles accepted/running/uncertain rows, sends a bounded `reconcile` list,
and re-delivers queued/delivered/accepted/running commands. `uncertain` is
operator-reconciled and is deliberately not re-delivered automatically. A
repeated operation key must have the same canonical command payload; Core machine transport
rejects a conflicting reuse and the node journal never respawns a previously
accepted/running/completed operation. This is at-least-once delivery with
explicit reconciliation, not an assumption that a WebSocket send means the
provider executed.

The node wire carries bounded `runtime_event` frames for every normalized
adapter event while a command is running. Frames are correlated by the
authenticated machine, command ID, operation key, deterministic per-command
sequence (1–10,000), and event ID; provider-supplied session IDs are not
trusted for routing. Sessions classifies the live stream as follows:

- `message.delta` and turn lifecycle (`turn.started`, `turn.completed`,
  `turn.steered`, `turn.cancelled`) are transient app-WebSocket updates. They
  are sent only to currently authorized subscribers and are not written to the
  durable project event log.
- `approval.requested` and `tool.call.started`/`tool.call.completed` are
  durable. Sessions records approvals/tool events in the immutable event log,
  deduplicated by the runtime event ID, and they replay to reconnecting app
  subscribers through the normal event watermark.

The terminal `command_status` result also retains a bounded event list. Node
and Core machine transport drop transient entries first and preserve durable approval/tool
events within a 900 KiB terminal-result budget. Core machine transport validates the survivors
and replays them through the same handler so a lost live frame can recover a
durable event; the event ID makes this replay idempotent. If the durable events
alone cannot fit, the command becomes `uncertain` and no false completed result
is recorded. Live event sequence numbers stop at 10,000: later transient
events are dropped, while a later durable event likewise makes completion
uncertain. A provider approval request is visible only if its adapter emits an
approval event; an approval answer still depends on the adapter capability
above.

Runtime-to-session mapping (runtime key, canonical workspace, and secret
reference) is held in the node process. After a node restart the mapping is
gone, even though the server still has the durable native session ID and
operation rows. Issue an explicit `resume_runtime_session` command and wait
for its terminal status before sending follow-up turns; an unmapped follow-up
fails closed. Native runtime history/replay is provider-specific as described
below, and no turn is blindly replayed.

Sessions sanitizes obvious credentials before outbound user/steering text is
placed in a command (PEM private-key blocks, `Bearer` tokens, common `sk`/`rk`/
`pk` keys, and key/value forms such as `api-key=...`). Node and Core machine transport apply
additional field-key, string, size, and opaque-output redaction to command
results, errors, descriptors, and journal status. This is a pattern-based
defense; callers must still avoid putting secrets in prompts, commands, or
fixtures.

### Codex app-server

`CodexRuntimeAdapter` starts one `codex app-server` process per in-memory
session key (the default argv is `app-server`; tests may override argv). It
sends JSON-RPC `initialize` with Dhole's `clientInfo` (`name: dhole-node`,
`title: Dhole Node`, and the adapter client version), then sends the
`initialized` notification. A `JsonRpcDemux` owns the single stdout reader and
matches concurrent responses by JSON-RPC ID; notifications are retained and
routed to the oldest pending request. An aborted request rejects locally and
late responses are discarded.

- Create sends `thread/start` (including the canonical workspace `cwd`) and
  returns the thread ID.
- Resume sends `thread/resume` with the thread ID.
- A next turn sends `turn/start` with a text input item.
- Active steering sends `turn/steer` with `expectedTurnId` set to Dhole's turn
  ID; a nested native `turn.id` is retained when returned. The server exposes
  this only when the registered descriptor says `activeTurnSteering: true` and
  a steering lease is held.
- Codex messages are text-only in this adapter. It does not request image
  input or structured output, and it does not normalize native child-agent
  lifecycle events; `nativeSubagentObservation` remains `false`.
- Cancellation sends `turn/interrupt`, using the command turn ID or the last
  native nested turn ID observed for the session.
- Codex approval requests can be observed as `approval.requested`, but
  `approval/response` is intentionally not implemented because inbound JSON-RPC
  request IDs are not retained. `approvalResponses` is therefore `false` and
  this path is read-only.
- Notifications are mapped to message deltas, tool lifecycle, approval, turn,
  and session events; unrecognized methods remain raw.

`thread/resume` is the native history/replay hook. A process or node restart is
not a transparent replay: the node journal reports the operation state and a
caller must issue an explicit resume/reconciliation command. There is no
automatic turn re-run.

### Claude Code stream-json

`ClaudeCodeRuntimeAdapter` uses the installed Claude Code CLI, not a bundled
proprietary SDK. Creation starts `claude` in print mode with stream JSON input
and output. Sending a user frame reads until a result/stop frame and maps
assistant, tool, permission, and result frames to normalized events.

- Create starts a local session ID; the CLI process is ready for a user frame.
- Create generates a UUID and starts the process with `--session-id <uuid>`.
- Resume starts a process with `--resume <runtimeSessionId>`.
- A next turn sends a structured frame:
  `{ "type": "user", "message": { "role": "user", "content": "..." } }`.
- The frame contains text only. Image input and structured output are not
  requested by this adapter; repository and terminal behavior is delegated to
  the Claude Code process running in the canonical workspace.
- `steer` is deliberately rejected. Queue a follow-up message instead; there
  is no active-turn steering capability in this adapter.
- Cancellation kills the child process and emits `turn.cancelled`.
- Permission/approval frames may be observed as `approval.requested`, but
  `answer_approval` is rejected. `approvalResponses` is false, so this is a
  read-only approval path.

The CLI's `--resume` is the history/replay mechanism. If the child disappears,
the journal can surface a failed or uncertain command and a later explicit
resume can start a new process. The adapter does not replay a partially sent
turn or observe native child agents.

### Kimi Code ACP v1

`KimiCodeRuntimeAdapter` starts `kimi acp` and exchanges newline-delimited
JSON-RPC. It initializes ACP v1 before opening a session, advertising
read/write filesystem and terminal capabilities as `false` and sending
`clientInfo` (`dhole-node`, `Dhole Node`, and the adapter client version).
The initialize result is inspected for `agentCapabilities.loadSession`,
`sessionLoad`, or `sessionCapabilities.load`; these determine whether
`sessionResume`/`historyReplay` stay enabled.

- Create uses `session/new` with an absolute canonical `cwd` and an empty
  `mcpServers: []` list.
- Resume uses `session/load` with the same `mcpServers: []`, absolute `cwd`,
  and `sessionId`; it is rejected when initialize did not advertise load
  support.
- A next turn uses `session/prompt` with ACP content blocks:
  `prompt: [{ "type": "text", "text": "..." }]`.
- The ACP client advertises `fs.readTextFile: false`, `fs.writeTextFile: false`,
  and `terminal: false`; this adapter therefore does not claim repository or
  terminal tooling. Prompt content is text-only, with no image or structured
  output request.
- `steer` is rejected because this adapter does not advertise active-turn
  steering. Queue the next prompt.
- Cancellation writes `session/cancel` as a JSON-RPC notification (no response
  ID), leaving the shared demux free to continue reading updates.
- Permission requests may be observed, but `session/request_permission` is not
  sent by this adapter because inbound request IDs are not retained.
  `approvalResponses` is false and the approval path is read-only.
- ACP `session/update` content blocks are normalized to message deltas;
  `tool_call`/`tool_call_update` become tool lifecycle events. Other ACP
  notifications remain raw.

`session/load` is the native history hook when negotiated. ACP v1 does not
provide a native subagent-observation contract used by this adapter, so that
capability remains false. Process loss requires journal reconciliation and an
explicit resume; the adapter does not silently replay a turn.

### OpenAI-compatible Chat Completions

`OpenAICompatibleRuntimeAdapter` is a bounded API adapter for CLIProxyAPI,
OpenRouter, direct providers, and other compatible endpoints. It posts to
`{baseUrl}/chat/completions` with the configured model and `stream: false`.

- Create allocates an in-memory `openai-<runtimeSessionKey>` transcript.
- `sessionResume` and `historyReplay` are false. `resume_runtime_session`
  always rejects with `does not support durable session resume`; a provider
  transcript is never reconstructed from Dhole events.
- A next turn appends the user message and runs a bounded model/tool loop.
- Active steering is rejected and approval answers are unsupported.
- `cancel` aborts the in-flight request's `AbortController` (when one exists)
  and emits a cancellation event.
- Tool calls are accepted only from the configured allow-list. Each round is
  emitted as `tool.call.started`/`tool.call.completed`, with redacted input and
  output. The loop is limited to 1–16 rounds (default 4), request bodies and
  responses are bounded, and fetches have a deadline.
- Requests contain text messages only and do not include image content or a
  structured-output schema. The optional `allowedTools` hook is a generic
  controlled executor; no repository or terminal tool is built into this
  adapter.

The in-memory transcript is useful only while the adapter process lives; it is
not advertised as replay and is not rebuilt from Dhole events. A node restart
loses it, so callers that need continuity must start a new session. This
adapter never observes native subagents or edits repositories by itself.

### Fake fixture

`FakeRuntimeAdapter` is deterministic, in-memory, and provider-free. It emits a
single fake response for each message and records steering, cancellation, and
approval events without performing those operations. Resume creates an empty
fixture transcript when necessary. The fixture exists for tests and demo data;
it must never masquerade as live runtime availability.

## Normalization, limits, and security

All adapters return `RuntimeExecutionResult` and use `eventEmitter` so callers
can persist the same normalized event stream. The common event vocabulary is:
`session.created`, `session.resumed`, `session.updated`, `turn.started`,
`turn.completed`, `turn.cancelled`, `turn.steered`, `message.delta`,
`message.completed`, `tool.call.started`, `tool.call.completed`,
`approval.requested`, `approval.answered`, and `runtime.raw`.

Stdio adapters use `BoundedStdioProcess`: argument-array `spawn` (no shell),
2 MiB stdout, 64 KiB stderr, newline framing, abort handling, and normalized
errors. JSON-RPC adapters add `JsonRpcDemux`: one reader per process,
ID-based response demultiplexing, bounded timeout, and cancellation that
rejects the pending request while discarding a late response. Kimi's
`session/cancel` is a notification and therefore has no response to await. The
API adapter uses `fetch`, a 1 MiB default body/response bound, a wall-clock
deadline, redaction, and an allow-listed tool executor. Workspace paths are
canonicalized before they reach an adapter. Provider secrets arrive through
the execution context or a secret reference; they never belong in a
`NodeCommand`, event payload, log, or descriptor.

At the node boundary each adapter callback is wrapped as a `dhole.node.v1`
`runtime_event` frame. The event kind, payload, per-command sequence, and
deterministic event ID are bounded before sending. The same events are included
in the terminal result when they fit the bounded status envelope, allowing
Core machine transport to replay durable approval/tool events after a lost live frame.

## Availability and recovery truth

Codex, Claude Code, and Kimi executables are not bundled. Before use, node
discovery calls each configured executable's `--version` through `execFile`
without a shell (two-second timeout and bounded output). Defaults are
`codex`, `claude`, and `kimi`; an explicit executable path may be supplied.
Missing binaries and failed probes intentionally collapse to:
`{ available: false, reason: "Runtime executable is unavailable" }`.
Constructors report `Run discover() before use` until discovery runs. The
observed executable and version are included in the heartbeat descriptor and
persisted by the server's `/api/runtime/registrations` endpoint.

The OpenAI-compatible descriptor has no local executable and is unavailable
until `DHOLE_OPENAI_BASE_URL` is configured; it does not perform a network or
quota probe. The fake descriptor is included in the daemon registry only when
`DHOLE_NODE_ENABLE_FAKE=true`. An unavailable registration is visible for
diagnosis but must not be scheduled.

The daemon reads optional `DHOLE_CODEX_EXECUTABLE`,
`DHOLE_CLAUDE_EXECUTABLE`, `DHOLE_KIMI_EXECUTABLE`,
`DHOLE_OPENAI_BASE_URL`, and `DHOLE_OPENAI_MODEL` settings when it creates the
compile-time registry. Provider values are node-local: a command may name an
opaque `secretReference`, which the node resolves through
`DHOLE_NODE_SECRETS` and supplies only in the in-memory execution context.
Commands and journal results never contain that resolved value.

The node journal is at-least-once and operation-keyed. Reconnect reports
accepted/running/completed/failed/uncertain operations; it does not imply that
a provider turn was replayed. Adapter state is process-local, so recovery is
explicit (reconcile, resume, or fail) and never a blind duplicate spawn.

`NodeClient.stop()` is a graceful local shutdown: it marks the daemon stopped,
aborts active session controllers, closes registered adapters, stops heartbeat
and reconnect timers, and closes the WebSocket. A queued session command that
has not started fails with `node stopped before execution`. If a runtime
operation had already started and shutdown races its external side effect, the
journal records `uncertain`; Core machine transport does not expire or redeliver that operation
automatically. On the next start, accepted/running journal entries are likewise
converted to `uncertain` and require explicit reconciliation or resume.

The live adapters are implemented, but this repository has not spent live
model quota to verify provider behavior. Use local fixtures and an explicitly
configured endpoint for verification.

## Current wiring note

`RuntimeRegistry.execute(kind, command)` directly exercises every operation
above and is covered by node tests. The shared follow-up command shapes carry a
`runtimeSessionId`, not a `runtimeId`. `NodeClient` records the
runtime-session-to-runtime mapping when create or resume succeeds, then uses
that mapping for send, steer, cancel, and approval commands. The mapping is
in-process; after a node restart, issue an explicit resume before sending a
follow-up. An unmapped runtime session fails closed instead of returning a
generic success result. Do not interpret a command status as evidence that a
provider turn ran unless the adapter result/events confirm it.

## Primary references

These links describe the external protocols that the adapters target; the
descriptor protocol strings above are Dhole's own versioned labels.

- [OpenAI Codex app-server](https://developers.openai.com/codex/app-server/) and
  [Codex repository protocol docs](https://github.com/openai/codex/tree/main/docs)
- [Claude Code CLI and SDK documentation](https://docs.anthropic.com/en/docs/claude-code)
- [Agent Client Protocol overview](https://agentclientprotocol.com/protocol/overview)
  (ACP v1)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [OpenRouter model API](https://openrouter.ai/docs/api-reference/list-available-models)

The implementation baseline is locked by ADR 0001: Node.js `>=24.15 <25`,
`pnpm@10.29.2`, and no runtime plugin loader.
