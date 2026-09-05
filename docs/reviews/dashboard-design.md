# Dashboard design research

Research date: 2026-09-05. This review informed the Core, Access, and Gateway
layout revision. Public project documentation and source are evidence for the
comparison, not instructions to deploy or copy their architecture.

The CPAMP public demo could not load in the research browser. It returned
`ERR_CONNECTION_RESET`. Its README, dashboard implementation, demo setup, and
capability matrix were inspected through the official repository instead.
EasyCLIProxyAPI's README and navigation source were inspected. The supplied
Pangolin screenshot was inspected and shows an icon rail, an active-item
background, and a short orange tooltip beside the hovered Domains icon.

## What to borrow

CPAMP organizes operations around questions an administrator needs answered:
which requests fail, where usage and estimated cost go, and which accounts need
attention. Its dashboard source combines usage metrics, traffic, collector
state, health alerts, and connection information. Those are useful groupings
for Dhole's existing observations. A decorative chart without trustworthy
coverage would make the dashboard less useful. [1][2][3]

EasyCLIProxyAPI makes setup concrete with copyable endpoints, an OAuth
workspace, provider search, usage filtering, and client configuration. Dhole
should make its model catalog and supported client connection steps easy to
find. The desktop application's process installation, start/stop, and local
configuration controls do not transfer directly to a browser connected to
Dhole's central server. [4][5]

Carbon's table guidance puts search, filters, and global actions in a toolbar,
keeps row actions next to their subject, and uses expandable rows for detail.
Its shell guidance avoids a third tier of navigation. Use four product areas
and shallow page navigation instead of presenting every internal module as a
separate product. [6][7]

## Recommended page organization

| Area | Pages and purpose |
| --- | --- |
| Core | Master overview, projects, sessions, runtime, and agent connection guidance for MCP and Skills. The overview leads with work needing attention and links to its source. |
| Access | Human users, role and status management, account settings, and machine authorization. Provider accounts belong in Gateway. |
| Coordination | Active collaboration and project-scoped coordination evidence. |
| Gateway | Overview, requests and usage, accounts and OAuth, models and client access, connection settings. |

Memory, Lab, and Orchestration are outside the current product navigation.
Fleet is the user's private project, not a public Dhole module. Machine and
runtime operations needed for core sessions stay available within Core.

Gateway should keep the selected connection and observation freshness visible
above its page navigation. The overview needs direct links to account failures,
request history, and stale catalogs. Settings and removal actions belong after
the daily inspection workflows. On an empty installation, adding a connection
is the clear primary action.

## Gateway capability comparison

The Dhole column records functionality present in the inspected
`gateway-api.ts`, `gateway-types.ts`, and `Gateway.svelte` before this layout
revision. "Partial" is a product boundary, not a claim of complete upstream
compatibility. Deliberate deferrals remain in [ROADMAP.md](../../ROADMAP.md).

| Workflow | CPAMP / EasyCLIProxyAPI evidence | Dhole status and design consequence |
| --- | --- | --- |
| Connection overview | CPAMP connection, traffic, usage, collection, and health cards. Easy has runtime state and API endpoints. | Existing connection status, last check, catalog timestamps, stored usage, and request counts. Combine these in a useful overview; distinguish management health from inference health. |
| Persistent requests | CPAMP persists queue history with failure evidence and JSONL import/export. Easy stores local usage with subscription/fallback collection. | Existing paginated, filtered saved requests, redacted failures, latency, tokens, correlation, and JSON export. Collection is explicit push/import. Do not present it as continuous monitoring or complete traffic coverage. |
| Usage analytics | Both expose time, model, provider, account, result, token, and cost analysis. | Partial. Existing hour/day aggregation by provider, model, or account index; failure totals, measured latency, and estimated cost. Keep time scope and unpriced coverage visible. Broader key/project dimensions and richer trends remain roadmap work. |
| Provider accounts | Both expose provider accounts, quotas, and availability. CPAMP adds inspection schedules and action queues. | Partial. Existing saved account state, quota data when supplied, cooldown observations, refresh, and reviewed enable/disable. Missing quota stays unknown. Provider-specific quota interpretation and automation remain roadmap work. |
| OAuth | CPAMP has provider OAuth; Easy documents Codex, Claude, Antigravity, Kimi, and xAI. | Partial. Existing Codex, Anthropic, and Antigravity consent with callback submission and expiry. Keep provider consent beside accounts. Additional flows require verified contracts. |
| Models and clients | CPAMP has provider/model management and aliases. Easy has aliases and managed client configuration. | Partial. Existing catalog discovery, freshness, model enablement, compatibility metadata, diffs, and scoped read-only catalog credentials. Make the supported client steps prominent. Broad alias editors and client restore tools remain roadmap work. |
| Routing and configuration | Both expose broader core/provider settings. | Partial. Four bounded routing/retry settings have read, preview, apply, and management history. Connection metadata has revisions and rollback. Explain the upstream concurrency limit where a user reviews a change. |
| Credentials | Both support broader credential and auth-file management. | Partial. Existing one-time secret submission/rotation and scoped catalog credentials. Never return management credentials or raw auth files to the browser. |
| Local proxy lifecycle | Easy installs, starts, stops, restarts, and updates its local core. | Outside Dhole's browser architecture. Do not add a shell endpoint, process-control service, or direct browser-to-provider connection to match a desktop feature. |
| Plugins and automatic remediation | CPAMP manages plugins, scheduled checks, cooldowns, and account action queues. | Outside the current product focus. The existing roadmap records evidence and authorization requirements. |

CPAMP's own capability matrix explicitly preserves unknown values and calls
cost an estimate. Its demo uses fictional data and does not run a real
collector or inspect real accounts. Those distinctions should also be visible
in Dhole's fixture preview. [3]

## Access dashboard

Use a compact user table as the main workspace. Summary counts for active,
pending, and disabled users help an administrator find pending access. A
search field should match display name or email; role and status filters
should have explicit labels and a clear reset. Keep columns to identity,
role, status, and actions. Show creation time only when the API returns it.
Do not invent last login, MFA coverage, or invitation delivery state.

The invitation action creates a private setup link. The interface must say
that, because the existing workflow does not send email. Pending users need a
clear approval action. The current human account is marked "You". A role
change should show its consequence and an explicit Apply action before the
write; choosing an option should not silently promote someone. The server
remains responsible for authorization and protecting account invariants.

Distinguish "No users" from "No users match these filters". Preserve the
table after an action fails and identify the failed action. Successful
updates should be announced without moving keyboard focus. A modal should
have a title, sensible initial focus, Escape support, and focus returned to
its trigger when closed. [6][11][12]

## Icon rail and controls

Use one Lucide icon consistently for each destination. Suitable mappings are
`LayoutDashboard` for overview, `FolderKanban` for projects, `MessagesSquare`
for sessions, `Cpu` for runtime, `ShieldCheck` for Access, `Network` for
Coordination, and `Waypoints` for Gateway. The mascot is a separate brand
asset, not a replacement for recognizable action icons.

Wide layouts show icon and text together. A narrow layout can collapse to a
64 to 72 pixel rail. Give links accessible names and an active state with
`aria-current="page"`. Do not depend on color alone. Keep the page content
shrinkable and horizontal scrolling contained within a wide table.

Tooltips should contain a short destination label and appear on both hover
and keyboard focus. They must stay visible when the pointer moves onto the
tooltip, persist while relevant, and support Escape dismissal when they
cover other content. Do not put links or controls inside a tooltip. A
browser `title` alone does not provide the requested visual treatment.
Carbon gives this pattern concrete usage guidance. WAI's tooltip pattern is
marked work in progress, so WCAG 1.4.13 is the stronger requirement. [8][9][10]

Styled choice controls need visible labels, clear selected values, disabled
states, and keyboard support. For a custom single-select combobox, preserve
Arrow navigation, Enter selection, Escape cancellation, focus management,
and the accessible name/value relationship. Form validation and FormData
must still receive the chosen value. A pretty trigger with an inaccessible
popup is an incomplete replacement. [13]

Aim for comfortable 40 to 44 pixel controls in the rail and action toolbar.
WCAG 2.2's minimum target criterion is 24 by 24 CSS pixels or its documented
spacing exceptions, not a universal 44 pixel legal requirement. [14]

## Delivery and evaluation

This review is research and design rationale. The capability matrix describes
inspected existing functionality; the page organization and control behavior
are the target of this revision. Their inclusion here is not proof that a
component was implemented or passed accessibility testing. Final delivery
must be checked against the actual changed components and verification
results. No authenticated upstream service or paid model request was used.

Review the result with these tasks:

1. Find a failed request and its sanitized evidence without opening settings.
2. Identify whether a cost total is complete, partial, or unavailable.
3. Find a stale model catalog and the observation time that supports it.
4. Find a pending user, review access changes, and recover from a failed write.
5. Navigate the compact rail, tooltips, and every choice control by keyboard.
6. Use a narrow screen without clipping actions or scrolling the whole page
   horizontally.

## Sources

1. [CPAMP README](https://github.com/seakee/CPA-Manager-Plus/blob/7c4cbeadaa801613e98ea6874b902844f09e59c6/README.md).
2. [CPAMP dashboard implementation](https://github.com/seakee/CPA-Manager-Plus/blob/7c4cbeadaa801613e98ea6874b902844f09e59c6/apps/web/src/features/dashboard/DashboardPage.tsx).
3. [CPAMP capability matrix](https://github.com/seakee/CPA-Manager-Plus/blob/7c4cbeadaa801613e98ea6874b902844f09e59c6/apps/docs/en/reference/capability-matrix.md) and [demo setup](https://github.com/seakee/CPA-Manager-Plus/blob/7c4cbeadaa801613e98ea6874b902844f09e59c6/apps/web/src/features/demo/DemoPage.tsx).
4. [EasyCLIProxyAPI feature tour](https://github.com/router-for-me/EasyCLIProxyAPI/blob/ca4a3307f31530fe891dfd6510dc416f32751d1c/README.md).
5. [EasyCLIProxyAPI page availability](https://github.com/router-for-me/EasyCLIProxyAPI/blob/ca4a3307f31530fe891dfd6510dc416f32751d1c/src/navigation.ts).
6. [Carbon data table usage](https://carbondesignsystem.com/components/data-table/usage/), read through its [official source](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/data-table/usage.mdx).
7. [Carbon shell guidance](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/UI-shell-left-panel/usage.mdx).
8. [Carbon tooltip usage](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/tooltip/usage.mdx).
9. [WAI tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/).
10. [WCAG 2.2 understanding content on hover or focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
11. [WCAG 2.2 understanding status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
12. [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
13. [WAI combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
14. [WCAG 2.2 understanding target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
