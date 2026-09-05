# Connect and operate a machine

A machine needs one Dhole authorization. Its agents then obtain narrower
project credentials without creating human accounts. An execution node is a
separate outbound process that runs installed runtimes on that host. The
browser talks only to the central server.

These commands are operator instructions. Preparing or testing Dhole does not
authorize running them on a real machine. This checkout is not configured for
live Mediation.

## Authorize the machine

Build with Node.js `>=24.15 <25` and pnpm 10.x. Sign in to Dhole, then run on
the machine to connect:

```sh
node apps/node/dist/index.js connect --server https://DHOLE_HOST
```

The command prints a central-server approval URL and a short code. Review the
machine name and requested permissions in the browser and approve them. The
command polls within the code's expiry, stores the approved credentials
privately, and exits. It does not start a daemon, install a service, or edit a
runtime's configuration.

The normal request includes `projects:create`, so an approved agent can
create private native projects. Use `--agent-only` when the machine only needs
the MCP bridge. Full execution node enrollment requires an administrator grant of `fleet:admin`. Use
`--name NAME` to choose the display name and `--state-dir /absolute/path` for
a separate state directory. Add `--gateway` to request Gateway read and
management access explicitly; an administrator must approve management.
Machine transport is always part of Core. If the approved grant omits machine
administration, connection completes with agent authorization and skips
execution enrollment. The `fleet:admin` scope remains a compatibility name.
`--dry-run` validates the intended setup and prints a summary without contacting
the server or writing files.

The default state directory is `~/.dhole-node`, with mode `0700`. Private JSON
files use mode `0600` and atomic writes:

| File | Purpose |
| --- | --- |
| `agent.json` | Revocable machine authorization and central origin |
| `credential.json` | Execution node ID and node credential, when enrolled |
| `connection.json` | Node WebSocket URL and explicit local repository map |
| `journal.json` | Durable command acceptance, execution, and result state |

No credential is printed. A repeated connection checks authorization with the server and reuses
valid stored authorization and node identity. Revoked or expired access starts
a fresh approval flow. A different server requires a
separate state directory. Do not copy these files into a repository, client
configuration, issue, log, or browser message.

## Create a native project

After approval, an agent can create a private project without a forge account:

```sh
node apps/node/dist/index.js create-project --name 'Local project'
```

The command returns `projectId` and `repositoryId`. It sends no local
filesystem path and grants no execution allowlist. Add `--remote` to record a
safe Codeberg or other remote as unverified metadata. Calls with the same
working directory, name, and remote use a stable retry key; `--request-id`
selects an explicit key. `--dry-run` performs no credential read or network
request. Pass the resulting project ID to the MCP command or installer.

## Allow repositories and start the node

Only explicitly listed roots enter the local repository allowlist:

```sh
node apps/node/dist/index.js connect --server https://DHOLE_HOST \
  --repository REPOSITORY_ID=/absolute/repository/path
node apps/node/dist/index.js run
```

Each path must be an existing directory and is canonicalized. The local map
does not grant server permission. An authorized administrator must also bind
that repository and root to the machine through
`POST /api/machines/:machineId/allowlist`. Both the server's policy and
the node's local allowlist must permit an operation.

`run` starts the outbound WebSocket to `/ws/node`. Outside loopback, the URL
must use WSS. The node discovers installed runtimes, heartbeats, receives
closed structured commands, and journals operations before execution. Stop
with Ctrl-C. Installing a host service is an operator deployment choice;
`connect` does not perform it.

## Configure the local agent bridge

The bridge runs as a local stdio MCP process:

```sh
node apps/node/dist/index.js mcp --project PROJECT_ID
```

Explicit `--project` mode uses an existing authorized Dhole project and works
for local repositories and non-GitHub hosting. Without it, the current bridge
selects the Git push remote and uses the configured GitHub repository
authorization path. Ambiguous or unsupported remotes fail with guidance rather
than choosing a project by display name. GitHub linking is optional for native
Dhole sign-in and manual project work.

The bridge obtains a short-lived project token, registers its own coordination
session, retains the session capability outside model arguments, sends quiet
heartbeats, and ends the transport session on shutdown. Manual mode includes a
stable local worktree identity, so a new bridge process in the same checkout
can recover the same user's earlier claims. Its model-visible
tools contain coordination work, not credential or setup operations. See
[Mediation integration](MEDIATION_INTEGRATION.md).

The installer edits only an explicitly named config file:

```sh
node apps/node/dist/index.js install --client codex --project PROJECT_ID \
  --config /absolute/path/config.toml --dry-run
node apps/node/dist/index.js install --client codex --project PROJECT_ID \
  --config /absolute/path/config.toml
```

Supported client selectors are `codex`, `claude`, and `opencode`. Use
`uninstall` with the same arguments to remove Dhole's managed entry. The
installer preserves unrelated entries, rejects an unowned conflicting entry,
and preserves the managed entry ownership marker. OpenCode JSONC
is rejected rather than rewritten as plain JSON. The config contains the
bridge command and state directory, not credentials. See
[Client setup](../clients/README.md) for client-specific examples. Maintained
agent Skills use the separate `install-skills --skills-dir /absolute/path` and
`uninstall-skills` commands, each with `--dry-run` support. These commands
manage the two owned files in `clients/skills`; they do not enable a server
Skills module or install machine authorization.

## Gateway administration by agents

With an approved `connect --gateway` grant, use a named action in the explicit
native project. An existing grant cannot gain these scopes silently; revoke
the old device grant and pair again to request the added permissions:

```sh
node apps/node/dist/index.js gateway --project PROJECT_ID \
  --action '{"action":"connections.list"}'
```

The local MCP bridge exposes the same operations as `gateway_manage`, pinned
to its project. Gateway actions do not need a Coordination session. The helper
privately derives only the required read or management scope for each action.
Connection secrets and callback inputs use private file references; issued
catalog tokens and authorization URLs go to private files rather than model
output. Catalog credentials retain their parent API/device authority and its
shorter expiry. Reissue an expired file through the authorized action;
revoking the machine also revokes its issued catalog access. See [Gateway administration](GATEWAY_AND_CPAMP_REPLACEMENT.md) for the
25 supported actions and [Client setup](../clients/README.md) for setup.

The optional [OpenCode catalog plugin](../clients/opencode/README.md) is
separate from the MCP installer. Its actual startup path is tested with
OpenCode 1.18.27 in isolated fixture directories. Installing either integration
on a real host remains an operator action.

## Revocation and recovery

The browser lists authorized devices and can revoke one. Revocation invalidates
the device's derived project access and its linked node authorization. Session
and command paths recheck current authorization rather than relying only on
the original sign-in. Reconnect through the approval flow after revocation or
expiry; do not patch private database rows or recycle a leaked credential.

The node writes accepted operation keys before spawning. At-least-once
command delivery therefore does not mean repeated execution. On restart,
completed results can be reported again, while ambiguous running operations
become uncertain and require reconciliation. Do not delete the journal to
force a retry. Runtime process handles do not survive a node restart; the
resume limits are tracked in [Roadmap](../ROADMAP.md).

## Environment overrides and low-level enrollment

Existing environment-based daemon configuration remains supported:
`DHOLE_NODE_SERVER_URL`, `DHOLE_NODE_MACHINE_ID`, `DHOLE_NODE_CREDENTIAL`,
`DHOLE_NODE_STATE_DIR`, `DHOLE_NODE_REPOSITORIES`, and `DHOLE_NODE_SECRETS`.
Explicit environment values override saved connection configuration. Keep
secret values in a protected host environment. Command bodies contain secret
references, never provider credentials.

Low-level node enrollment remains available through short-lived
`POST /api/machines/enrollment-tokens` and node-facing
`POST /api/machines/enrollment/consume`. The former `/api/fleet/*` endpoints
remain compatibility aliases with the same authorization checks. Browser callers cannot consume enrollment
or receive a persistent node credential. The device flow avoids copying one
through the browser. Core machine administration and rotation use appropriately
scoped machine/API credentials.

The onboarding, journal, runtime, and WebSocket tests use fixtures. They do not
validate a real host runtime, account, provider, or production proxy.
