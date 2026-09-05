# Access control

Native Dhole accounts are the primary human identity. Machine authorization,
project API credentials, execution node credentials, and catalog consumer
tokens are separate capabilities. An optional GitHub link proves a linked
identity; it does not grant local account access, project access, or a role.

Every request derives its actor and scope from the authenticated credential.
Path and body IDs never grant access. HTTP, MCP, WebSocket, and background
command paths recheck the relevant scope, expiry, revocation, and current
user/team membership. Supplying a bearer credential does not gain the broader
rights of an accompanying browser cookie.

## Human and machine flow

Native sign-in uses email and password. Production first-owner bootstrap also
requires the deployment operator's one-time secret. Accounts are closed to
self-registration; an administrator controls invitations. Password changes
and recovery revoke prior sessions and machine-derived access. The browser
uses secure cookies and CSRF protection for mutations.

`POST /api/auth/device/start` creates a ten-minute machine code. A signed-in
human reviews the requested permissions and grants only permissions they hold.
The machine polls to consume the approval once and saves its 90-day
authorization privately. The browser receives no persistent device or node credential.
The user can inspect and revoke machines through `/api/auth/devices`.

A device derives narrower project credentials through
`POST /api/auth/device/project`. Manual project mode supports local and
non-GitHub work using native project authorization. The optional GitHub path
verifies repository write permission separately. Manual project credentials last at most one hour; GitHub-derived credentials
last at most five minutes. A project credential cannot expand beyond the device grant or the user's current access.

A separately approved global `projects:create` device permission permits
`POST /api/auth/device/projects` to create an owned private project with an
optional repository reference. It supports an `Idempotency-Key` header for
safe retries. That reference remains unverified remote metadata. The normal connection request includes this permission; the human still
chooses whether to approve it. Global project creation is not included in project API tokens or model-visible
coordination arguments.

## Account and project administration

`GET /api/auth/methods` describes the available native sign-in, first-owner
bootstrap, and optional GitHub-link behavior. Production bootstrap uses
`DHOLE_BOOTSTRAP_TOKEN` or `DHOLE_BOOTSTRAP_TOKEN_FILE` and the
`x-dhole-bootstrap-token` request header. It succeeds only before the first
user exists. New passwords require at least 15 characters.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Native email/password sign-in |
| `POST` | `/api/auth/password` | Verify current password, replace it, and revoke prior access |
| `POST` | `/api/admin/invitations` | Administrator issues a single-use setup link, default 24 hours and maximum seven days |
| `GET`, `POST` | `/api/auth/invitation`, `/api/auth/invitation/accept` | Inspect safe grant metadata, then choose a display name and password |
| `POST` | `/api/admin/users/:id/reset-password` | Issue a one-hour single-use recovery link for an eligible account |
| `GET`, `POST` | `/api/auth/password/reset` | Inspect the recovery grant, then choose a replacement password |
| `POST` | `/api/auth/github/link` | Verify current native password and begin optional GitHub linking |
| `GET` | `/api/auth/github/callback` | Complete a browser/session-bound link to the same native account |

The server returns invitation/recovery links once and stores only token hashes.
An administrator delivers the link through an appropriate separate channel;
Dhole sends no email. Acceptance requires subsequent native sign-in. Recovery
revokes sessions, API tokens, device authorization, and linked node access.
An administrator cannot reset another administrator through this route.
GitHub linking is neither login nor account recovery, performs no email merge,
and does not change native roles.

A sole active native administrator who loses access can use the narrow
offline `recover-account` server command. It requires explicit existing
private database, administrator email, unused output path, and public origin.
It creates a one-hour reset grant and writes its link only to a private file;
it neither sets a password directly nor bypasses native account revocation.
The command opens no network connection and runs no migrations. Follow the
[operator recovery procedure](DEPLOYMENT.md#later-recovery-of-a-sole-administrator)
with a stopped server and consistent backup. No real recovery was performed
during development; tests use temporary databases.

New projects are private. Their creator and team administrators are owners;
owners can grant existing active team users `editor` or `viewer` membership.
Editors can change project work; viewers have read access only. Existing
legacy team-visible projects retain their visibility until an owner explicitly
makes them private. Recording a Codeberg, GitHub, or other repository remote
is metadata and grants no remote repository rights.

Human owners use `GET /api/projects/:projectId/members`,
`PUT` or `DELETE /api/projects/:projectId/members/:userId`, and
`PUT /api/projects/:projectId/visibility` with `visibility: "private"`.
Membership administration is browser-session and CSRF protected, not an
ambient API-token right. Downgrades and revocation invalidate affected access;
old tokens do not retain write authority after a viewer downgrade.

## Permission matrix

| Operation | Human access | Machine/API/MCP access |
| --- | --- | --- |
| Account invitations, user administration | Administrator | No general account-administration bearer route |
| Approve/revoke own machine | Signed-in owner; administrator permissions require current administrator role | Start/poll are machine-facing; approval stays with the human |
| Create a private project through a machine | Approve the requested global grant | `projects:create` on the device; native owned project, no remote rights implied |
| Project/repository reads and changes | Current native project/team authorization | Derived project scope and its current native access checks |
| Session transcript/tools | Authorized participant or permitted administrator read | Explicit owning run/project scope; node sees assigned command data only |
| Queue, steer, cancel, answer approval | Participant, capability, and control-lease checks | Narrow owning-run tools where granted; no generic session takeover |
| Coordination read/check | Authorized project reader | `project:read`; session-specific checks also prove capability |
| Coordination session/claim/lifecycle mutation | Authorized project writer and session ownership | `coordination:write` plus owned session capability |
| Execution node enrollment | Administrator-approved `fleet:admin` device grant | Machine-facing exchange returns the private node credential |
| Replace node credential | Browser cookies cannot receive the credential | `fleet:admin`, current administrator, non-run project token, project write and same machine team |
| Gateway metadata/history/catalog read | Authorized team member through Gateway policy | `gateway:read`, non-run project token, current native project read and same team |
| Gateway import | Administrator | `gateway:ingest`, current administrator, non-run project token and project write |
| Gateway connection/settings/accounts/catalog administration | Administrator | `gateway:manage`, current administrator, non-run project token and project write |
| Effective catalog projection | Dedicated consumer credential | Connection/client-scoped, expiring, read-only catalog token |

Gateway permissions are explicit team-level administration capabilities carried
by a project-authorized credential. A run-scoped token cannot use them.
`gateway:manage` includes typed connection changes, credential rotation,
settings preview/apply, account status, provider consent, health, pruning, and
catalog policy/token management. It is not arbitrary upstream request access.

The shared `TokenPermissionSchema` in `packages/shared/src/mcp.ts` preserves
legacy permission names for stored-token compatibility. The `fleet:admin`
scope authorizes Core machine operations. Retired memory, skill-proposal,
child-work, and benchmark scopes grant no active route or MCP tool. Static
agent Skills are client files and require no server Skills permission.

The local CLI requests Gateway authority only with `connect --gateway`.
`gateway_manage` and the `gateway` command use the same closed action schema
and privately derive a project token containing the required single Gateway
permission. A Gateway-only grant can use these actions without Coordination.
Its arguments contain private file paths for secret or callback input;
responses identify private files for issued credentials. This client does not
expand the server's current native project or administrator checks.

## Credential boundaries

Human passwords use parameterized scrypt. API/device/enrollment/catalog tokens
are random and hashed at rest, with expiry and revocation. Provider and CPA
management secrets use encrypted envelopes with external versioned keys.
The local bridge retains its project token and session capability outside
model arguments. Commands contain secret references, never secret values.

Catalog credentials cannot perform inference or management through Dhole.
Agent-issued catalog tokens record the parent API/device identity, expire no
later than that authority, and cannot survive its revocation or scope change.
The token also requires current native project and administrator access.
Browser-issued catalog tokens remain tied to current native administrator
authority and are revoked by password reset, disablement, or demotion.
Migration 015 invalidates pre-existing catalog tokens with unknown issuer
provenance; they must be reissued.
Catalog token issue responses contain that narrow token once; they do not
contain provider, management, or node credentials. OAuth authorization codes
are transient inputs forwarded to CPA and are not persisted in command/event
history. Public DTOs, errors, events, logs, fixtures, and exports are redacted.

See [Node operation](NODE_ENROLLMENT.md),
[Mediation integration](MEDIATION_INTEGRATION.md),
[Gateway administration](GATEWAY_AND_CPAMP_REPLACEMENT.md), and
[Threat model](THREAT_MODEL.md) for the owning operations and fixture tests.
The [auth security review](reviews/auth-security.md) records the resolved
revocation and delayed-request findings; its independent fixture checks are
separate from the aggregate release gate.
