# Podman deployment preparation

This package runs one Dhole central server and one Pangolin Newt client. Dhole
serves the built web app and stores its SQLite database in a named volume. The
existing CLIProxyAPI instance stays external. Execution daemons run on their
hosts later and connect outward to Dhole over WSS.

Native Dhole accounts are the default. Local and Codeberg repositories need no
GitHub account or GitHub App. An optional Compose override adds GitHub account
linking and repository permission checks to the same server.

The checked-in files and the ignored local `.env` contain placeholders. No
Pangolin site, GitHub App, account, deployment, or live provider connection is
created by these files or the checks below. Stop after local verification until
deployment is authorized.

## Requirements

Use rootless Podman with a Compose provider that supports `service_healthy`,
`userns_mode`, and Podman's volume options. Local syntax verification uses
`podman-compose` 1.5.0 with Podman 5.8.4. This Compose file targets Podman; its
`keep-id` and `:U` options are not Docker Engine options.

The server image uses Debian Bookworm's glibc and Node.js 24.19.0. The build
installs pnpm 10.29.2, compiles the shared contracts, server, and web, and copies
only production server dependencies into the final image. Python, make, and g++
are available in the build stage for `better-sqlite3`'s native-build fallback.
Dependency install scripts are disabled. The production SQLite dependency is
explicitly rebuilt with npm after pnpm deployment and opened against an
in-memory database during the build. No execution runtime or node daemon is installed in
the image.

Node and Newt images are pinned by tag and manifest digest. The Node 24.19.0
Bookworm-slim tag and digest were checked against Docker Hub's public registry
on 2026-09-05. Newt 1.16.0 and its digest come from the
[upstream release](https://github.com/fosrl/newt/releases/tag/1.16.0).

Compose defines the server healthcheck explicitly. Podman's default OCI image
format does not retain a Containerfile `HEALTHCHECK` instruction.

## Configuration to fill in later

If `.env` does not exist, copy `.env.example` with permissions restricted to
your user. Preserve any existing file. Never commit `.env`, private PEM files,
database files, or rendered Compose output containing real credentials.

| Variable | Value to supply |
| --- | --- |
| `DHOLE_PUBLIC_ORIGIN` | The HTTPS origin visitors will open, with no path. |
| `DHOLE_ALLOWED_HOSTS` | Its hostname, without scheme or port. |
| `DHOLE_MASTER_KEY_ID` | The ID of the active encryption key. |
| `DHOLE_MASTER_KEYS` | A JSON object mapping key IDs to base64 values, each decoding to exactly 32 random bytes. Keep the active key and any old keys still needed to decrypt stored secrets. |
| `DHOLE_BOOTSTRAP_TOKEN` | At least 43 characters encoded from 32 random bytes, required to create the first native administrator account during the later setup. |
| `DHOLE_GATEWAY_ALLOWED_HOSTS` | Comma-separated hostnames Dhole may contact for the existing CPA management API. Empty denies those requests. |
| `DHOLE_MODULES` | `all`, `none`, or comma-separated compiled module IDs. Core and access remain enabled. Selected modules must include their dependencies. |
| `PANGOLIN_ENDPOINT` | The HTTPS endpoint from your Pangolin site's Newt configuration. |
| `NEWT_ID` | The Newt site ID from Pangolin. |
| `NEWT_SECRET` | The site's Newt secret from Pangolin. |

The base deployment needs a public hostname, encryption keys, a bootstrap
secret, and the Pangolin site credentials. It fixes `DHOLE_AUTH_MODE=password`,
`NODE_ENV=production`, and `DHOLE_DEMO=false`. The bootstrap token protects
creation of the first native administrator; it is not an account password.
Keep it out of browser URLs and logs. Once setup has created the first account,
the setup route cannot create another initial administrator. This preparation
does not generate the token or create an account.

Replacing only one placeholder does not make the sample usable. Invalid
configuration prevents startup. Newt waits for the Dhole health check before
starting.

The server receives only its listed settings; Newt receives only its own
credentials. Neither receives the other service's secrets. CPA management
credentials are entered through the authenticated Dhole Gateway later and
encrypted using the master key. They do not belong in Compose, browser
responses, provider fixtures, or node command bodies.

## Optional GitHub integration

Leave the commented GitHub settings in `.env.example` unused unless you want
GitHub account linking and repository permission checks. Native accounts and
local or Codeberg repositories work with `compose.yaml` alone.

To configure the integration later, fill in the optional settings and select
`compose.github.yaml` after `compose.yaml` when invoking Compose. The override
adds environment settings and a private-key mount to Dhole, with no extra
process. Native account sign-in remains enabled.

| Optional variable | Value to supply |
| --- | --- |
| `DHOLE_GITHUB_CLIENT_ID` | The GitHub App's client ID for user authorization. |
| `DHOLE_GITHUB_CLIENT_SECRET` | The GitHub App's client secret. |
| `DHOLE_GITHUB_APP_ID` | The app's numeric App ID, distinct from its client ID. |
| `DHOLE_GITHUB_APP_PRIVATE_KEY_PATH` | An existing host file containing that app's RSA private PEM, with mode 0600. Use an absolute path or a path relative to `compose.yaml`. |

Set the app's callback URL to
`<DHOLE_PUBLIC_ORIGIN>/api/auth/github/callback`. Install it on the repositories
Dhole should check and grant the permissions described in
[Access control](ACCESS_CONTROL.md). Account linking and repository permissions
are separate checks. The override requires all four settings; an invalid or
unreadable key prevents startup only when the override is selected.

## Pangolin routing

Create or select the Pangolin site later. Add an HTTP resource with the chosen
public hostname and a target of `http://dhole:4173` through that site. Newt
resolves `dhole` on the private Compose bridge. The three environment variable
names follow the upstream
[Newt installation guide](https://docs.pangolin.net/manage/sites/install-site).

Pangolin must preserve the public `Host` header and the browser's `Origin`, and
forward WebSocket upgrades for `/ws/app` and `/ws/node`. If GitHub linking is
enabled, keep its callback reachable through the same HTTPS origin. If Pangolin adds an
interactive login page, node WebSockets and machine API calls need a route
policy that lets Dhole authenticate their credentials; an HTML login redirect
cannot authenticate a node. Validate that policy with fixtures before enrolling
a real node.

Compose publishes no host ports and mounts no container socket. Both services
use a private bridge with outbound access. `internal: true` would block the
GitHub API, external CPA management API, and Newt's connection to Pangolin.
Pangolin terminates TLS, then Newt forwards HTTP inside the private bridge.

If the existing CPA API runs on the Podman host, `localhost` inside Dhole does
not reach it. Use a deliberately configured address reachable from the
container, such as Podman's `host.containers.internal` where supported, and
allowlist that exact hostname. Reachability and the CPA listener's binding
must be checked later without changing that existing service during packaging.

## Storage and process permissions

The server runs as UID/GID 1000 with a read-only root filesystem. The named
`dhole-data` volume at `/app/data` stores `dhole.db`, WAL, and SHM files. Keep
one server replica per volume. Compose prefixes the volume name with the
project name, normally `dhole_dhole-data`; changing the project name selects a
different volume.

The image creates `/app/data` with owner 1000 and mode 0700. Podman's `:U`
volume option sets the named volume's ownership for that container user. It
can walk the volume recursively at startup. The nonroot entrypoint sets the
mounted directory's mode to 0700 before executing Node because a newly created
Podman volume starts with mode 0755. Rootless
`keep-id:uid=1000,gid=1000` maps the invoking host user to the server's UID so a
host-owned private key with mode 0600 remains readable without making it
world-readable. Use the same rootless Podman user for future starts and backups.

When the optional override is selected, the GitHub App key mounts read-only at
`/run/secrets/github-app.pem`. The `:Z`
option applies a private SELinux label. Store a dedicated copy under an ignored
directory such as `secrets/`, rather than relabeling a key another service uses.
Named volumes receive Podman's volume labels automatically. Do not disable
SELinux to resolve an ownership or path error.

Both services drop Linux capabilities and prohibit privilege escalation. Each
has a bounded writable `/tmp` tmpfs; Podman also supplies its standard runtime
tmpfs mounts. Newt stores its
temporary configuration and connection health file there. No network device or
`NET_ADMIN` capability is needed for Newt's userspace tunnel.

The entrypoint replaces itself with Node, which receives SIGTERM directly.
Compose allows 20 seconds for shutdown; Dhole's existing drain timeout is 10
seconds. Migrations run on startup and reject changed migration checksums.
Migration 015 revokes existing catalog tokens because they lack issuer
provenance. Issue replacement catalog tokens after that upgrade.
Back up the database and master keys before upgrading. Stop Dhole, copy the
whole volume as one snapshot, and restore ownership when restoring it. Include
any SQLite sidecars still present. Keep master keys separately from the database
backup and test restoration with a copy. Never remove the volume as part of an
ordinary restart or upgrade. See
[production operations](DEVELOPMENT_AND_PRODUCTION.md) for migration and key
rotation details.

## Later recovery of a sole administrator

If the sole active native administrator loses access, the operator can
issue a reset link with the packaged recovery command. This is a future
operator action, not part of deployment preparation or local verification.

Stop the server and take a consistent backup first. Run the matching image as
a temporary container under the database-owning UID/GID, with the existing
database volume and a private output directory mounted. Use the same rootless
user mapping as the server. The recovery command needs no network connection.
Inside the packaged image, its command shape is:

```sh
node /app/apps/server/dist/recover-account.js \
  --database /app/data/dhole.db \
  --email administrator@example.invalid \
  --output /app/data/recovery-link.json \
  --origin https://dhole.example.invalid
```

Replace the email and origin with the existing administrator and public Dhole
origin. All paths must be absolute. The database must already exist, belong to
the invoking UID, have no group or other permissions, and have no symbolic or
hard links. Its directory and the output directory must belong to that UID,
have no symbolic links, and not be writable by group or others. The command
does not create directories or a database, run migrations, or bypass the sole
administrator check. Use a new output filename each time.

The command writes an exclusive mode-0600 JSON file containing `setupUrl` and
`expiresAt`; stdout reports only the output path. Keep that file private and
out of logs and shared backups. The reset link expires after one hour. Issuing
a replacement invalidates earlier unused reset grants. Restart the server,
open the link privately, choose a password, and sign in normally. Consuming
the link revokes existing sessions, API tokens, device credentials, and other
pending grants. Delete the
private output file after use. See [Access control](ACCESS_CONTROL.md) for the
account recovery and revocation rules.

## Local verification only

Run from the repository root:

```sh
pnpm verify
node scripts/deployment-check.mjs
podman-compose --env-file .env.example -f compose.yaml config --quiet
podman build --file Containerfile --tag localhost/dhole:local .
node scripts/deployment-check.mjs --image localhost/dhole:local
```

The deployment check reads only `.env.example`, confirms that the placeholders
fail production validation, checks Compose syntax when `podman-compose` is
installed, and confirms that missing required settings fail Compose parsing.
It checks the optional GitHub override using fixture strings without opening a
private key file.
Without `--image`, it does not read `.env`, create accounts, start services, or contact Pangolin,
GitHub, or a model provider. Avoid `compose config` without `--quiet` after
adding credentials, because the rendered output includes environment secrets.

The explicit `--image` check starts a temporary fixture server with no network,
no published ports, a read-only root filesystem, and a temporary named volume.
It verifies native SQLite, migrations, static files, host checks, empty account
state, UID/GID 1000, the configured healthcheck, SIGTERM shutdown, and database
survival after recreating the container. It removes its own container and
volume afterward. It never starts Newt or creates an account.

Image building fetches public images and dependencies. It creates no running
deployment. Build success and local checks cannot verify a real Newt tunnel,
TLS routing, GitHub App installation, OAuth callback, CPA reachability,
SELinux mount behavior, or an execution host. Those checks require a separately
authorized deployment. Do not run Compose `up`, create live credentials, or
enroll a node as part of this preparation.
