<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, optional } from './lib/api';
  import Mark from './lib/Mark.svelte';
  import Tree from './lib/Tree.svelte';
  import { AppSocket, type SocketStatus } from './lib/ws';
  import type { AgentNode, Approval, GatewayRequest, GatewaySummary, JsonObject, LabRun, Machine, MemoryPack, Project, Repository, Route, RuntimeRegistration, SessionMessage, SessionSnapshot, SessionSummary, User } from './lib/types';

  const socket = new AppSocket();
  let route: Route = parseRoute();
  let user: User | null = null;
  let authLoading = true;
  let loading = false;
  let routeLoading = false;
  let snapshotsLimited = false;
  let message = '';
  let error = '';
  let projects: Project[] = [];
  let project: Project | null = null;
  let repositories: Repository[] = [];
  let runtimeRegistrations: RuntimeRegistration[] = [];
  let runtimeRegistrationsProjectId: string | undefined;
  let machines: Machine[] = [];
  let sessions: SessionSummary[] = [];
  let snapshots: SessionSnapshot[] = [];
  let snapshot: SessionSnapshot | null = null;
  let gatewaySummary: GatewaySummary | null = null;
  let gatewayRequests: GatewayRequest[] = [];
  let gatewayRequestTotal = 0;
  let gatewayConnections: JsonObject[] = [];
  let gatewayAccounts: JsonObject[] = [];
  let labBenchmarks: JsonObject[] = [];
  let labRuns: LabRun[] = [];
  let labComparison: JsonObject | null = null;
  let memoryPacks: MemoryPack[] = [];
  let memoryGenerations: JsonObject[] = [];
  let memoryProposals: JsonObject[] = [];
  let socketStatus: SocketStatus = 'offline';
  let socketSessionId: string | undefined;

  let loginEmail = '';
  let loginPassword = '';
  let showBootstrap = false;
  let bootstrapName = '';
  let bootstrapTeam = 'Dhole';
  let createProjectOpen = false;
  let createSessionOpen = false;
  let sessionTitle = '';
  let sessionRuntimeRegistrationId = '';
  let projectName = '';
  let projectDescription = '';
  let repoLabel = '';
  let repoRemote = '';
  let repoPath = '';
  let repoBranch = 'main';
  let composer = '';
  let steerText = '';
  let leaseToken = '';
  let createUserOpen = false;
  let newUserEmail = '';
  let newUserName = '';
  let newUserPassword = '';
  let newUserRole: 'member' | 'administrator' = 'member';
  let providerFilter = '';
  let modelFilter = '';
  let failedOnly = false;
  let decisionReason = '';
  let memorySearch = '';
  let selectedPack: MemoryPack | null = null;
  let proposalTitle = '';
  let proposalBody = '';
  let createUserDialog: HTMLDialogElement | undefined;
  let createUserTrigger: HTMLButtonElement | undefined;
  let createUserFirstInput: HTMLInputElement | undefined;
  let createProjectDialog: HTMLDialogElement | undefined;
  let createProjectTrigger: HTMLElement | undefined;
  let createProjectFirstInput: HTMLInputElement | undefined;
  let createSessionDialog: HTMLDialogElement | undefined;
  let createSessionTrigger: HTMLElement | undefined;
  let createSessionFirstInput: HTMLInputElement | undefined;

  $: agentNode = findNode(route.id, snapshots);
  $: owningAgentSnapshot = route.kind === 'agent' && route.id ? snapshots.find((item) => Boolean(findNode(route.id, [item]))) : undefined;
  $: selectedProjectId = route.kind === 'project'
    ? route.id
    : route.kind === 'session'
      ? (snapshot?.session.id === route.id ? snapshot.session.projectId : sessions.find((item) => item.id === route.id)?.projectId)
      : route.kind === 'agent'
        ? owningAgentSnapshot?.session.projectId
        : route.kind === 'dashboard' || route.kind === 'gateway' || route.kind === 'admin'
          ? undefined
          : projects[0]?.id;
  $: selectedProject = projects.find((item) => item.id === selectedProjectId) ?? project;
  $: sessionRuntimeRegistration = snapshot?.session.runtimeRegistrationId ? runtimeRegistrations.find((item) => item.id === snapshot?.session.runtimeRegistrationId) : undefined;
  $: activeTurnSteeringSupported = sessionRuntimeRegistration?.capabilities?.activeTurnSteering === true;
  $: runningSessions = sessions.filter((item) => ['busy', 'running'].includes(item.state));
  $: waitingSessions = sessions.filter((item) => ['needs_input', 'needs_approval'].includes(item.state));
  $: failedSessions = sessions.filter((item) => ['failed', 'cancelled'].includes(item.state));
  $: pendingApprovals = snapshots.flatMap((item) => item.approvals ?? []).filter((item) => item.state === 'pending');
  $: pendingSessionApprovals = snapshot?.approvals?.filter((item) => item.state === 'pending') ?? [];
  $: attentionMachines = machines.filter((item) => field(item, 'status') === 'disconnected' || field(item, 'status') === 'stale');
  $: gatewayCoolingRows = coolingGatewayRows(gatewaySummary);
  $: needsAttention = pendingApprovals.length + waitingSessions.length + failedSessions.length + attentionMachines.length + gatewayCoolingRows.length;
  $: approvalResponsesSupported = sessionRuntimeRegistration?.capabilities?.approvalResponses === true;
  $: memoryPackId = route.kind === 'memory' ? route.id : undefined;
  $: if (typeof document !== 'undefined') {
    route; project; selectedProject; snapshot; agentNode;
    document.title = pageTitle();
  }

  function parseRoute(path = location.pathname): Route {
    const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (!parts.length) return { kind: 'dashboard' };
    if (parts[0] === 'login') return { kind: 'login' };
    if (parts[0] === 'projects' && parts[1]) return { kind: 'project', id: parts[1] };
    if (parts[0] === 'sessions' && parts[1]) return { kind: 'session', id: parts[1] };
    if (parts[0] === 'agents' && parts[1]) return { kind: 'agent', id: parts[1] };
    if (parts[0] === 'gateway') return { kind: 'gateway' };
    if (parts[0] === 'lab') return { kind: 'lab' };
    if (parts[0] === 'memory') return { kind: 'memory', id: parts[1] };
    if (parts[0] === 'admin') return { kind: 'admin' };
    return { kind: 'dashboard' };
  }

  function goto(path: string, reload = true): void {
    history.pushState({}, '', path);
    route = parseRoute(path);
    error = '';
    message = '';
    requestAnimationFrame(() => document.getElementById('main-content')?.focus());
    if (reload) void loadRoute();
  }

  function field(value: unknown, key: string): string | number | boolean | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const result = record[key] ?? record[snake];
    return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' ? result : undefined;
  }

  function records<T>(value: unknown, key: string): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === 'object') {
      const candidate = (value as Record<string, unknown>)[key];
      return Array.isArray(candidate) ? candidate as T[] : [];
    }
    return [];
  }

  function findNode(id: string | undefined, roots: SessionSnapshot[]): AgentNode | undefined {
    if (!id) return undefined;
    const visit = (nodes: AgentNode[]): AgentNode | undefined => {
      for (const node of nodes) {
        if (node.id === id || node.activationId === id) return node;
        const child = visit(node.children ?? []);
        if (child) return child;
      }
      return undefined;
    };
    for (const item of roots) {
      const found = visit(item.tree ?? []);
      if (found) return found;
    }
    return undefined;
  }

  function coolingGatewayRows(summary: GatewaySummary | null): JsonObject[] {
    const accounts = summary?.accounts ?? [];
    const explicit = accounts.filter((account) => {
      const status = String(account.status ?? '').toLowerCase();
      const until = account.cooldownUntil ? Date.parse(account.cooldownUntil) : Number.NaN;
      return status === 'cooldown' || status === 'cooling_down' || (Number.isFinite(until) && until > Date.now());
    });
    const count = Math.max(summary?.capacity?.coolingDown ?? 0, explicit.length);
    return Array.from({ length: count }, (_, index) => explicit[index] ?? { id: `cooldown-${index + 1}`, provider: 'Gateway account', status: 'cooldown' });
  }

  function participantLabel(userId: unknown): string {
    const id = typeof userId === 'string' ? userId : '';
    if (user && id === user.id) return `${user.displayName} (you)`;
    const participant = snapshot?.participants?.find((item) => field(item, 'userId') === id);
    const displayName = field(participant, 'displayName');
    if (typeof displayName === 'string') return displayName;
    return id || 'Unknown participant';
  }

  function messageAttribution(item: SessionMessage): string {
    if (item.role === 'human') return item.authorUserId ? `Human · ${participantLabel(item.authorUserId)}` : 'Human';
    if (item.role === 'agent') return item.logicalAgentId ? `Agent · ${item.logicalAgentId}` : 'Agent';
    return titleCase(item.role);
  }

  function memoryEntries(generation: JsonObject): JsonObject[] {
    const entries = records<JsonObject>(generation, 'entries');
    const query = memorySearch.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => [entry.title, entry.body, entry.sourceType, entry.sourceReference].some((value) => String(value ?? '').toLowerCase().includes(query)));
  }

  function openCreateUser(): void { createUserOpen = true; }

  function closeCreateUser(): void {
    if (createUserDialog?.open) createUserDialog.close();
    createUserOpen = false;
    requestAnimationFrame(() => createUserTrigger?.focus());
  }

  function openCreateProject(event?: Event): void {
    createProjectTrigger = event?.currentTarget as HTMLElement | undefined;
    createProjectOpen = true;
  }

  function closeCreateProject(): void {
    if (createProjectDialog?.open) createProjectDialog.close();
    else { createProjectOpen = false; requestAnimationFrame(() => createProjectTrigger?.focus()); }
  }

  function handleCreateProjectClose(): void {
    createProjectOpen = false;
    requestAnimationFrame(() => createProjectTrigger?.focus());
  }

  function openCreateSession(event?: Event): void {
    createSessionTrigger = event?.currentTarget as HTMLElement | undefined;
    createSessionOpen = true;
  }

  function closeCreateSession(): void {
    if (createSessionDialog?.open) createSessionDialog.close();
    else { createSessionOpen = false; requestAnimationFrame(() => createSessionTrigger?.focus()); }
  }

  function handleCreateSessionClose(): void {
    createSessionOpen = false;
    requestAnimationFrame(() => createSessionTrigger?.focus());
  }

  function handleCreateUserClose(): void {
    createUserOpen = false;
    requestAnimationFrame(() => createUserTrigger?.focus());
  }

  $: if (createUserOpen && createUserDialog && !createUserDialog.open) {
    createUserDialog.showModal();
    requestAnimationFrame(() => createUserFirstInput?.focus());
  }

  $: if (createProjectOpen && createProjectDialog && !createProjectDialog.open) {
    createProjectDialog.showModal();
    requestAnimationFrame(() => createProjectFirstInput?.focus());
  }

  $: if (createSessionOpen && createSessionDialog && !createSessionDialog.open) {
    createSessionDialog.showModal();
    requestAnimationFrame(() => createSessionFirstInput?.focus());
  }

  function date(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function money(microusd: number | null | undefined): string {
    return `$${((microusd ?? 0) / 1_000_000).toFixed(4)}`;
  }

  function titleCase(value: unknown): string {
    return String(value ?? 'unknown').replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function pageTitle(): string {
    if (route.kind === 'project') return `${project?.name ?? selectedProject?.name ?? 'Project'} · Dhole`;
    if (route.kind === 'session') return `${snapshot?.session.title ?? 'Session'} · Dhole`;
    if (route.kind === 'agent') return `${agentNode?.name ?? 'Agent detail'} · Dhole`;
    if (route.kind === 'gateway') return 'Gateway · Dhole';
    if (route.kind === 'lab') return 'Improvement Lab · Dhole';
    if (route.kind === 'memory') return 'Memory · Dhole';
    if (route.kind === 'admin') return 'Administration · Dhole';
    if (route.kind === 'login') return 'Sign in · Dhole';
    return 'Dhole · Coordinated agent work';
  }

  function gatewayConnectionClass(connection: JsonObject): string {
    const status = String(connection.status ?? '').toLowerCase();
    if (['healthy', 'connected', 'available', 'ready'].includes(status)) return 'live';
    if (['unavailable', 'failed', 'error', 'degraded'].includes(status)) return 'danger';
    return 'idle';
  }

  function gatewayQuota(account: JsonObject): string {
    const quota = account.quota && typeof account.quota === 'object' ? account.quota as JsonObject : undefined;
    const remaining = field(quota, 'remainingTokens');
    const limit = field(quota, 'limitTokens');
    if (typeof remaining === 'number' && typeof limit === 'number') return `${remaining.toLocaleString()} / ${limit.toLocaleString()} tokens remaining`;
    return quota && Object.keys(quota).length ? 'Quota reported' : 'Quota unavailable';
  }

  function displayError(value: unknown): string {
    if (value instanceof ApiError) return value.message;
    return value instanceof Error ? value.message : 'Something went wrong';
  }

  async function init(): Promise<void> {
    try {
      const result = await api.me();
      user = result.user;
      if (result.csrfToken) sessionStorage.setItem('dhole_csrf', result.csrfToken);
      if (route.kind === 'login') {
        history.replaceState({}, '', '/');
        route = parseRoute('/');
      }
      await loadDashboard();
      if (route.kind !== 'dashboard') await loadRoute();
    } catch (value) {
      if (!(value instanceof ApiError && value.status === 401)) error = displayError(value);
      user = null;
    } finally {
      authLoading = false;
    }
  }

  async function loadDashboard(): Promise<void> {
    loading = true;
    snapshotsLimited = false;
    try {
      projects = await api.projects();
      const loaded = await Promise.all(projects.map((item) => optional(() => api.sessions(item.id), [])));
      sessions = loaded.flat();
      const snapshotSessions = sessions.slice(0, 30);
      snapshotsLimited = sessions.length > snapshotSessions.length;
      snapshots = (await Promise.all(snapshotSessions.map((item) => optional(() => api.session(item.id), null)))).filter((item): item is SessionSnapshot => item !== null);
      machines = await optional(() => api.machines(), []);
      gatewaySummary = await optional(() => api.gatewaySummary(), null);
    } catch (value) {
      error = displayError(value);
    } finally {
      loading = false;
    }
  }

  async function loadRoute(): Promise<void> {
    if (!user) return;
    routeLoading = true;
    try {
      if (route.kind !== 'session' && socketSessionId) {
        socket.close();
        socketSessionId = undefined;
      }
      if (route.kind === 'dashboard') {
        await loadDashboard();
      } else if (route.kind === 'project' && route.id) {
        const value = await api.project(route.id);
        project = value.project;
        repositories = value.repositories;
        sessions = await optional(() => api.sessions(route.id as string), []);
        runtimeRegistrations = await optional(() => api.runtimeRegistrations(route.id as string), []);
        runtimeRegistrationsProjectId = route.id;
      } else if (route.kind === 'session' && route.id) {
        await loadSession(route.id);
      } else if (route.kind === 'gateway') {
        await loadGateway();
      } else if (route.kind === 'lab') {
        labBenchmarks = await optional(() => api.labBenchmarks(selectedProjectId), []);
        labRuns = await optional(() => api.labRuns(), []);
      } else if (route.kind === 'memory') {
        const id = route.id ?? undefined;
        memoryPacks = selectedProjectId ? await optional(() => api.memoryPacks(selectedProjectId as string), []) : [];
        selectedPack = id ? memoryPacks.find((pack) => pack.id === id) ?? null : memoryPacks[0] ?? null;
        if (selectedPack?.id) await loadMemory(selectedPack.id);
      }
    } catch (value) {
      error = displayError(value);
    } finally {
      routeLoading = false;
    }
  }

  async function loadSession(id: string): Promise<void> {
    const after = snapshot?.session.id === id ? snapshot.watermark : undefined;
    const nextSnapshot = await api.session(id, after);
    const nextRuntimes = runtimeRegistrationsProjectId === nextSnapshot.session.projectId
      ? runtimeRegistrations
      : await optional(() => api.runtimeRegistrations(nextSnapshot.session.projectId), []);
    if (route.kind !== 'session' || route.id !== id) return;
    runtimeRegistrations = nextRuntimes;
    runtimeRegistrationsProjectId = nextSnapshot.session.projectId;
    snapshot = nextSnapshot;
    const index = sessions.findIndex((item) => item.id === id);
    if (index >= 0 && snapshot.session) sessions[index] = snapshot.session;
    if (route.kind === 'session' && route.id === id && snapshot.session?.id && socketSessionId !== snapshot.session.id) {
      socketSessionId = snapshot.session.id;
      socket.connect(snapshot.session.id, snapshot.watermark ?? 0, onSocketEvent, (status) => { socketStatus = status; });
    }
  }

  function onSocketEvent(event: Record<string, unknown>): void {
    const sequence = event.projectSequence;
    if (typeof sequence === 'number' && snapshot) snapshot = { ...snapshot, watermark: Math.max(snapshot.watermark ?? 0, sequence) };
    if (route.kind === 'session' && route.id === snapshot?.session.id) void loadSession(snapshot.session.id);
  }

  async function loadGateway(): Promise<void> {
    gatewaySummary = await optional(() => api.gatewaySummary(), null);
    gatewayConnections = await optional(() => api.gatewayConnections(), []);
    gatewayAccounts = await optional(() => api.gatewayAccounts(), []);
    await refreshGatewayRequests();
  }

  async function refreshGatewayRequests(): Promise<void> {
    const query = new URLSearchParams();
    if (providerFilter) query.set('provider', providerFilter);
    if (modelFilter) query.set('model', modelFilter);
    if (failedOnly) query.set('failed', 'true');
    query.set('limit', '100');
    const value = await optional(() => api.gatewayRequests(query.toString()), { items: [], total: 0 });
    gatewayRequests = value.items ?? [];
    gatewayRequestTotal = value.total ?? gatewayRequests.length;
  }

  async function loadMemory(packId: string): Promise<void> {
    memoryGenerations = await optional(() => api.memoryGenerations(packId), []);
    memoryProposals = await optional(() => api.memoryProposals(packId), []);
  }

  async function login(): Promise<void> {
    error = '';
    try {
      const result = await api.login(loginEmail, loginPassword);
      user = result.user;
      loginPassword = '';
      await loadDashboard();
      goto('/', false);
    } catch (value) { error = displayError(value); }
  }

  async function bootstrap(): Promise<void> {
    error = '';
    try {
      const result = await api.bootstrap({ email: loginEmail, displayName: bootstrapName, password: loginPassword, role: 'administrator', teamName: bootstrapTeam });
      user = result.user;
      loginPassword = '';
      await loadDashboard();
      goto('/', false);
    } catch (value) { error = displayError(value); }
  }

  async function logout(): Promise<void> {
    try { await api.logout(); } catch { /* local state still needs clearing */ }
    socket.close();
    socketSessionId = undefined;
    runtimeRegistrations = [];
    runtimeRegistrationsProjectId = undefined;
    user = null;
    projects = [];
    sessions = [];
    snapshots = [];
    goto('/login');
  }

  async function createProject(): Promise<void> {
    try {
      const result = await api.createProject({ name: projectName, description: projectDescription });
      projectName = '';
      projectDescription = '';
      closeCreateProject();
      await loadDashboard();
      goto(`/projects/${encodeURIComponent(result.project.id)}`);
    } catch (value) { error = displayError(value); }
  }

  async function createRepository(): Promise<void> {
    if (!route.id) return;
    try {
      await api.createRepository(route.id, { label: repoLabel, canonicalRemote: repoRemote || undefined, localPathHint: repoPath || undefined, defaultBranch: repoBranch || undefined });
      const value = await api.project(route.id);
      repositories = value.repositories;
      repoLabel = '';
      repoRemote = '';
      repoPath = '';
      message = 'Repository linked.';
    } catch (value) { error = displayError(value); }
  }

  async function createSession(): Promise<void> {
    const projectId = selectedProjectId;
    if (!projectId || !sessionTitle.trim()) return;
    try {
      const result = await api.createSession(projectId, { title: sessionTitle.trim(), ...(sessionRuntimeRegistrationId ? { runtimeRegistrationId: sessionRuntimeRegistrationId } : {}) });
      sessionTitle = '';
      sessionRuntimeRegistrationId = '';
      closeCreateSession();
      sessions = await api.sessions(projectId);
      goto(`/sessions/${encodeURIComponent(result.session.id)}`);
    } catch (value) { error = displayError(value); }
  }

  async function queueMessage(): Promise<void> {
    if (!snapshot || !composer.trim()) return;
    try {
      await api.queueMessage(snapshot.session.id, { body: composer.trim(), includeHumanIdentity: true });
      composer = '';
      await loadSession(snapshot.session.id);
    } catch (value) { error = displayError(value); }
  }

  async function steer(): Promise<void> {
    if (!snapshot || !activeTurnSteeringSupported || !steerText.trim() || !snapshot.session.activeTurnId) return;
    try {
      if (!leaseToken) leaseToken = (await api.acquireLease(snapshot.session.id)).leaseToken;
      await api.steer(snapshot.session.id, { message: steerText.trim(), turnId: snapshot.session.activeTurnId, leaseToken });
      steerText = '';
      message = 'Steer sent.';
    } catch (value) { error = displayError(value); leaseToken = ''; }
  }

  async function cancelSession(): Promise<void> {
    if (!snapshot) return;
    try { await api.cancel(snapshot.session.id, snapshot.session.activeTurnId); await loadSession(snapshot.session.id); } catch (value) { error = displayError(value); }
  }

  async function answerApproval(approval: Approval, decision: 'approve_once' | 'approve_session' | 'deny' | 'cancel'): Promise<void> {
    if (!snapshot) return;
    try { await api.answerApproval(snapshot.session.id, approval.id, { decision, expectedVersion: approval.version }); await loadSession(snapshot.session.id); } catch (value) { error = displayError(value); }
  }

  async function createUser(): Promise<void> {
    try {
      await api.createUser({ email: newUserEmail, displayName: newUserName, password: newUserPassword, role: newUserRole });
      newUserEmail = '';
      newUserName = '';
      newUserPassword = '';
      closeCreateUser();
      message = 'User created.';
    } catch (value) { error = displayError(value); }
  }

  async function decideLab(decision: 'promote' | 'reject' | 'canary'): Promise<void> {
    const run = labComparison?.run as JsonObject | undefined;
    if (!run || !user) return;
    try {
      await api.labDecision({ projectId: selectedProjectId, subjectType: 'skill', subjectVersionId: String((labComparison?.definitions as JsonObject | undefined)?.id ?? ''), benchmarkRunId: String(run.id ?? ''), decision, reason: decisionReason || `Human ${decision} decision`, decidedBy: user.id });
      decisionReason = '';
      message = `Candidate ${decision}.`;
    } catch (value) { error = displayError(value); }
  }

  async function showComparison(runId: string): Promise<void> {
    try { labComparison = await api.labComparison(runId); } catch (value) { error = displayError(value); }
  }

  async function proposeMemory(): Promise<void> {
    if (!selectedPack?.id) return;
    try {
      await api.memoryProposal(selectedPack.id, { title: proposalTitle, body: proposalBody, sourceType: 'human', sourceReference: `web:${user?.id ?? 'unknown'}` });
      proposalTitle = '';
      proposalBody = '';
      await loadMemory(selectedPack.id);
      message = 'Memory proposal submitted for review.';
    } catch (value) { error = displayError(value); }
  }

  async function memoryAction(action: 'fold' | 'clear'): Promise<void> {
    if (!selectedPack?.id) return;
    try {
      if (action === 'fold') await api.memoryFold(selectedPack.id, { reason: 'Folded from the web console' });
      else await api.memoryClear(selectedPack.id, selectedPack.activeGenerationId);
      await loadMemory(selectedPack.id);
      message = action === 'fold' ? 'Memory folded into a new generation.' : 'Working memory cleared to a new baseline.';
    } catch (value) { error = displayError(value); }
  }

  onMount(() => {
    const pop = (): void => {
      route = parseRoute();
      requestAnimationFrame(() => document.getElementById('main-content')?.focus());
      void loadRoute();
    };
    window.addEventListener('popstate', pop);
    void init();
    return () => { window.removeEventListener('popstate', pop); socket.close(); };
  });
</script>

<a class="skip-link" href="#main-content">Skip to main content</a>
{#if authLoading}
  <div class="loading-screen"><Mark size={42} /><span>Loading Dhole…</span></div>
{:else if !user}
  <main class="auth-shell" id="main-content" tabindex="-1">
    <section class="auth-panel" aria-labelledby="auth-title">
      <div class="brand-lockup"><Mark size={42} /><div><span class="eyebrow">DHOLE</span><h1 id="auth-title">Coordinated agent work.</h1></div></div>
      <p class="lede">A quiet control plane for people, runtimes, machines, and the work between them.</p>
      {#if error}<p class="alert error" role="alert">{error}</p>{/if}
      {#if !showBootstrap}
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void login(); }}>
          <label>Email<input type="email" bind:value={loginEmail} autocomplete="username" required /></label>
          <label>Password<input type="password" bind:value={loginPassword} autocomplete="current-password" required /></label>
          <button class="primary" type="submit">Sign in</button>
        </form>
        <button class="link-button" type="button" onclick={() => { showBootstrap = true; error = ''; }}>First run? Create the administrator</button>
      {:else}
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void bootstrap(); }}>
          <label>Administrator name<input bind:value={bootstrapName} autocomplete="name" required /></label>
          <label>Team name<input bind:value={bootstrapTeam} required /></label>
          <label>Email<input type="email" bind:value={loginEmail} autocomplete="username" required /></label>
          <label>Password <span class="muted">12+ characters</span><input type="password" bind:value={loginPassword} autocomplete="new-password" minlength="12" required /></label>
          <button class="primary" type="submit">Create administrator</button>
        </form>
        <button class="link-button" type="button" onclick={() => { showBootstrap = false; error = ''; }}>Back to sign in</button>
      {/if}
      <footer class="legal-notice"><span>© 2026 Kyle Der Zweite and contributors. No warranty.</span><span>Licensed under the <a href="/LICENSE" target="_blank" rel="noreferrer">MIT License</a>; <a href="/source" target="_blank" rel="noreferrer">view source code</a>.</span></footer>
    </section>
  </main>
{:else}
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}><Mark size={30} /><span>Dhole</span></a>
      <div class="topbar-project">
        {#if projects.length}<label class="sr-only" for="project-select">Project</label><select id="project-select" value={selectedProjectId ?? ''} onchange={(event) => { const id = (event.currentTarget as HTMLSelectElement).value; goto(id ? `/projects/${encodeURIComponent(id)}` : '/'); }}><option value="">All projects</option>{#each projects as item}<option value={item.id}>{item.name}</option>{/each}</select>{/if}
      </div>
      <div class="topbar-actions"><span class="connection" role="status" aria-live="polite"><span class={`connection-dot ${socketStatus}`}></span>Socket: {socketStatus === 'connected' ? 'Live' : socketStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}</span><span class="user-chip" title={user.email}>{user.displayName}</span><button class="icon-button" type="button" aria-label="Sign out" onclick={() => void logout()}>↪</button></div>
    </header>
    <div class="workspace">
      <aside class="sidebar" aria-label="Primary navigation">
        <nav aria-label="Primary navigation links">
          <a class:active={route.kind === 'dashboard'} aria-current={route.kind === 'dashboard' ? 'page' : undefined} href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}><span class="nav-glyph">⌂</span>Overview</a>
          <div class="nav-label">Workspace</div>
          {#each projects as item}
            <a class:active={route.kind === 'project' && route.id === item.id} aria-current={route.kind === 'project' && route.id === item.id ? 'page' : undefined} href={`/projects/${item.id}`} onclick={(event) => { event.preventDefault(); goto(`/projects/${encodeURIComponent(item.id)}`); }}><span class="project-dot"></span>{item.name}</a>
          {/each}
          <button class="nav-add" type="button" onclick={(event) => openCreateProject(event)}>＋ New project</button>
          <div class="nav-label">Surfaces</div>
          <a class:active={route.kind === 'gateway'} aria-current={route.kind === 'gateway' ? 'page' : undefined} href="/gateway" onclick={(event) => { event.preventDefault(); goto('/gateway'); }}>Gateway <span class="nav-count">{gatewaySummary?.totals?.requests ?? 0}</span></a>
          <a class:active={route.kind === 'lab'} aria-current={route.kind === 'lab' ? 'page' : undefined} href="/lab" onclick={(event) => { event.preventDefault(); goto('/lab'); }}>Improvement Lab</a>
          <a class:active={route.kind === 'memory'} aria-current={route.kind === 'memory' ? 'page' : undefined} href={`/memory${memoryPacks[0]?.id ? `/${memoryPacks[0].id}` : ''}`} onclick={(event) => { event.preventDefault(); goto(`/memory${memoryPacks[0]?.id ? `/${memoryPacks[0].id}` : ''}`); }}>Memory</a>
          {#if user.role === 'administrator'}<a class:active={route.kind === 'admin'} aria-current={route.kind === 'admin' ? 'page' : undefined} href="/admin" onclick={(event) => { event.preventDefault(); goto('/admin'); }}>Administration</a>{/if}
        </nav>
        <div class="sidebar-foot"><span class="eyebrow">DHOLE 0.1</span><span class="muted">Central server only</span></div>
      </aside>
      <main class="content" id="main-content" tabindex="-1" aria-busy={loading || routeLoading}>
        {#if routeLoading}<div class="route-loading" role="status" aria-live="polite">Loading {titleCase(route.kind)}…</div>{/if}
        {#if error}<div class="alert error" role="alert">{error}<button type="button" class="dismiss" aria-label="Dismiss" onclick={() => { error = ''; }}>×</button></div>{/if}
        {#if message}<div class="alert success" role="status">{message}</div>{/if}

        {#if route.kind === 'dashboard'}
          <section class="page-heading"><div><span class="eyebrow">CONTROL PLANE</span><h1>Good work, {user.displayName.split(' ')[0]}.</h1><p class="muted">The smallest useful view of your work, right now.</p></div><button class="primary compact" type="button" onclick={(event) => openCreateProject(event)}>＋ Project</button></section>
          <div class="dashboard-grid">
            <section class="area attention" aria-labelledby="attention-title"><header class="area-header"><div><span class="section-index">01</span><h2 id="attention-title">Needs attention</h2></div><span class="count-badge">{needsAttention}</span></header>
              {#if snapshotsLimited}<p class="muted snapshot-limit-note">Live details are shown for the first 30 sessions. Open a project to inspect older sessions.</p>{/if}
              {#if pendingApprovals.length === 0 && failedSessions.length === 0 && needsAttention === 0}<div class="empty"><span class="empty-mark">✓</span><p>Nothing is asking for you.</p><span class="muted">Approvals, conflicts, and failures will appear here.</span></div>{/if}
              {#each pendingApprovals as approval}<button class="attention-row" type="button" onclick={() => { const owning = snapshots.find((item) => item.approvals?.some((candidate) => candidate.id === approval.id)); if (owning) goto(`/sessions/${owning.session.id}`); }}><span class="status-dot approval"></span><span><strong>{approval.summary}</strong><small>{titleCase(approval.kind)} · approval requested</small></span><span class="row-arrow">→</span></button>{/each}
              {#each waitingSessions as item}<button class="attention-row" type="button" onclick={() => goto(`/sessions/${item.id}`)}><span class="status-dot approval"></span><span><strong>{item.title}</strong><small>{titleCase(item.state)} · open session</small></span><span class="row-arrow">→</span></button>{/each}
              {#each failedSessions as item}<button class="attention-row" type="button" onclick={() => goto(`/sessions/${item.id}`)}><span class="status-dot danger"></span><span><strong>{item.title}</strong><small>{titleCase(item.state)} · open session</small></span><span class="row-arrow">→</span></button>{/each}
              {#each attentionMachines as item}<div class="attention-row"><span class="status-dot danger"></span><span><strong>{String(field(item, 'name') ?? field(item, 'id') ?? 'Machine')}</strong><small>Machine {titleCase(field(item, 'status'))}</small></span></div>{/each}
              {#each gatewayCoolingRows as account}<a class="attention-row" href="/gateway" onclick={(event) => { event.preventDefault(); goto('/gateway'); }}><span class="status-dot approval"></span><span><strong>{String(account.provider ?? 'Gateway account')}</strong><small>Provider cooldown{account.cooldownUntil ? ` · until ${date(account.cooldownUntil)}` : ''} · view Gateway</small></span><span class="row-arrow">→</span></a>{/each}
            </section>

            <section class="area running" aria-labelledby="running-title"><header class="area-header"><div><span class="section-index">02</span><h2 id="running-title">Running</h2></div><span class="count-badge neutral">{runningSessions.length}</span></header>
              {#if runningSessions.length === 0}<div class="empty"><span class="empty-mark">◌</span><p>No active sessions.</p><span class="muted">Open a project to start a shared session.</span></div>{/if}
              {#each runningSessions as item}
                <button class="run-row" type="button" onclick={() => goto(`/sessions/${item.id}`)}><span class={`status-dot ${item.state === 'needs_input' || item.state === 'needs_approval' ? 'attention-dot' : 'live'}`}></span><span class="run-main"><strong>{item.title}</strong><small>{titleCase(item.state)} · {item.modelId ?? 'Model pending'}</small><span class="run-tree"><span class="tree-stem"></span><span>{item.runtimeRegistrationId ?? 'Runtime pending'}</span><span class="muted">{item.workspaceId ?? 'No workspace'}</span></span></span><span class="row-arrow">→</span></button>
              {/each}
            </section>

            <section class="area capacity" aria-labelledby="capacity-title"><header class="area-header"><div><span class="section-index">03</span><h2 id="capacity-title">Capacity</h2></div><span class="count-badge neutral">{machines.length}</span></header>
              <div class="capacity-summary"><div><strong>{machines.filter((item) => field(item, 'status') === 'connected').length}</strong><span>connected machines</span></div><div><strong>{gatewaySummary?.capacity?.available ?? 0}</strong><span>provider accounts ready</span></div></div>
              <div class="capacity-list">{#each machines.slice(0, 5) as item}<div class="capacity-row"><span class={`status-dot ${field(item, 'status') === 'connected' ? 'live' : 'danger'}`}></span><span><strong>{String(field(item, 'name') ?? field(item, 'id') ?? 'Machine')}</strong><small>{titleCase(field(item, 'status'))} · {field(item, 'availableSlots') ?? field(item, 'available_slots') ?? 0} slots available</small></span></div>{/each}{#if gatewaySummary}<div class="capacity-row"><span class="status-dot live"></span><span><strong>Gateway</strong><small>{gatewaySummary.totals?.requests ?? 0} requests · {gatewaySummary.totals?.failures ?? 0} failures · {money(gatewaySummary.totals?.estimatedCostMicrousd)}</small></span><a class="row-arrow" aria-label="Open Gateway details" href="/gateway" onclick={(event) => { event.preventDefault(); goto('/gateway'); }}>→</a></div>{/if}</div>
              {#if machines.length === 0 && !gatewaySummary}<div class="empty compact-empty"><p>Capacity data will appear when a node or Gateway is connected.</p></div>{/if}
            </section>
          </div>
        {:else if route.kind === 'project'}
          <section class="page-heading"><div><a class="back-link" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}>← Overview</a><h1>{project?.name ?? selectedProject?.name ?? 'Project'}</h1><p class="muted">{project?.description || 'Project detail and shared activity.'}</p></div><button class="primary compact" type="button" onclick={(event) => openCreateSession(event)}>＋ Session</button></section>
          <div class="detail-grid"><section class="panel wide"><header class="panel-header"><div><span class="eyebrow">PROJECT ACTIVITY</span><h2>Sessions</h2></div><span class="count-badge neutral">{sessions.length}</span></header>{#if sessions.length === 0}<div class="empty"><p>No sessions yet.</p><span class="muted">A session becomes the shared room for people and agents.</span></div>{:else}<div class="table-list">{#each sessions as item}<button class="table-row" type="button" onclick={() => goto(`/sessions/${item.id}`)}><span class={`status-dot ${item.state === 'busy' || item.state === 'running' ? 'live' : item.state === 'failed' ? 'danger' : 'idle'}`}></span><span><strong>{item.title}</strong><small>{titleCase(item.state)} · {date(item.updatedAt)}</small></span><span class="muted">{item.modelId ?? '—'}</span><span>→</span></button>{/each}</div>{/if}</section><section class="panel"><header class="panel-header"><div><span class="eyebrow">SOURCE</span><h2>Repositories</h2></div></header>{#if repositories.length === 0}<p class="muted">No repository is linked.</p>{:else}<div class="table-list">{#each repositories as repo}<div class="table-row static"><span class="repo-icon">⌁</span><span><strong>{repo.label}</strong><small>{repo.canonicalRemote ?? repo.localPathHint ?? 'Remote not set'}</small></span><span class="muted">{repo.defaultBranch ?? '—'}</span></div>{/each}</div>{/if}<form class="stack inset" onsubmit={(event) => { event.preventDefault(); void createRepository(); }}><label>Link repository<input bind:value={repoLabel} placeholder="frontend" required /></label><label>Remote URL <span class="muted">optional</span><input type="url" bind:value={repoRemote} placeholder="https://…" /></label><label>Local path hint <span class="muted">optional</span><input bind:value={repoPath} placeholder="workspace/repo" /></label><label>Default branch<input bind:value={repoBranch} /></label><button class="secondary" type="submit">Link repository</button></form></section></div>
        {:else if route.kind === 'session'}
          {#if snapshot}<section class="page-heading"><div><a class="back-link" href={`/projects/${snapshot.session.projectId}`} onclick={(event) => { event.preventDefault(); goto(`/projects/${snapshot?.session.projectId}`); }}>← {projects.find((item) => item.id === snapshot?.session.projectId)?.name ?? 'Project'}</a><h1>{snapshot.session.title}</h1><p class="muted">{titleCase(snapshot.session.state)} · watermark {snapshot.watermark ?? 0} · <span class={`socket-label ${socketStatus}`} role="status" aria-live="polite">Socket {socketStatus}</span> · <span class="lease-label">Control lease: {leaseToken ? 'held in this browser' : snapshot.session.activeTurnId ? 'not held in this browser' : 'not required'}</span></p></div><div class="heading-actions"><button class="secondary compact" type="button" onclick={() => void cancelSession()} disabled={!['busy', 'running', 'needs_input', 'needs_approval'].includes(snapshot.session.state)}>Cancel</button></div></section><div class="session-layout"><section class="panel conversation"><header class="panel-header"><div><span class="eyebrow">SHARED SESSION</span><h2>Conversation</h2></div><span class="muted">{snapshot.messages.length} messages</span></header><div class="messages" aria-live="polite">{#if snapshot.messages.length === 0}<div class="empty"><p>No messages yet.</p><span class="muted">Queue a message to begin.</span></div>{/if}{#each snapshot.messages as item (item.id)}<article class={`message ${item.role}`}><div class="message-meta"><span class="message-role">{messageAttribution(item)}</span><span>{date(item.createdAt)}</span><span class="muted">{item.status ?? ''}</span></div><p>{item.body}</p></article>{/each}</div><form class="composer" onsubmit={(event) => { event.preventDefault(); void queueMessage(); }}><label class="sr-only" for="composer">Message the session</label><textarea id="composer" bind:value={composer} rows="3" placeholder="Write to everyone in this session…"></textarea><div class="composer-actions"><span class="muted">Plain text is shared with participants.</span><button class="primary compact" type="submit" disabled={!composer.trim()}>Queue message</button></div></form>{#if activeTurnSteeringSupported}<form class="steer-form" onsubmit={(event) => { event.preventDefault(); void steer(); }}><label for="steer">Steer active turn <span class="muted">requires the control lease</span></label><div class="inline-form"><input id="steer" bind:value={steerText} placeholder="A bounded direction for the active turn" disabled={!snapshot.session.activeTurnId} /><button class="secondary compact" type="submit" disabled={!steerText.trim() || !snapshot.session.activeTurnId}>Steer</button></div></form>{:else}<p class="muted steering-unavailable" role="status">Steering unavailable: this runtime does not advertise active-turn steering.</p>{/if}</section><aside class="session-rail"><section class="panel participants-panel"><header class="panel-header"><h2>Participants</h2><span class="count-badge neutral">{snapshot.participants?.length ?? 0}</span></header>{#if snapshot.participants?.length}<ul class="participant-list">{#each snapshot.participants as participant}<li><span>{participantLabel(participant.userId)}</span><small>Joined {date(participant.joinedAt)}</small></li>{/each}</ul>{:else}<p class="muted">No active participants recorded.</p>{/if}</section><section class="panel"><header class="panel-header"><h2>Approvals</h2><span class="count-badge">{pendingSessionApprovals.length}</span></header>{#if pendingSessionApprovals.length === 0}<p class="muted">No pending approval requests.</p>{:else}{#each pendingSessionApprovals as approval}<div class="approval"><strong>{approval.summary}</strong><small>{titleCase(approval.kind)}{approval.expiresAt ? ` · expires ${date(approval.expiresAt)}` : ''}</small>{#if approvalResponsesSupported}<div class="approval-actions"><button class="primary compact" type="button" onclick={() => void answerApproval(approval, 'approve_once')}>Approve</button><button class="secondary compact" type="button" onclick={() => void answerApproval(approval, 'deny')}>Deny</button></div>{:else}<p class="muted approval-readonly" role="status">Read-only: this runtime does not advertise approval responses.</p>{/if}</div>{/each}{/if}</section><section class="panel"><header class="panel-header"><h2>Lineage</h2><span class="muted">{snapshot.tree?.length ?? 0} roots</span></header><div class="legend"><span><i class="legend-dot full"></i>Full control</span><span><i class="legend-dot observed"></i>Observed</span><span><i class="legend-dot heuristic"></i>Heuristic</span></div><div class="tree"><Tree nodes={snapshot.tree ?? []} /></div></section><section class="panel mini-stats"><div><span>Runtime</span><strong>{snapshot.session.runtimeRegistrationId ?? '—'}</strong></div><div><span>Model</span><strong>{snapshot.session.modelId ?? '—'}</strong></div><div><span>Workspace</span><strong>{snapshot.session.workspaceId ?? '—'}</strong></div></section></aside></div>{:else}<div class="empty page-empty"><p>Loading session…</p></div>{/if}
        {:else if route.kind === 'agent'}
          <section class="page-heading"><div><a class="back-link" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}>← Overview</a><h1>{agentNode?.name ?? 'Agent detail'}</h1><p class="muted">Activation history and control boundary.</p></div></section><section class="panel agent-detail">{#if agentNode}<div class="agent-hero"><span class={`tree-dot ${agentNode.control === 'observe_only' ? 'observed' : agentNode.control === 'uncertain' ? 'heuristic' : 'full'}`}></span><div><h2>{agentNode.name}</h2><p class="muted">{titleCase(agentNode.state)} · {agentNode.evidence ?? 'platform'} evidence · {agentNode.control ?? 'full'} control</p></div></div><dl class="facts"><div><dt>Runtime</dt><dd>{agentNode.runtimeId ?? '—'}</dd></div><div><dt>Machine</dt><dd>{agentNode.machineId ?? '—'}</dd></div><div><dt>Activation</dt><dd>{agentNode.activationId ?? '—'}</dd></div><div><dt>Started</dt><dd>{date(agentNode.startedAt)}</dd></div></dl><p class="muted">Open the owning session to inspect messages, approvals, tools, and progress.</p>{#each snapshots.filter((item) => findNode(agentNode?.id, [item])) as owning}<a class="secondary button-link" href={`/sessions/${owning.session.id}`} onclick={(event) => { event.preventDefault(); goto(`/sessions/${owning.session.id}`); }}>Open session</a>{/each}{:else}<div class="empty"><p>Agent not found in the current snapshots.</p><span class="muted">Agents are progressively disclosed from a session lineage.</span></div>{/if}</section>
        {:else if route.kind === 'gateway'}
          <section class="page-heading"><div><span class="eyebrow">PROVIDER OBSERVABILITY</span><h1>Gateway</h1><p class="muted">Requests, usage, accounts, and quota from the central proxy.</p></div><button class="secondary compact" type="button" onclick={() => void loadGateway()}>Refresh</button></section><div class="metric-strip">{#each [{ label: 'Requests', value: gatewaySummary?.totals?.requests ?? gatewayRequestTotal }, { label: 'Failures', value: gatewaySummary?.totals?.failures ?? 0 }, { label: 'Input tokens', value: gatewaySummary?.totals?.inputTokens ?? 0 }, { label: 'Estimated cost', value: money(gatewaySummary?.totals?.estimatedCostMicrousd) }] as metric}<div class="metric"><span>{metric.label}</span><strong>{metric.value}</strong></div>{/each}</div><section class="panel filters"><div class="filter-grid"><label>Provider<input bind:value={providerFilter} placeholder="all providers" /></label><label>Model<input bind:value={modelFilter} placeholder="all models" /></label><label class="check-label"><input type="checkbox" bind:checked={failedOnly} /> Failed only</label><button class="secondary compact" type="button" onclick={() => void refreshGatewayRequests()}>Apply filters</button></div></section><div class="detail-grid"><section class="panel wide"><header class="panel-header"><div><span class="eyebrow">REQUESTS</span><h2>Recent traffic</h2></div><span class="muted">{gatewayRequestTotal} total</span></header>{#if gatewayRequests.length === 0}<div class="empty"><p>No gateway requests.</p><span class="muted">Connect CLIProxyAPI or load the local fixture.</span></div>{:else}<div class="table-list gateway-list">{#each gatewayRequests as request}<div class="table-row static"><span class={`status-dot ${request.failed ? 'danger' : 'live'}`}></span><span><strong>{request.provider ?? 'unknown'} / {request.model ?? 'unknown'}</strong><small>{date(request.occurredAt)} · {request.statusCode ?? '—'} · {request.durationMs ?? '—'}ms</small></span><span>{request.failed ? titleCase(request.failureCategory) : 'ok'}</span><span>{money(request.estimatedCostMicrousd)}</span><span class="confidence">{request.correlationConfidence ?? 'unmatched'}</span></div>{/each}</div>{/if}</section><aside class="panel"><header class="panel-header"><h2>Accounts</h2><span class="count-badge neutral">{gatewaySummary?.capacity?.accounts ?? gatewayAccounts.length}</span></header>{#if gatewaySummary?.accounts?.length}{#each gatewaySummary.accounts as account}<div class="capacity-row"><span class={`status-dot ${account.status === 'healthy' || account.status === 'available' ? 'live' : 'danger'}`}></span><span><strong>{String(account.provider ?? 'Provider')}</strong><small>{String(account.label ?? account.authIndex ?? account.id ?? '')} · {titleCase(account.status)} · {gatewayQuota(account)}</small></span></div>{/each}{:else if gatewayAccounts.length}<div class="table-list">{#each gatewayAccounts as account}<div class="table-row static"><span><strong>{String(account.provider ?? 'Provider')}</strong><small>{titleCase(account.status)} · {gatewayQuota(account)}</small></span></div>{/each}</div>{:else}<p class="muted">No account health data.</p>{/if}</aside></div><section class="panel gateway-connections"><header class="panel-header"><div><span class="eyebrow">CONNECTION HEALTH</span><h2>Gateway connections</h2></div><span class="count-badge neutral">{gatewayConnections.length}</span></header>{#if gatewayConnections.length === 0}<p class="muted connection-empty">No Gateway connections configured.</p>{:else}<div class="table-list">{#each gatewayConnections as connection}<div class="capacity-row"><span class={`status-dot ${gatewayConnectionClass(connection)}`}></span><span><strong>{String(connection.name ?? 'Gateway connection')}</strong><small>{titleCase(connection.status)} · {connection.enabled === false ? 'disabled' : 'enabled'} · checked {date(connection.lastCheckedAt)}</small>{#if connection.lastErrorSummary}<small class="connection-error">{String(connection.lastErrorSummary)}</small>{/if}</span></div>{/each}</div>{/if}</section>
        {:else if route.kind === 'lab'}
          <section class="page-heading"><div><span class="eyebrow">IMPROVEMENT LAB</span><h1>Compare before promoting.</h1><p class="muted">Independent dimensions keep quality, speed, and cost visible.</p></div></section><div class="detail-grid"><section class="panel wide"><header class="panel-header"><div><span class="eyebrow">RUN HISTORY</span><h2>Benchmarks</h2></div><span class="count-badge neutral">{labRuns.length}</span></header>{#if labRuns.length === 0}<div class="empty"><p>No benchmark runs.</p><span class="muted">The Lab uses deterministic fixtures when configured.</span></div>{:else}<div class="table-list">{#each labRuns as run}<button class="table-row" type="button" onclick={() => run.id && void showComparison(String(run.id))}><span class={`status-dot ${run.state === 'completed' ? 'live' : run.state === 'failed' ? 'danger' : 'idle'}`}></span><span><strong>{String(run.id ?? 'Run').slice(0, 12)}</strong><small>{titleCase(run.state)} · benchmark {String(run.benchmarkId ?? '—')}</small></span><span>{date(run.createdAt)}</span><span>Compare →</span></button>{/each}</div>{/if}</section><aside class="panel"><header class="panel-header"><h2>Definitions</h2></header>{#if labBenchmarks.length === 0}<p class="muted">No benchmark definitions.</p>{:else}{#each labBenchmarks as benchmark}<div class="definition"><strong>{String(benchmark.name ?? benchmark.stableKey ?? 'Benchmark')}</strong><small>{titleCase(benchmark.kind)} · v{String(benchmark.version ?? '—')}</small></div>{/each}{/if}</aside></div>{#if labComparison}<section class="panel comparison"><header class="panel-header"><div><span class="eyebrow">SIDE-BY-SIDE</span><h2>{String((labComparison.definitions as JsonObject | undefined)?.name ?? 'Benchmark comparison')}</h2></div><span class="status-pill">{titleCase((labComparison.run as JsonObject | undefined)?.state)}</span></header><div class="comparison-columns"><div><span class="eyebrow">BASELINE</span><strong>{String(((labComparison.run as JsonObject | undefined)?.baseline as JsonObject | undefined)?.reference ?? 'Baseline')}</strong></div><div><span class="eyebrow">CANDIDATE</span><strong>{String(((labComparison.run as JsonObject | undefined)?.candidate as JsonObject | undefined)?.reference ?? 'Candidate')}</strong></div></div><div class="dimension-table">{#each records<JsonObject>(labComparison, 'dimensions').filter((item) => item.variant === 'comparison') as dimension}<div class="dimension-row"><span>{titleCase(dimension.dimension)}</span><span>{String(dimension.numericValue ?? dimension.textValue ?? '—')}</span><span>{String(dimension.evidence && typeof dimension.evidence === 'object' ? (dimension.evidence as JsonObject).winner ?? '—' : '—')}</span></div>{/each}</div><form class="decision-form" onsubmit={(event) => { event.preventDefault(); }}><label>Decision reason<input bind:value={decisionReason} placeholder="What did you observe?" /></label><div><button class="primary compact" type="button" onclick={() => void decideLab('promote')}>Promote</button><button class="secondary compact" type="button" onclick={() => void decideLab('canary')}>Canary</button><button class="danger-button compact" type="button" onclick={() => void decideLab('reject')}>Reject</button></div></form></section>{/if}
        {:else if route.kind === 'memory'}
          <section class="page-heading"><div><span class="eyebrow">PROJECT MEMORY</span><h1>Working knowledge, with an expiry.</h1><p class="muted">Generations are immutable; only an explicit activation enters agent context.</p></div></section><div class="detail-grid"><section class="panel"><header class="panel-header"><h2>Packs</h2><span class="count-badge neutral">{memoryPacks.length}</span></header>{#if memoryPacks.length === 0}<div class="empty"><p>No memory packs.</p><span class="muted">Create packs through the project API.</span></div>{:else}<div class="table-list">{#each memoryPacks as pack}<button class:active={selectedPack?.id === pack.id} class="table-row" type="button" onclick={() => { selectedPack = pack; goto(`/memory/${pack.id}`); void loadMemory(pack.id ?? ''); }}><span class="memory-icon">✦</span><span><strong>{String(pack.name ?? pack.stableKey ?? 'Memory')}</strong><small>{titleCase(pack.scope)} · active {String(pack.activeGenerationId ?? 'none').slice(0, 10)}</small></span><span>→</span></button>{/each}</div>{/if}</section><section class="panel wide">{#if selectedPack}<header class="panel-header"><div><span class="eyebrow">{titleCase(selectedPack.scope)}</span><h2>{String(selectedPack.name ?? selectedPack.stableKey ?? 'Memory')}</h2></div><div class="heading-actions"><button class="secondary compact" type="button" onclick={() => void memoryAction('fold')}>Fold</button><button class="secondary compact" type="button" onclick={() => void memoryAction('clear')}>Clear active</button></div></header><div class="memory-toolbar"><label class="search-label">Search<input bind:value={memorySearch} placeholder="Search active context" /></label><span class="muted">{memorySearch.trim() ? 'Filtered safe entries' : `${memoryGenerations.length} generations · ${memoryProposals.length} proposals`}</span></div><div class="generation-list">{#each memoryGenerations.filter((generation) => !memorySearch.trim() || memoryEntries(generation).length > 0) as generation}<details><summary><span class={`status-dot ${generation.state === 'active' ? 'live' : 'idle'}`}></span><strong>Generation {String(generation.generation ?? '—')}</strong><span class="muted">{titleCase(generation.state)} · {date(generation.createdAt)}</span></summary><div class="generation-body">{#each memoryEntries(generation) as entry}<article><h3>{String(entry.title ?? 'Untitled')}</h3><p>{String(entry.body ?? '')}</p><small>{String(entry.sourceType ?? 'source')} · {String(entry.sourceReference ?? '')}</small></article>{/each}</div></details>{/each}{#if memorySearch.trim() && memoryGenerations.every((generation) => memoryEntries(generation).length === 0)}<div class="empty compact-empty"><p>No matching memory entries.</p><span class="muted">Search filters the safe title, body, and source fields.</span></div>{/if}</div><div class="proposal-box"><h3>Propose memory</h3><form class="stack" onsubmit={(event) => { event.preventDefault(); void proposeMemory(); }}><label>Title<input bind:value={proposalTitle} required /></label><label>Plain-text entry<textarea bind:value={proposalBody} rows="3" required></textarea></label><button class="primary compact" type="submit">Submit proposal</button></form></div>{#if memoryProposals.length}<div class="proposal-list"><h3>Pending proposals</h3>{#each memoryProposals as proposal}<div class="proposal-row"><span><strong>{String(proposal.title ?? 'Proposal')}</strong><small>{titleCase(proposal.state)} · {date(proposal.createdAt)}</small></span><span class="muted">{String(proposal.sourceType ?? '')}</span></div>{/each}</div>{/if}{:else}<div class="empty"><p>Select a memory pack.</p></div>{/if}</section></div>
        {:else if route.kind === 'admin'}
          <section class="page-heading"><div><span class="eyebrow">ADMINISTRATION</span><h1>Keep the control plane legible.</h1><p class="muted">Users, nodes, providers, and security boundaries.</p></div><button bind:this={createUserTrigger} class="primary compact" type="button" onclick={openCreateUser}>＋ User</button></section><div class="detail-grid"><section class="panel wide"><header class="panel-header"><div><span class="eyebrow">IDENTITIES</span><h2>Users</h2></div></header>{#await api.users() then users}<div class="table-list">{#each users as item}<div class="table-row static"><span class="avatar">{item.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{item.displayName}</strong><small>{item.email}</small></span><span class="status-pill">{titleCase(item.role)}</span></div>{/each}</div>{:catch}<p class="muted">User list unavailable.</p>{/await}</section><section class="panel"><header class="panel-header"><div><span class="eyebrow">FLEET</span><h2>Nodes</h2></div><span class="count-badge neutral">{machines.length}</span></header>{#if machines.length === 0}<p class="muted">No execution nodes enrolled.</p>{:else}{#each machines as item}<div class="capacity-row"><span class={`status-dot ${field(item, 'status') === 'connected' ? 'live' : 'danger'}`}></span><span><strong>{String(field(item, 'name') ?? field(item, 'id'))}</strong><small>{titleCase(field(item, 'status'))} · heartbeat {date(field(item, 'lastHeartbeatAt') ?? field(item, 'last_heartbeat_at'))}</small></span></div>{/each}{/if}</section></div>
        {/if}
        <footer class="legal-notice app-legal"><span>© 2026 Kyle Der Zweite and contributors. No warranty.</span><span><a href="/LICENSE" target="_blank" rel="noreferrer">MIT License</a> · <a href="/source" target="_blank" rel="noreferrer">source code</a></span></footer>
      </main>
    </div>
  </div>
{/if}

{#if createProjectOpen}
  <dialog bind:this={createProjectDialog} class="modal" aria-modal="true" aria-labelledby="create-project-title" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeCreateProject(); } }} oncancel={(event) => { event.preventDefault(); closeCreateProject(); }} onclose={handleCreateProjectClose}><header class="modal-header"><h2 id="create-project-title">New project</h2><button class="icon-button" type="button" aria-label="Close" onclick={closeCreateProject}>×</button></header><form class="stack" onsubmit={(event) => { event.preventDefault(); void createProject(); }}><label>Name<input bind:this={createProjectFirstInput} bind:value={projectName} required /></label><label>Description <span class="muted">optional</span><textarea bind:value={projectDescription} rows="3"></textarea></label><button class="primary" type="submit">Create project</button></form></dialog>
{/if}
{#if createSessionOpen}
  <dialog bind:this={createSessionDialog} class="modal" aria-modal="true" aria-labelledby="create-session-title" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeCreateSession(); } }} oncancel={(event) => { event.preventDefault(); closeCreateSession(); }} onclose={handleCreateSessionClose}><header class="modal-header"><h2 id="create-session-title">New shared session</h2><button class="icon-button" type="button" aria-label="Close" onclick={closeCreateSession}>×</button></header><form class="stack" onsubmit={(event) => { event.preventDefault(); void createSession(); }}><label>Title<input bind:this={createSessionFirstInput} bind:value={sessionTitle} required placeholder="Investigate the failing build" /></label><label>Runtime <span class="muted">optional</span><select bind:value={sessionRuntimeRegistrationId}><option value="">Collaboration only</option>{#each runtimeRegistrations as runtime}<option value={runtime.id}>{runtime.label} · {runtime.kind}</option>{/each}</select></label><p class="muted form-hint">Choose a runtime to send the first message to an allowlisted project repository. Workspace selection is automatic.</p><button class="primary" type="submit">Create session</button></form></dialog>
{/if}
{#if createUserOpen}
  <dialog bind:this={createUserDialog} class="modal" aria-modal="true" aria-labelledby="create-user-title" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeCreateUser(); } }} oncancel={(event) => { event.preventDefault(); closeCreateUser(); }} onclose={handleCreateUserClose}><header class="modal-header"><h2 id="create-user-title">Create user</h2><button class="icon-button" type="button" aria-label="Close" onclick={closeCreateUser}>×</button></header><form class="stack" onsubmit={(event) => { event.preventDefault(); void createUser(); }}><label>Display name<input bind:this={createUserFirstInput} bind:value={newUserName} required /></label><label>Email<input type="email" bind:value={newUserEmail} required /></label><label>Temporary password<input type="password" bind:value={newUserPassword} minlength="12" required /></label><label>Role<select bind:value={newUserRole}><option value="member">Member</option><option value="administrator">Administrator</option></select></label><button class="primary" type="submit">Create user</button></form></dialog>
{/if}
