# OpenCode catalog startup plugin

`catalog.mjs` loads a Dhole Gateway projection into a dedicated OpenCode
provider's model selection at startup. This is optional. The
[local MCP bridge](../README.md) handles agent coordination separately.

OpenCode 1.18.27 is the tested client version, pinned to upstream commit
[`4b7e19e315cca414121ba1d61523fef74bb3ae8b`](https://github.com/anomalyco/opencode/tree/4b7e19e315cca414121ba1d61523fef74bb3ae8b).
Its [plugin loader](https://github.com/anomalyco/opencode/blob/4b7e19e315cca414121ba1d61523fef74bb3ae8b/packages/opencode/src/plugin/index.ts)
runs `config` hooks before [provider initialization](https://github.com/anomalyco/opencode/blob/4b7e19e315cca414121ba1d61523fef74bb3ae8b/packages/opencode/src/provider/provider.ts)
reads the resulting model definitions. The installed local CPAMP startup
plugin supplied the workflow reference. Dhole's implementation uses the
scoped projection instead of retrieving provider credentials from config or
calling CPA discovery directly. No donor implementation was copied.

## Configure locally

No installation or real configuration change happens during repository
verification. To opt in on an execution host:

1. Copy `catalog.mjs` into a local directory you control. Make `zod` version
   `4.5.4` available to that file through the directory's `node_modules`.
   OpenCode supports dependencies declared in its configuration directory's
   `package.json`. Preserve existing dependencies when adding Zod.
2. Add the plugin's absolute `file://` URL to OpenCode's `plugin` array. Create
   a dedicated custom provider whose ID begins with `dhole-`, such as
   `dhole-cpa`, with `npm: "@ai-sdk/openai-compatible"`. Keep the normal CPA
   inference destination and native provider authentication configuration.
3. An authorized agent on a machine paired with `connect --gateway` can issue
   the private settings file through `gateway_manage` or the CLI below. The
   approving Dhole user must have Gateway administrator authority. Use the
   OpenCode provider key from step 2 as `openCodeProvider`, which defaults to
   `dhole-cpa` if omitted.

```sh
node /absolute/path/to/dhole/apps/node/dist/index.js gateway \
  --project PROJECT_ID \
  --state-dir /absolute/path/to/private/dhole-state \
  --action '{"action":"tokens.issue","connectionId":"connection-1","name":"OpenCode catalog","client":"opencode","openCodeProvider":"dhole-cpa","expiresInDays":7}'
```

The result contains a `credentialFile` path and expiry metadata. The client
writes the scoped token directly into that owner-only `0600` file. The file
already matches the plugin's settings contract; agents pass its path without
reading, printing, copying, or transforming the token. Keep the private state
directory outside repositories and shared config. The OpenCode process must
run as the file's owner.

4. Set `DHOLE_OPENCODE_CATALOG_CONFIG` to the returned `credentialFile` absolute
   path when launching OpenCode. This variable contains only the path. Without
   the variable, the plugin does nothing. Repeat the issuance action when the
   catalog credential expires or is revoked, then use the new path.

For reference, the private file has this schema. The CLI fills these values;
manual token copying is unnecessary.

```json
{
  "schemaVersion": 1,
  "provider": "dhole-cpa",
  "connectionId": "connection-1",
  "endpoint": "https://dhole.example/api/gateway/catalog/v1/connection-1/opencode",
  "token": "<scoped catalog token>"
}
```

For example, the nonsecret OpenCode configuration can contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/catalog.mjs"],
  "provider": {
    "dhole-cpa": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://cpa.example/v1" },
      "models": {}
    }
  }
}
```

Keep provider authentication in OpenCode's normal private credential store.
The catalog token has no inference or management rights. The plugin sends it
only as the authorization header to the exact configured Dhole endpoint.
Do not put it in OpenCode's config, model options, shell arguments, or project files.
HTTPS is required except for literal IPv4/IPv6 loopback fixture endpoints.
Redirects are rejected. Startup fetches have a five-second whole-body deadline
and a 512 KiB limit; schemas also bound models and metadata.

## Freshness and selection

The plugin replaces only the dedicated provider's `models` object in memory.
It preserves the inference destination, provider authentication, SDK selection,
other providers, and saved config. It does not set a default model. A saved
model choice removed by policy can therefore become unavailable, and OpenCode
will require another selection.

An authenticated stale response may contain Dhole's last successful metadata
combined with its current enablement policy. The plugin installs that response
and warns with the observation time. An unobserved or changed source has no
selection. A valid empty response removes all models. A rejected token,
unavailable endpoint, malformed response, or timeout also clears the dedicated
provider's models and emits a fixed warning. The plugin stores no local cache
that could retain a revoked or removed selection.

If the private file cannot be read or validated, the plugin cannot identify
the dedicated provider and leaves the configuration as supplied. Keep its
saved `models` empty as shown above. Other native providers remain available.
Restart OpenCode after a Dhole refresh or policy change to fetch again.

Projected limits and modalities are upstream declarations. Missing fields
stay absent in the plugin output. OpenCode supplies its own defaults for
missing metadata; those defaults do not prove tool support, available quota,
or successful inference. Dhole selection policy governs cooperating clients.
CPA independently authorizes calls sent directly to CPA.

## Local verification

Run the always-on boundary and actual plugin-hook fixtures from the repository
root:

```sh
node --test clients/opencode/catalog.test.mjs
```

To additionally exercise an installed OpenCode 1.18.27 binary:

```sh
DHOLE_TEST_OPENCODE=/absolute/path/opencode node --test clients/opencode/catalog.test.mjs
```

The installed-client test creates isolated config/data/cache/state directories,
supplies a local models database, disables built-in auth plugins, model fetches,
updates, and external skill discovery, and runs only `models --verbose`.
Only a loopback fixture serves the catalog. The test verifies the actual
startup hook, projected context/output limits, removal of the saved model,
unchanged configuration file, absence of catalog tokens in client output, and
that no inference request occurs. It uses an empty private credential store.
It neither installs the plugin into the user's config nor calls a live provider.

The tests also cover another connection/client scope, rejected or revoked
credentials, malformed and oversized responses, metadata destination
injection, reflected tokens, private-file permissions, removal, empty
selection, staleness, and a stalled response body. The
[server catalog tests](../../apps/server/src/modules/gateway/catalog.test.ts)
exercise the real hashed-token, connection/team authorization, revocation,
and projection policy boundary. Mock status responses in these client tests
do not substitute for those server checks.
