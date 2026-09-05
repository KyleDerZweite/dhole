# Gateway and CPA administration

CPA remains the inference service and account authority. Native runtimes and
clients call CPA through their configured provider path. Dhole's optional
`gateway` module stores sanitized observations, explicit model policy,
request history, and administration audit records. The browser calls Dhole
only. There is no inference forwarding, browser management passthrough,
generic upstream RPC, shell endpoint, or Docker socket control.

Select `DHOLE_MODULES=gateway` to use Gateway with Core and Access. The full
application can include it alongside the other modules. Gateway is not a
requirement for native accounts, machine authorization, or Coordination.

## Connections and credentials

An administrator creates a connection with
`POST /api/gateway/connections`. The body contains `name`, `baseUrl`,
`managementSecret`, optional `catalogSecret`, `enabled`, and `retentionDays`.
The catalog credential is a CPA inference/catalog credential, separate from
its management credential. A consumer token for Dhole's catalog projection is
a third, narrower credential.

`DHOLE_GATEWAY_ALLOWED_HOSTS` controls exact allowed hostnames or hosts with
ports. The production example starts with no allowed destinations. URLs must
be HTTP or HTTPS, with no userinfo, query, or fragment. The server validates
the stored destination before requests, denies redirects, bounds the complete
response body to 512 KiB, and applies a whole-request timeout. Management
credentials use encrypted AES-GCM envelopes with external versioned keys.
Public records show only configured/not-configured flags.

Every connection has an existing Runtime provider identity. Gateway updates
that identity's endpoint and enablement; the operator does not create a
second Provider record just to use Gateway. Discovery uses the existing model
policy rows rather than maintaining a second enabled-model list.

| Method | Path under `/api/gateway` | Behavior |
| --- | --- | --- |
| `GET`, `POST` | `/connections` | List safe metadata or create a connection |
| `PATCH` | `/connections/:id` | Edit name, endpoint, enabled state, or retention with `expectedRevision` |
| `POST` | `/connections/:id/secrets` | Replace management and/or catalog credential with `expectedRevision` |
| `POST` | `/connections/:id/archive` | Disable and archive while retaining history |
| `DELETE` | `/connections/:id` | Mark deleted, remove stored credentials, retain history |
| `GET` | `/connections/:id/revisions` | Read immutable sanitized connection revisions |
| `POST` | `/connections/:id/rollback` | Restore nonsecret metadata from `targetRevision`, subject to current revision |
| `POST` | `/connections/:id/health` | Bounded management health check returning safe status |
| `POST` | `/connections/:id/sync` | Health synchronization; ordinary use imports no usage records |

Changes reject stale Dhole revisions. Connection metadata rollback does not
restore old credentials, undelete a connection, reverse an upstream account
change, or reactivate a key revoked by CPA. Active endpoint, credential, and enablement changes check the candidate
management endpoint before activation. Catalog credential changes and endpoint
changes with a catalog credential also check the catalog response. The server
rechecks the revision after network I/O. Disabled edits wait for validation
on enablement. These bounded checks establish endpoint acceptance, not live
model execution.

The legacy queue-import path is an explicit administrator operation:
`POST /connections/:id/sync?includeUsageQueue=true&acceptDataLoss=true`.
It reads CPA's destructive usage queue. CPA can remove records before Dhole
commits them, so a timeout, crash, or competing consumer can permanently lose
records. The two flags acknowledge that loss; they do not provide a cursor,
acknowledgment protocol, or delivery guarantee. No automatic queue polling
runs. Prefer a retained-file import or producer push when preserving coverage
matters.

## Model catalog

The catalog parser accepts bounded OpenAI `data[]` and CPA Codex-style
`models[]` envelopes. It validates at most 2,048 complete entries, rejects
malformed or duplicate IDs, strips unsupported fields, and preserves declared
reasoning order. Generic input is not silently truncated at 100 models.

Successful refreshes create immutable snapshots with source connection and
provider, endpoint shape, client version when supplied, connection revision,
observation time, content hash, and deterministic added/removed/changed IDs.
Canonical reordering does not create a model change. Failed refreshes retain
the last valid snapshot and expose the failed attempt. One hour without a
successful observation marks it stale.

New models default disabled. Refresh preserves explicit enabled policy and
submitted capability evidence. Removal leaves history but removes the ID from
the effective selection; a returning ID keeps its prior explicit policy.
Changing the source revision makes the old observation stale and excludes it
from the effective catalog until a successful refresh.

| Method | Path under `/api/gateway` | Behavior |
| --- | --- | --- |
| `GET` | `/connections/:id/catalog` | Snapshot, diff, freshness, declarations, policy, and evidence |
| `POST` | `/connections/:id/catalog/refresh` | Refresh with optional `clientVersion` |
| `PATCH` | `/connections/:id/catalog/models/:modelId` | Set `{enabled: boolean}` explicitly |
| `GET`, `POST` | `/connections/:id/catalog/tokens` | List metadata or issue a scoped token for `generic`, `opencode`, or `codex` |
| `DELETE` | `/connections/:id/catalog/tokens/:tokenId` | Revoke a projection token |
| `GET` | `/catalog/v1/:connectionId/:client` | Pull-only versioned effective catalog with dedicated bearer token |

Tokens are issued once, hashed at rest, connection/client scoped, and
revocable. Requested lifetime is 1 to 30 days. An agent-issued token also
records its parent API/device authority and expires no later than either
parent, so its actual lifetime may be much shorter. Use the returned expiry.
Parent revocation or scope change permanently revokes descendants. Current
native project access and administrator authority are checked on use.
Browser-issued tokens retain user authority and are permanently revoked by
password reset, account disablement, or administrator demotion.

Migration `015_gateway_catalog_authority.sql` revokes all older catalog tokens
because their issuer provenance was not recorded. Reissue them after upgrade;
copying an old private file cannot restore that authority.

The projection authenticates before conditional handling and uses private caching with an ETag over the full representation,
including policy and freshness. A stale last-known catalog is labeled stale;
it is not a live availability guarantee. Disabled sources have no effective
models. Provider, management, and node credentials never enter projections.

Declared tool/image/reasoning metadata is an upstream statement. The Runtime
probe API stores administrator-submitted evidence with `verified: false`; it
does not perform a live measurement. Legacy boolean capability records are
shown as `unknown` so they do not masquerade as verified outcomes or break a
catalog read. The catalog's compatibility flags mean
that a projection can represent the observed metadata, not that an installed
client or model has passed an execution test.

The optional [OpenCode startup plugin](../clients/opencode/README.md) passed
the actual OpenCode 1.18.27 startup fixture in isolated configuration, data,
and cache directories. It fetches through the client's config hook, replaces
only a dedicated provider's in-memory model list, and keeps CPA inference and
native credentials unchanged. It does not rewrite saved client configuration
or select a default model. Scoped stale responses retain current policy with
a warning; revoked tokens, failed reads, malformed data, or valid empty
catalogs clear that dedicated selection. The private settings file identifies
the provider, so its saved model map should remain empty if that file cannot
be read. Other providers remain available.

Codex native discovery depends on its installed version and authentication
configuration. The inspected app-server supports `model/list`, but an ordinary
custom provider with an environment API key does not necessarily use the same
refresh path as the Codex backend or command authentication. The generic and
Codex projection shapes do not establish installed-client integration. See
[Issue #2 review](reviews/issue-2.md), [MVP status](MVP_STATUS.md), and
[Roadmap](../ROADMAP.md).

## Request history and retention

`POST /connections/:id/ingest` accepts retained JSON or JSONL without making
an upstream call. The normalizer keeps bounded scalar usage, latency, status,
model/provider, account references, and correlation evidence. It removes
prompts, messages, bodies, credentials, and unsafe metadata, including
secret-bearing object keys. Permanent receipt hashes prevent duplicate
imports even after detailed request rows are pruned.

The retained history is the coverage Dhole has received. It is not a promise
of complete CPA traffic. `GET /connections/:id/collection` reports collection
mode, last stored time, lifetime accepted count, retained range/count, and
retention settings. No background upstream collector runs.

| Method | Path under `/api/gateway` | Behavior |
| --- | --- | --- |
| `GET` | `/requests` | Paginated normalized records and filters |
| `GET` | `/summary` | Observed request, token, estimated-cost, failure, and account summaries |
| `GET` | `/usage` | UTC hour/day buckets grouped by none, provider, model, or auth index |
| `GET` | `/requests/export` | Bounded JSON/JSONL pages with team/filter-bound cursors |
| `GET` | `/accounts` | Sanitized observed account health, quota, and cooldown fields |
| `GET` | `/connections/:id/collection` | Explicit import/push coverage and retention metadata |
| `POST` | `/connections/:id/prune` | Bounded retention prune, including `dryRun` |
| `GET`, `POST` | `/prices` | Effective-dated manual price overrides |

Request filters include connection, provider, model, auth index, failed state,
status code, occurrence range, and correlation confidence. Lists allow at most
500 rows; usage queries at most 1,000 groups. Export pages contain at most 500
rows and 2 MiB, with stable receipt ordering that excludes later inserts.
Concurrent pruning can remove detail rows before a later export page reads
them. Export is not a backup of the database or immutable history.

The Gateway lifecycle starts a retention cycle after startup and then hourly.
It processes bounded batches across connections, including disabled/archived
connections, without upstream requests. It deletes request details only.
Receipt hashes, catalog snapshots, events, and audits remain. Disabling the
Gateway module stops its retention hook too.

Correlation labels are evidence-ranked: an accepted session ID is `exact`,
a runtime turn match is `high`, project plus nearby session time is `medium`,
a project reference alone is `low`, and absent evidence is `none`. A heuristic
match never becomes exact through presentation.

Price overrides use integer micro-USD per million tokens, effective dates,
model patterns, optional service tier, and context thresholds. Explicit zero
is a rate. Missing cost remains unknown. Usage responses report unpriced
requests separately and totals are estimates, not invoices. Provider quota
and estimated spend are different observations.

## Accounts, settings, and provider consent

Account refresh reads permitted status fields from CPA's auth-file list.
Dhole does not download or return credential files. The supported mutation is
an explicit disabled/enabled change for a file-backed account, with current
connection revision and expected account state. Missing quota windows, reset
times, or cooldown evidence remain unknown.

Typed configuration editing supports only `request-retry`,
`max-retry-credentials`, `max-retry-interval`, and `routing/strategy`.
`GET /connections/:id/config`, `POST .../config/preview`, and
`POST .../config/apply` return a sanitized diff and record immutable history.
The request includes current connection and config revisions. CPA has no
atomic compare-and-swap contract for these writes, so conflict detection is
best effort across management clients. Dhole does not expose raw YAML or
claim that a local revision prevents every external race.

Supported provider-consent flows are Codex, Anthropic/Claude, and Antigravity:

1. Start through `POST /connections/:id/oauth` with provider and current revision.
2. Open the validated provider authorization URL and complete its consent.
3. Copy the resulting localhost callback URL, even if the local browser page cannot connect, and submit it through `POST /connections/:id/oauth/:flowId/callback`.
4. Poll `GET /connections/:id/oauth/:flowId` for completion, or `DELETE` that path to cancel.

Flows are bound to the authenticated administrator, team, connection revision,
and a five-minute expiry. Dhole parses the callback without fetching it and
forwards its transient code to CPA. A submitted callback is not yet completed
consent. CPA retains provider credentials. Dhole starts no callback listener
and copies no provider credential into the browser, command history, or
client configuration.

## Typed agent administration

Pair with `connect --gateway` and have an administrator approve the requested
Gateway read and management scopes. Use `dhole-node gateway --project ID
--action JSON` or the local bridge's `gateway_manage` tool. The helper pins the
native project used to derive team-level Gateway authority, and requests only
the single required scope for each operation.
It keeps machine and project credentials private and requires no Coordination
session.

`GatewayActionSchema` in `apps/node/src/gateway-client.ts` defines these 25
operations:

| Area | Action names |
| --- | --- |
| Connections | `connections.list`, `connections.create`, `connections.update`, `connections.rotate`, `health`, `sync` |
| Catalog | `catalog.read`, `catalog.refresh`, `models.policy`, `tokens.list`, `tokens.issue`, `tokens.revoke` |
| Accounts | `accounts.list`, `accounts.refresh`, `accounts.status` |
| Settings | `config.read`, `config.preview`, `config.apply` |
| Observations | `collection`, `usage`, `requests` |
| Provider consent | `oauth.start`, `oauth.status`, `oauth.callback`, `oauth.cancel` |

Creation and rotation take an absolute `secretFile` reference to an owned
private regular JSON file containing `managementSecret` and/or `catalogSecret`.
Creation requires the management secret. Callback submission similarly reads
`redirectFile` containing `redirectUrl`. These files are bounded to 64 KiB;
on Unix they must have no group/other permissions and cannot be symlinks.
Secrets never belong in action JSON or model arguments.

`oauth.start` writes the authorization URL to a private local file and returns
`authorizationFile` metadata. `tokens.issue` writes the issued catalog token
privately and returns `credentialFile` metadata. For `client: "opencode"`, that
file is already the plugin's strict settings file, including its selected
provider, connection, endpoint, and token. Set `DHOLE_OPENCODE_CATALOG_CONFIG`
to its returned path. The default dedicated provider is `dhole-cpa`;
`openCodeProvider` can choose another `dhole-` provider.

The action union is narrower than the HTTP administration API. It includes no
archive/delete/rollback, history export, ingestion, queue consumption, price
changes, or prune action. Its `sync` performs the ordinary nonconsumptive
health path. It cannot select server modules, administer human accounts,
enroll nodes, configure unrelated runtime providers, or send an arbitrary
HTTP request. Use the owning browser/API workflow for other supported
operations. [Client setup](../clients/README.md) has the command examples.

## Verification boundary

Catalog, management, request import/export, retention, and authorization tests
use local fixtures. The OpenCode test executes only `models --verbose` against
a loopback catalog with isolated state and no inference request. The inspected upstream contract is CPA v7.2.151 at commit
`5208aec703b5ce7e3445f6e9d91cc13b3e78003a`; this is evidence for fixture design,
not a live compatibility certificate for an installed CPA instance.

Gateway fixtures are unavailable in production. Preparation does not contact
or change a live CPA, provider, CPAMP, or Dhole deployment. The complete
replacement scope and deliberate gaps are recorded in
[MVP status](MVP_STATUS.md) and [Roadmap](../ROADMAP.md).
