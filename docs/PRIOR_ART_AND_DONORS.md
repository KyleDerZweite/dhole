# Prior art and donor record

This record captures the public projects and specifications reviewed while designing Dhole. It is an engineering provenance record, not a legal opinion. The review was read-only and was current on 2026-08-30.

## Concepts researched

The following sources informed requirements and design questions. Dhole uses compatible ideas where useful, but keeps its own server, schemas, storage, and implementation.

| Source | Concepts reviewed | Dhole boundary or decision |
| --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) ([remote-access guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)) | A remote control surface for local coding agents; server-owned environments; reconnect and provider-driver boundaries. | Dhole keeps the browser on the central server and uses an outbound, authenticated node protocol. It is not a T3 Code fork or runtime dependency. |
| [CPA Manager Plus](https://github.com/seakee/CPA-Manager-Plus) | Request history, normalization, provider/model attribution, usage and cost views, account health, quota/cooldown signals, redaction, and JSONL history. | Dhole's Gateway module cleanly reimplements the required boundary and remains independent of CPAMP's application, database, and runtime. |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | OpenAI/Gemini/Claude-compatible gateway behavior, provider/account routing, usage records, and management endpoints. | Dhole supports an explicitly configured OpenAI-compatible endpoint and fixture importer; it never embeds CLIProxyAPI or forwards arbitrary browser calls. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Persistent sessions, skills and memory loops, FTS-backed recall, remote messaging, and bounded subagent delegation. | Dhole models memory packs, versioned skills, sessions, and orchestration as separate server-owned concepts with explicit authorization and immutable history. |
| [Mediation](https://github.com/KyleDerZweite/mediation) | Project/repository identity, overlap claims, heartbeats, lifecycle events, agent detection, MCP tools, and privacy/redaction boundaries. | These concepts are native Coordination policies in Dhole. Compatibility is implemented through Dhole's versioned contracts; no external Mediation service is required. |
| [MCP specification](https://github.com/modelcontextprotocol/specification) and [ACP](https://github.com/agentclientprotocol/agent-client-protocol) | Typed tool/session transport, capability negotiation, streaming, reconnect, and approval/lifecycle semantics. | Dhole implements only the locked MCP boundary and runtime adapters needed by the MVP. Protocol names and schemas are versioned in `packages/shared`; no protocol source files are copied. |
| [Agent Skills](https://github.com/agentskills/agentskills) | Portable `SKILL.md` packaging, references, optional scripts, and a simple discovery/activation model. | Dhole stores skills as versioned, reviewed records and enforces its own permission, size, provenance, and benchmark policies. |

The review also covered the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui) for event-oriented agent/user interfaces. Its event-streaming pattern is prior art only; Dhole's event envelope, sequence, authorization, and replay rules are original to this repository.

## Code actually adapted

**None verified as of this record.** No source file, generated asset, fixture, logo, stylesheet, or documentation passage has been copied from the projects above. Implementations are clean reimplementations based on public behavior and protocol documentation. A protocol or API compatibility decision is not an assertion that the underlying implementation was copied.

If a future change imports or adapts code, examples, images, or documentation, update this file and `THIRD_PARTY_NOTICES.md` in the same change with the exact path, source revision, copyright line, license, and any required attribution or share-alike terms. Preserve upstream notices in redistributed artifacts; do not rely on a repository-level summary for files with different licenses.

## Attribution and license obligations

- T3 Code, CPAMP, CLIProxyAPI, and Hermes Agent publish MIT notices. MIT permits reuse subject to retaining the applicable copyright and permission text. CLIProxyAPI's repository has an unusual historical copyright range; its wording is preserved verbatim in `THIRD_PARTY_NOTICES.md`.
- The Mediation repository's `package.json` declares MIT, but the repository had no `LICENSE` file at the reviewed revision. Treat that as an unresolved provenance risk: obtain and preserve an authoritative license file before adapting Mediation source, and record the exact commit and copyright holders.
- The MCP repository is in a licensing transition: its `LICENSE` says new code and specification contributions are Apache-2.0, documentation other than specifications is CC-BY-4.0, and authors who have not consented to relicensing remain under MIT. Determine the per-file license before redistributing any MCP material.
- Agent Skills states that repository code is Apache-2.0 and documentation is CC-BY-4.0, with individual directories potentially carrying additional terms. Attribute and preserve notices for any copied example or document; the current Dhole implementation copies none.
- Dhole itself is licensed under MIT. Third-party MIT, Apache-2.0, and CC-BY-4.0 material remains under its own terms; this file does not relicense donor works.

Research sources can change. Release reviews should re-check the pinned upstream revisions, regenerate the dependency inventory, and resolve all entries marked as conditional or unresolved before distributing a bundle.
