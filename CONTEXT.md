# Dhole

Dhole manages provider access and shared agent work for approved users and their machines.

## Language

**Core**:
The accounts, projects, conversations, agent activity, runtimes, provider configuration, machine access, and master overview available in every Dhole installation.

**Module**:
An optional product feature within Dhole, with declared dependencies on other modules. A module does not imply a separate deployment.

**Access**:
The approval and permission rules for human users, machines, and their project credentials.

**MCP**:
The optional protocol connection through which authorized agent clients use Dhole's available work tools.

**Machine**:
A user's approved execution host with its own runtime installations and permitted repositories.
_Avoid_: Fleet

**Executor**:
A machine selected to carry out an agent operation.

**Device authorization**:
A user's revocable approval for one machine to obtain scoped access and perform permitted work on their behalf.

**Session**:
A persistent conversation shared by authorized people and agents.

**Run**:
One human objective and the agent activity associated with it.

**Agent**:
An attributed participant doing work through a runtime, with recorded activity and control limits.

**Runtime**:
The program that conducts agent work, such as Codex, Claude Code, or Kimi Code.

**Provider**:
A service that offers model inference, such as CLIProxyAPI or a direct vendor endpoint.

**Model**:
A provider's model identity, with separately recorded advertisement, enablement, and capability evidence.

**Gateway**:
Dhole's optional CPA administration and observation feature, including catalog policy and retained request history.

**Coordination**:
Dhole's optional record of active work, overlap, findings, and agent lifecycle.

**Claim**:
An agent's declared intent to work on a repository scope, used to make overlapping work visible.

**Skill**:
Static instructions and references that an agent client loads for a particular kind of work.
_Avoid_: Server skill registry
