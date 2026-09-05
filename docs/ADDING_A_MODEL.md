# Adding a model

A model is a provider-scoped identifier and capability record. A provider
supplies inference; a runtime conducts an agent session. Keep those identities
separate. Core owns their configuration even with `DHOLE_MODULES=none`.
Model names belong in configuration data, not branches in session or adapter
code. See [Runtime adapters](RUNTIME_ADAPTERS.md).

## Data shape and safety

Core validates imports with Zod. `POST /api/runtime/models/import` accepts:

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

`modelKey` is unique within its provider. Preserve the provider's spelling.
Imports default models to disabled; an explicit `enabled` value updates that
policy. Reimporting without `enabled: true` therefore disables an existing
model. Imports preserve earlier submitted capability outcomes.

Provider routes sanitize configuration and keep credentials in encrypted secret
records. Never put credentials in a base URL, model record, capability evidence,
event, fixture, or browser response. Provider and model administration require
a current administrator in the owning team.

## Core runtime administration

These routes retain `/api/runtime` as their URL prefix. Runtime is part of Core,
not an optional module.

| Method and path | Purpose |
| --- | --- |
| `GET /api/runtime/providers` | List team providers with sanitized configuration. |
| `POST /api/runtime/providers` | Create a provider with a name, kind, optional base URL, configuration, and optional initial secret. |
| `PATCH /api/runtime/providers/:providerId` | Update provider metadata/configuration or rotate an optional secret. |
| `POST /api/runtime/providers/:providerId/secrets` | Store or rotate an encrypted secret by label. |
| `GET /api/runtime/providers/:providerId/secrets` | List secret IDs, labels, and lifecycle timestamps; never values. |
| `GET /api/runtime/models` | List provider-scoped models and capability metadata. |
| `POST /api/runtime/models/import` | Import or update models for a provider ID. |
| `POST /api/runtime/providers/:providerId/models/import` | Import with the provider ID in the path. |
| `POST /api/runtime/models/:modelId/probe` | Record submitted capability outcomes and bounded evidence. This does not run inference. |
| `GET /api/runtime/registrations` | Inspect machine runtime descriptors and availability. |

## Capability evidence

`declaredCapabilities` contains supplied metadata. It is not proof that the
provider supports a capability. The probe endpoint accepts `supported`,
`unsupported`, or `unknown` outcomes, optional latency and error summaries,
and bounded evidence. Although the stored field is named
`measuredCapabilities`, these are administrator-submitted observations. The
server labels submitted probe evidence `verified: false`; it does not execute
or independently verify a probe.

A capability record never changes provider credentials or selects a different
runtime. Model enablement remains an explicit administrative decision. Catalog
presence, freshness, enablement, and successful inference are separate facts.

## Gateway catalogs

Optional Gateway catalog discovery accepts the supported OpenAI `data[]` and
CPA Codex-style `models[]` envelopes through its bounded connector. It records
snapshots, differences, freshness, and client policy. See
[Gateway administration](GATEWAY_AND_CPAMP_REPLACEMENT.md) for the supported
catalog and client workflow.

Core's import endpoint accepts the normalized Dhole shape shown above. It does
not accept a raw OpenRouter response. The former Lab parser, model
recommendations, benchmarks, and promotion routes are retired under
[ADR 0003](adr/0003-core-and-product-focus.md).

For a compatible API provider, use the API root as `baseUrl`, such as
`https://openrouter.ai/api/v1`. The generic runtime appends
`/chat/completions`; never embed credentials in the URL.

## Workflow

1. Create or select a provider with its name, kind, and API root.
2. Store its credential through the encrypted secret route. Check that list
   responses expose only safe metadata.
3. Import a normalized local fixture or use Gateway's supported catalog flow.
   Leave new models disabled while reviewing them.
4. Record outcomes from a local fixture or separately authorized controlled
   test, including source and observation time. The record alone is unverified.
5. Enable the model through explicit policy and select the provider/model in a
   session. Review Gateway request evidence separately from session events.

Repository verification uses fixtures. It does not call a live model or consume
quota. Current runtime adapters still require the appropriate installed runtime
or configured endpoint for real use.
