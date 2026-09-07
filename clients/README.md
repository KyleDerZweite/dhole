# Agent clients

> Archived project: Dhole is discontinued and no longer maintained. These
> client setup instructions are preserved for reference.

The node binary includes a stdio MCP bridge for Codex, Claude Code, and
OpenCode. One browser approval stores machine authorization locally. Each
agent process then gets a short-lived project token and its own coordination
session. Credentials and session capabilities stay outside tool arguments
and model output.

Build the workspace first with `pnpm build`. The examples below describe
setup to run when ready. They do not imply setup has already happened.

## Connect once

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js connect \
  --server https://dhole.example \
  --state-dir /absolute/path/to/private/dhole-state
```

Open the displayed central-server URL, sign in, review the machine and
permissions, and approve the displayed code. The command polls for up to the
code's expiry, saves the approved authorization, and exits. It does not
install a service or start a daemon. Use `--agent-only` to request coordination
without machine enrollment. Add `--gateway` during pairing to request Gateway
read and management permissions explicitly. Machine enrollment belongs to Core.
A browser approval that omits machine administration also skips enrollment.
Existing credentials retain the `fleet:admin` wire scope for compatibility.

The state directory is mode `0700`. `agent.json` contains the machine's
long-lived authorization. `credential.json` contains its outbound node
credential when enrolled. `connection.json` stores its central WebSocket URL
and explicit repository mappings. Files are mode `0600`. Repeating `connect`
checks the existing authorization with the server and reuses valid credentials.
Revoked or expired authorization starts a new browser pairing. A different
server requires a different state directory.

Use `--repository REPOSITORY_ID=/absolute/repository/path` for each repository
the execution daemon may access. No repository mapping is inferred by scanning
the disk. The server must separately authorize that repository for the machine.
An empty mapping grants no repository execution access. To preview the pairing
plan without networking or writing state, add `--dry-run`.

Start the outbound daemon separately when needed:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js run \
  --state-dir /absolute/path/to/private/dhole-state
```

Existing `DHOLE_NODE_*` environment settings override saved connection settings.
No inbound port opens on the machine.

## Create a local project

The initial `connect` request includes `projects:create`. After the human
approves that permission, an agent can create a private Dhole project without
a GitHub account, integration, or remote repository:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js create-project \
  --name 'Local project' \
  --state-dir /absolute/path/to/private/dhole-state
```

The command prints JSON containing the new `projectId` and `repositoryId`.
Pass that project ID to `install --project PROJECT_ID` or `mcp --project
PROJECT_ID`. The local repository identity survives agent-process restarts,
so the same user can recover earlier claims in the same checkout.

Add `--remote https://codeberg.org/owner/repository.git` when recording a
remote. This is unverified metadata; it grants no remote permissions. Omitting
`--remote` creates a repository record with no remote. The command sends no
local filesystem paths and grants no daemon execution access.

Repeated calls with the same working directory, name, and remote use the same
idempotency key. `--request-id KEY` supplies an explicit retry key. Add
`--dry-run` to preview without reading credentials, contacting the server, or
writing files. If project creation was not approved for this machine, the
command fails before creating anything.

## Preview client installation

Use the client's actual config path. The installer does not choose a home
folder or edit any other file.

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js install \
  --client codex \
  --config /absolute/path/to/codex/config.toml \
  --state-dir /absolute/path/to/private/dhole-state \
  --dry-run
```

Review the generated configuration, then run the same command without
`--dry-run` to apply it. `--client claude` edits a JSON `mcpServers.dhole`
entry; `--client opencode` edits a JSON `mcp.dhole` local-server entry. OpenCode
JSONC files are rejected rather than rewritten without their comments. The
config file's parent directory must already exist.

Codex uses a marked TOML block. Claude and OpenCode entries include the
`DHOLE_CONFIG_OWNER` environment marker. Repeated installs replace only the
owned entry. An existing unowned Dhole entry is rejected. Other MCP servers
and client settings remain in place. JSON formatting is normalized.

Restart the client after applying its MCP config. The generated command is:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js mcp \
  --state-dir /absolute/path/to/private/dhole-state
```

Run that command with the intended repository as its working directory. The
bridge reads that repository's Git push-remote configuration only. It uses the
branch push remote, configured push default, or branch remote; a repository
with one remote also has an unambiguous default. Multiple unresolved remotes,
multiple push URLs, non-GitHub URLs, and URLs with embedded credentials are
rejected. The server verifies the signed-in user's GitHub write permission
before selecting a project. For a server using manual authorization, pass
`--project PROJECT_ID` to `install` or explicitly to the MCP command. A harness
that launches MCP outside the current repository must set the process's
working directory or use explicit manual project mode. The bridge does not
guess a repository from unrelated folders.

The optional [OpenCode catalog integration](opencode/README.md) updates the
client model list from Dhole. Its setup is separate from this MCP connection.

## Install agent skills

The maintained [Coordination skill](skills/dhole-coordination/SKILL.md) guides
claims, overlap checks, recovery, and completion. The [Gateway skill](skills/dhole-gateway/SKILL.md)
guides typed proxy administration. These are agent instructions stored in this
repository, separate from the server's modules.

Choose the skills directory used by your agent client and preview the files:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js install-skills \
  --skills-dir /absolute/path/to/client/skills \
  --dry-run
```

Run without `--dry-run` to copy the two `SKILL.md` files. The command creates
only `dhole-coordination/SKILL.md` and `dhole-gateway/SKILL.md` beneath that
explicit directory. Repeating it updates owned copies from this checkout.
Unowned files and symlink targets are rejected. Keep personal instructions
in separate files because updates replace managed skill content.

`uninstall-skills --skills-dir /absolute/path/to/client/skills --dry-run`
previews removal. Running it without `--dry-run` deletes only the two owned
skill files and their empty directories. MCP configuration and private
machine authorization have separate lifecycles.

## Gateway actions

A machine paired with `connect --gateway` can manage the chosen native
project through the local `gateway_manage` MCP tool or the CLI:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js gateway \
  --project PROJECT_ID \
  --action '{"action":"connections.list"}' \
  --state-dir /absolute/path/to/private/dhole-state
```

Actions use a fixed schema. The CLI supports `--dry-run`; it does not accept a
generic URL or shell action. The helper reads credentials from private files
and exchanges machine authorization for a scoped project token. Gateway does
not need an active Coordination session. Existing machine authorizations that
lack Gateway permissions require a new browser approval; revoke the old
connection in the central UI, then pair with `--gateway`.

## Normal work and shutdown

The bridge exposes the available native work tools: check, claim, complete,
release, revive, state, and agent events. It registers a session automatically,
keeps its capability private, renews project authorization before expiry, and
sends a quiet heartbeat every 30 seconds. There is no model-facing login,
setup, or session-registration tool. Agent work does not need repeated setup
prompts.

The work bridge requires both `project:read` and `coordination:write` so it can
register its own session. A grant containing only read permission cannot run
the coordination tools. Gateway-only grants can use the Gateway tool without
a Coordination session. Missing authorization, offline servers, and failed
permission checks return an empty tool list or a failed coordination action. They do not stop ordinary
agent work. A failed coordination action is never reported as a successful
claim. The bridge prints at most one terse availability warning to stderr and
keeps stdout exclusively for MCP. Ending the client closes the session and
stops its heartbeat; claims retain their recorded status until completed,
released, recovered, or expired under server policy.

## Uninstall

Preview and remove the same owned client entry:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js uninstall \
  --client codex \
  --config /absolute/path/to/codex/config.toml \
  --state-dir /absolute/path/to/private/dhole-state \
  --dry-run
```

Run without `--dry-run` to apply. Uninstall does not remove credentials or
rewrite agent instructions. Revoke the machine from the central server's
connection screen to invalidate its authorization. Delete its private state
directory separately if it is no longer needed.

`dhole-node --help`, all dry-run commands, and the fixture tests perform no
live pairing, GitHub authorization, provider calls, or service changes.
