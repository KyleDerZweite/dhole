# Questions for Dhole's owner

These are the unresolved Dhole decisions for you to answer. This file is not a
skill or an interviewing protocol. Questions whose answers can be established
from code, documentation, experiments, or external research do not belong
here.

Owner answers were recorded on 2026-09-04. `Accepted` records a settled
direction, `partial` preserves a decision whose required detail remains open,
`deferred` postpones the decision, and `research` delegates fact-finding
without silently choosing the result.

## P0 — Product and v0

### Q01 — First users

Should v0 be optimized specifically for the two trusted developers operating
one private, self-hosted Dhole installation, with public users, SaaS,
untrusted tenants, contractors, BYOD, and cross-organization sharing out of
scope?

Answer (accepted 2026-09-04): Optimize v0 fully for the two trusted developers
and their one private, self-hosted installation. The listed public,
multi-tenant, contractor, BYOD, and cross-organization cases are out of scope.

### Q02 — Defining job

Is Dhole's defining v0 job to prevent missed messages, stale ownership,
duplicated work, and conflicting edits among agents working across several
machines—not merely to provide remote access to coding agents? If not, what is
the one defining job?

Answer (accepted 2026-09-04): Yes. The defining job is reliable cross-machine
agent coordination, including an agent-to-agent communication surface such as
a project message board or inbox.

### Q03 — Smallest useful core

Do you accept this as the smallest coherent v0: project realtime, durable
addressed inboxes, fenced claims and handoffs, visible uncertainty/conflicts,
an exception-first control pane, and safe links into external execution and
remote-access tools?

Answer (accepted 2026-09-04): Yes.

### Q04 — Explicit exclusions

Should v0 explicitly exclude a native backlog/Kanban authority, arbitrary
workflow engine, generic job scheduler, embedded terminal or desktop,
browser-to-node traffic, generic shell, runtime plugin loading, and duplicated
T3 Code functionality?

Answer (accepted with one revisit on 2026-09-04): Exclude the listed broad
systems and duplicated execution/remote-control functionality. Q06 separately
reopens research into a deliberately tiny Dhole-native agent work queue; that
must not silently grow into a general PM suite or workflow engine.

### Q05 — Baseline and kill criterion

What observation from the current baseline—two developers using hosted T3 Code
or direct agent tools plus the existing issue tracker—would make you stop,
substantially narrow, or defer Dhole?

Answer (partial 2026-09-04): Existing tools do not provide the desired
coordination. Mediation attempted only that job but was not polished or
reliable enough across machines, so Dhole should start new and improve it.

Still open: no measurable observation was supplied that would make the owner
stop, narrow, or defer Dhole.

### Q06 — Durable work authority

Which system should own work intent during the first pilot: the existing Git
issue tracker, OpenProject, another named system, or Dhole itself? What evidence
would earn a Dhole-native backlog later?

Answer (research 2026-09-04): Not decided. GitHub Issues feel clunky and create
unhelpful notifications when agents use them; OpenProject appears excessive.
Research a much smaller Dhole-native work/coordination board inspired by the
useful parts of those systems.

Still open: the durable authority and the evidence threshold for adopting a
native queue.

### Q07 — Work discovery

May an idle agent claim any ready work in its project, only work assigned to
its role, or only an item explicitly selected by a human or controller?

Answer (partial 2026-09-04): Agents may autonomously claim very small,
independent tasks, complete them on a branch, push, and report that the result
is ready for review or testing. Complex work needs an explicit workflow, but
deterministic sub-work may still be agent-executed through a branch and PR
handoff. An agent started manually in T3 Code must be able to claim existing
work or create and immediately claim new work.

Still open: the exact eligibility rules, workflow states, and boundary between
simple and complex work.

### Q08 — Dispatch responsibility

Should v0 actively launch agent work through preconfigured execution policies,
or should it initially coordinate agents started elsewhere and add dispatch
only after the coordination loop is proven?

Answer (accepted 2026-09-04): Prove the coordination loop first. Add dispatch
afterward.

## P0 — Private Discord, Codex, and admin CLI

### Q09 — ADR 0003 process boundary

Do you accept ADR 0003's proposed exception: one optional, separately
supervised Discord bridge on the central Linux host under an OS identity
different from the Dhole server, while Dhole core remains one server process?

Answer (accepted 2026-09-04): Yes, the proposed separate bridge/server process
boundary is accepted as the direction. ADR 0003 remains proposed until its
still-deferred activation and recovery decisions are settled.

### Q10 — Meaning of all projects

Does “all projects” mean every current and future project belonging to one
exact Dhole team, never deployment-global access across unrelated teams?

Answer (partial 2026-09-04): Ordinary users see only projects to which they are
authorized; an administrator sees all projects.

Still open: whether “administrator” is team-wide or deployment-wide once Dhole
supports more than the current team model.

### Q11 — Initial admin action set

Should the first all-project service principal be limited to all of—and only—
the following operations?

- Discover exact projects.
- Read bounded status, claims, conflicts, and project events.
- Create work requests and addressed messages.
- Read and acknowledge messages.
- Enqueue work through preconfigured execution policies.
- Inspect and cancel only controller-created runs.
- Request human intervention.
- Return allow-listed control-pane, T3 Code, and remote-access links.

If not, which item must be added, removed, or narrowed?

Answer (accepted 2026-09-04): The listed initial action set is sufficient for
now. Elevated actions are not part of this acceptance.

### Q12 — Elevated administrative powers

Which elevated operations, if any, may the Discord controller perform: answer
approvals, cancel another actor's run, force-retry ambiguous work, override a
claim, administer users, enroll nodes, manage providers or models, manage
credentials, or change project policies?

Answer (deferred 2026-09-04): The Discord/controller design needs a dedicated
brainstorm and review before any elevated powers are chosen.

### Q13 — Discord caller authority

Which exact guilds, channels, roles, and users may invoke the controller, and
do all accepted identities receive the same authority or different
server-enforced action subsets?

Answer (deferred 2026-09-04): Decide during the dedicated Discord review.

### Q14 — Discord activation modes

Which inputs may activate the controller: explicit application commands,
mentions, allow-listed ambient messages, direct messages, or attachments?

Answer (deferred 2026-09-04): Decide during the dedicated Discord review.

### Q15 — Confirmation boundary

Which permitted operations require separate human confirmation because they
are destructive, expensive, externally visible, security-sensitive, or hard to
reverse?

Answer (partial 2026-09-04): Within Dhole, require confirmation for actions
that are destructive, expensive, externally visible, security-sensitive, or
hard to reverse. Agents may separately have full access on their execution
machine; Dhole does not need to reproduce those machine permissions.

Still open: the exact operation-to-confirmation matrix. Dhole confirmation
cannot constrain an agent acting outside Dhole with its machine account.

### Q16 — Secret isolation

Must Discord transport and Codex execution use separate OS identities and
closed IPC so Codex cannot read the bot token, or do you explicitly accept
Codex as trusted with every bridge secret available to a shared identity?

Answer (accepted in principle 2026-09-04): Codex is trusted for the private
pilot. A further secret-isolation boundary is not an owner requirement, though
the exact process/OS layout remains an engineering and evidence decision.

### Q17 — Project selection

How must a Discord request select its exact project: a fixed channel or thread
binding, an explicit ID-backed choice, or both? May a controller session ever
switch projects?

Answer (deferred 2026-09-04): Decide during the dedicated Discord review.

### Q18 — Codex session lifetime

Should Codex start fresh for every request, or may it resume within one
serialized Discord thread while remaining pinned to one exact project?

Answer (partial 2026-09-04): Each Codex session opens a thread in a Discord
channel, and that thread contains the Codex session ID.

Still open: fresh versus resumed requests, project pinning, serialization, and
whether a session may ever switch projects.

### Q19 — Discord data boundary

What Discord content and identifiers may the bridge retain, what subset may be
copied into Dhole or sent to a model provider, and how long may each copy
remain? Should direct messages and attachments be excluded entirely?

Answer (deferred after an ambiguous response on 2026-09-04): “Yes” did not
select the retained fields, model-forwarding boundary, retention periods, or
DM/attachment policy. Resolve all of them during the dedicated Discord review.

### Q20 — Claim-holder identity

When the controller starts project work, do you accept that a separate,
project-bound agent identity—not the all-project administrative principal—must
own the fenced claim?

Answer (partial 2026-09-04): The claim-holder identity may depend on
configuration.

Still open: the allowed configurations and safe default. This does not yet
authorize reusing an all-project administrative identity as an ordinary
project claim holder.

### Q21 — Revocation behavior

When the Discord/Codex service principal is revoked, should already-running
work finish, be cancelled, or freeze pending human review? What should happen
to queued work?

Answer (deferred 2026-09-04): No revocation behavior is selected yet.

### Q22 — Event attribution

Should service principals become first-class actors in a new event-schema
version, or is named service attribution in audit records while project events
show `system` acceptable for v0?

Answer (deferred 2026-09-04): No event-attribution/schema choice is selected
yet.

## P1 — Coordination semantics

### Q23 — Claim strength

Should claims be exclusive by default, advisory by default, or selected by
scope type? Who may override an exclusive claim?

Answer (partial 2026-09-04): Claims are advisory by default.

Still open: when an exclusive claim is permitted and who may override it.

### Q24 — Overlap response

When two agents announce overlapping intentions without an exclusive claim,
should Dhole warn both agents, block the later agent, or ask the agents to
negotiate a handoff automatically?

Answer (accepted 2026-09-04): Warn both agents. Never automatically interrupt
or block either one. Provide the communication platform and let the agents
resolve the overlap.

### Q25 — Real-time target

What does “real time” mean for the pilot: sub-second, under five seconds, or
another measurable target? How long may an agent remain offline and still
receive every durable addressed message after reconnecting?

Answer (partial 2026-09-04): An online update should arrive within one minute;
faster is better.

Still open: the offline durable-delivery window.

### Q26 — Durable message classes

Which messages require durable delivery and acknowledgement: direct
agent-to-agent messages only, role/work-item messages too, or every project
broadcast? How long should acknowledged and unacknowledged messages remain?

Answer (partial 2026-09-04): Agent-to-agent messages require durable delivery
and acknowledgement.

Still open: whether role, work-item, and project broadcasts use the same
guarantee, plus acknowledged and unacknowledged retention periods.

### Q27 — Lost-agent policy

When an agent stops heartbeating while holding work, should Dhole wait for a
fixed lease, immediately request human intervention, or permit an automatic
replacement after a defined grace period?

Answer (partial 2026-09-04): Permit automatic replacement after a defined
grace period.

Still open: the grace duration, eligibility checks, claim-generation change,
and behavior when the previous agent returns.

### Q28 — Heartbeat authority

May a heartbeat process only report liveness, renew leases, and reconcile
durable state, or may it also select and launch new work without a separate
scheduler decision?

Answer (accepted for a later phase on 2026-09-04): After coordination is
proven, a heartbeat/controller may start new work only from a pre-specified
bucket of simple tasks such as research or one-off fixes.

Still open: bucket membership, deterministic eligibility, capacity checks,
idempotency, and who configures or disables it.

## P1 — Control pane, T3 Code, and machines

### Q29 — Default control-pane view

Should the default view show only exceptions and intervention requests, or
also provide a conventional board and routine activity stream? Which five
pieces of information must be visible without opening another tool?

Answer (partial 2026-09-04): The default surface must show which agents are
running in each project, what each agent is working on, its state, messages
between agents, and claimed files.

Still open: exception-only versus conventional board/activity layout.

### Q30 — Field authority

Which system is authoritative for each of these fields: work title and
priority, assignment, claim ownership, agent status, execution status,
messages, machine health, and final completion?

Answer (partial 2026-09-04):

- Work/project title derives from the actual project in which the agent was
  launched, including its working-directory identity; the precise record owner
  remains open.
- Humans own priority.
- Humans own explicit assignment; the later heartbeat path may auto-claim
  eligible simple tasks.
- Agents own claim state.
- A local Dhole hook/daemon reports agent status.
- A Codex hook reports execution status and may include the last bounded tool
  summary.
- Dhole plus its daemon own coordination messages and machine-health
  observations.
- A human owns final completion.

### Q31 — T3 Code integration depth

Should initial T3 Code integration stop at environment identity, observed
health/status, and safe deep links, or must Dhole create, resume, or control T3
threads during v0?

Answer (accepted 2026-09-04): Dhole must not control T3 Code. Integration is
limited to identity/status observation and safe deep links.

### Q32 — T3 deployment shape

Do you want one T3 server only on the central host, one T3 environment on every
machine that executes work, or a mixed model? Which machines must support
direct human interaction during the pilot?

Answer (partial 2026-09-04): Use a mixed model. The two main developer machines
must support mixed direct interaction and node use; the remaining machines use
the central service plus a node.

Still open: the exact T3/environment role on each remaining machine.

### Q33 — Human remote access

Should SSH and graphical remote access remain operator-only deep links into a
separately authenticated product for v0, or is browser-embedded control a
requirement? May an agent ever request that a human open such a session?

Answer (partial 2026-09-04): Remote access may remain operator-only for v0.
Prepare the model so Dhole can participate in some bounded way later.

Still open: what later participation means and whether an agent may request a
human-opened session.

### Q34 — Network ownership

Is a managed private network such as Tailscale acceptable for the pilot, or
must networking and remote access be entirely self-hosted?

Answer (accepted in principle 2026-09-04): A private-network product is
acceptable. Prefer Pangolin if current research shows that it fits the target
estate and trust boundary.

### Q35 — Machine isolation

Are agents trusted as the machine account under which they run, or must
projects, repositories, runtimes, and provider credentials be isolated using
separate OS identities or an additional sandbox?

Answer (recorded interpretation 2026-09-04): For the risk-tolerant private
pilot, agents are trusted as the machine account under which they run; an
additional per-project sandbox is not a v0 requirement. Correct this answer if
“yes” was intended to select the isolation branch instead.

## P2 — Pilot and release policy

### Q36 — Autonomous resource limits

What maximum cost, runtime, and concurrency may one Discord request, one agent,
and one project consume before human approval is required?

Answer (partial 2026-09-04): Do not impose one universal static number. Resource
limits should be configurable and tuned to available machine/project
resources.

Still open: resource signals, adaptive policy, minimum hard safety bounds, and
the point at which approval is required.

### Q37 — Mandatory intervention

Which failures must always interrupt a human: ambiguous external side effects,
exhausted retries, claim conflicts, stale agents, budget limits, missing
verification, security-policy violations, or another named condition?

Answer (partial 2026-09-04): A security-policy violation must always interrupt
a human. Tune the policy during the private pilot.

Still open: whether any other failure class is always interrupting and which
security rules are hard rather than tunable.

### Q38 — Pilot success

What exact thresholds for setup effort, coordination time saved, duplicate or
conflicting work prevented, false warnings, recovery time, and repeated use
would mean “continue,” “narrow,” or “stop”?

Answer (partial 2026-09-04): Start smaller, build new rather than bolting onto
Mediation, and evolve over time. One-command or one-prompt setup is a primary
pilot success requirement.

Still open: measurable continue, narrow, and stop thresholds for coordination
benefit.

### Q39 — First Linux release envelope

Which exact Linux distribution/version, service manager, reverse proxy, and
installation artifact should define the first supported central-server
release?

Answer (partial 2026-09-04): The real estate includes Fedora 43, NixOS, Arch,
and possibly Windows 11. Pangolin is the preferred network/access candidate.
Avoid storing artifacts in Dhole; if later required, local storage or RustFS
are candidates.

Still open: one Tier-1 server distribution, service manager, installation
artifact, and the exact role of each OS.

### Q40 — Node.js lifecycle

Should the first alpha accept Node 24 entering Maintenance LTS in October 2026,
or must Node 26 be qualified before an alpha support claim?

Answer (research delegated 2026-09-04): Follow the evidence-backed recommended
Node.js lifecycle choice. The recommendation still needs to be recorded before
this becomes an owner decision.

### Q41 — Acceptable pilot risk

Which known risks are acceptable for a private two-developer pilot, and which
must block live autonomous execution even in that private environment?

Answer (partial 2026-09-04): The two-developer pilot is deliberately
risk-tolerant and may accept more risk than a later polished version.
Security-policy violations remain a mandatory intervention.

Still open: the explicit accepted-risk list and non-negotiable live-execution
blockers.

### Q42 — Release claim

What evidence must exist before you will call the Linux central server
production-ready rather than code-present, fixture-tested, or a development
pilot?

Answer (partial and conflicting 2026-09-04): The immediate target is a
development pilot with easy deployment through a Compose file and a
one-command/one-prompt installation path, so an operator can tell an agent
“install Dhole” with a website link and the agent can complete the setup.

Still open: production-readiness evidence. Compose conflicts with the current
native-packaging/no-containers architecture lock, so it is a requested
packaging reversal that requires an ADR/contributor-policy decision before
implementation; this answer alone does not authorize containers.

### Q43 — Compose packaging reversal

Should ADR 0001, ADR 0002, the roadmap, and the contributor policy be amended
so that a pinned, single-service Compose package becomes:

1. the primary central-server artifact for the private development pilot;
2. an optional convenience beside a host-native server installation; or
3. still prohibited?

Does this apply only to the central server while execution nodes remain
host-native? A “single-service” answer would package only the existing Dhole
server: it would not authorize bundled PostgreSQL, Redis, a queue, Pangolin, a
proxy, or another Dhole core service.

Answer: _Unanswered._

## Research and follow-up queue

These are not delegated tasks or accepted designs. They are the subjects to
investigate before returning to the linked owner questions. Each investigation
must end with a concrete recommendation, rejected alternatives, implementation
impact, and the smallest experiment that could disprove the recommendation.

### R01 — Minimal agent-native work registry

Related answers: Q04–Q08 and Q28.

Research the smallest Dhole-owned work model that lets agents discover, create,
claim, and report work without turning GitHub notifications into the agent bus
or importing OpenProject's full PM surface. Compare at least:

- typed local work references with no backlog;
- a minimal `ready / active / blocked / review / done` registry;
- GitHub Issues/Projects with notifications disabled or isolated;
- OpenProject as a separately operated authority; and
- lessons worth retaining from Mediation without using it as the new
  foundation.

The result must define the minimum fields, dependencies, priority/assignment
ownership, branch/PR references, audit history, and deletion/archive behavior.
It must explain when this remains a coordination registry and when it has
become a general PM/workflow product. Return to Q06 afterward.

### R02 — Simple versus complex work

Related answers: Q07, Q08, Q28, Q36, and Q37.

Define a finite classification that an operator can configure and an agent
cannot broaden:

- small independent work that may be auto-claimed;
- deterministic work that may produce a branch and PR, then stop for review;
- complex work that requires an explicit multi-step workflow; and
- work that always requires a human before execution.

Research eligibility rules, acceptance checks, dependency handling,
branch/worktree naming, PR handoff, retry/uncertain states, and how a manually
started T3 agent creates-and-claims a new item. Avoid a generic workflow engine.

### R03 — Native A2A message board

Related answers: Q02, Q03, Q25, Q26, and Q29.

Treat “A2A” here first as agent-to-agent communication, not automatic adoption
of the external A2A protocol. Define:

- direct, role, work-item, and project-addressed messages;
- a project activity/message-board projection;
- durable recipient delivery, cursor, acknowledgement, retry, and deduplication;
- unread, answered, expired, superseded, and dead-letter states;
- online delivery within one minute, with a faster best-effort target;
- offline catch-up and retention choices; and
- authorization/redaction when messages cross project, user, or machine
  boundaries.

Separately evaluate A2A 1.0 only as a future edge adapter for an independent
agent host. It must not dictate Dhole's internal project, claim, or inbox
schema.

### R04 — Advisory claims, file intentions, and fencing

Related answers: Q03, Q20, Q23, Q24, Q27, and Q29.

Separate three concepts that must not be conflated:

1. advisory work/file intentions that warn overlapping agents;
2. optional explicit exclusive scopes; and
3. generation fencing that rejects stale Dhole-side renew/settle operations
   after expiry or replacement.

Research canonical file/component scopes, rename/delete behavior, branch and
worktree identity, overlap precision, warning delivery, agent negotiation and
handoff messages, override authority, and what the UI shows. The accepted
default is to warn both agents and never automatically interrupt either one.

### R05 — Heartbeat-triggered simple-work dispatch

Related answers: Q08, Q27, Q28, Q30, and Q36.

Design this as a later phase after coordination is proven. A heartbeat may
trigger an idempotent request to consider work, but a durable scheduler must
atomically select, claim, and dispatch from the configured simple-task bucket.
Research:

- bucket membership and who may configure it;
- capacity/resource observations and adaptive finite limits;
- stable selection and operation keys;
- duplicate/reordered heartbeat behavior;
- fairness, starvation, pause, and maintenance modes;
- failure between claim and launch; and
- proof that one logical item launches at most one active generation.

Do not make an LLM reread the whole board on every heartbeat.

### R06 — Grace-period replacement and returning agents

Related answers: Q23, Q24, and Q27.

Measure realistic heartbeat/network gaps on the target machines, then recommend
a grace policy. Define what happens to the old claim, branch, messages, and
execution when a replacement is selected; how a new generation is issued; and
what happens when the previous agent returns after continuing work offline.
Replacement must be visible and recoverable and must not silently label an
ambiguous external side effect as failed or safe to repeat.

### R07 — Project, repository, worktree, and actor identity

Related answers: Q07, Q10, Q18, Q20, Q30, Q32, and Q35.

Research a canonical mapping among Dhole project IDs, Git repository identity,
clone/worktree/branch, T3 environment/project/thread, Codex session, node,
agent instance, human, and service principal. A working directory may suggest
a project but must not become authorization by itself. Resolve:

- team-wide versus deployment-wide administrator visibility;
- whether every ordinary claim must use a project-bound agent identity;
- which configurable delegation modes are safe;
- session/thread project pinning; and
- collision, rename, clone, and reconnect behavior.

### R08 — Control-pane information architecture

Related answers: Q29 and Q30.

Prototype a calm default view that still exposes routine state, not only
exceptions. It must show at minimum:

- running agents grouped by project;
- current objective/work item and state;
- messages between agents;
- claimed/intended files or components;
- machine/environment and freshness;
- blockers, overlap warnings, uncertainty, and requested human action; and
- links to the authoritative work item, branch/PR, T3 session, or operator
  access tool.

Research board, timeline, inbox, topology, and exception-summary variants with
the two developers. Every displayed field must name its authority and
observation time; a failed source must not appear as an empty all-clear.

### R09 — T3 observation without T3 control

Related answers: Q07, Q18, Q30–Q32, and Q38.

Confirm which stable T3 identifiers, hooks, status events, last bounded tool
summary, and deep links are actually available. Define the mixed topology for
the two main developer machines and the central/node-only machines. Dhole may
observe, correlate, and link; it must not create, resume, steer, cancel, or
otherwise control T3 threads under the accepted v0 boundary.

Research how an agent already running inside T3 registers with Dhole, creates
or claims work, receives A2A messages, and reports progress without exposing a
T3 pairing secret or making provider-native session IDs global identities.

### R10 — Pangolin and operator access

Related answers: Q33, Q34, and Q39.

Evaluate Pangolin as an independently operated network/access layer for the
actual estate: Fedora 43, NixOS, Arch, Windows 11, headless Linux, and machines
with graphical sessions. Verify against pinned versions:

- HTTP and WebSocket exposure for Dhole and T3;
- outbound site connectivity and client availability on every target OS;
- TCP/UDP, SSH, RDP, and graphical-access fit;
- identity, access policy, audit, revocation, and link behavior;
- DNS/TLS, reconnect, relay failure, and offline behavior;
- self-hosted deployment dependencies and upgrade/backup burden; and
- whether safe deep links are possible without credentials or capability
  tokens entering Dhole.

Pangolin remains external. Do not bundle it into a Dhole Compose project or
claim that it replaces a remote-desktop product without evidence.

### R11 — Compose versus host-native installation

Related answers: Q39, Q42, and Q43.

Before changing the architecture lock, compare:

- one pinned central-server Compose service with a local-filesystem SQLite
  volume;
- a signed/versioned native bundle plus systemd unit for Fedora/Arch;
- a Nix flake/module for NixOS; and
- one stable agent-readable installation URL that selects the correct recipe.

Keep execution nodes host-native unless a separate decision proves otherwise.
For Compose, investigate Docker versus Podman Compose, non-root UID/GID,
Fedora SELinux labels, database/WAL volume ownership, backup/restore,
upgrade/rollback, health/readiness, secrets, logs, and reverse-proxy behavior.
Also determine how proposed ADR 0003's host bridge reaches the server: a
deliberately mounted Unix-socket directory or a separately authenticated local
transport. Compose is not evidence that all Linux hosts behave the same.

### R12 — One-prompt installer

Related answers: Q38, Q39, and Q42.

Specify an idempotent install, upgrade, repair, diagnose, uninstall, and
rollback contract that an agent can follow from one stable website link.
Research signed checksums/provenance, supported-version discovery, unprivileged
service identities, directory permissions, secret input through file/stdin
rather than argv, node enrollment, failure recovery, and a retained redacted
install report. A convenient `curl | sh` path may be a risk-tolerant pilot
experiment but is not production-installation evidence by itself.

### R13 — Linux and Node.js support tuple

Related answers: Q39 and Q40.

Select one exact Tier-1 central-server tuple instead of treating an estate list
as support:

- distribution and version;
- x86-64 architecture;
- init/service manager;
- reverse proxy or Pangolin ingress;
- filesystem and SQLite durability mode;
- package/Compose engine and versions; and
- exact Node.js and pnpm versions.

Using official release schedules and dependency compatibility, recommend
whether the first alpha stays on Node 24 or qualifies Node 26. Then run
clean-host install, native dependency build, service, WebSocket, upgrade,
backup/restore, shutdown, and soak evidence on that exact tuple. Return to Q40
with the recommendation.

### R14 — Discord design review

Related answers: Q12–Q22.

Discord is postponed until the coordination core is proven. The later review
must decide:

- caller allowlists and whether accepted callers share one authority;
- commands, mentions, ambient monitoring, DMs, and attachments;
- project selection and whether sessions may switch;
- the exact relation among a Codex session, Discord thread, and displayed
  session ID;
- confirmation and elevated-operation matrices;
- retained/forwarded Discord data and retention;
- service-principal versus project claim-holder identity;
- revocation behavior;
- service-actor event/audit representation; and
- request journaling, idempotency, restart, and reply recovery.

The owner accepts Codex as trusted for the private pilot, but that does not give
the bridge the Dhole server's database, master keys, environment, raw SQL, or a
generic shell.

### R15 — Adaptive resources and pilot security boundary

Related answers: Q15, Q35–Q37, and Q41.

Translate “dialed to available resources” into configurable, finite profiles
rather than unbounded execution. Research CPU, memory, disk, process,
concurrency, runtime, provider-cost, queue, and output signals; minimum hard
safety bounds; overload behavior; and which changes need approval.

Document the private-pilot trust assumption that an agent may have the full
rights of its machine account. Dhole confirmations govern Dhole-mediated
actions only. Determine which secrets/environment data must still be withheld
from child runtimes and define the non-tunable security-policy violations that
always request human intervention. Risk tolerance must not waive
authorization, idempotency, or honest `uncertain` outcomes.

### R16 — Artifact and evidence policy

Related answers: Q30, Q38, Q39, Q41, and Q42.

Prefer links and metadata over storing artifact blobs in Dhole for the pilot.
Research when local filesystem storage or RustFS would be justified, who owns
retention and access, how hashes/provenance are recorded, and how an external
artifact remains available for review. Do not add RustFS or another persistent
service without a separate decision.

Define measurable pilot outcomes: setup time, weekly repeated use, message
delivery/recovery, stale ownership, overlap-warning usefulness, coordination
time saved, duplicated work, false warnings, and human recovery. Record
continue/narrow/stop thresholds before using the results to expand scope.
Production-ready evidence remains a separate and later gate.
