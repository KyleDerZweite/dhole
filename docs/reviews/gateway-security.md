# Gateway security and correctness review

Reviewed the concurrent Gateway catalog, management, OAuth, and operations implementation against [issue #2's reality review](issue-2.md), the architecture documents, and CPA revision `5208aec703b5ce7e3445f6e9d91cc13b3e78003a`. This review used source inspection, public upstream source, injected fetch implementations, and in-memory SQLite. It made no requests to the user's CPA, consumed no model quota, and changed no running services.

The authors fixed every confirmed finding below. Ten additional independent regression checks passed after those fixes. This is a review of the listed paths, not a claim that arbitrary CPA responses or every client integration have been verified. Repository-wide `pnpm verify` remains the integration owner's check.

## Findings resolved during review

| Initial priority | Trigger and observed failure | Fix verified |
| --- | --- | --- |
| P1 | Imported metadata contained an upstream composite key such as `https://upstream.invalid|opaque-key`. The redactor changed values but retained the credential-bearing key in exports. | The shared metadata redactor rejects unsafe keys. The independent export fixture contains no composite-key credential. See `index.ts`, `redactValue`. |
| P1 | An administrator explicitly consumed a queue containing more than 100 records. The request asked for 1,000, but the general management redactor truncated the response array to 100 after CPA had popped all records. | The bounded queue response reaches record ingestion without that truncation. A 101-record fixture stores all 101 records. See `index.ts`, `sync`. |
| P1 | A single imported request contained a normal `usage` object. Envelope detection unwrapped that field, losing the request ID, model, provider, and timestamp. | Record detection precedes envelope detection. Single-request fixtures preserve their identity and pricing inputs. Non-object records are rejected without creating history. See `index.ts`, `parseCliProxyRecords`. |
| P2 | A gateway URL or catalog credential changed after a successful observation. The previous snapshot still appeared current and remained selectable. | Snapshot provenance includes the connection revision and credential scope. A source mismatch is stale and contributes no effective models until refresh. See `catalog.ts`, `view` and `projection`. |
| P2 | A GitHub identity was disabled while its catalog token remained unexpired. Catalog authentication checked the user and team role but omitted the active GitHub identity requirement. | Catalog authentication now checks the active identity in GitHub mode, matching the other authentication paths. The catalog author's regression covers revocation. See `catalog.ts`, `authenticate`. |
| P2 | A price override existed for a different model, date, tier, or context. Unpriced requests became zero-cost requests. Partial rates also filled unknown charges with zero, and offset timestamps were compared lexically. | Selection checks the applicable override, preserves unknown costs, and compares instants. Independent fixtures cover an unrelated model, a UTC offset, and a missing output-token rate. See `index.ts`, `costFor` and `selectPriceOverride`. |
| P2 | Plain usage or a repeated old import referred to a previously observed account. Ingestion overwrote its current status with `unknown` and advanced its observation timestamp. | Receipt deduplication precedes account updates; absent account evidence preserves existing observations. The independent fixture retains both status and observation time. See `index.ts`, `ingest`. |
| P2 | OAuth finished upstream before an administrator cancelled it. CPA returned `cancelled: false`, but Dhole claimed cancellation. | Dhole polls the actual status when CPA cannot cancel. The independent race fixture reports completion. See `management.ts`, `cancelOAuth`. |
| P2 | An upstream response declared an oversized body or returned a redirect. The early rejection left its fetch transport alive after clearing the timeout. | Fetch cleanup aborts the request on completion and rejection. The independent oversized-response fixture confirms the signal is aborted. See `index.ts`, `fetchGateway`. |

The catalog also preserves CPA's reasoning-effort order instead of sorting it alphabetically. OAuth responses now prohibit caching, authorization URLs accept only supported query keys, and terminal flow updates cannot overwrite an already finished state.

## Boundaries checked

Catalog and management requests use separate encrypted credentials, fixed server-selected paths, the configured host allowlist, manual redirect rejection, a complete response deadline, and a 512 KiB body limit. The allowlist trusts the operator's configured hostnames and their DNS; it is not IP pinning.

Catalog snapshots, connection revisions, and management history have database immutability protections. Effective catalogs express Dhole selection policy, not authorization for calls sent directly to CPA. Scoped catalog authentication precedes conditional-response handling, and the ETag includes the actual freshness and policy representation.

OAuth callback fixtures reject another actor and repeated state parameters. An ambiguous callback remains submitted and cannot be replayed through Dhole. The database and audit fixtures contain neither the authorization code nor plaintext upstream state. CPA's cancellation behavior was checked against [its pending-session implementation](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/api/handlers/management/oauth_sessions.go#L230).

Typed management edits label concurrency as best effort. They do not claim upstream compare-and-swap or credential restoration through metadata rollback. Export queries enforce team scope and bind cursors to filters. Retention deletes request details in bounded transactions while keeping receipt identities, project events, and audit history.

The independent fixture runner used the current shared TypeScript source through a temporary Vitest alias, without rebuilding shared output during concurrent work. The maintained Gateway suites are `catalog.test.ts`, `management.test.ts`, `operations.test.ts`, and `index.test.ts` under `apps/server/src/modules/gateway`.
