# Optional modules and deployment packaging

Accepted on 2026-09-05. Dhole's first release prioritizes CPA management and Agent Mediation. A module is trusted code compiled with the central server and may depend on declared modules; it does not need its own process or independent deployment. The core must start with every optional module disabled. Static selection disables routes, tools, navigation, and background work while retaining migrations and immutable history.

The user explicitly approved Podman deployment packaging with Pangolin Newt, superseding ADR 0001's container prohibition. `compose.yaml` runs the central server and Newt; CPA remains an existing external inference service and execution nodes stay on their hosts. Preparing or locally testing this packaging does not authorize deploying it or enrolling the current machine.

Human interaction should normally stop after signing in and authorizing a machine. Agents use revocable device authorization and derived scopes to perform supported administration and coordination. Dhole owns native user accounts and project memberships; local projects and other code hosts work without GitHub. Optional GitHub linking binds an immutable external identity after native reauthentication. External write-access verification never substitutes for membership in an existing Dhole project. Browser responses, logs, events, and commands must not contain provider, management, or node credentials.

[ADR 0003](0003-core-and-product-focus.md) narrows the active product and defines Core to include sessions, runtime/provider configuration, agent activity, and machine transport. Only Coordination, Gateway, and MCP remain optional. Earlier Fleet, Sessions, and Runtime module IDs are not current product modules.
