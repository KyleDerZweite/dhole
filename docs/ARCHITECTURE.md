# Architecture

Dhole is a self-hosted control plane with one central server and one outbound daemon per execution machine.

Browser -> central server <- authenticated outbound node connections

The server owns authentication, authorization, SQLite, modules, scheduling, normalized events, and the production web build. Nodes own runtime processes, allowed repository workspaces, and an idempotent local operation journal. Provider configuration is independent of runtime configuration.

## Runtime boundaries

- apps/server: Hono API, WebSockets, migrations, domain modules, static web serving, MCP boundary.
- apps/web: Svelte 5 application. It has no direct machine or provider connection.
- apps/node: outbound daemon, runtime discovery, repository allowlists, command journal, runtime process adapters.
- packages/shared: versioned Zod schemas and wire types only.

## Static modules

Core, Fleet, Sessions, Runtime, Coordination, Gateway, Orchestration, Memory, Skills, and Lab register at compile time. Each module contributes routes and services through a small server context. Domain code may depend on shared wire schemas and server infrastructure but not on another module's private storage helpers.

## Authority

Git remains authoritative for issues, branches, commits, pull requests, accepted documentation, and project-stored skills. Dhole records references and execution evidence. SQLite operational rows are authoritative for live Dhole state; its append-only event/outbox table is authoritative for ordered external notification history.

## Reconnection

App clients fetch an authorized snapshot and watermark, register a subscription, replay rows after the watermark, then receive post-commit live events. Nodes authenticate again, report journal state and capabilities, and receive incomplete commands. A repeated operation key is reconciled, never blindly respawned.

## Extension rule

Add compatible models through provider/model data. Add a runtime by implementing the locked adapter contract and registering it statically. Add a module only when it owns a distinct policy and user-facing boundary; a new table alone is not a module.
