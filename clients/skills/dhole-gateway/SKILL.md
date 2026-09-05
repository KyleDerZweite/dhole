---
name: dhole-gateway
description: Inspect or administer a project's CLI API Proxy connections through Dhole. Use for Gateway health, accounts, usage, model catalog, routing settings, provider authorization, or client access tokens.
---

# Dhole Gateway

Use the local `gateway_manage` MCP tool and its advertised action schema.
The bridge uses the selected project and derives a scoped token from approved
machine authorization. Gateway work needs no Coordination session.

1. Call `gateway_manage` with `{"action":"connections.list"}`. Choose the
   connection the user requested by its returned ID. Read its `health` and
   relevant state before changing it.
2. Pick the action that matches the requested result. `accounts.list`,
   `catalog.read`, `config.read`, `collection`, `usage`, `requests`, and
   `tokens.list` inspect state. Each takes `connectionId`.
3. For routing or retry settings, call `config.read`, then `config.preview`
   with the requested change, the connection's `expectedRevision`, and the
   config's `expectedConfigRevision`. Apply the reviewed change with
   `config.apply` when the user has authorized it. A revision conflict requires
   a fresh read and preview. Never reuse a stale revision to force a change.
4. Read the affected state after an applied action and report the observed
   result. Distinguish stored history from a fresh provider observation.

`accounts.status` needs the account revision and previously observed disabled
state. `models.policy` controls whether a catalog model is available to clients.
`catalog.refresh`, `accounts.refresh`, `health` and `sync` contact the configured
proxy. Check the user's intended connection before requesting these calls.

`connections.create` and `connections.rotate` accept an absolute `secretFile`
path to a private JSON file containing `managementSecret` or `catalogSecret`.
The helper reads the file; keep its contents out of tool arguments and output.
`oauth.start` begins a provider authorization flow. Use `oauth.status` to check
it, `oauth.callback` with the private `redirectFile` supplied by the user to
submit a callback, and `oauth.cancel` to stop it. `tokens.issue` saves the client
credential privately and returns a path; `tokens.revoke` invalidates a named
token. Report paths and status without reading secret files into model context.

If MCP is unavailable but the CLI is configured, use the same typed action:

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js gateway \
  --project PROJECT_ID \
  --state-dir /absolute/path/to/private/dhole-state \
  --action '{"action":"connections.list"}'
```

Replace placeholders with the installed paths and intended project. `--dry-run`
previews the chosen action without contacting the server. For authorization or
installation, follow `clients/README.md` in the Dhole checkout. A missing grant requires the
user's machine authorization; it cannot be widened through action arguments.

<!-- DHOLE MANAGED SKILL: dhole-gateway -->
