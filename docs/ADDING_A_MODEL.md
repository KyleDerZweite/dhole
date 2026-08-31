# Adding a model

A model is a provider-scoped identifier and capability record. It is not a
runtime process and it is not a provider credential. Keep these dimensions
separate:

- **Provider** — an OpenAI-compatible endpoint, OpenRouter, CLIProxyAPI, or a
  direct vendor connection. A provider has a team scope, kind, optional base
  URL, sanitized configuration, and encrypted secret records.
- **Model** — one provider's `modelKey`, display name, declared capabilities,
  measured capability outcomes, catalog timestamp, and explicit enabled flag.
- **Runtime** — Codex, Claude Code, Kimi ACP, the generic API adapter, or the
  fake fixture that executes a session. See [Runtime adapters](RUNTIME_ADAPTERS.md).

The kernel routes by provider/model data. Do not add model-name branches to
session, orchestration, or adapter code.

## Data shape and safety

The runtime module validates every request with Zod. A model import accepts:

```json
{
  "providerId": "provider-id",
  "models": [
    {
      "modelKey": "vendor/model-name",
      "displayName": "Model name",
      "declaredCapabilities": { "tools": true, "vision": true },
      "enabled": false
    }
  ]
}
```

`modelKey` is unique only within a provider. Preserve the provider's spelling,
including OpenRouter's `vendor/model` form. Models default to disabled in both
the runtime and Lab APIs.

Provider configuration is sanitized before storage and responses never include
secret material. Store a token through the encrypted secret route, not in
`config`, a model record, an event, a fixture, or a browser response. Provider
and model routes are administrator-protected and team-scoped.

## Endpoints

The central server exposes two related surfaces.

### Runtime administration

All `/api/runtime/*` routes require an administrator session.

| Method and path | Purpose |
| --- | --- |
| `GET /api/runtime/providers` | List team providers (sanitized config only). |
| `POST /api/runtime/providers` | Create a provider with `name`, `kind`, optional `baseUrl`, config, and optional initial secret. |
| `PATCH /api/runtime/providers/:providerId` | Update provider metadata/config or rotate an optional secret. |
| `POST /api/runtime/providers/:providerId/secrets` | Store or rotate an encrypted provider secret by label. |
| `GET /api/runtime/providers/:providerId/secrets` | List secret IDs/labels and lifecycle timestamps; never values. |
| `GET /api/runtime/models` | List provider-scoped models and declared/measured capabilities. |
| `POST /api/runtime/models/import` | Import/upsert models for a provider ID. |
| `POST /api/runtime/providers/:providerId/models/import` | Same import with provider ID in the path. |
| `POST /api/runtime/models/:modelId/probe` | Record a capability probe outcome (`supported`, `unsupported`, or `unknown`). |
| `GET /api/runtime/registrations` | Inspect node runtime descriptors and availability (not model catalog data). |

### Improvement Lab

The Lab provides the same model concepts for benchmarks and recommendations:

| Method and path | Purpose |
| --- | --- |
| `POST /api/lab/providers` | Register a provider through the Lab service (administrator only). |
| `POST /api/lab/models` | Manually register one model. |
| `POST /api/lab/models/catalog` | Parse a catalog payload and upsert models. |
| `POST /api/lab/providers/:providerId/catalog` | Parse a provider-scoped catalog payload. |
| `POST /api/lab/models/probes` | Record one measured capability probe. |
| `GET /api/lab/models/:modelId/probes` | Read probe history. |
| `GET /api/lab/models/recommendations` | Rank models against required capabilities; disabled models can be included for review. |

All Lab calls enforce the caller's team/provider/model scope. The Lab's
benchmark and promotion records are evidence and human decisions; they do not
silently enable or replace a model.

## Declared versus measured capabilities

`declaredCapabilities` are provider/catalog metadata. They are useful hints,
but are unverified and may be absent or wrong. `measuredCapabilities` are the
latest probe outcomes, each one explicitly `supported`, `unsupported`, or
`unknown`, with optional latency, error summary, evidence, and observation
time. A new import updates declarations and catalog time without erasing prior
measured outcomes unless the model is intentionally re-created by policy.

Routing recommendations resolve each required capability as follows:

1. Use the measured outcome when one exists.
2. Otherwise treat a declaration of `false` as `unsupported`.
3. Otherwise return `unknown`.

Recommendations rank supported above unknown above unsupported. They are
informational; a recommendation never changes `enabled`, provider secrets,
runtime selection, or a promotion decision. Probe evidence is redacted at the
boundary and should identify a local fixture or controlled test, not a secret.

## OpenRouter catalog import

OpenRouter's model listing is documented at
[`GET https://openrouter.ai/api/v1/models`](https://openrouter.ai/docs/api-reference/list-available-models).
The parser in `apps/server/src/modules/lab/service.ts` accepts either the raw
array or an object containing `data: []`. For each entry it imports:

- `id` → `modelKey` (required and preserved exactly),
- `name` → `displayName` (falls back to `id`), and
- boolean values under `capabilities` → `declaredCapabilities`.

Other catalog fields, including pricing and context metadata, are not inferred
into capabilities by this parser. Imported entries are disabled (`enabled:
false`) until an administrator explicitly enables one after reviewing probes,
provider health, and budget policy. Catalog ingestion does not call a model,
consume quota, or promote a candidate.

For an OpenRouter or CLIProxyAPI provider, set `baseUrl` to the compatible API
root (for example, `https://openrouter.ai/api/v1` or an internal `/v1` URL),
store its token as a labeled provider secret, then import the catalog or add
models manually. The generic runtime appends `/chat/completions` to its
configured base URL; do not put credentials in that URL.

## Recommended workflow

1. Create or select the provider with a stable `kind`, name, and API root.
2. Store/rotate the provider secret through the secret endpoint. Verify that
   list responses contain only IDs, labels, and timestamps.
3. Import a local fixture/catalog or submit one model to the manual endpoint.
   Leave it disabled while validating it.
4. Run bounded capability probes against a local fixture or explicitly
   authorized endpoint. Record evidence, latency, and failures without raw
   prompts, tokens, or credentials.
5. Review measured capabilities and Lab recommendations. Enable the model via
   an explicit administrative change only when policy permits.
6. Select the provider/model in a session or orchestration profile and monitor
   Gateway request evidence separately from runtime session events.

There is no automatic model discovery-to-enable path, no automatic promotion
from a benchmark, and no fallback that silently changes providers. Live model
adapters are implemented, but this repository has not quota-tested them. Use
fixtures for CI and documentation examples.

## Versioning and provenance

Model rows are durable operational state: IDs, provider association, declared
and measured JSON, catalog observation time, enablement, and update timestamps.
Probe rows preserve outcome, latency, bounded error summary, redacted evidence,
and observation time. Keep an external model/version reference in evidence when
useful; do not put secrets or full provider responses there. If a provider
changes its catalog, import the new snapshot and let the explicit measured
probe/promotion workflow decide what is safe to enable.

The implementation baseline follows ADR 0001 (Node.js `>=24.15 <25`,
`pnpm@10.29.2`). Provider APIs and model catalogs are remote boundaries, so
their current behavior must be rechecked when upgrading a connector.
