# Auth and project security review

This review preserves the implementation before the final ADR 0003 product
narrowing. Fleet-disabled behavior and optional Sessions references describe
that historical revision. Core now owns both machine transport and sessions;
see [current MVP status](../MVP_STATUS.md) for the latest scope and verification.

Reviewed on 2026-09-05 against the active implementation. No confirmed release blocker remains in the reviewed native authentication, optional GitHub linking, account recovery, device authorization, project ACL, and browser WebSocket paths. This is a fixture-backed code review, not verification of a deployed installation.

## Findings resolved during review

| Finding | Exploit precondition and impact | Resolution |
| --- | --- | --- |
| Concurrent enrollment could escape device revocation | Two requests used the same device authorization with different machine names. Both captured an empty machine binding before reading their bodies, creating two nodes while retaining only the last binding. | Device enrollment reloads current authorization after reading the body and creates or rotates the single binding in a synchronous transaction. |
| Enrolled nodes retained obsolete owner authority | A node credential remained valid after its approving user was disabled or demoted. | Fleet checks the parent device, current user, team, administrator role, permission, expiry, and revocation during authentication, incoming frames, and command delivery. Account changes revoke device authorizations and bound nodes permanently. |
| Disabled Fleet remained reachable through Access | A core-only installation could call the device enrollment endpoint and create Fleet records. | The endpoint rejects enrollment when Fleet is disabled. |
| Recovery links survived password changes | A previously issued reset link could overwrite a password chosen after that link was issued. Issuer grants could also become usable again after re-enabling an account. | Password changes, recovery, disabling, and role changes revoke unused grants targeting or issued by the affected user. Grant consumption checks current authority again after password hashing. |
| Requests could grant fresh access after session revocation | A stolen cookie could start a slow request, wait for password rotation, then finish an invitation, API-token issuance, device approval, or project-sharing operation. | The shared JSON boundary invokes the authentication guard after reading and validating the body. Core reloads the same session and principal; Access reloads the bearer, parent device, scopes, role, and native project ACL. Credential-issuance paths also recheck before committing. |

## Boundaries checked

Native login, sessions, machine tokens, and project access do not depend on GitHub. Optional linking requires a native session, CSRF, and current password. OAuth state binds the user, exact native session, browser cookie, and PKCE verifier; it is consumed before the exchange. The callback rechecks the session after the provider response. Linking neither creates a native account nor changes roles or merges email identities.

New projects are private. Creator and team administrators retain owner authority; editor and viewer membership is resolved from current native records. Existing GitHub repository bindings require native project access even after successful external write verification. Derived tokens cannot exceed the device grant or the user's current project permission. Session snapshots, subscriptions, and live delivery additionally require current participant or administrator access.

Recovery and device codes are hashed, expiring, single-use, and rate limited. Browser-facing device responses omit node credentials. Provider exchanges use fixed endpoints, bounded responses, schema validation, and sanitized errors. Fixtures cover denied scopes, arbitrary foreign IDs, revocation, expiry, concurrent requests, and rollback when audit persistence fails.

## Verification

Independent runs passed 96 tests across eight suites: Core, native/GitHub authentication, account grants, project ACL, device authorization, Access, module host, and session WebSockets. Core coverage includes revocation, expiry, disabling, role changes, and team changes during a streamed request body. Earlier Fleet-specific verification passed with the device suites. The integrating task owns the final `pnpm verify` result.

No live provider calls, real machine enrollment, deployment, or user configuration changes were performed for this review. Production proxy behavior and real external provider interoperability remain outside this fixture-backed result.

## Offline administrator recovery addendum

The bounded review of `apps/server/src/recover-account.ts` found no confirmed issue. The command requires explicit database, account, output, and origin arguments. It opens an existing private, caller-owned database without migrations or environment-derived configuration and permits only the sole active native administrator. A one-hour grant uses the normal single-use reset consumer and stores only the token hash with a system audit record.

The command creates the plaintext link in an exclusive, nonsymlinked, mode-0600 output file. File creation and synchronization occur inside the immediate SQLite transaction that replaces any prior reset grant. Failure preserves the previous grant and removes only a newly created output file. The link never goes to stdout.

All six recovery tests passed in an independent single-worker run using temporary databases and directories. Coverage includes successful consumption, repeat issuance, existing-output protection, symlink and mode rejection, missing migration, and a forced commit failure after file creation. No real account or database was used.
