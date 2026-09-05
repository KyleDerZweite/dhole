# Name directions for Dhole

Research date: 2026-09-05. These are naming proposals. The product and repository remain Dhole.

I would test **Rookport** first. It is short, pronounceable, and supports a distinct animal mark. **Packrail** is the strongest alternative when describing coordinated work matters more than putting the animal in the name. **Otterport** has a friendlier character, though existing Otter products make it a weaker choice for search and recognition.

The name should cover the current product: provider access and agent coordination, with accounts, projects, sessions, and runtime information in Core. It should not promise an autonomous scheduler, a model vendor, or a private machine fleet. Keep that description visible on the login screen and project page:

> Manage AI provider access and coordinate your agents.

An animal name alone will not explain those functions. A useful compound plus that sentence addresses both branding and product clarity. Keep module names literal: Core, Access, Coordination, and Gateway. MCP and Skills should inherit the chosen product name.

| Candidate | Say it | Animal and mark | Why it fits | Main reservation | Judgment |
| --- | --- | --- | --- | --- | --- |
| **Rookport** | ROOK-port, with rook rhyming with book | Rook. Upright head, pointed beak, one pale cutout at the beak base. | Port suggests an entry point and connection. Rook supplies a recognizable animal without making the name long. Rookport Gateway, Rookport MCP, and Rookport Skills all read naturally. | Rook is already an established Kubernetes storage project. Always use the complete name; avoid storage, chess, and Kubernetes imagery. | First concept to test. |
| **Packrail** | PACK-rail | Dhole. Round ears and a rust coat; keep the animal while replacing the difficult name. | Pack suggests a group working together. Rail suggests a shared route. It carries more of the coordination meaning than the other candidates and preserves the strongest reason to use a dhole mascot. | People may first expect logistics, package tooling, or a scheduler. The product description must name agents and provider access. | Best functional alternative. |
| **Otterport** | OT-ter-port | Otter. Low rounded head, small ears, pale muzzle. | Both words are familiar. Port fits the gateway and a shared place to connect accounts and agents. A calm otter could make account administration feel approachable. | Otter.ai markets AI agents, and OtterLink already manages remote coding-agent CLIs. The compound differs, but the association remains close. | Worth a visual comparison, third choice. |
| **Weaverport** | WEE-ver-port | Weaver bird. Compact bird head for the icon; a woven nest belongs only in larger illustrations. | Weaver suggests bringing separate pieces of work together, while port suggests controlled connections. | Four spoken syllables, a less recognizable animal silhouette, and proximity to Service Weaver's cloud application framework. WeaverPort can also look like a developer's portfolio title. | Plausible, weaker at small sizes. |
| **Ternrelay** | TURN-ree-lay | Tern. Pointed bill and dark head cap. Use a perched profile. | Relay directly suggests passing requests and messages. A short animal word gives it a clear pronunciation. | Tern already names container tooling. The bird is less familiar, and a flying or forked-tail mark would resemble RenewC's red kite direction. | Useful reserve candidate. |
| **Rookrelay** | ROOK-ree-lay | Same rook direction as Rookport. | Relay describes the gateway more directly than port. | Longer and less comfortable to say than Rookport. It narrows the impression toward message forwarding and retains the Rook collision. | Naming variant, not a separate visual direction. |
| **Waymarten** | WAY-mar-ten | Marten. Pointed muzzle and throat patch. | Way suggests routing and guidance. The compound is distinctive and reasonably easy to say. | Mardwerk already uses a marten. Another marten brand would be difficult to distinguish in the user's own project collection. | Drop unless a shared brand family is intentional. |

Rookport has the best balance, but it is not a collision-free answer. Rook's established infrastructure identity is the largest reason to choose Packrail instead. Compare those two as equal-sized wordmarks next to the current Dhole name before settling on either.

The wordmarks should use one weight and one spelling, such as `Rookport`, rather than coloring each half differently. Test the animal beside the full wordmark, alone at 20 pixels, and as a 16-pixel favicon. A readable sidebar icon matters more than details in a large mascot illustration. The coordinated animal study is in [brand-animals.md](brand-animals.md).

The relevant context from the user's other projects supports a distinct third identity. Mardwerk uses a marten with brown and amber; RenewC's current task retains a red kite. I used that context for differentiation only. Those tasks do not choose Dhole's name or authorize a rename.

Public checks found several attractive names that should be discarded:

| Name | Observed collision | Implication |
| --- | --- | --- |
| OtterLink | [OtterLink](https://github.com/lihy11/OtterLink) describes resuming Codex, Claude Code, and OpenCode through messaging services. | Exact name and directly adjacent purpose. Reject. |
| PackRelay | [PackRelay](https://github.com/MrDemonWolf/packrelay) is a WordPress REST API bridge with submission management. Other repositories also use the name. | Exact software name with API integration overlap. Reject. |
| Rook | [Rook](https://rook.io/) manages storage for Kubernetes and is a CNCF graduated project. | Do not use the animal name alone. The full Rookport compound still needs differentiation. |
| Otter | [Otter.ai](https://otter.ai/) markets its meeting agent and other AI agents. | Do not use the animal name alone. This also lowers Otterport's rank. |
| Kestrel | [Microsoft's Kestrel](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel?view=aspnetcore-10.0) is ASP.NET Core's default web server. | Exact name in server infrastructure. Reject. |
| Bower | [Bower](https://bower.io/) is a package manager for the web. | A nest-building story does not overcome an established software identity. Reject. |

The preliminary screen queried GitHub repository names with `NAME in:name` and the exact lowercase npm registry endpoint. Rookport, Packrail, Otterport, Ternrelay, Rookrelay, and Waymarten each returned zero GitHub repository results and HTTP 404 from npm. Weaverport returned two longer repository names, WeaverPortfolio and WeaverPortal_deploy, with no exact repository-name match, plus npm HTTP 404. These observations are dated, limited screening results; they do not establish domain or trademark availability. Search-engine requests did not return usable evidence, so this is not a complete web search.

Reproducible public query examples are [Rookport on GitHub](https://api.github.com/search/repositories?q=Rookport%20in%3Aname), [Packrail on GitHub](https://api.github.com/search/repositories?q=Packrail%20in%3Aname), [Otterport on GitHub](https://api.github.com/search/repositories?q=Otterport%20in%3Aname), and the [npm registry endpoint for rookport](https://registry.npmjs.org/rookport). Additional root-name checks confirmed [Service Weaver](https://serviceweaver.dev/) as a cloud application framework and [Tern](https://github.com/tern-tools/tern) as a container software composition analysis tool. An existing root name is a recognition risk even when the proposed compound has no exact match in these queries.

No name has been selected, registered, or substituted into code. The next review should compare Rookport, Packrail, and Otterport with the same real dashboard layout and product description. That will expose differences in pronunciation, visual recognition, and product meaning without changing the product merely to suit a name.
