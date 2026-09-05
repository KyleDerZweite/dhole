# Project authorization for native Dhole accounts

This review preserves the implementation before the final ADR 0003 product
narrowing. Fleet-disabled behavior and optional Sessions references describe
that historical revision. Core now owns both machine transport and sessions;
see [current MVP status](../MVP_STATUS.md) for the latest scope and verification.

Research date: 2026-09-05. This is a design recommendation based on the working checkout and public forge documentation. Concurrent implementation may move the referenced code. No authenticated forge calls, live repositories, model providers, deployments, or machine enrollment were used.

## Recommended decision

Dhole should authorize access to a project through its own project membership records. A native Dhole user can create a project, own that project, and invite other approved Dhole users without linking any forge account. A linked GitHub or Codeberg account supplies an optional external identity. A server-verified repository binding supplies evidence about a particular repository. Neither operation, by itself, grants another project's data.

Use the existing Core and Access modules, SQLite, users, teams, device tokens, and scoped API tokens. Add the small project membership boundary that is currently missing. Do not add a separate authorization service, generic policy engine, or mandatory forge integration.

For the first release, use direct membership and owner/admin approval. Later, an owner can explicitly opt a project into automatic admission of verified forge contributors. That policy needs its own expiration and revocation rules. There is no need to wait for automatic admission to support GitHub repositories, Codeberg repositories, or local repositories.

## What the current checkout does

The root architecture and ADR 0002 currently describe GitHub sign-in and repository proof as the normal path. The user's new requirement supersedes that product assumption. Updating sign-in alone would leave the authorization behavior inconsistent.

| Area | Current behavior | Consequence for the change |
| --- | --- | --- |
| [Core project access](../../apps/server/src/modules/core/core.ts), `requireProjectAccess` and project listing | Joins `projects` to `team_members`. There is no project membership table. | Every current team member can read every team project. A GitHub check at token issuance does not make that project private. |
| Core project creation and repository registration | Any authenticated team member can create a project and register a remote or local path hint. | This already provides the basis for a native local flow. Creation must add the creator's project ownership atomically. Repository metadata must remain a description rather than a grant. |
| [Device exchange](../../apps/server/src/modules/access/device.ts), `/api/auth/device/project` | Selects GitHub or manual repository authorization from the server's sign-in `authMode`. Manual mode rejects projects with a GitHub binding. | A GitHub sign-in configuration blocks the local path. A repository's optional link should not disable a member's native authorization. |
| Device GitHub proof | Calls GitHub from the server, compares immutable user ID, checks effective write/admin permission, and binds an immutable repository ID. | Preserve these checks as optional evidence. The proof is stronger than anything a client can claim about its checkout. |
| Device GitHub project lookup | Reuses a project by team and GitHub repository ID, or creates one. | Automatic reuse needs a separate project admission decision. A verified collaborator should not receive existing Dhole data solely because the remote matches. |
| [Access bearer authentication](../../apps/server/src/modules/access/index.ts) and [MCP authentication](../../apps/server/src/modules/mcp/index.ts) | Recheck active user, team membership, token expiry/revocation, and parent device authorization. | Extend the shared authority calculation with current project membership. Preserve the parent device checks. |
| [Sessions service](../../apps/server/src/modules/core/sessions/service.ts) and [Coordination service](../../apps/server/src/modules/coordination/service.ts) | Also contain direct team and actor checks. | Route middleware alone will not cover service calls, WebSocket delivery, session participation, or node-attributed coordination actions. |
| [Mediation integration guide](../MEDIATION_INTEGRATION.md) | Describes server-owned projects and administrator-created scoped tokens, with older onboarding guidance. | Keep server-owned project IDs and per-session capabilities. Align the documented onboarding with native accounts and device-derived project tokens after the implementation changes. |

The existing protections are useful. The missing distinction is between membership in a deployment/team and membership in a particular project.

## What a client can prove

An authenticated device proves possession of a revocable Dhole credential. It does not prove the truth of every statement its agent sends.

| Client statement or artifact | What it establishes | What it cannot authorize |
| --- | --- | --- |
| `cwd`, local directory name, Git config, or a submitted remote URL | A claimed checkout description | Access to an existing Dhole project or ownership of an external repository |
| Submitted `gh auth status`, `gh api`, Git command output, or a screenshot | Untrusted text supplied by the requester | The identity or current repository role reported by GitHub |
| Readable public clone, commit ID, or `git ls-remote` output | Knowledge available to anyone with read access | Write permission or access to private Dhole notes and sessions |
| A locally writable repository | The host process can write those local files, if checked by the trusted node | Ownership of the upstream repository or another user's coordination project |
| An authenticated server call to a forge permission API | That forge's reported identity and permission at the time checked, within the credential's scope | A guarantee that every branch can be pushed, or automatic permission to see Dhole project data |
| A current Dhole project membership | The user's allowed Dhole project actions | Permission to clone or push at a forge, or permission to access arbitrary paths on an execution node |

A user may legitimately coordinate work in their own local project, including a fork or a clone of a public repository they cannot push to. No external ownership proof is needed to create that private Dhole space. An existing project's owner decides who may join it.

Avoid test pushes as an authorization mechanism. They change an external repository, can trigger workflows, and still do not express the intended Dhole sharing policy. Branch rules, archive state, SSO requirements, and token restrictions can prevent a push even when a general repository role is write-capable.

## The smallest durable project model

Keep `users.id` as the account identity. Keep `teams` as the deployment's administrative boundary. Add `project_members` with a unique project/user pair, a role, the granting actor, and timestamps. The membership must refer to an active user in the project's team. Record grants, role changes, and revocations in the existing audit/event facilities, in the same transaction as the operational change. Preserve immutable history.

Start with `owner` and `member`. Both can perform ordinary project work. Owners additionally manage membership, project sharing, and verified repository bindings. If a read-only project user is required, add `viewer` with an explicit operation mapping. Do not make every existing token permission a new project role.

The current administrator role remains a trusted team operator role. Preserve its existing recovery powers explicitly and audit their use. Project ownership does not confer `fleet:admin`, `gateway:manage`, provider administration, or access to other projects. A project remains private from other ordinary team members, not from the trusted deployment operator who owns the database.

An owner invitation should name a Dhole user ID. If acceptance uses a link, use an expiring, single-use random capability stored as a hash and bind it to the intended account. Email addresses and forge usernames can help find an account, but do not use a matching string as proof that two identities are the same. A pending invitation grants no project reads. Keep at least one active owner or require an explicit administrator recovery/transfer operation.

For device and agent calls, effective authority is the intersection of:

1. The active native user and current team membership.
2. Current project membership and its allowed operations.
3. The permissions approved for the parent device.
4. The narrower project token permissions and optional run scope.
5. The operation's existing participant, claim ownership, session capability, and module checks.

Implement this once as a small Core authorization service that HTTP, Access, MCP, and service-level checks can call. List queries still need an indexed membership join so unauthorized projects never appear. Recheck authorization before mutation after any awaited external work. Do not replace session participation with general project membership.

This scales through indexed local lookups. A project/user primary key plus an index for listing a user's projects is enough for the current SQLite monolith. Batch owner/admin grants can handle larger teams before any forge synchronization is necessary.

## Native and local onboarding

The user signs in to Dhole and approves a machine once. The machine can then select projects the user currently belongs to and obtain short-lived project credentials within its approved permissions. Separate agent processes register separate coordination sessions and session capabilities under that user/device authority. Spawning another agent should not require another human sign-in.

Creating a local project creates a server-generated project ID and an owner membership. Give an approved device an explicit project-creation permission if agents should perform this step. The server derives the owner and team from the credential. The agent cannot choose another owner, team, or existing project by supplying a name. Apply quotas and idempotency to retries.

A local client may save a mapping between a checkout and its chosen Dhole project ID. Treat a repository-contained mapping as a hint, because another contributor can edit it. Resolve the ID only after checking the authenticated user's membership. The server must not join projects by directory basename, `.git` data, matching history, repository label, or raw remote string.

Execution nodes retain their separate repository allowlists and canonical realpath checks. Membership in a Dhole project does not allow the caller to select any filesystem path. A compromised host remains able to read local files and credentials already available to that host; server-side project scoping cannot attest an honest host.

## Optional forge binding and admission

Store external identity by a server-configured forge instance and stable user ID. Store repository identity by that instance and stable repository ID. Names, owner slugs, clone URLs, and default branches are mutable display/routing metadata. IDs are only unique within their forge instance. For Forgejo, treat a numeric database ID as stable within the trusted instance's normal lifecycle, not as a cryptographic identity across database replacement or restoration.

Resolve an entered remote using a fixed supported forge origin. Do not fetch arbitrary client-selected hosts, follow credential-bearing redirects, or forward a credential across hosts. A later self-hosted Forgejo integration needs an administrator-configured origin and the existing SSRF protections, not a generic URL proxy. Validate bounded responses with Zod and never return upstream secrets or raw error bodies.

Binding a repository to a project requires authority to manage that Dhole project. The forge check records the external user, repository, effective permission, verification time, credential/installation reference, and proof expiration. It does not create membership as a side effect of account linking. Bindings should be project-scoped; separate projects may legitimately coordinate the same repository. A unique global remote-to-project mapping would prevent that and create a first-claimant ownership problem.

If automatic contributor admission becomes necessary, require the existing project owner to enable a policy for one verified binding. State the resulting Dhole role and data visibility. Require repository administration proof before claiming a canonical shared space for a repository, or retain a native owner/admin approval step. Ordinary write access is suitable evidence for an opt-in contributor policy; it is not evidence that the first writer may decide everyone else's sharing policy.

An admission result should create an expiring grant with `source = forge`, the verified external identity, repository binding, and proof expiry. Direct owner-granted membership remains separate. The two sources have different revocation semantics. A forge-derived grant must never silently become a permanent direct grant during token renewal.

Forks have separate repository IDs. Having write access to a personal fork does not prove write access to its upstream. A project owner can still invite that contributor directly. A rename or transfer must preserve the stored ID and trigger fresh policy evaluation where relevant. Deleting and recreating a repository with the same name must not inherit the old binding.

## GitHub API evidence

[Get repository permissions for a user](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user) supports GitHub App installation tokens with repository `Metadata: read`. The response contains `permission`, `role_name`, and a `user` object with immutable numeric `id`.

GitHub documents that `permission` reports the highest effective base role across repository, team, organization, and enterprise grants. `maintain` maps to `write`; `triage` maps to `read`. Use the documented base permission for a write threshold instead of recognizing arbitrary custom `role_name` strings. Compare the returned user ID with the account's linked GitHub ID. A changed or reused login must never transfer the identity link.

The existing `verifiedGithubRepository` flow has the right foundation. The server finds the App installation, creates a restricted installation token, reads the repository, and queries that user's permission. GitHub documents that [installation tokens can be limited to repository IDs and requested permissions](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app). Prefer the bound repository ID during renewal; the first lookup may need its current owner/name. Keep the token metadata-only and private to the server. An installation's access establishes the App's authority, so the separate human permission check remains necessary.

GitHub also documents that [a user token cannot exceed the user's access and is further limited by the token's permissions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user). Identity linking therefore does not by itself establish any repository permission. A metadata verifier does not require Dhole to clone source, accept SSH keys, or receive a user's `gh` credentials.

GitHub calls can return an inaccessible/missing resource when installation access, organization policy, or the user's access is insufficient. Deny a new forge-derived grant on denial. Treat timeout, rate limiting, and unavailable service as failed verification, not evidence of access. Return a bounded error without leaking private repository existence to a nonmember.

## Codeberg and Forgejo API evidence

Codeberg publishes its deployed [API explorer](https://codeberg.org/api/swagger) and [OpenAPI specification](https://codeberg.org/swagger.v1.json). At review time the schema identifies version `16.0.0-dev-714-11075108+gitea-1.22.0`. It includes:

- `GET /api/v1/user` for the authenticated user and numeric user ID.
- `GET /api/v1/repos/{owner}/{repo}` for the repository and numeric repository ID.
- `GET /api/v1/repositories/{id}` for repository lookup by ID.
- `GET /api/v1/repos/{owner}/{repo}/collaborators/{collaborator}/permission` for a user's permission, role name, and user object.

Forgejo's [permission endpoint implementation](https://codeberg.org/forgejo/forgejo/src/commit/80fa6d9a909840746891784763e817dcb5370922/routers/api/v1/repo/collaborators.go) permits an authenticated user to query their own permission; querying another user's permission requires repository or instance administration. The implementation deliberately calculates the user's repository permission independently of the token's fine-grained permission. This is useful for a read-only verifier credential. It is not the same authentication model as a GitHub App installation.

There is an additional permission detail to test before shipping automated Codeberg admission. The collaborator endpoint returns a repository access mode. Forgejo also has permissions for individual repository units. Its [repository conversion](https://codeberg.org/forgejo/forgejo/src/commit/80fa6d9a909840746891784763e817dcb5370922/services/convert/repository.go) computes `permissions.push` specifically from the Code unit. Do not assume every general `write` role or every authenticated `permissions` object proves the same code-write authority under a restricted token. Pin fixture cases for organization teams, code versus issues permissions, read-only tokens, and owner/admin access against the supported Forgejo version. Until the exact threshold is established, native approval remains the working admission path.

[Forgejo token scopes](https://forgejo.org/docs/latest/user/token-scope/) distinguish `read:user` and `read:repository`, but `read:repository` includes repository files, releases, and collaborators. It is broader than GitHub's metadata-only permission. Selected-repository tokens restrict repository access, but the current documentation permits only repository/issue scopes for those tokens, so do not assume a single selected-repository token also permits `/user`. Identity verification and repository verification may need separate credentials or a confirmed supported endpoint.

The current [Forgejo OAuth2 provider documentation](https://forgejo.org/docs/latest/user/oauth2-provider/) explicitly says OAuth2 scopes are not yet implemented and warns that applications obtain broad user authority. This documentation may differ from a particular deployment's newer behavior. Verify the deployed version before promising narrow Codeberg OAuth permissions. Do not request broad authority merely to make a sign-in button work. A native account with an owner invitation can use a Codeberg repository immediately, without any Codeberg credential in Dhole.

The [Forgejo API guide](https://forgejo.org/docs/latest/user/api-usage/) says compatibility is maintained within a major version and major releases may break endpoints. Use static, tested integrations for supported instances. The public source inspection above supplies design evidence; it is not a live authenticated conformance test of Codeberg.

## Revocation and unavailable services

Direct Dhole membership remains valid during a forge outage and after a voluntary identity unlink. It was granted by a Dhole owner. Unlinking should invalidate grants whose source is that forge and remove the verifier credential, while preserving the native account and unrelated direct memberships.

For a forge-derived grant, require a recent server proof at issuance and renewal. The existing five-minute lifetime for GitHub-derived project tokens is a reasonable starting bound. Token expiry must be no later than proof expiry and parent-device expiry. A cached positive result may only be reused within its original validity window. Failure to refresh must not extend that window. An already verified grant may run until its published expiry; after that, unavailable verification denies renewal.

Use one verification per user/repository window, shared by the user's agents, rather than a forge API call for every claim, heartbeat, or project read. Keep indexed local authorization on every request. Event/webhook invalidation can reduce revocation delay when implemented with signature validation and delivery idempotency, but must not replace expiry and reconciliation. A forge has no universal webhook that makes every possible permission change instantly known to Dhole.

Removing project membership, disabling the native user, leaving the team, or revoking the device must stop the corresponding server access immediately at the next check. Recheck active WebSocket subscriptions and service actions. Invalidate descendant project credentials and coordination authority without deleting claims, completed runs, or audit history. Enforce authorization again before dispatching new queued work. Cancellation of already executing work uses the existing node command/reconciliation path; it cannot undo files already read or changed.

When the central server is unreachable, local coding may continue under the host's own permissions. The agent must not claim an active central reservation or forge fresh project credentials offline. Buffer only the bounded, idempotent execution/reporting data the existing protocol supports, and reconcile after reconnect. Do not replay expired capabilities as authorization for new work.

## Migration without silently changing access

Existing projects are team-shared. Making them creator-only during a schema migration would silently remove collaborators and break their devices. Keeping the current team join as an undocumented fallback would silently expose new private projects.

Use an explicit compatibility rule for existing projects, such as `access_mode = team`, with new projects defaulting to `members`. Display existing projects as shared with their team. Team mode keeps existing behavior, including the access of future team members, until an owner or administrator deliberately converts that project. It should not be selected by a missing membership row.

To convert a project, show its effective members and outstanding credentials, then materialize the chosen memberships. Preserve currently authorized people unless the operator deliberately removes them. Assign an active creator as owner where appropriate; disabled or departed creators require administrator recovery. Owners should never be inferred from a remote URL or the first device to reconnect.

Keep project IDs, repository IDs, event sequence numbers, token attribution, sessions, and immutable history. Re-evaluate existing tokens against the compatibility mode or memberships on every use; do not turn them into fresh permanent memberships. Retain existing GitHub repository IDs as binding evidence. The presence of a legacy binding must not silently opt a project into automatic contributor admission.

## Bounded implementation order and verification

1. Establish native account authority independently of optional forge links, coordinated with the sign-in work.
2. Add project membership, explicit existing-project compatibility, owner creation, and a shared Core authorization check. Apply it to project listing, mutations, tokens, MCP, sessions, WebSockets, and node-attributed actions.
3. Make device project selection use native project IDs and memberships regardless of how the user signed in. Preserve device scope narrowing and per-agent coordination capabilities.
4. Add owner/admin membership management and optional verified binding display. Keep code access credentials separate from metadata and membership credentials.
5. Add automated forge admission only when a project owner requests that sharing policy and the provider-specific permission and revocation tests are complete.

Required fixture checks should exercise two ordinary users in the same team with different private projects, cross-team denial, owner/member operations, local use with no linked identity, and a linked user who continues to use a local project. Test a malicious remote/name/cwd, same repository basename on two forges, fork versus upstream, renamed/recreated repositories, and changed/reused forge usernames.

Exercise membership revocation during a provider await, device revocation across several agent tokens, an open subscription after removal, forged body identities, and attempts to widen project/run scope. Test forge timeout, 403/404, rate limits, stale proof expiry, and direct membership during an outage. Migration fixtures must keep existing project access and history intact while proving new projects are private by default.

This report changes documentation only. The coordinating implementation task owns source changes, acceptance checks, documentation alignment, and the required `pnpm verify`. Future features actually deferred by that task belong in `ROADMAP.md`.
