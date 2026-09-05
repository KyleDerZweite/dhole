# Native authentication review

Reviewed 2026-09-05 against the in-progress checkout. This is a design recommendation, not a claim that the controls below are implemented or that Dhole meets a NIST assurance level. No live authentication, provider requests, service changes, or deployment occurred.

## Decision

Keep Dhole accounts as the primary identity. Password sign-in must work without GitHub configuration, a forge account, or a remote repository. Attach an optional GitHub identity to an existing account for features that need it. The Dhole user ID remains stable when a GitHub handle changes or a link is removed. Project membership and repository permission checks are separate authorization decisions.

Reuse the current Node `crypto.scrypt` password hashing and database-backed opaque sessions for this MVP. The current `N=2^15, r=8, p=3` parameters are one of OWASP's published scrypt configurations. OWASP prefers Argon2id and accepts scrypt when Argon2id is unavailable. Better Auth itself uses scrypt because Node supports it natively. Using a standard cryptographic implementation is appropriate here; implementing WebAuthn, OIDC token verification, or a new password hash algorithm ourselves would not be. [1][7]

## Account lifecycle

- Keep public registration closed by default. An administrator invites a user with a short-lived, one-use setup grant and a preassigned role. The user chooses their own password. Invitation possession proves authorization to create that account, not ownership of an email address. Without mail delivery, an administrator shares the grant through a trusted existing channel. Pending public registration is a separate future policy, not needed for a private server.
- Protect first-admin setup with an operator-provisioned, randomly generated secret of at least 32 bytes, preferably loaded from a mounted secret file. Submit it over HTTPS in a designated header, compare hashes in constant time, and atomically require an uninitialized installation when creating the first administrator. Persist initialization so the route stays closed after restart. No default password, publicly claimable first user, or GitHub-first takeover rule. Do not publish the secret in configuration responses, URLs, logs, or audit records. A local operator command with no web bootstrap endpoint is also valid.
- Keep account activation and suspension on the native account. Optional GitHub link state must not decide whether a native account can sign in. Preserve the last active administrator guard. If public requests are added later, pending users receive no application access, devices, or API tokens before approval.
- Allow an authenticated user to change their password after checking the current password. A privileged administrator should issue a reset grant rather than choose and retain the user's permanent password.
- Without an email service, use a documented operator/admin recovery procedure. Issue a random, hashed, short-lived, one-use reset grant after out-of-band identity verification. Consume it atomically with password replacement and revocation of browser sessions, devices, derived API tokens, and pending grants. Require normal sign-in afterward. Recovery must not silently clear account suspension or elevate roles. The last administrator needs a narrow operator recovery command, not a generic shell endpoint or public recovery bypass. [4]

The existing administrator-created-password endpoint can remain during development, but a deployable account lifecycle needs a way for the recipient to set or change that password and for the operator to recover a lost administrator account. An unverified email field can remain a login identifier. It must not become evidence for account merging or an email reset destination.

## Password and session hardening

NIST SP 800-63B-4 requires a minimum of 15 characters for passwords used alone, recommends allowing at least 64, rejects composition rules and periodic forced changes, and requires checking newly selected passwords against a blocklist of common, expected, or compromised values. Count Unicode code points. A local curated blocklist avoids sending passwords or hashes to an external service. The current 12-character creation minimum and absence of a blocklist should be corrected. Preserve verification of existing hashes; introducing Unicode normalization requires an explicit hash-format migration rather than silently changing legacy password bytes. [2][3]

The current login limiter uses one combined IP-and-email key. Apply independent limits per normalized account and per trusted source address to cover distributed guessing and password spraying. Bound concurrent scrypt work to protect memory and the worker pool. Verify a precomputed dummy hash for unknown users so the missing-account path does not skip all expensive work. Keep generic errors for nonexistent, suspended, and wrong-password accounts. Never trust arbitrary forwarded IP headers. Validate stored hash parameters before invoking scrypt and fail closed on malformed hashes. [2][3]

Keep random session secrets in `Secure`, `HttpOnly`, host-only cookies with an appropriate `SameSite` policy; store only token hashes in SQLite. Keep the existing separate CSRF token bound to its session and server-side origin checks for mutations. Rotate sessions after sign-in and sensitive authentication changes. A seven-day absolute browser session is a defensible MVP product choice if sensitive actions require recent password verification. NIST's AAL1 guidance permits a longer overall period; this does not establish compliance with its other requirements or with AAL2. [2][5]

Provide current-session logout and account-wide session/device revocation. Suspension and role reduction must permanently revoke device grants and their derived API tokens, not merely reject them while the user is disabled and revive them on reactivation. Close authenticated WebSockets after committed revocation. Recheck the approving user's current status and permissions when redeeming a device code, not only when approving it.

## Optional GitHub link

Start linking from a CSRF-protected request by an active native session. Require its current password, or a short-lived recent-authentication marker established by the same check. Bind the one-use OAuth state to the intent `link`, native user ID, exact initiating session, browser nonce, PKCE verifier, and expiry. The callback must revalidate the same still-active session before attaching the identity.

The current production session cookie uses `SameSite=Strict`, which a browser omits on the cross-site GitHub callback. Use `SameSite=Lax` with the existing CSRF and origin defenses for this OAuth flow, or introduce a same-origin completion step before linking. Request-level fixtures do not simulate browser cookie rules, so verify this behavior explicitly.

Use GitHub's numeric user ID as the unique external key. Reject a GitHub ID already linked to another native account. Never merge accounts because their email or display names match. Do not overwrite the native profile from the provider response. Reauthenticate before unlinking or replacing an identity, audit the change, and re-evaluate any GitHub-derived authority. GitHub OAuth tokens stay server-side and may be discarded after identity verification when no continuing delegated access is needed.

For this MVP, linking alone is sufficient. Optional GitHub sign-in can be added later for identities that are already explicitly linked, with the same native account suspension and session rules. GitHub login must never automatically register or approve a native account.

## Library comparison and growth

| Choice | Fit for Dhole | Recommendation |
| --- | --- | --- |
| Existing Node scrypt and SQLite sessions | Already integrated with audit history, CSRF, devices, WebSockets, and native roles. Lifecycle and rate-limit gaps remain. | Harden and reuse for the current password-only MVP. |
| Better Auth | Supports Hono, `better-sqlite3`, passwords, session management, account linking, and passkeys. A migration changes auth tables, routes, cookies, and audit integration. | Best candidate for a deliberate future migration if several additional login methods are committed. Disable implicit email linking and cookie caching where immediate revocation is required. Its defaults do not implement Dhole approval or repository authorization. [6][7][8][9] |
| Auth.js credentials provider | Forwards credentials to application logic. Its documentation leaves credential persistence, password hashing, throttling, and resets to the application. | Little reduction of Dhole's present password-management work. [10] |
| SimpleWebAuthn / `openid-client` | Established purpose-built protocol implementations. `openid-client` documents OpenID conformance certification. | Use for future WebAuthn or OIDC support if retaining native sessions; do not implement those protocols manually. [11][12] |

Passkeys can remove password entry and provide phishing resistance when correctly verified. They require a stable RP ID/origin, server-verified challenges, explicit user verification policy, credential management, and recovery. They are valuable follow-on work, not a reason to make GitHub mandatory. An OIDC provider is another optional login method keyed by issuer and subject, never by matching email.

One server and local SQLite are suitable for the current deployment. Keep auth and account writes transactional, use the existing database, and avoid another service. Limit unnecessary `last_seen_at` writes if they become a bottleneck. Multiple server replicas would require shared session/revocation state, coordinated throttling, shared or database-backed pending OAuth state, and cross-process WebSocket invalidation. SQLite's own guidance recommends a client/server database when concurrent writers cannot queue. Migrate for measured concurrency or availability needs, not a guessed user count. [13]

## Sources

1. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), especially its scrypt parameter alternatives. Retrieved from the [official source](https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Password_Storage_Cheat_Sheet.md).
2. [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), sections 2.1.3, 3.1.1.2, 3.2.2, and 4.2. Retrieved from NIST's published [authenticator guidance](https://raw.githubusercontent.com/usnistgov/800-63-4/nist-pages/sp800-63b/authenticators/index.html), [assurance guidance](https://raw.githubusercontent.com/usnistgov/800-63-4/nist-pages/sp800-63b/aal/index.html), and [recovery guidance](https://raw.githubusercontent.com/usnistgov/800-63-4/nist-pages/sp800-63b/events/index.html).
3. [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), retrieved from its [official source](https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Authentication_Cheat_Sheet.md).
4. [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), retrieved from its [official source](https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Forgot_Password_Cheat_Sheet.md).
5. [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), retrieved from its [official source](https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Session_Management_Cheat_Sheet.md).
6. Better Auth [Hono integration](https://www.better-auth.com/docs/integrations/hono) and [installation/database support](https://www.better-auth.com/docs/installation).
7. Better Auth [email and password authentication](https://www.better-auth.com/docs/authentication/email-password).
8. Better Auth [users and accounts](https://www.better-auth.com/docs/concepts/users-accounts), including `disableImplicitLinking`.
9. Better Auth [session management](https://www.better-auth.com/docs/concepts/session-management), including immediate revocation limitations with cookie caching, and [passkeys](https://www.better-auth.com/docs/plugins/passkey).
10. Auth.js [credentials provider](https://authjs.dev/getting-started/authentication/credentials).
11. [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn).
12. [`openid-client`](https://github.com/panva/openid-client).
13. SQLite [appropriate uses](https://www.sqlite.org/whentouse.html).

The direct NIST and OWASP pages returned HTTP 403 in this research environment. Their official published repository copies were read instead. Other cited documentation was retrieved directly. This review used no live model quota and did not run the repository verification suite; the integrating implementation must run `pnpm verify`.
