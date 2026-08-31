# Adding a runtime

Add a runtime only when it is a real execution boundary with a structured,
documented protocol. The MVP uses compile-time registration: a runtime adapter
is TypeScript in `apps/node/src/runtimes`, imported by the static registry, and
validated through the shared descriptor contract. Runtime plugin loading,
screen scraping, arbitrary shell commands, and browser-to-node connections are
out of scope.

## Contract to implement

Implement `RuntimeAdapter` from `apps/node/src/runtimes/types.ts`:

```ts
interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly label: string;
  readonly protocolVersion: string;
  readonly capabilities: RuntimeCapabilities;
  readonly availability: RuntimeDescriptor['availability'];
  descriptor(id?: string): RuntimeDescriptor;
  execute(command: NodeCommand, context?: RuntimeExecutionContext):
    Promise<RuntimeExecutionResult>;
  close?(): Promise<void>;
}
```

`RuntimeCapabilities` is not optional. Declare every field truthfully:
session creation/resume, next-turn messaging, active steering, cancellation,
approval responses, history replay, structured tool events, native subagent
observation, image input, structured output, repository editing, and terminal
tools. A capability is an explicit product promise; do not set it to `true`
just because a provider might support the feature.

If the new kind is part of the shared wire contract, add it to the
`RuntimeKindSchema` enum and update the descriptor tests as one integration
change. Keep the wire schema versioned and backwards-compatible.

## Implementation steps

1. **Choose a structured protocol.** Prefer an official JSON-RPC, stream-JSON,
   ACP, or HTTP interface. Record the protocol/version and the exact lifecycle
   operations it supports. Do not parse terminal screen output.
2. **Create the adapter.** Add `apps/node/src/runtimes/<kind>.ts`. Follow the
   existing adapters' shape: constructor options, `discover()` when an
   executable is involved, `descriptor()`, an operation switch, bounded errors,
   and `close()` for child processes.
3. **Use safe transport helpers.** For local programs use
   `BoundedStdioProcess`, `readUntilResponse`, `normalizeRuntimeError`, and
   `throwIfAborted`. They use argument-array `spawn`, newline framing, bounded
   stdout/stderr, and abort handling. For HTTP use `fetch` with a fixed
   endpoint, body/response limits, timeout, and an `AbortSignal`.
4. **Normalize events.** Map native frames into the common event vocabulary and
   preserve unknown notifications as `runtime.raw` with bounded native fields.
   Emit through `eventEmitter(context, events)` so the node journal/server can
   persist the same stream.
5. **Register statically.** Add options, imports, exports, and a map entry in
   `apps/node/src/runtimes/index.ts` (`RuntimeRegistryOptions`,
   `createRuntimeRegistry`). Never import a path, module name, executable, or
   JavaScript supplied by a user at runtime.
6. **Document the operation matrix.** Update the runtime guide with exact
   create/resume/send/steer/cancel/approval/replay/recovery behavior and any
   provider-specific limitations. If a method is unsupported, reject it and
   set the capability to `false`.

## Command and lifecycle behavior

`execute()` receives a Zod-validated `NodeCommand` and an execution context.
Implement only the command kinds the adapter can honor:

- `create_runtime_session` must return a stable runtime session ID and emit
  `session.created`.
- `resume_runtime_session` must use the provider's native resume/history hook
  when one exists; otherwise return an explicit unsupported/error result rather
  than pretending to replay.
- `send_message` is the next queued turn and should return a turn ID when the
  protocol has one, plus normalized message/tool events.
- `steer` is active-turn control, not a queued follow-up. The server gates it
  on `activeTurnSteering` and an exclusive, renewable steering lease.
- `cancel` must honor `AbortSignal` where possible and report whether a
  provider interrupt was actually sent. Do not claim cancellation merely
  because a local row changed state.
- `answer_approval` is one-shot and must map the Dhole decision to the native
  approval/request ID. Set `approvalResponses: false` when the protocol has no
  such operation.

History replay means native provider/session history or a deliberately bounded
local transcript. It does not mean replaying arbitrary persisted events into a
model. Recovery is explicit: the node journal reports at-least-once command
state (`accepted`, `running`, `completed`, `failed`, `uncertain`), and a caller
reconciles or resumes after process/connection loss. Never blindly spawn a
second child for an ambiguous operation key.

## Capability gating and registration

Nodes publish `RuntimeDescriptor` values in `dhole.node.v1` heartbeats. The
server validates descriptors and upserts them at
`POST /api/runtime/registrations`; administrators can inspect them at
`GET /api/runtime/registrations`. An unavailable descriptor is diagnosable but
not eligible for placement.

Session steering checks the stored descriptor's `activeTurnSteering` value in
addition to authorization, a running turn, and the steering lease. Orchestration
profiles likewise use explicit runtime kinds and required capabilities. Keep
runtime, provider, model, executor, skill, memory, and orchestration profile
identities separate.

## Security and boundaries

- Never add a generic shell endpoint or pass shell syntax to a process. Use
  `spawn`/`execFile` with argument arrays and reject unsafe executable values.
- The node dispatcher provides a canonicalized workspace `cwd`; do not accept
  an arbitrary path or follow an unvalidated symlink.
- `NodeCommand` may contain a secret reference, never secret material. Actual
  credentials are injected into the execution context and must not appear in
  events, logs, fixtures, descriptors, or error messages.
- Validate every external frame/request with Zod or an equivalent bounded
  schema. Limit stdout/stderr, HTTP bodies, event depth/size, wall-clock time,
  and API tool rounds.
- Allow-list API tools and execute them through the supplied controlled tool
  executor. Redact provider tokens, authorization headers, emails, and private
  keys before storing evidence.
- Preserve idempotency keys, authorization checks, redaction, immutable event
  history, and protocol schema versions.

## Tests and verification

Add focused tests next to the adapter and, when framing is shared, to
`apps/node/src/runtimes/protocol.test.ts`:

- descriptor shape and every capability flag;
- fixture child/API transport with create, resume, message, cancel, approval,
  and unsupported-steer paths;
- native notification-to-event normalization, including an unknown frame;
- abort, timeout, stdout/stderr/body limits, malformed JSON, and provider error
  handling;
- missing executable discovery without shell execution;
- operation-key/recovery behavior and clean `close()`.

Use local deterministic fixtures. Do not invoke a live model, spend quota, or
change a running provider/service in tests. Run `pnpm format:check`, the node
runtime tests, and the full `pnpm verify` before integration. The current live
adapters are implemented but have not been quota-tested.

## Protocol references

Use the current primary documentation for the protocol you integrate and pin
the observed version in the descriptor:

- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview)
- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)

The baseline is ADR 0001: Node.js `>=24.15 <25`, `pnpm@10.29.2`, one central
server, one outbound node per execution machine, and no runtime plugin loader.
