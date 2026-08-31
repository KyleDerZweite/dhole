# Dhole name-collision scan

**Scan date:** 2026-08-30 (UTC)

**Working product name:** Dhole (retained)

This is a lightweight, public-web screening and not legal trademark clearance. It does not assess every country, trademark class, app store, domain, unregistered mark, pending filing, or confusingly similar spelling. A trademark professional should repeat the search before a commercial launch.

## Sources and exact-name hits

| Surface | Exact-name result | Relevance observed |
| --- | --- | --- |
| GitHub repository search for [“Dhole”](https://github.com/search?q=%22Dhole%22&type=repositories) and the [Dhole account](https://github.com/Dhole?tab=repositories) | The `Dhole` organization owns many repositories, including the active self-hosted Gallerina project. [`innoo-net/Dhole`](https://github.com/innoo-net/Dhole) is an exact-name remote-desktop product, and [`iamkorun/dhole`](https://github.com/iamkorun/dhole) is an exact-name Rust CLI. | Material product, organization, repository, and potential command-name collisions exist. Avoid the bare `dhole` binary/package name and any implication of affiliation. |
| npm registry [`dhole`](https://www.npmjs.com/package/dhole) | `dhole@0.0.1`, ISC license, empty description (registry metadata observed 2026-03-04). | Exact package-name collision. It appears a tiny, unrelated package; npm publication and ownership can change independently of this project. |
| PyPI [`dhole`](https://pypi.org/project/dhole/) | `dhole==0.0.1`, summary “Currently just a test lib,” author Berislav Paradžik. | Exact package-name collision, apparently unrelated to agent control. |
| RubyGems [`dhole`](https://rubygems.org/gems/dhole) | `dhole` 0.0.14, MIT, “ActiveRecord mapping of main Mediawiki entities and relationships” (38,949 total downloads at scan time). | Established exact package name in another ecosystem; unrelated functionality, but a meaningful distribution/search collision. |
| crates.io [`dhole`](https://crates.io/search?q=dhole) | No exact crate record was returned by the registry API during this scan. | Absence is not a reservation; a crate or similarly named project may be published later. |
| Other package registries | Packagist contains the abandoned `soatok/dhole-cryptography`; npm also contains `dhole-crypto`. | These are unrelated but reinforce the software/security namespace collision. |
| General web search ([Bing exact phrase](https://www.bing.com/search?q=%22Dhole%22+software+product), [Google exact phrase](https://www.google.com/search?q=%22Dhole%22+software+product)) | Exact-name uses include The Dhole’s House (an established online game toolkit), Dhole Conservation Fund, and the Dhole Moments software/security publication. Results are also dominated by the zoological common name. | No reviewed result offered the same agent-control-plane function, but exact-name organizations and products create discoverability and possible trademark risk outside that narrow category. |

The scan found no material exact-name conflict with a known software product offering the same self-hosted coordinated agent-control-plane function. The GitHub account and package registrations remain practical namespace conflicts, and the zoological use is an obvious search collision.

## Decision and follow-up

Keep **Dhole** as the implementation name for this MVP. Use an owned scope such as `@your-org/dhole-server`, `@your-org/dhole-node`, or `dhole-control-plane`; do not publish a bare `dhole` package or globally installed `dhole` executable without resolving the existing collisions. Do not copy logos, illustrations, mascots, screenshots, or trade dress from any result above. Before public launch, check national trademark databases, domains, package owners, app stores, and social handles in the intended markets; document any coexistence or rename decision in a dated update to this report.
