# Development and production operations

Dhole runs as one central server process plus one outbound `dhole-node` process
per execution machine. The web build is served by the server; there is no
container, queue service, database service, or browser-to-node connection.

## Development loop

From the repository root, with Node.js 24.15+ and pnpm 10.x:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

`pnpm dev` rebuilds and starts `apps/server/dist/index.js` on
`http://127.0.0.1:4173` (override with the `DHOLE_*` server variables). Use
`pnpm demo` for a complete local graph with a fake node and fixtures. The
server runs migrations when it opens `DHOLE_DATABASE`; no separate migration
binary is required.

The verification commands are intentionally explicit:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
# or run the same gates as one command:
pnpm verify             # also runs smoke:runtime and smoke:session after the build
```

Targeted examples:

```sh
pnpm --filter @dhole-control/server test:run src/lib/database.test.ts
pnpm --filter @dhole-control/server test:run src/modules/gateway/index.test.ts
pnpm --filter @dhole-control/node test:run src/journal.test.ts
```

Do not use `docker`, `podman`, `kubectl`, `systemctl`, or a global package
install as part of the development workflow.

## Production configuration and build

Use a deployment-owned environment (or secret manager) rather than committing
`.env` files. Production requires a current, matching master key:

```sh
export NODE_ENV=production
export DHOLE_PUBLIC_ORIGIN='https://dhole.example'
export DHOLE_SOURCE_URL='https://github.com/your-org/dhole/tree/v0.1.0'
export DHOLE_ALLOWED_HOSTS='dhole.example'
export DHOLE_MASTER_KEY_ID='v1'
# DHOLE_MASTER_KEYS is JSON: {"v1":"<base64 for exactly 32 random bytes>"}
export DHOLE_MASTER_KEYS='{"v1":"..."}'
```

Generate a key with `openssl rand -base64 32` (or an equivalent approved
secret generator). Keep key material outside Git, logs, crash reports, and
shell history. `DHOLE_MASTER_KEYS` may contain old key IDs during a rotation;
`DHOLE_MASTER_KEY_ID` is used for newly encrypted or rotated provider secrets.
There is no automatic re-encryption job, so retain an old key until every
record using it has been deliberately re-encrypted and verified.

Build and start the single server:

```sh
pnpm install --frozen-lockfile
NODE_ENV=production pnpm build
NODE_ENV=production pnpm --filter @dhole-control/server start
```

The compiled server serves `apps/web/dist` at `/` and falls back to the web
application for client-side routes. Set `DHOLE_DATABASE` to a durable path
(the default is `./data/dhole.db`, resolved from the working directory). The
database directory is created with mode `0700`; the database file is tightened
to mode `0600`.

## Reverse proxy and HTTPS/WSS

Terminate TLS at a trusted reverse proxy and forward ordinary HTTP to the
server's listen address. Configure the externally visible origin, not the
internal hop:

- `DHOLE_PUBLIC_ORIGIN=https://dhole.example`
- `DHOLE_ALLOWED_HOSTS=dhole.example` (hostnames only; ports are stripped for
  the host check)
- `DHOLE_GATEWAY_ALLOWED_HOSTS=...` for explicitly permitted Gateway targets

Preserve the `Host` and `Origin` headers. Forward WebSocket upgrades and
connection headers for both `/ws/app` and `/ws/node`; do not route either path
to a separate service. The browser chooses `wss://` automatically when loaded
over HTTPS, and nodes should use `wss://dhole.example/ws/node`. Production
cookies are `Secure` and `SameSite=Strict`; an incorrect public origin or
missing upgrade forwarding appears as an origin or WebSocket authentication
failure.

The reverse proxy is part of the trust boundary. Enforce its own request-size,
access, certificate, and client-IP policies; Dhole still applies host/origin,
CSRF, object authorization, frame, and payload limits at the application layer.

## SQLite migrations and backups

`openDatabase` enables foreign keys, a 5-second busy timeout, WAL mode, and
`synchronous=NORMAL`, then applies ordered SQL files from
`apps/server/migrations`. Each applied migration stores a SHA-256 checksum;
editing an applied migration causes startup to fail. Migrations are additive
and the immediately previous schema is covered by a test fixture.

For a simple consistent file backup, stop the server first so SQLite has
checkpointed its WAL, then copy the database and any sidecars as one unit:

```sh
db_path="${DHOLE_DATABASE:-./data/dhole.db}"
cp "$db_path" "${db_path}.backup-$(date +%Y%m%d%H%M%S)"
```

If `-wal` or `-shm` files are present, copy them alongside the database in the
same stopped-server snapshot; never mix sidecars from different snapshots.
Restore only while the server is stopped, preserve ownership/mode, and start it
to run pending migrations. The repository does not ship a live-backup or
migration-rollback command; validate a backup by opening a copy before relying
on it.

## CLIProxyAPI fixtures and Gateway

The Gateway accepts an administrator-configured, host-allowlisted management
URL and encrypts its management secret. A configured connection can be checked
or synchronized through:

- `POST /api/gateway/connections/:id/health`
- `POST /api/gateway/connections/:id/sync` (add `?includeUsageQueue=true` when
  the provider exposes that endpoint)
- `POST /api/gateway/connections/:id/ingest` for a local JSON or JSONL import

Development, test, and demo builds expose deterministic local fixtures at
`/api/gateway/fixture` and the `/api/gateway/fixture/v0/management/*` paths.
The source fixture is `apps/server/src/demo/fake-cliproxy.jsonl`; ingestion
normalizes records, hashes them for deduplication, redacts sensitive metadata,
and records exact/approximate correlation. Fixture endpoints return 404 in
production. Never point a production connection at `fixture.invalid` or put a
real management secret in a fixture.

## Shutdown and restart

The server handles `SIGINT` and `SIGTERM`: it stops maintenance, flushes the
event outbox, closes app subscriptions and WebSockets, closes the HTTP server,
and closes SQLite. A 10-second safety timeout exits if the listener cannot
drain. Stop the node process separately; when restarted it reconnects outward,
reports its journal, and reconciles incomplete operation keys. Plan node and
server restarts together when rotating credentials.

## Operational boundaries

Keep `DHOLE_DATABASE`, node state directories, and repository roots on storage
with restricted ownership. Do not expose the node WebSocket as a public browser
API, enable demo mode in production, or send provider credentials in command
bodies. Live runtime/provider, hardware, and reverse-proxy validation is
outside the local test suite; see [Acceptance traceability](ACCEPTANCE_TRACEABILITY.md)
for the exact fixture and external-unverified boundaries.
