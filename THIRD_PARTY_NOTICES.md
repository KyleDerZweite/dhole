# Dhole third-party notices

Dhole is distributed under the GNU Affero General Public License, version 3 or any later version; see [`LICENSE`](LICENSE). This notice records the direct dependencies in the workspace manifests and the public projects/specifications reviewed as prior art. It is not a complete transitive software bill of materials. Versions and license metadata were checked on 2026-08-30; update this file with every dependency or source revision change.

The workspace packages (`@dhole-control/server`, `@dhole-control/node`, `@dhole-control/web`, and `@dhole-control/shared`) are first-party code and are not listed as third-party components. The tables below use the license and copyright notices shipped by each package; links point to the corresponding upstream source.

## Direct runtime dependencies

| Component (version) | License | Copyright / source notice |
| --- | --- | --- |
| [`@hono/node-server` 2.1.1](https://github.com/honojs/node-server) | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors ([license](https://github.com/honojs/node-server/blob/main/LICENSE)) |
| [`better-sqlite3` 13.0.3](https://github.com/WiseLibs/better-sqlite3) | MIT | Copyright (c) 2017 Joshua Wise ([license](https://github.com/WiseLibs/better-sqlite3/blob/master/LICENSE)) |
| [`hono` 4.13.5](https://github.com/honojs/hono) | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors ([license](https://github.com/honojs/hono/blob/main/LICENSE)) |
| [`svelte` 5.57.0](https://github.com/sveltejs/svelte/tree/main/packages/svelte) | MIT | Copyright (c) 2016-2025 [Svelte Contributors](https://github.com/sveltejs/svelte/graphs/contributors) ([license](https://github.com/sveltejs/svelte/blob/main/LICENSE.md)) |
| [`ws` 8.21.3](https://github.com/websockets/ws) | MIT | Copyright (c) 2011 Einar Otto Stangvik; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors ([license](https://github.com/websockets/ws/blob/master/LICENSE)) |
| [`zod` 4.5.4](https://github.com/colinhacks/zod) | MIT | Copyright (c) 2025 Colin McDonnell ([license](https://github.com/colinhacks/zod/blob/main/LICENSE)) |

## Direct development dependencies

| Component (version) | License | Copyright / source notice |
| --- | --- | --- |
| [`@sveltejs/vite-plugin-svelte` 6.2.1](https://github.com/sveltejs/vite-plugin-svelte/tree/main/packages/vite-plugin-svelte) | MIT | Copyright (c) 2021 [these people](https://github.com/sveltejs/vite-plugin-svelte/graphs/contributors) ([license](https://github.com/sveltejs/vite-plugin-svelte/blob/main/packages/vite-plugin-svelte/LICENSE)) |
| [`@types/better-sqlite3` 7.6.13](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/better-sqlite3) | MIT | Copyright (c) Microsoft Corporation ([license](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/better-sqlite3/LICENSE)) |
| [`@types/node` 24.10.0](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | MIT | Copyright (c) Microsoft Corporation ([license](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/node/LICENSE)) |
| [`@types/ws` 8.18.1](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ws) | MIT | Copyright (c) Microsoft Corporation ([license](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/ws/LICENSE)) |
| [`typescript` 7.0.2](https://github.com/microsoft/TypeScript) | Apache-2.0 | Copyright (c) Microsoft Corporation; the installed package ships `LICENSE` and `NOTICE.txt` ([license](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt), [notice](https://github.com/microsoft/TypeScript/blob/main/NOTICE.txt)) |
| [`vite` 7.1.12](https://github.com/vitejs/vite/tree/main/packages/vite) | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors ([license](https://github.com/vitejs/vite/blob/main/packages/vite/LICENSE.md)) |
| [`vitest` 4.1.11](https://github.com/vitest-dev/vitest/tree/main/packages/vitest) | MIT | Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors ([license](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/LICENSE.md)) |

MIT-licensed components above carry the following permission and disclaimer terms. Keep each component's copyright line with the text when redistributing that component:

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Toolchain and native-build notes

`apps/web/package.json` declares Svelte **5.57.0** as a runtime dependency and `@sveltejs/vite-plugin-svelte` **6.2.1**, Vite **7.1.12**, Vitest **4.1.11**, TypeScript **7.0.2**, and `@types/node` **24.10.0** as development dependencies. The Vite build bundles Svelte runtime code into `apps/web/dist/assets/*.js`; retain the Svelte MIT notice above when redistributing those generated assets.

Vite 7 is intentional: its `lightningcss` dependency is optional, avoiding Vite 8's mandatory MPL-licensed CSS dependency for the web build. This install resolved `lightningcss` **1.33.0** and the platform package `lightningcss-linux-x64-gnu` **1.33.0**, both MPL-2.0. Vite **8.2.2** appears only as a Vitest transitive development dependency in the non-web workspaces; no Vite 8 production build is used. The Vite package license records bundled BSD-2-Clause, CC0-1.0, ISC, and MIT components; Vitest's package license records BSD-3-Clause, ISC, and MIT components.

The following packages were observed in `pnpm licenses list` for this install and anchor the non-MIT notices above; this is not a complete transitive inventory. `aria-query` and `axobject-query` are Svelte production dependencies and appear in `pnpm licenses list --prod`; retain their Apache-2.0 notices when shipping production `node_modules`. `detect-libc` and `expect-type` are development-only transitive packages and appear only in the development inventory.

| Component (version) | License | Copyright / source notice |
| --- | --- | --- |
| [`aria-query` 5.3.1](https://github.com/A11yance/aria-query) | Apache-2.0 | Copyright 2020 A11yance ([license](https://github.com/A11yance/aria-query/blob/main/LICENSE)) |
| [`axobject-query` 4.1.0](https://github.com/A11yance/axobject-query) | Apache-2.0 | Copyright 2020 A11yance ([license](https://github.com/A11yance/axobject-query/blob/main/LICENSE)) |
| [`detect-libc` 2.1.2 (dev only)](https://github.com/lovell/detect-libc) | Apache-2.0 | Package metadata names Lovell Fuller; installed `LICENSE` has no copyright line ([license](https://github.com/lovell/detect-libc/blob/main/LICENSE)) |
| [`expect-type` 1.4.0 (dev only)](https://github.com/mmkal/expect-type) | Apache-2.0 | Copyright 2024 Misha Kaletsky ([license](https://github.com/mmkal/expect-type/blob/main/LICENSE)) |
| [`lightningcss` 1.33.0](https://github.com/parcel-bundler/lightningcss) and optional [`lightningcss-linux-x64-gnu` 1.33.0](https://github.com/parcel-bundler/lightningcss) | MPL-2.0 | The installed package `LICENSE` contains no copyright line; Parcel Lightning CSS source ([license](https://github.com/parcel-bundler/lightningcss/blob/master/LICENSE)) |
| [`source-map-js` 1.2.1](https://github.com/7rulnik/source-map-js) | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors ([license](https://github.com/7rulnik/source-map-js/blob/master/LICENSE)) |
| [`picocolors` 1.1.1](https://github.com/alexeyraspopov/picocolors) | ISC | Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov ([license](https://github.com/alexeyraspopov/picocolors/blob/main/LICENSE)) |
| [`siginfo` 2.0.0](https://github.com/emilbayes/siginfo) | ISC | Copyright (c) 2017, Emil Bay <github@tixz.dk> ([license](https://github.com/emilbayes/siginfo/blob/master/LICENSE)) |

`better-sqlite3` is MIT-licensed but contains a native addon. Unsupported platforms may need a compiler/toolchain or may fail to install; this is an operational portability risk, not an additional license obligation. The architecture and threat-model documents record the same fallback risk.

## Prior-art and donor research (not runtime dependencies)

The following projects were consulted for public behavior, protocol, or product concepts. Dhole currently contains no verified copied source, generated asset, logo, screenshot, or documentation passage from them. If code or documentation is later adapted, record the exact source revision and path here and preserve the applicable notices in the redistributed artifact.

### Protocol prior art

| Protocol | License / attribution | Scope |
| --- | --- | --- |
| [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) | Apache-2.0; Copyright 2025 Zed Industries, Inc. and contributors ([license](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/LICENSE)) | Specification and protocol behavior reviewed only; Dhole redistributes no ACP source or text. |
| [AG-UI](https://github.com/ag-ui-protocol/ag-ui) | MIT; Copyright (c) 2025 ([license](https://github.com/ag-ui-protocol/ag-ui/blob/main/LICENSE)) | Event protocol behavior reviewed only; Dhole redistributes no AG-UI source or text. |

### T3 Code

[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) is MIT-licensed. Its repository notice is:

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.
```

Retain the complete MIT permission/disclaimer text above when redistributing adapted T3 Code material. Dhole is an independent implementation and does not use T3 Code as a runtime dependency.

### CPA Manager Plus

[`seakee/CPA-Manager-Plus`](https://github.com/seakee/CPA-Manager-Plus) is MIT-licensed. Its repository notice is:

```text
MIT License

Copyright (c) 2026 Seakee
```

Retain the complete MIT permission/disclaimer text above when redistributing adapted CPAMP material. Dhole's Gateway module is a clean reimplementation of selected boundary behavior, not a copy of the CPAMP application.

### CLIProxyAPI

[`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI) publishes an MIT license. The copyright wording below is preserved exactly as it appears in the repository (including its historical range):

```text
MIT License

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Dhole interoperates with an explicitly configured OpenAI-compatible endpoint and local fixtures; it does not embed CLIProxyAPI or claim its source.

### Hermes Agent

[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) is MIT-licensed. Its repository notice is:

```text
MIT License

Copyright (c) 2025 Nous Research
```

Retain the complete MIT permission/disclaimer text above when redistributing adapted Hermes material. Dhole's memory, skills, sessions, and orchestration are independent implementations.

### Mediation

The [`KyleDerZweite/mediation`](https://github.com/KyleDerZweite/mediation) `package.json` declares `"license": "MIT"`, but the reviewed repository revision has no `LICENSE` file. This is an unresolved notice/provenance risk. Do not copy Mediation source until an authoritative license file and copyright holders are confirmed; if adapted, preserve that file and record the exact commit. Dhole incorporates coordination concepts and compatible behavior, not verified Mediation source.

### Model Context Protocol (MCP)

The [MCP specification repository](https://github.com/modelcontextprotocol/specification) is undergoing a licensing transition. Its current [`LICENSE`](https://github.com/modelcontextprotocol/specification/blob/main/LICENSE) states that new code and specification contributions are Apache-2.0; documentation other than specifications is CC-BY-4.0; contributions whose authors have not consented to relicense remain MIT; and no rights beyond the applicable original license are conveyed. Determine the per-file license and retain notices before redistributing any MCP text, schema, or code. Dhole implements a small compatible boundary and copies no MCP source.

### Agent Skills

The [Agent Skills repository](https://github.com/agentskills/agentskills) states in its [README](https://github.com/agentskills/agentskills#license) that repository code is Apache-2.0 and documentation is CC-BY-4.0, with individual directories able to carry additional terms. Dhole follows the public packaging concept but currently copies no Agent Skills code or documentation. Any future adapted example or document must include the Apache-2.0 or CC-BY-4.0 attribution and notice required for that file.

## Open notice risks

- This file covers direct dependencies and selected observed transitive packages only; release builds should generate and review a complete transitive SBOM/license report, including platform-specific native packages.
- `lightningcss` and its platform package are optional/toolchain artifacts; verify target-specific installs and preserve the MPL-2.0 notice in release packaging.
- MCP's transition and Mediation's missing repository license require per-file provenance checks before any source or documentation adaptation.
- Upstream licenses, copyright years, and repository contents can change. Pin source revisions in a future release record and rerun this review.
