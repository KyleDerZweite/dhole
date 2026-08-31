# Gateway and CPAMP replacement

## Boundary and responsibility

CLIProxyAPI remains the provider proxy. Dhole does not replace its
OpenAI/Gemini/Claude-compatible request path, route provider calls through the
browser, or embed the CLIProxyAPI/CPA Manager Plus applications. Dhole's
`gateway` module replaces CPAMP's primary dashboard and history views: the
central server makes bounded management reads from a configured proxy, stores a
normalized/redacted history in SQLite, and serves the Gateway dashboard to
authorized team members.

The browser communicates only with Dhole. Gateway management calls originate
from the Dhole server. There is no browser proxy, `/api-call` passthrough,
generic management RPC, or shell endpoint. The implementation and this guide
were verified with the Gateway module, migration, fixture routes, and tests.
No live CLIProxyAPI, CPAMP, provider, or Dhole instance was contacted,
restarted, reconfigured, or otherwise changed while preparing this document.

## Configure a connection

Gateway hosts are operator-controlled by `DHOLE_GATEWAY_ALLOWED_HOSTS`, a
comma-separated exact hostname/host allowlist (default:
`127.0.0.1,localhost`). A connection is created by an administrator with:

```http
POST /api/gateway/connections
Content-Type: application/json
Cookie: dhole_session=...; dhole_csrf=...
X-CSRF-Token: ...

{
  "name": "local CLIProxy",
  "baseUrl": "http://127.0.0.1:8787",
  "managementSecret": "proxy-management-bearer",
  "enabled": true,
  "retentionDays": 30
}
```

The Zod boundary requires a 1–120 character name, a 1–2,048 character URL,
and a 1–16,384 character management secret. `enabled` defaults to `true`;
`retentionDays` defaults to 30 and is bounded to 1–3,650. `baseUrl` must be
`http` or `https`, must not contain URL credentials, a query, or a fragment,
and its hostname (or host including port) must exactly match the allowlist.
Trailing slashes are normalized. Duplicate names in a team return `409`.

The secret is encrypted before persistence with the shared security envelope:
AES-256-GCM, a random nonce, external versioned 32-byte keys from
`DHOLE_MASTER_KEYS`, the current `DHOLE_MASTER_KEY_ID`, and record-bound
associated data `gateway:<connectionId>:management`. SQLite stores only the
encrypted provider-secret envelope and its key id. Production refuses to
start without a matching current master key. The secret is never returned by
the connection list, placed in an event, logged, or sent to the browser. It is
used only as the server-side `Authorization: Bearer` header on a management
request.

There is currently no connection update/delete route. To change a secret or
URL, an administrator must use a planned management workflow; do not edit the
database by hand in production.

## Exact connection and synchronization routes

All routes below are served by the Dhole origin and are team-authorized. A
human administrator is required for configuration and ingestion; members can
read and refresh data.

| Method | Path | Access and behavior |
| --- | --- | --- |
| `POST` | `/api/gateway/connections` | Administrator; validates URL/secret and creates the encrypted connection. |
| `GET` | `/api/gateway/connections` | Team member; lists name, base URL, enabled/status, timestamps, error summary, and retention setting (never the secret). |
| `POST` | `/api/gateway/connections/:id/health` | Team member; server performs `GET <baseUrl>/v0/management/config` with the decrypted bearer, JSON accept header, a bounded timeout (default 5 seconds, capped at 60 seconds), and redirect following disabled. |
| `POST` | `/api/gateway/connections/:id/sync` | Team member; health-checks `v0/management/config`, then returns a zero-record sync unless queue import is explicitly enabled. Current CLIProxyAPI has no non-destructive aggregate usage export; normal traffic arrives via import/push. Add `?includeUsageQueue=true` only when an operator explicitly accepts queue consumption. |
| `POST` | `/api/gateway/connections/:id/ingest` | Administrator; imports a JSON/JSONL/array/object fixture or historical export without making an upstream call. |

Health marks a connection `healthy` on a 2xx response, `degraded` on a
non-2xx response, and `unavailable` on a transport, timeout, URL, or secret
failure. `sync` marks failures unavailable and records only a bounded error
summary.

`includeUsageQueue=true` performs a second `GET` on
`/v0/management/usage-queue?count=1000`. Some CLIProxyAPI versions consume or
clear that queue as it is read. The default is `false`; no implicit queue read
exists. Redirect responses from any management request are denied (`redirect:
manual`) rather than followed to another host.
This is the only intentionally destructive Gateway action in the MVP and is
opt-in per request.

## Request history, filters, and capacity

`GET /api/gateway/requests` returns `{items,total,offset,limit,nextOffset}`
ordered by occurrence time descending. Query parameters are:

```text
connectionId=<id>
provider=<exact provider>
model=<exact served model>
authIndex=<proxy account/auth index>
failed=true|false
statusCode=<integer>
occurredFrom=<ISO timestamp>
occurredTo=<ISO timestamp>
correlationConfidence=exact|high|medium|low|none
limit=<1..500>       (default 50)
offset=<0 or greater> (default 0)
```

The route enforces team ownership of a selected connection. It does not expose
an account-id filter yet; use `authIndex`, provider, model, or connection
filters. Invalid status-code integers return `422`.

`GET /api/gateway/accounts?connectionId=<id>` returns observed provider account
rows: opaque account id, auth index, provider, label, status, redacted quota,
and cooldown timestamp. `GET /api/gateway/summary?connectionId=<id>` returns
totals (requests, failures, token classes, estimated cost, average duration),
provider/model groups, accounts, and capacity counts. Capacity considers
`healthy`, `available`, `ready`, and `ok` account statuses available;
`cooldownUntil` in the future counts as cooling down; `failed`, `error`, and
`unavailable` count as failed.

The dashboard's compact capacity card and its progressive Gateway page are
views over these same routes. CPAMP is not needed at runtime.

## Fixture endpoint and offline import

For local development and demo mode only, the module exposes a deterministic
fake CLIProxy-compatible endpoint. It returns `404` in production:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/gateway/fixture` | `{protocol:"cliproxy.fixture",schemaVersion:1,health,records}` with redacted sample records. |
| `GET` | `/api/gateway/fixture/v0/management/config` | `{usageStatisticsEnabled:true,fixture:true}`. |
| `GET` | `/api/gateway/fixture/v0/management/usage-queue` | Redacted fixture records (the fake queue endpoint ignores the optional `count=1000` query). |

Two records exercise a successful request and a rate-limit failure, token
usage, account index, duration, and redaction. A normal `sync` against the
fixture checks config but imports zero records because the current proxy has no
non-destructive aggregate endpoint. To import fixture data, fetch
`/api/gateway/fixture` and send its body to the administrator-only
`POST /api/gateway/connections/:id/ingest`, or explicitly request queue import
with `POST .../sync?includeUsageQueue=true`. No fixture value is treated as a
live provider credential.

`parseCliProxyRecords` accepts a JSON string (single object, array, or a JSONL
stream), an array, or an object whose `records`, `requests`, `usage`, `items`,
or `data` property contains records. Invalid JSONL identifies the line and
returns `422`.

## Normalization, redaction, and idempotency

The normalizer accepts common CLIProxyAPI spellings for request id, timestamp,
provider, served/requested model, status, endpoint, failure, duration/TTFT,
token usage, account/auth index, project/session references, service tier,
context size, trace reference, and estimated cost. Every stored request has
`schemaVersion: 1` and a canonical SHA-256 `eventHash`.

Before hashing or persistence, request bodies, response bodies, prompts,
messages, completions, usage/account credential objects, and obvious sensitive
metadata are removed or recursively redacted. Sensitive keys include
authorization, cookie, token, secret, password, API key, bearer, credential,
body, prompt, completion, and content; common key/value forms are masked in
strings. Arrays and nested objects are bounded, and free text is length
limited. Account quota and status messages receive the same redaction.

`gateway_requests` is unique on `(connection_id,event_hash)`. Re-importing the
same normalized record reports a duplicate and does not append another
progress event. A newly correlated request appends a redacted Dhole
`progress.changed` event with provider/model/failure/token/cost summary; raw
request bodies never enter the event log.

## Correlation confidence

Gateway correlation is evidence-ranked and explicit in every request view:

| Confidence | Evidence and reason |
| --- | --- |
| `exact` | A supplied `sessionId` matches a Dhole session (`native session id`). |
| `high` | A supplied request id matches `session_turns.runtime_turn_id` (`runtime turn id`). |
| `medium` | A supplied project id is valid and a session was updated within approximately five minutes of the request (`project and near-time match`). |
| `low` | A valid project reference exists but no nearby session matched (`project reference only`). |
| `none` | No trusted Dhole session or project reference was present. |

The server never upgrades a low/medium/none match to exact by guesswork.
Filters can select the confidence label, and the UI shows it next to each
request. A `traceReference` is retained as a redacted opaque field but is not
itself correlation proof.

## Pricing and cost semantics

Price overrides are administrator-managed through:

```http
POST /api/gateway/prices
Content-Type: application/json

{
  "connectionId": "CONNECTION_ID",
  "modelPattern": "gpt-4o*",
  "effectiveFrom": "2026-08-30T00:00:00.000Z",
  "promptMicrousdPerMillion": 5000000,
  "completionMicrousdPerMillion": 15000000,
  "cacheReadMicrousdPerMillion": 0,
  "cacheCreateMicrousdPerMillion": 0,
  "contextThresholdTokens": 0,
  "serviceTier": "standard"
}
```

`connectionId` is required in practice. `modelPattern` is a case-insensitive
exact pattern with `*` wildcard. Rates are integer micro-USD per million
tokens; explicit zero is a real rate, not a missing value. `effectiveFrom`
must be an ISO timestamp with offset. `serviceTier` is an optional exact
match. `contextThresholdTokens` is a strict threshold: an override applies
only when `contextTokens > threshold` (equal does not match). List overrides
with `GET /api/gateway/prices?connectionId=<id>`.

For a matching override, cost is rounded micro-USD:

```text
(input * prompt + output * completion
 + cached * cacheRead + cacheCreation * cacheCreate) / 1,000,000
```

The selector prefers an exact (non-wildcard) model, then the latest effective
timestamp, then the highest applicable context threshold. Null rate fields
fall back to zero. If there is no override/default rate at all, an upstream
`estimated_cost_microusd` is preserved; if neither exists the stored cost is
`null`. Dashboard totals sum these stored estimates and do not claim a billing
invoice.

## What this replaces and what it does not

The MVP replaces the CPAMP dashboard's central operational views with Dhole
views for connections, health, requests, usage, model/provider groups,
failures, account health, quota/cooldown, capacity, correlation, and manual
pricing. It intentionally does not mutate provider accounts or proxy traffic.

Deferred until a separately reviewed management workflow (and tracked in
`ROADMAP.md`):

- Full CPAMP/CLIProxy OAuth credential onboarding and browser consent flows.
- Destructive credential or account deletion, revocation, and rotation.
- Complex provider-account setup and provider-side account mutation.
- Connection edit/delete UI and automatic secret/key rotation tooling.
- Automatic retention pruning (the configured `retentionDays` value is stored
  and displayed, but no cleanup job is wired in this MVP).
- Live provider conformance tests or imports that consume paid model quota.

Safe health refresh, usage synchronization, fixture ingestion, redacted history,
and price overrides are the supported management surface. Existing CLIProxyAPI
and CPAMP deployments remain untouched during development and cutover; point
Dhole at an allowlisted endpoint and verify with the fixture before enabling a
live read.
