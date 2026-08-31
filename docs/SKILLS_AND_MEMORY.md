# Skills and project memory

Skills and memory are server-owned, reviewable inputs to a run. They are not
runtime plug-ins and they never carry provider credentials. The server stores
their content and provenance in SQLite; a runtime receives only the bounded,
authorized context selected for that activation.

## Portable `SKILL.md`

A skill package is portable when it has a directory whose basename is the
skill name, a `SKILL.md`, and optional relative reference files. Dhole parses a
small YAML frontmatter subset instead of shipping a general YAML parser or
Markdown renderer. A document must start with `---` and contain a closing
`---`; the body is the remaining trimmed text (it may be empty). The whole
file is limited to 500,000 characters.

The accepted frontmatter keys and limits are:

| Key | Shape and limit |
| --- | --- |
| `name` | Required kebab-case (`[a-z0-9]+(?:-[a-z0-9]+)*`), 1–64 characters. |
| `description` | Required trimmed string, 1–1,024 characters. |
| `license` | Optional trimmed string, at most 160 characters. |
| `compatibility` | Optional trimmed string, at most 500 characters. |
| `allowed-tools` | Optional inline comma/bracket list, at most 100 values, each 1–120 characters. |
| `metadata` | Optional JSON object or indented key/value map; each value is trimmed to at most 500 characters. |
| `references` | Optional inline comma/bracket list, at most 64 relative paths, each 1–1,024 characters. |

Keys are case-folded, duplicate or unknown keys are rejected, and `>`/`|`
block values are folded/literal according to the small parser rules. The
stored manifest may also include `stableKey` and a SHA-256 `contentHash`; the
service adds those fields after parsing. `stableKey` must equal the
frontmatter `name`.

Directories and references are deliberately boring and safe. They must be
bounded relative paths: no leading slash, backslash, NUL, URI scheme, empty
component, `.` or `..`. The directory basename must be kebab-case, at most 64
characters, and equal `name`; a reference cannot escape the package. Dhole
does not execute scripts from a skill package. References are evidence for a
human or runtime to read through an explicitly allowed repository/workspace
operation.

### Skill lifecycle and proposal gate

Each skill has an immutable, monotonically numbered version. A version moves
through `draft`, `benchmarked`, `canary`, `active`, or `deprecated`:

```
proposal -> draft -> benchmarked -> canary -> active -> deprecated
```

The arrows describe the intended review path; the lifecycle endpoint accepts a
valid enum but enforces that an active version is deprecated before another
non-terminal lifecycle change. A deprecated version cannot be reused. There is
at most one active version per `(project, stableKey)`; activating a new version
atomically deprecates the former active version. Installation-global skills
(`projectId` omitted) are readable by any authenticated active user, while
proposing or changing their lifecycle requires a current administrator. Project
skills remain project-member scoped for reads and mutations.

`POST .../proposals` rejects markdown containing recognizable credentials and otherwise always creates `draft`. An activation-origin proposal is
recorded with `proposedByActivationId`, but only an authenticated human user
may activate or deprecate it. This keeps model output advisory: a benchmark,
runtime, or agent cannot silently change the active prompt. Skill changes are
also suitable subjects for Improvement Lab promotion decisions, but Lab never
creates or activates a skill version.

### Skill API

All routes below use the authenticated browser user and object-level project
authorization. Request bodies are parsed with the Zod schemas in
`apps/server/src/modules/skills/types.ts`.

| Method and path | Body/query | Result |
| --- | --- | --- |
| `GET /api/projects/:projectId/skills` | — | Project-visible skill summaries. |
| `GET /api/skills` | — | Installation-global skill summaries; any authenticated active user may read them. |
| `GET /api/skills/:skillId` | — | One skill summary, including `activeVersionId` when present; global rows are readable by authenticated users and project rows by members. |
| `GET /api/skills/:skillId/versions` | — | Versions newest first, including lifecycle, manifest, markdown, hash, and proposal provenance, with the same global/project read scope. |
| `GET /api/skills/versions/:versionId` | — | One version, with the same global/project read scope. |
| `POST /api/skills/proposals` | `{ projectId?, stableKey, markdown, directory?, references? }` | `201` and a new `draft` version; omitting `projectId` targets an installation-global skill and requires an administrator, while a supplied project requires project membership. |
| `POST /api/projects/:projectId/skills/proposals` | Same fields; path supplies `projectId`. | `201` and a new project-scoped `draft`. |
| `POST /api/skills/versions/:versionId/lifecycle` | `{ lifecycle }` | Updated version after lifecycle validation; installation-global rows require an administrator, project rows a project member. |
| `POST /api/skills/versions/:versionId/activate` | — | Human-only activation; same global-administrator/project-member rule; prior active version is deprecated. |
| `POST /api/skills/versions/:versionId/deprecate` | — | Human-only deprecation; same global-administrator/project-member rule; active pointer is cleared when needed. |

`contentHash` is SHA-256 over the normalized manifest/body representation used
by the parser. The original markdown is retained for review. Never put a
provider token, node credential, or management secret in markdown, metadata,
references, logs, events, or browser responses.

## Memory packs

A memory pack is a project-owned set of working knowledge. Its `stableKey` is
unique within a project and its scope is one of:

| Scope | `scopeKey` |
| --- | --- |
| `project` | Must be omitted; one pack applies to the project. |
| `role` | Required (for example, `reviewer`). |
| `phase` | Required (for example, `release`). |

Entries are not edited in place. A pack points at one active generation;
generations form a parent-linked, monotonically numbered history. A generation
contains an immutable ordered list of entries (`title`, `body`, `sourceType`,
`sourceReference`, evidence, and content hash) and has state `draft`,
`approved`, `active`, or `archived`. SQLite triggers reject updates and deletes
of entries. Activating, folding, or clearing a pack creates a new active
generation and automatically archives the former active generation. Archived
rows remain available for audit and explicit comparison.

### Proposals, decisions, fold, and clear

An agent activation or user may propose an entry. A proposal records its base
generation (when supplied), actor identity, source, and evidence, and starts in
`pending`. A human decision is a one-shot transition to `approved` or
`rejected`; a second decision returns a generation-conflict error. Only
approved proposals can be folded. The decision row update and its durable
`memory.decided` event are one atomic transaction: if the event append fails,
the state change rolls back and no decision is visible.

`fold` selects entries from the base generation and/or approved proposals,
copies them into a new active generation, and records a reason. `clear` is the
same immutable-generation operation with an empty entry list; it does not
delete the previous content. `activateGeneration` can point a pack at an
existing reviewed `approved` or `archived` generation (and is a no-op for the
current active generation), subject to the expected current base; an unreviewed
`draft` generation is rejected. There is intentionally no destructive “delete
memory” route.

Every mutating operation that changes the active pointer uses a compare-and-
swap check (`expectedBaseGenerationId`/`baseGenerationId`) inside a transaction.
If another writer won the race, Dhole raises `memory_generation_conflict` and
the caller must reread the active generation and retry. Duplicate selected
IDs, entries from another generation, proposals from another pack, and
proposals based on a different generation are rejected. Generation and entry
content hashes make retries and audit comparisons deterministic.

### Read, search, and injection rules

`readContext` injects only an `active` generation by default. An `archived`
generation requires `includeArchived=true`; `draft` and `approved` generations
are never injected. Reads are bounded by `maxEntries` (default 200, maximum
2,000) and `maxChars` (default 100,000, maximum 500,000), and return a
`truncated` flag. The context includes the pack, generation, ordered entries,
content hashes, and source provenance so a runtime can show where each fact
came from. The caller chooses a pack and generation explicitly; memory is not
implicitly appended to every prompt.

SQLite FTS5 indexes entry title/body at insert time. Search is current-only:
the default query returns entries from active generations only. Archived rows
are included only when `archived=true`; drafts and approved generations never
match. The query is trimmed to 512 characters, tokenized to at most 32
letters/numbers/underscore/hyphen terms, and quoted before `MATCH`. There is
no embedding or vector store. FTS results still carry the entry's source
provenance and content hash.

Memory mutations append versioned `memory.proposed`, `memory.decided`, and
`memory.activated` events in the same transaction as the row change when an
authenticated user is the actor. A `memory.decided` payload records the
proposal ID, normalized decision (`approve`/`reject`), resulting state, and
optional reason. Events contain only redacted references and IDs; the event log
is the audit/outbox, not a replacement for the operational generation tables.

### Memory API

| Method and path | Body/query | Result |
| --- | --- | --- |
| `GET /api/projects/:projectId/memory/packs` | — | Project packs, sorted by `stableKey`. |
| `POST /api/projects/:projectId/memory/packs` | `{ stableKey, name, scope, scopeKey? }` | `201` pack; scope rules are enforced. |
| `GET /api/projects/:projectId/memory/search` | `q`, optional `archived=true`, `limit` (clamped 1–500) | FTS entries from active generations, or active+archived when requested. |
| `GET /api/memory/packs/:packId` | — | Pack summary and active pointer. |
| `GET /api/memory/packs/:packId/generations` | — | Generations newest first, with entries. |
| `GET /api/memory/packs/:packId/proposals` | — | Proposal history and decisions. |
| `GET /api/memory/packs/:packId/context` | `generationId?`, `archived=true?`, `maxEntries?`, `maxChars?` | Bounded injectable context; archived requires explicit opt-in. |
| `POST /api/memory/packs/:packId/proposals` | `{ title, body, sourceType, sourceReference, evidence?, baseGenerationId? }` | `201` pending proposal. |
| `POST /api/memory/proposals/:proposalId/decision` | `{ decision: approve\|approved\|reject\|rejected, reason? }` | One-shot human decision and atomic `memory.decided` event. |
| `POST /api/memory/packs/:packId/fold` | `{ baseGenerationId?, entryIds?, proposalIds?, reason? }` | `201` new active generation. |
| `POST /api/memory/packs/:packId/clear` | `{ baseGenerationId? }` | `201` empty active generation; history remains. |
| `POST /api/memory/packs/:packId/activate` | `{ generationId, baseGenerationId? }` | Reviewed `approved` or `archived` generation becomes active; drafts are rejected and the prior active generation is archived. |

Users must be active members of the project for all pack operations. An
activation actor is accepted by the service layer only when the activation
belongs to a run/session in that project; the HTTP routes intentionally use the
current user, while MCP or orchestration bridges may pass the activation form.
No route exposes credentials or private node state.

## Verification

The focused tests cover parser/path limits, human-only skill activation,
immutable generations, archived-read opt-in, stale-base conflicts, and
active-only FTS search:

```sh
pnpm --filter @dhole-control/server test:run -- src/modules/skills/service.test.ts src/modules/memory/service.test.ts
pnpm format:check
```

Run `pnpm verify` before delivery; it adds lint, typecheck, the full test suite,
and builds.
