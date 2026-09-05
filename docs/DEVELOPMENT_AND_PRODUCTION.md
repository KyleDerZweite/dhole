# Development and production

Dhole runs one central server with its web build. Execution nodes run on their
hosts and connect outward. Production packaging uses Podman and optional
Pangolin Newt. The local fixture workflow needs neither a container nor an
external service.

## Local preview

Use Node.js `>=24.15 <25` and pnpm 10.x:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds every workspace and starts `apps/server/dist/index.js`.
Defaults are [http://127.0.0.1:4173](http://127.0.0.1:4173) and
`./data/dhole.db`. The first-run screen creates an administrator and a session. The bootstrap
endpoint is `POST /api/auth/bootstrap`; it requires a password of at least 15
characters. Production bootstrap additionally requires the deployment
operator's one-time bootstrap secret.

`pnpm demo` builds and starts a fixture server plus a temporary fake node.
Its default database is `./data/dhole-demo.db`. Demo mode is rejected in
production. It includes deterministic records and the demo credentials listed
in [README](../README.md).

Use an unused port and separate database when another server exists. From a
development shell without production credentials, for example:

```sh
preview_dir=$(mktemp -d /tmp/dhole-preview.XXXXXX)
NODE_ENV=development DHOLE_AUTH_MODE=password DHOLE_MODULES=all \
  DHOLE_HOST=127.0.0.1 DHOLE_PORT=4273 \
  DHOLE_PUBLIC_ORIGIN=http://127.0.0.1:4273 \
  DHOLE_ALLOWED_HOSTS=127.0.0.1,localhost \
  DHOLE_DATABASE="$preview_dir/dhole-demo.db" pnpm demo
```

The demo also creates per-process fake-node state under `data/`. Stop it with
Ctrl-C. Do not reuse a production database, load a deployment environment,
initialize live Mediation, or connect an existing machine for preview work.
The server does not load `.env` itself. Compose reads its deployment `.env`.

## Module checks

`DHOLE_MODULES=none` starts Core and Access. `all` enables the complete compiled
set of Coordination, Gateway, and MCP. For example,
`DHOLE_MODULES=coordination,mcp` adds coordination and its MCP boundary. Core
sessions, runtime configuration, and machine transport remain available with
every optional module disabled. Disabled modules contribute no routes, navigation,
WebSocket handlers, or background work. Migrations still run. See
[Adding a module](ADDING_A_MODULE.md) for the exact dependency table.

## Verification

```sh
pnpm verify
```

The gate runs `format:check`, `lint`, `typecheck`, `test:run`, `test:clients`,
`build`, `smoke:runtime`, `smoke:session`, `smoke:onboarding`, and
`check:deployment`. Focused tests can be run while iterating,
then the full gate is required before completing a change. Build and tests
use local fixtures and temporary databases. They do not validate installed
runtime accounts, spend model quota, or change existing services.

The [acceptance record](ACCEPTANCE_TRACEABILITY.md) separates historical
fixture evidence from the current release result. See [MVP status](MVP_STATUS.md)
for the issue #2 delivery mapping.

## Production preparation

Follow [Deployment](DEPLOYMENT.md) for `Containerfile`, `compose.yaml`,
replacement environment markers, native account bootstrap, optional GitHub
linking, keys, Newt configuration,
artifact checks, and backup/restore. The package serves server and web from
one Dhole container and keeps CPA external. Nodes remain host processes.
Preparing or validating these files does not start a deployment.

Set the public HTTPS origin and matching allowed host. The trusted reverse
proxy must preserve `Host` and `Origin` and forward WebSocket upgrades for
`/ws/app` and `/ws/node`, which both belong to Core. Nodes use WSS outside
loopback. Production cookies are secure; a wrong origin causes authentication
or CSRF failures rather than a fallback to an unsafe connection.

Keep master keys outside the image and Git. `DHOLE_MASTER_KEY_ID` selects the
key for new secret envelopes; retain prior keys while rows still use them.
The matching SQLite backup and encryption keys are both needed for recovery.
A prior binary may not understand a later schema, so binary rollback alone is
not database rollback.

## Storage and shutdown

SQLite uses WAL, foreign keys, a five-second busy timeout, and
`synchronous=NORMAL`. Startup applies numbered migrations and verifies their
stored SHA-256 checksums. Never edit an applied migration. Disabling a module
does not skip migrations or remove history.

For backups and restore, use the stopped-server procedure in
[Deployment](DEPLOYMENT.md). Preserve database ownership, modes, any WAL
sidecars belonging to the snapshot, and the referenced encryption keys.
Validate a restored copy before relying on it.

On `SIGINT` or `SIGTERM`, the server stops module maintenance and WebSocket
work, drains the outbox, closes the listener, and closes SQLite. A ten-second
safety timeout bounds listener shutdown. Stop host node processes separately.
Their durable journals reconcile incomplete commands when they reconnect.

## Gateway fixtures

Gateway fixture routes and `apps/server/src/demo/fake-cliproxy.jsonl` are
available only outside production. Import retained JSON/JSONL through
`POST /api/gateway/connections/:id/ingest`. Health and catalog refresh are
bounded, allowlisted server requests. No fixture result establishes live CPA
compatibility or complete upstream usage coverage. See
[Gateway administration](GATEWAY_AND_CPAMP_REPLACEMENT.md) for supported
operations and their exact limits.
