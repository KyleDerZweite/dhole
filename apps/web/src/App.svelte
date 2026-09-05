<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, loadOverview } from './lib/api';
  import { LayoutDashboard, FolderKanban, GitBranch, Network, Bot, UserRound, Monitor, ShieldCheck, Settings2, LogOut, Plus, ChevronRight, RefreshCw, CircleCheck, CircleAlert, Activity, Cpu, Cable, BookOpen, Search, X } from '@lucide/svelte';
  import Admin from './lib/Admin.svelte';
  import Select from './lib/Select.svelte';
  import Gateway from './lib/Gateway.svelte';
  import AccountSetup from './lib/AccountSetup.svelte';
  import Account from './lib/Account.svelte';
  import Devices from './lib/Devices.svelte';
  import Mark from './lib/Mark.svelte';
  import Tree from './lib/Tree.svelte';
  import { AppSocket, type SocketStatus } from './lib/ws';
  import type { AccountGrant, CoordinationState, AgentNode, Approval, AuthMethods, ModuleCatalog, GatewaySummary, JsonObject, Machine, Project, Repository, Route, RuntimeRegistration, SessionMessage, SessionSnapshot, SessionSummary, User } from './lib/types';

  const socket = new AppSocket();
  let route: Route = parseRoute();
  let user: User | null = null;
  let accountGrant: AccountGrant | null = null;
  let authMethods: AuthMethods | null = null;
  let moduleCatalog: ModuleCatalog | null = null;
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
  let overviewRuntimes: RuntimeRegistration[] = [];
  let projectSearch = '';
  let coordinationProjectId = new URLSearchParams(location.search).get('project') ?? '';
  let coordinationState: CoordinationState | null = null;
  let coreTab: 'activity' | 'runtime' = location.pathname === '/runtime' ? 'runtime' : 'activity';
  let tooltipsDismissed = false;
  let socketStatus: SocketStatus = 'offline';
  let socketSessionId: string | undefined;

  let loginEmail = '';
  let loginPassword = '';
  let showBootstrap = false;
  let bootstrapName = '';
  let bootstrapTeam = 'Dhole';
  let bootstrapToken = '';
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
      ? (snapshot && snapshot.session.id === route.id ? snapshot.session.projectId : sessions.find((item) => item.id === route.id)?.projectId)
      : route.kind === 'agent'
        ? owningAgentSnapshot?.session.projectId
        : route.kind === 'coordination'
          ? coordinationProjectId || undefined
          : undefined;
  $: selectedProject = projects.find((item) => item.id === selectedProjectId) ?? project;
  $: sessionRuntimeRegistration = snapshot?.session.runtimeRegistrationId ? runtimeRegistrations.find((item) => item.id === snapshot?.session.runtimeRegistrationId) : undefined;
  $: activeTurnSteeringSupported = sessionRuntimeRegistration?.capabilities?.activeTurnSteering === true;
  $: runningSessions = sessions.filter((item) => ['busy', 'running'].includes(item.state));
  $: waitingSessions = sessions.filter((item) => ['needs_input', 'needs_approval', 'waiting_for_user', 'waiting_for_approval', 'blocked'].includes(item.state));
  $: failedSessions = sessions.filter((item) => ['failed', 'cancelled'].includes(item.state));
  $: pendingApprovals = snapshots.flatMap((item) => item.approvals ?? []).filter((item) => item.state === 'pending');
  $: pendingSessionApprovals = snapshot?.approvals?.filter((item) => item.state === 'pending') ?? [];
  $: attentionMachines = machines.filter((item) => field(item, 'status') === 'disconnected' || field(item, 'status') === 'stale');
  $: gatewayCoolingRows = coolingGatewayRows(gatewaySummary);
  $: needsAttention = pendingApprovals.length + waitingSessions.length + failedSessions.length + attentionMachines.length + gatewayCoolingRows.length;
  $: approvalResponsesSupported = sessionRuntimeRegistration?.capabilities?.approvalResponses === true;
  $: enabledModules = moduleCatalog?.enabledModules ?? [];
  $: filteredProjects = projects.filter((item) => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(projectSearch.toLowerCase()));
  $: navItems = [
    { path: '/', label: 'Overview', icon: LayoutDashboard, active: route.kind === 'dashboard' },
    { path: '/projects', label: 'Projects', icon: FolderKanban, active: ['projects', 'project', 'session'].includes(route.kind) },
    ...(enabledModules.includes('coordination') ? [{ path: '/coordination', label: 'Coordination', icon: GitBranch, active: route.kind === 'coordination' }] : []),
    ...(enabledModules.includes('gateway') ? [{ path: '/gateway', label: 'Gateway', icon: Network, active: route.kind === 'gateway' }] : []),
    { path: '/agents', label: 'Agents', icon: Bot, active: ['agents', 'agent'].includes(route.kind) },
  ];
  $: accessItems = [
    { path: '/connect', label: 'Devices', icon: Monitor, active: route.kind === 'connect' },
    ...(user?.role === 'administrator' ? [{ path: '/admin', label: 'Users & access', icon: ShieldCheck, active: route.kind === 'admin' }] : []),
    { path: '/modules', label: 'Configuration', icon: Settings2, active: route.kind === 'modules' },
  ];
  $: routeOwner = routeModule(route);
  $: routeUnavailable = Boolean(routeOwner && !enabledModules.includes(routeOwner));
  $: if (typeof document !== 'undefined') {
    route; project; selectedProject; snapshot; agentNode; accountGrant;
    document.title = pageTitle();
  }

  function moduleEnabled(id: string): boolean { return moduleCatalog?.enabledModules.includes(id) === true; }

  function routeModule(value: Route): string | undefined {
    return ({ gateway: 'gateway', coordination: 'coordination' } as Partial<Record<Route['kind'], string>>)[value.kind];
  }

  function parseRoute(path = location.pathname): Route {
    const parts = path.split('?')[0]!.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (!parts.length || (parts[0] === 'sessions' && !parts[1]) || parts[0] === 'runtime') return { kind: 'dashboard' };
    if (parts[0] === 'account') return { kind: 'account' };
    if (parts[0] === 'connect') return { kind: 'connect' };
    if (parts[0] === 'modules') return { kind: 'modules' };
    if (parts[0] === 'login') return { kind: 'login' };
    if (parts[0] === 'projects' && !parts[1]) return { kind: 'projects' };
    if (parts[0] === 'agents' && !parts[1]) return { kind: 'agents' };
    if (parts[0] === 'coordination') return { kind: 'coordination' };
    if (parts[0] === 'projects' && parts[1]) return { kind: 'project', id: parts[1] };
    if (parts[0] === 'sessions' && parts[1]) return { kind: 'session', id: parts[1] };
    if (parts[0] === 'agents' && parts[1]) return { kind: 'agent', id: parts[1] };
    if (parts[0] === 'gateway') return { kind: 'gateway' };
    if (parts[0] === 'admin') return { kind: 'admin' };
    return { kind: 'dashboard' };
  }

  function goto(path: string, reload = true): void {
    history.pushState({}, '', path);
    if (route.kind === 'session' && path !== `/sessions/${route.id}`) clearSession();
    route = parseRoute(path);
    error = '';
    message = '';
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      document.getElementById('main-content')?.focus({ preventScroll: true });
    });
    if (reload) void loadRoute();
  }

  function field(value: unknown, key: string): string | number | boolean | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const result = record[key] ?? record[snake];
    return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' ? result : undefined;
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

  function participantLabel(userId: unknown, participants: JsonObject[] | undefined, viewer: User | null): string {
    const id = typeof userId === 'string' ? userId : '';
    if (viewer && id === viewer.id) return `${viewer.displayName} (you)`;
    const participant = participants?.find((item) => field(item, 'userId') === id);
    const displayName = field(participant, 'displayName');
    if (typeof displayName === 'string') return displayName;
    return id || 'Unknown participant';
  }

  function messageAttribution(item: SessionMessage, participants: JsonObject[] | undefined, viewer: User | null): string {
    if (item.role === 'human') return item.authorUserId ? `Human · ${participantLabel(item.authorUserId, participants, viewer)}` : 'Human';
    if (item.role === 'agent') return item.logicalAgentId ? `Agent · ${item.logicalAgentId}` : 'Agent';
    return titleCase(item.role);
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

  function titleCase(value: unknown): string {
    return String(value ?? 'unknown').replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function pageTitle(): string {
    if (accountGrant) return accountGrant.kind === 'invitation' ? 'Set up your account · Dhole' : 'Reset your password · Dhole';
    if (route.kind === 'project') return `${project?.name ?? selectedProject?.name ?? 'Project'} · Dhole`;
    if (route.kind === 'session') return `${snapshot?.session.title ?? 'Session'} · Dhole`;
    if (route.kind === 'agent') return `${agentNode?.name ?? 'Agent detail'} · Dhole`;
    if (route.kind === 'projects') return 'Projects · Dhole';
    if (route.kind === 'agents') return 'Agents · Dhole';
    if (route.kind === 'coordination') return 'Coordination · Dhole';
    if (route.kind === 'gateway') return 'Gateway · Dhole';
    if (route.kind === 'admin') return 'Administration · Dhole';
    if (route.kind === 'login') return 'Sign in · Dhole';
    if (route.kind === 'connect') return 'Connect a machine · Dhole';
    if (route.kind === 'account') return 'Your account · Dhole';
    if (route.kind === 'modules') return 'Modules · Dhole';
    return 'Overview · Dhole';
  }

  function displayError(value: unknown): string {
    if (value instanceof ApiError) return value.message;
    return value instanceof Error ? value.message : 'Something went wrong';
  }

  async function init(): Promise<void> {
    try {
      const fragments = new URLSearchParams(location.hash.slice(1));
      const invite = fragments.get('invitation');
      const reset = fragments.get('password-reset');
      if (invite !== null || reset !== null) {
        history.replaceState({}, '', location.pathname + location.search);
        accountGrant = invite ? { kind: 'invitation', token: invite } : reset ? { kind: 'password-reset', token: reset } : null;
        if (accountGrant) return;
      }
      authMethods = await api.authMethods();
      const outcome = new URLSearchParams(location.search).get('github');
      if (outcome === 'linked') message = 'GitHub linked to your Dhole account.';
      else if (outcome === 'error') error = 'GitHub linking failed. Please try again from your account.';
      if (outcome) {
        history.replaceState({}, '', '/account');
        route = { kind: 'account' };
      }
      const result = await api.me();
      user = result.user;
      if (result.csrfToken) sessionStorage.setItem('dhole_csrf', result.csrfToken);
      await loadSignedIn();
    } catch (value) {
      if (!(value instanceof ApiError && value.status === 401)) error = displayError(value);
    } finally {
      authLoading = false;
    }
  }

  async function loadSignedIn(): Promise<void> {
    if (!user || user.status === 'pending' || user.status === 'disabled') return;
    moduleCatalog = await api.modules();
    await loadDashboard();
    if (route.kind === 'login') goto('/', false);
    if (route.kind !== 'dashboard') await loadRoute();
  }

  function clearSession(): void {
    socket.close();
    socketSessionId = undefined;
    socketStatus = 'offline';
    snapshot = null;
    leaseToken = '';
    steerText = '';
    composer = '';
  }

  async function loadDashboard(): Promise<void> {
    loading = true;
    snapshotsLimited = false;
    try {
      const overview = await loadOverview(moduleCatalog?.enabledModules ?? []);
      projects = overview.projects;
      sessions = overview.sessions;
      snapshots = overview.snapshots;
      machines = overview.machines;
      overviewRuntimes = overview.runtimes;
      gatewaySummary = overview.gatewaySummary;
      snapshotsLimited = overview.snapshotsLimited;
    } catch (value) {
      error = displayError(value);
    } finally {
      loading = false;
    }
  }

  async function loadRoute(): Promise<void> {
    if (!user || user.status === 'pending' || user.status === 'disabled' || (routeModule(route) && !moduleEnabled(routeModule(route)!)) || (route.kind === 'admin' && user.role !== 'administrator')) return;
    routeLoading = true;
    try {
      if (route.kind !== 'session' && socketSessionId) {
        clearSession();
      }
      if (['dashboard', 'projects', 'agents', 'agent'].includes(route.kind)) {
        await loadDashboard();
      } else if (route.kind === 'project' && route.id) {
        project = null;
        const value = await api.project(route.id);
        project = value.project;
        repositories = value.repositories;
        sessions = await api.sessions(route.id);
        runtimeRegistrations = await api.runtimeRegistrations(route.id);
        runtimeRegistrationsProjectId = route.id;
      } else if (route.kind === 'session' && route.id) {
        await loadSession(route.id);
      } else if (route.kind === 'coordination') {
        coordinationState = null;
        if (!coordinationProjectId) coordinationProjectId = projects[0]?.id ?? '';
        if (coordinationProjectId) coordinationState = await api.coordination(coordinationProjectId);
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
      : await api.runtimeRegistrations(nextSnapshot.session.projectId);
    if (route.kind !== 'session' || route.id !== id) return;
    runtimeRegistrations = nextRuntimes;
    runtimeRegistrationsProjectId = nextSnapshot.session.projectId;
    snapshot = nextSnapshot;
    socket.updateWatermark(snapshot.watermark ?? 0);
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
    if (snapshot && route.kind === 'session' && route.id === snapshot.session.id) void loadSession(snapshot.session.id).catch((value: unknown) => { error = displayError(value); });
  }

  async function login(): Promise<void> {
    error = '';
    try {
      const result = await api.login(loginEmail, loginPassword);
      user = result.user;
      loginPassword = '';
      await loadSignedIn();
    } catch (value) { error = displayError(value); }
  }

  async function bootstrap(): Promise<void> {
    error = '';
    try {
      const result = await api.bootstrap({ email: loginEmail, displayName: bootstrapName, password: loginPassword, role: 'administrator', teamName: bootstrapTeam }, bootstrapToken.trim() || undefined);
      user = result.user;
      loginPassword = '';
      await loadSignedIn();
    } catch (value) { error = displayError(value); }
    finally { bootstrapToken = ''; }
  }

  async function logout(): Promise<void> {
    try { await api.logout(); } catch { /* local state still needs clearing */ }
    clearSession();
    runtimeRegistrations = [];
    runtimeRegistrationsProjectId = undefined;
    user = null;
    projects = [];
    sessions = [];
    snapshots = [];
    machines = [];
    gatewaySummary = null;
    moduleCatalog = null;
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
      goto(`/sessions/${encodeURIComponent(result.id)}`);
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
      if (!leaseToken) leaseToken = (await api.acquireLease(snapshot.session.id)).token;
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

  function closeAccountSetup(): void {
    accountGrant = null;
    goto('/login', false);
    authLoading = true;
    user = null;
    void api.authMethods().then((value) => { authMethods = value; }).catch((value: unknown) => { error = displayError(value); }).finally(() => { authLoading = false; });
  }

  onMount(() => {
    const pop = (): void => {
      clearSession();
      route = parseRoute();
      coordinationProjectId = new URLSearchParams(location.search).get('project') ?? '';
      requestAnimationFrame(() => document.getElementById('main-content')?.focus());
      void loadRoute();
    };
    window.addEventListener('popstate', pop);
    void init();
    return () => { window.removeEventListener('popstate', pop); socket.close(); };
  });
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') tooltipsDismissed = true; }} />

<a class="skip-link" href="#main-content">Skip to main content</a>
{#if authLoading}
  <div class="loading-screen"><Mark size={42} /><span>Loading Dhole…</span></div>
{:else if accountGrant}
  <AccountSetup grant={accountGrant} onclose={closeAccountSetup} />
{:else if !user}
  <main class="auth-shell" id="main-content" tabindex="-1">
    <section class="auth-panel" aria-labelledby="auth-title">
      <div class="brand-lockup"><Mark size={42} /><div><span class="eyebrow">DHOLE</span><h1 id="auth-title">Sign in to Dhole</h1></div></div>
      <p class="lede">Sign in once, connect your machine, and let your agents get to work.</p>
      {#if error}<p class="alert error" role="alert">{error}</p>{/if}
      {#if message}<p class="alert success" role="status">{message}</p>{/if}
      {#if !showBootstrap && authMethods?.password}
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void login(); }}>
          <label>Email<input type="email" bind:value={loginEmail} autocomplete="username" required /></label>
          <label>Password<input type="password" bind:value={loginPassword} autocomplete="current-password" required /></label>
          <button class="primary" type="submit">Sign in</button>
        </form>
      {:else if showBootstrap && authMethods?.bootstrap}
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void bootstrap(); }}>
          <label>Administrator name<input bind:value={bootstrapName} autocomplete="name" required /></label>
          <label>Team name<input bind:value={bootstrapTeam} required /></label>
          <label>Email<input type="email" bind:value={loginEmail} autocomplete="username" required /></label>
          <label>Password <span class="muted">15+ characters</span><input type="password" bind:value={loginPassword} autocomplete="new-password" minlength="15" required /></label>
          {#if authMethods.bootstrapTokenRequired}<label>Setup token <span class="muted">from your server operator</span><input type="password" bind:value={bootstrapToken} autocomplete="off" required /></label>{/if}
          <button class="primary" type="submit">Create administrator</button>
        </form>
        <button class="link-button" type="button" onclick={() => { showBootstrap = false; error = ''; }}>Back to sign in</button>
      {/if}
      {#if authMethods?.bootstrap && !showBootstrap}<button class="link-button" type="button" onclick={() => { showBootstrap = true; error = ''; }}>Create the first administrator</button>{/if}
      {#if authMethods && !authMethods.password && !authMethods.bootstrap}<p class="muted">Sign-in is not configured. Contact your administrator.</p>{/if}
      <footer class="legal-notice"><span>© 2026 Kyle Der Zweite and contributors. No warranty.</span><span>Licensed under the <a href="/LICENSE" target="_blank" rel="noreferrer">MIT License</a>; <a href="/source" target="_blank" rel="noreferrer">view source code</a>.</span></footer>
    </section>
  </main>
{:else if user.status === 'pending' || user.status === 'disabled'}
  <main class="auth-shell" id="main-content" tabindex="-1"><section class="auth-panel"><h1>{user.status === 'pending' ? 'Waiting for approval' : 'Account disabled'}</h1><p class="lede">{user.status === 'pending' ? 'An administrator needs to approve your account before you can continue.' : 'Contact your administrator to restore access.'}</p><button class="secondary" type="button" onclick={() => void logout()}>Sign out</button></section></main>
{:else}
  <div class="app-shell">
    <aside class:tooltips-dismissed={tooltipsDismissed} class="sidebar" aria-label="Workspace navigation">
      <a class="brand" aria-label="Dhole overview" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}><Mark size={34} /><span>Dhole<small>Agent workspace</small></span></a>
      <div class="nav-group"><span class="nav-label">Workspace</span><nav aria-label="Primary navigation">
        {#each navItems as item}<a class:active={item.active} aria-current={item.active ? 'page' : undefined} aria-label={item.label} href={item.path} onpointerenter={() => { tooltipsDismissed = false; }} onfocus={() => { tooltipsDismissed = false; }} onclick={(event) => { event.preventDefault(); goto(item.path); }}><svelte:component this={item.icon} size={20} strokeWidth={1.75} /><span class="nav-text">{item.label}</span><span class="nav-tooltip" role="tooltip">{item.label}</span></a>{/each}
      </nav></div>
      <div class="sidebar-bottom"><div class="nav-group"><span class="nav-label">Access & settings</span><nav aria-label="Access navigation">{#each accessItems as item}<a class:active={item.active} aria-current={item.active ? 'page' : undefined} aria-label={item.label} href={item.path} onpointerenter={() => { tooltipsDismissed = false; }} onfocus={() => { tooltipsDismissed = false; }} onclick={(event) => { event.preventDefault(); goto(item.path); }}><svelte:component this={item.icon} size={20} strokeWidth={1.75} /><span class="nav-text">{item.label}</span><span class="nav-tooltip" role="tooltip">{item.label}</span></a>{/each}</nav></div><nav class="sidebar-foot" aria-label="Account navigation"><a class:active={route.kind === 'account'} aria-current={route.kind === 'account' ? 'page' : undefined} aria-label="My account" href="/account" onpointerenter={() => { tooltipsDismissed = false; }} onfocus={() => { tooltipsDismissed = false; }} onclick={(event) => { event.preventDefault(); goto('/account'); }}><UserRound size={20} strokeWidth={1.75} /><span class="nav-text">My account</span><span class="nav-tooltip" role="tooltip">My account</span></a></nav></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="topbar-context"><span class="context-label">Workspace</span><ChevronRight size={14} /><span>{route.kind === 'connect' || route.kind === 'account' || route.kind === 'admin' ? 'Access' : route.kind === 'gateway' ? 'Gateway' : route.kind === 'coordination' ? 'Coordination' : 'Core'}</span></div>
        <div class="topbar-project">{#if projects.length}<Select id="project-select" aria-label="Switch project" value={selectedProjectId ?? ''} options={[{ value: '', label: 'All projects' }, ...projects.map((item) => ({value: item.id, label: item.name}))]} onchange={(event) => goto(event.currentTarget.value ? `/projects/${encodeURIComponent(event.currentTarget.value)}` : '/projects')} />{/if}</div>
        <div class="topbar-actions">{#if route.kind === 'session'}<span class="connection" role="status" aria-live="polite"><span class={`connection-dot ${socketStatus}`}></span>{socketStatus === 'connected' ? 'Live' : socketStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}</span>{/if}<button class="icon-button" type="button" aria-label="Sign out" title="Sign out" onclick={() => void logout()}><LogOut size={18} /></button></div>
      </header>
      <main class="content" id="main-content" tabindex="-1" aria-busy={loading || routeLoading}>
        <div class="page-content">
        {#if routeLoading}<div class="route-loading" role="status" aria-live="polite">Loading {titleCase(route.kind)}…</div>{/if}
        {#if error}<div class="alert error" role="alert">{error}<button type="button" class="dismiss" aria-label="Dismiss" onclick={() => { error = ''; }}><X size={18} /></button></div>{/if}
        {#if message}<div class="alert success" role="status">{message}</div>{/if}

        {#if routeUnavailable}
          <section class="panel empty page-empty"><h1>This module is disabled</h1><p class="muted">The server has not enabled {routeOwner}. Choose an available tool from the navigation.</p></section>
        {:else if route.kind === 'admin' && user.role !== 'administrator'}
          <section class="panel empty page-empty"><h1>Administrator access required</h1><p class="muted">Your account does not have access to administration.</p></section>
        {:else if route.kind === 'account'}
          <Account {user} githubLink={authMethods?.githubLink === true} />
        {:else if route.kind === 'connect'}
          <Devices {user} />
        {:else if route.kind === 'modules'}
          <section class="page-heading"><div><span class="eyebrow">WORKSPACE SETTINGS</span><h1>Configuration</h1><p class="muted">The capabilities available on this server.</p></div></section>
          <section class="panel"><header class="panel-header"><div><h2>Enabled capabilities</h2><p class="muted">Core and Access are always available.</p></div><Settings2 size={20} class="muted" /></header>{#if !moduleCatalog}<div class="empty"><p>Configuration could not be loaded.</p><button class="secondary compact" onclick={() => void loadSignedIn()}>Try again</button></div>{:else}{#each moduleCatalog.modules.filter((item) => ['core', 'access', 'coordination', 'gateway', 'mcp'].includes(item.id)) as item}<div class="capacity-row"><span class={`status-dot ${enabledModules.includes(item.id) ? 'live' : 'idle'}`}></span><span><strong>{item.id === 'mcp' ? 'Dhole MCP' : titleCase(item.id)}</strong><small>{item.id === 'core' ? 'Overview, projects, sessions and runtime' : item.id === 'access' ? 'Accounts, permissions and device authorization' : item.id === 'coordination' ? 'Work claims, conflicts and agent activity' : item.id === 'gateway' ? 'Providers, models, usage and routing' : 'Agent connection to the workspace'}</small></span><span class="status-pill">{enabledModules.includes(item.id) ? 'Enabled' : 'Disabled'}</span></div>{/each}{/if}</section>
        {:else if route.kind === 'dashboard'}
          <section class="page-heading"><div><span class="eyebrow">CORE</span><h1>Overview</h1><p class="muted">Your projects, shared sessions and execution capacity.</p></div><div class="heading-actions"><button class="secondary" type="button" disabled={loading} onclick={() => void loadDashboard()}><RefreshCw size={16} class={loading ? 'spinning' : ''} /> Refresh</button><button class="primary" type="button" onclick={(event) => openCreateProject(event)}><Plus size={17} /> New project</button></div></section>
          <div class="overview-metrics" aria-label="Workspace summary"><div class="overview-metric"><span><FolderKanban size={18} /> Projects</span><strong>{projects.length}</strong><small>Available to your account</small></div><div class="overview-metric"><span><Activity size={18} /> Running sessions</span><strong>{runningSessions.length}<small class="metric-total">/ {sessions.length}</small></strong><small>Across your projects</small></div><div class="overview-metric"><span><CircleAlert size={18} /> Needs attention</span><strong class:warning-text={needsAttention > 0}>{needsAttention}</strong><small>Sessions, approvals and capacity</small></div><div class="overview-metric"><span><Cpu size={18} /> Runtime capacity</span><strong>{overviewRuntimes.filter((item) => item.available).length}<small class="metric-total">/ {overviewRuntimes.length}</small></strong><small>Available runtime registrations</small></div></div>
          <div class="page-tabs" aria-label="Core views"><button type="button" class:active={coreTab === 'activity'} aria-pressed={coreTab === 'activity'} onclick={() => { coreTab = 'activity'; }}><Activity size={16} /> Activity</button><button type="button" class:active={coreTab === 'runtime'} aria-pressed={coreTab === 'runtime'} onclick={() => { coreTab = 'runtime'; }}><Cpu size={16} /> Runtime</button></div>
          {#if coreTab === 'activity'}
          <div class="dashboard-grid">
            <section class="area running" aria-labelledby="running-title"><header class="area-header"><div><h2 id="running-title">Shared sessions</h2><p class="muted">Current work across your projects</p></div><span class="count-badge neutral">{sessions.length}</span></header>
              {#if sessions.length === 0}<div class="empty"><span class="empty-icon"><Activity size={24} /></span><p>No sessions yet</p><span class="muted">Create a project, then start a session for people and agents.</span><a class="secondary compact" href="/projects" onclick={(event) => { event.preventDefault(); goto('/projects'); }}>Open projects <ChevronRight size={15} /></a></div>{/if}
              {#each [...runningSessions, ...sessions.filter((item) => !runningSessions.includes(item))].slice(0, 8) as item}<a class="run-row" href={`/sessions/${item.id}`} onclick={(event) => { event.preventDefault(); goto(`/sessions/${item.id}`); }}><span class={`status-dot ${runningSessions.includes(item) ? 'live' : waitingSessions.includes(item) ? 'approval' : item.state === 'failed' ? 'danger' : 'idle'}`}></span><span class="run-main"><strong>{item.title}</strong><small>{projects.find((candidate) => candidate.id === item.projectId)?.name ?? 'Project'} · {titleCase(item.state)}</small></span><span class="row-date">{date(item.updatedAt)}</span><ChevronRight size={16} class="muted" /></a>{/each}
            </section>
            <section class="area attention" aria-labelledby="attention-title"><header class="area-header"><div><h2 id="attention-title">Needs attention</h2><p class="muted">Decisions and issues to review</p></div><span class:neutral={needsAttention === 0} class="count-badge">{needsAttention}</span></header>
              {#if snapshotsLimited}<p class="muted snapshot-limit-note">Approval details cover the first 30 sessions. Open a project to inspect older sessions.</p>{/if}
              {#if needsAttention === 0}<div class="empty"><span class="empty-icon success-icon"><CircleCheck size={24} /></span><p>You're all caught up</p><span class="muted">Approvals and interrupted work will appear here.</span></div>{/if}
              {#each pendingApprovals as approval}<button class="attention-row" type="button" onclick={() => { const owning = snapshots.find((item) => item.approvals?.some((candidate) => candidate.id === approval.id)); if (owning) goto(`/sessions/${owning.session.id}`); }}><span class="status-dot approval"></span><span><strong>{approval.summary}</strong><small>Approval requested</small></span><ChevronRight size={16} class="muted" /></button>{/each}
              {#each [...waitingSessions, ...failedSessions] as item}<a class="attention-row" href={`/sessions/${item.id}`} onclick={(event) => { event.preventDefault(); goto(`/sessions/${item.id}`); }}><span class={`status-dot ${item.state === 'failed' ? 'danger' : 'approval'}`}></span><span><strong>{item.title}</strong><small>{titleCase(item.state)}</small></span><ChevronRight size={16} class="muted" /></a>{/each}
              {#each attentionMachines as item}<button class="attention-row" onclick={() => { coreTab = 'runtime'; }}><span class="status-dot danger"></span><span><strong>{String(field(item, 'name') ?? 'Machine')}</strong><small>{titleCase(field(item, 'status'))} · Review runtime</small></span><ChevronRight size={16} class="muted" /></button>{/each}
              {#each gatewayCoolingRows as account}<a class="attention-row" href="/gateway" onclick={(event) => { event.preventDefault(); goto('/gateway'); }}><span class="status-dot approval"></span><span><strong>{String(account.provider ?? 'Gateway account')}</strong><small>Provider cooldown{account.cooldownUntil ? ` · until ${date(account.cooldownUntil)}` : ''}</small></span><ChevronRight size={16} class="muted" /></a>{/each}
            </section>
          </div>
          {#if projects.length === 0}<section class="panel connect-prompt"><span class="empty-icon"><FolderKanban size={24} /></span><div><h2>Make room for your first project</h2><p class="muted">Keep repositories, people and agent sessions together.</p></div><button class="secondary" onclick={(event) => openCreateProject(event)}><Plus size={16} /> Create project</button></section>{/if}
          {:else}
          <div class="detail-grid"><section class="panel"><header class="panel-header"><div><h2>Runtime registrations</h2><p class="muted">Runtimes shared with your projects</p></div><Cpu size={20} class="muted" /></header>{#if !overviewRuntimes.length}<div class="empty"><span class="empty-icon"><Cpu size={24} /></span><p>No runtimes registered</p><span class="muted">An authorized execution machine reports its available runtimes.</span><a class="secondary compact" href="/connect" onclick={(event) => { event.preventDefault(); goto('/connect'); }}>Manage devices <ChevronRight size={15} /></a></div>{:else}{#each overviewRuntimes as runtime}<div class="capacity-row"><span class={`status-dot ${runtime.available ? 'live' : 'idle'}`}></span><span><strong>{runtime.label}</strong><small>{titleCase(runtime.kind)} · {machines.find((item) => item.id === runtime.machineId)?.name ?? runtime.machineId}</small></span><span class="status-pill">{runtime.available ? 'Available' : 'Unavailable'}</span></div>{/each}{/if}</section><section class="panel"><header class="panel-header"><div><h2>Execution machines</h2><p class="muted">Connections to the central server</p></div><Monitor size={20} class="muted" /></header>{#if !machines.length}<div class="empty"><span class="empty-icon"><Monitor size={24} /></span><p>No execution machines</p><span class="muted">Authorize a device to connect a runtime. Agent MCP access can work without execution.</span></div>{:else}{#each machines as item}<div class="capacity-row"><span class={`status-dot ${field(item, 'status') === 'connected' ? 'live' : 'idle'}`}></span><span><strong>{String(field(item, 'name') ?? 'Machine')}</strong><small>{titleCase(field(item, 'status'))} · {field(item, 'availableSlots') ?? 0} slots available</small></span></div>{/each}{/if}</section></div>
          {/if}
        {:else if route.kind === 'projects'}
          <section class="page-heading"><div><span class="eyebrow">CORE</span><h1>Projects</h1><p class="muted">A shared place for repositories, sessions and agent work.</p></div><button class="primary" onclick={(event) => openCreateProject(event)}><Plus size={17} /> New project</button></section>
          <section class="panel"><div class="list-toolbar"><label class="search-field"><Search size={18} /><input aria-label="Search projects" bind:value={projectSearch} placeholder="Search projects…" /></label><span class="muted">{filteredProjects.length} {filteredProjects.length === 1 ? 'project' : 'projects'}</span></div>{#if !filteredProjects.length}<div class="empty"><span class="empty-icon"><FolderKanban size={24} /></span><p>{projectSearch ? 'No matching projects' : 'Start with a project'}</p><span class="muted">{projectSearch ? 'Try another name or description.' : 'Add a project for local work or a connected repository.'}</span>{#if !projectSearch}<button class="secondary compact" onclick={(event) => openCreateProject(event)}><Plus size={16} /> Create project</button>{/if}</div>{:else}{#each filteredProjects as item}<a class="project-row" href={`/projects/${item.id}`} onclick={(event) => { event.preventDefault(); goto(`/projects/${encodeURIComponent(item.id)}`); }}><span class="project-icon"><FolderKanban size={21} /></span><span><strong>{item.name}</strong><small>{item.description || 'No description added'}</small></span><span class="project-row-meta">{sessions.filter((session) => session.projectId === item.id).length} sessions</span><ChevronRight size={17} class="muted" /></a>{/each}{/if}</section>
        {:else if route.kind === 'coordination'}
          <section class="page-heading"><div><span class="eyebrow">COORDINATION</span><h1>Work together</h1><p class="muted">See who owns each task and where work overlaps.</p></div><div class="heading-actions"><Select aria-label="Coordination project" bind:value={coordinationProjectId} options={projects.map((item) => ({value: item.id, label: item.name}))} onchange={() => { history.replaceState({}, '', `/coordination?project=${encodeURIComponent(coordinationProjectId)}`); void loadRoute(); }} /><button class="secondary" disabled={routeLoading} onclick={() => void loadRoute()}><RefreshCw size={16} /> Refresh</button></div></section>
          {#if !projects.length}<section class="panel empty"><span class="empty-icon"><GitBranch size={24} /></span><p>Create a project to coordinate work</p><span class="muted">Agents claim work within a project through Dhole MCP.</span><button class="secondary compact" onclick={(event) => openCreateProject(event)}><Plus size={16} /> New project</button></section>{:else if coordinationState}
          <div class="overview-metrics coordination-metrics"><div class="overview-metric"><span>Active agents</span><strong>{coordinationState.sessions.filter((item) => item.active).length}</strong><small>Connected coordination sessions</small></div><div class="overview-metric"><span>Work in progress</span><strong>{coordinationState.claims.length}</strong><small>Active work claims</small></div><div class="overview-metric"><span>Open conflicts</span><strong class:warning-text={coordinationState.conflicts.some((item) => !item.resolvedAt)}>{coordinationState.conflicts.filter((item) => !item.resolvedAt).length}</strong><small>Overlapping work to review</small></div></div>
          <section class="panel"><header class="panel-header"><div><h2>Work claims</h2><p class="muted">Scope and ownership reported by your agents</p></div><GitBranch size={20} class="muted" /></header>{#if !coordinationState.claims.length}<div class="empty"><span class="empty-icon"><GitBranch size={24} /></span><p>No active claims</p><span class="muted">Connected agents publish their intent and claimed files before editing.</span><a class="secondary compact" href="/agents" onclick={(event) => { event.preventDefault(); goto('/agents'); }}>Set up agents <ChevronRight size={15} /></a></div>{:else}{#each coordinationState.claims as claim}<div class="claim-row"><span class={`status-dot ${claim.status === 'blocked' ? 'approval' : 'live'}`}></span><div><strong>{claim.scope.task || claim.scope.intent}</strong><small>{coordinationState.sessions.find((item) => item.id === claim.coordinationSessionId)?.agent ?? 'Agent'} · {claim.scope.files.length} files · {date(claim.updatedAt)}</small>{#if claim.scope.files.length}<div class="file-tags">{#each claim.scope.files.slice(0, 4) as file}<code>{file}</code>{/each}{#if claim.scope.files.length > 4}<small>+{claim.scope.files.length - 4} more</small>{/if}</div>{/if}{#if coordinationState.conflicts.some((item) => !item.resolvedAt && (item.claimId === claim.id || item.conflictingClaimId === claim.id))}<span class="claim-warning"><CircleAlert size={14} /> Overlapping claim needs review</span>{/if}</div><span class="status-pill">{titleCase(claim.status)}</span></div>{/each}{/if}</section>{/if}
        {:else if route.kind === 'agents'}
          <section class="page-heading"><div><span class="eyebrow">CORE · AGENT ACCESS</span><h1>Agents</h1><p class="muted">Connect your coding agents to Dhole MCP and Skills.</p></div><a class="secondary" href="/connect" onclick={(event) => { event.preventDefault(); goto('/connect'); }}><Monitor size={17} /> Manage devices</a></section>
          <div class="integration-grid"><section class="panel integration-card"><span class="integration-icon"><Cable size={26} /></span><div class="integration-title"><h2>Dhole MCP</h2><span class="status-pill">{moduleEnabled('mcp') ? 'Enabled' : 'Disabled'}</span></div><p class="muted">Give Codex, Claude Code and OpenCode scoped access to your projects. The local bridge handles identity and connection lifecycle.</p><ul class="integration-list"><li><CircleCheck size={16} /> Check and claim shared work</li><li><CircleCheck size={16} /> Report progress and complete tasks</li><li><CircleCheck size={16} /> Manage Gateway with approved access</li></ul><a class="secondary compact" href="/connect" onclick={(event) => { event.preventDefault(); goto('/connect'); }}>Authorize a device <ChevronRight size={15} /></a></section><section class="panel integration-card"><span class="integration-icon"><BookOpen size={26} /></span><div class="integration-title"><h2>Dhole Skills</h2><span class="status-pill">Agent instructions</span></div><p class="muted">Practical instructions for using Dhole tools during everyday development. Install them in your agent's skills directory.</p><div class="skill-entry"><GitBranch size={18} /><div><strong>dhole-coordination</strong><small>Check overlap, claim scope, report findings and finish work.</small></div></div><div class="skill-entry"><Network size={18} /><div><strong>dhole-gateway</strong><small>Inspect providers, models and usage through approved tools.</small></div></div><p class="form-hint muted">Included with the Dhole agent client.</p></section></div>
          <section class="panel setup-guide"><header class="panel-header"><div><h2>Connect an agent</h2><p class="muted">One device approval. Project access follows your account.</p></div></header><ol class="setup-steps"><li><span class="step-number">1</span><div><h3>Authorize your device</h3><p>Run the client connect command, then review its code and permissions in Devices.</p></div></li><li><span class="step-number">2</span><div><h3>Add Dhole MCP to your client</h3><p>Use the client installer with your project's ID and your agent's configuration file.</p></div></li><li><span class="step-number">3</span><div><h3>Install the skills</h3><p>Use install-skills with your agent's skills directory, then restart the agent to load its tools.</p></div></li></ol></section>
        {:else if route.kind === 'project'}
          <section class="page-heading"><div><a class="back-link" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}>← Overview</a><h1>{project?.name ?? selectedProject?.name ?? 'Project'}</h1><p class="muted">{project?.description || 'Project detail and shared activity.'}</p></div><button class="primary compact" type="button" onclick={(event) => openCreateSession(event)}><Plus size={16} /> New session</button></section>
          <div class="detail-grid"><section class="panel wide"><header class="panel-header"><div><span class="eyebrow">PROJECT ACTIVITY</span><h2>Sessions</h2></div><span class="count-badge neutral">{sessions.length}</span></header>{#if sessions.length === 0}<div class="empty"><p>No sessions yet.</p><span class="muted">A session becomes the shared room for people and agents.</span></div>{:else}<div class="table-list">{#each sessions as item}<button class="table-row" type="button" onclick={() => goto(`/sessions/${item.id}`)}><span class={`status-dot ${item.state === 'busy' || item.state === 'running' ? 'live' : item.state === 'failed' ? 'danger' : 'idle'}`}></span><span><strong>{item.title}</strong><small>{titleCase(item.state)} · {date(item.updatedAt)}</small></span><span class="muted">{item.modelId ?? '—'}</span><span>→</span></button>{/each}</div>{/if}</section><section class="panel"><header class="panel-header"><div><span class="eyebrow">SOURCE</span><h2>Repositories</h2></div></header>{#if repositories.length === 0}<p class="muted">No repository is linked.</p>{:else}<div class="table-list">{#each repositories as repo}<div class="table-row static"><GitBranch size={18} class="muted" /><span><strong>{repo.label}</strong><small>{repo.canonicalRemote ?? repo.localPathHint ?? 'Remote not set'}</small></span><span class="muted">{repo.defaultBranch ?? '—'}</span></div>{/each}</div>{/if}<form class="stack inset" onsubmit={(event) => { event.preventDefault(); void createRepository(); }}><label>Link repository<input bind:value={repoLabel} placeholder="frontend" required /></label><label>Remote URL <span class="muted">optional</span><input type="url" bind:value={repoRemote} placeholder="https://…" /></label><label>Local path hint <span class="muted">optional</span><input bind:value={repoPath} placeholder="workspace/repo" /></label><label>Default branch<input bind:value={repoBranch} /></label><button class="secondary" type="submit">Link repository</button></form></section></div>
        {:else if route.kind === 'session'}
          {#if snapshot}<section class="page-heading"><div><a class="back-link" href={`/projects/${snapshot.session.projectId}`} onclick={(event) => { event.preventDefault(); goto(`/projects/${snapshot?.session.projectId}`); }}>← {projects.find((item) => item.id === snapshot?.session.projectId)?.name ?? 'Project'}</a><h1>{snapshot.session.title}</h1><p class="muted">{titleCase(snapshot.session.state)} · <span class={`socket-label ${socketStatus}`} role="status" aria-live="polite">{socketStatus === 'connected' ? 'Live updates connected' : socketStatus === 'reconnecting' ? 'Reconnecting live updates' : 'Live updates offline'}</span></p></div><div class="heading-actions"><button class="secondary compact" type="button" onclick={() => void cancelSession()} disabled={!['busy', 'running', 'needs_input', 'needs_approval', 'waiting_for_user', 'waiting_for_approval', 'blocked'].includes(snapshot.session.state)}>Cancel</button></div></section><div class="session-layout"><section class="panel conversation"><header class="panel-header"><div><span class="eyebrow">SHARED SESSION</span><h2>Conversation</h2></div><span class="muted">{snapshot.messages.length} messages</span></header><div class="messages" aria-live="polite">{#if snapshot.messages.length === 0}<div class="empty"><p>No messages yet.</p><span class="muted">Queue a message to begin.</span></div>{/if}{#each snapshot.messages as item (item.id)}<article class={`message ${item.role}`}><div class="message-meta"><span class="message-role">{messageAttribution(item, snapshot.participants, user)}</span><span>{date(item.createdAt)}</span><span class="muted">{item.status ?? ''}</span></div><p>{item.body}</p></article>{/each}</div><form class="composer" onsubmit={(event) => { event.preventDefault(); void queueMessage(); }}><label class="sr-only" for="composer">Message the session</label><textarea id="composer" bind:value={composer} rows="3" placeholder="Write to everyone in this session…"></textarea><div class="composer-actions"><span class="muted">Plain text is shared with participants.</span><button class="primary compact" type="submit" disabled={!composer.trim()}>Queue message</button></div></form>{#if activeTurnSteeringSupported}<form class="steer-form" onsubmit={(event) => { event.preventDefault(); void steer(); }}><label for="steer">Steer active turn <span class="muted">requires the control lease</span></label><div class="inline-form"><input id="steer" bind:value={steerText} placeholder="A bounded direction for the active turn" disabled={!snapshot.session.activeTurnId} /><button class="secondary compact" type="submit" disabled={!steerText.trim() || !snapshot.session.activeTurnId}>Steer</button></div></form>{:else}<p class="muted steering-unavailable" role="status">Steering unavailable: this runtime does not advertise active-turn steering.</p>{/if}</section><aside class="session-rail"><section class="panel participants-panel"><header class="panel-header"><h2>Participants</h2><span class="count-badge neutral">{snapshot.participants?.length ?? 0}</span></header>{#if snapshot.participants?.length}<ul class="participant-list">{#each snapshot.participants as participant}<li><span>{participantLabel(participant.userId, snapshot.participants, user)}</span><small>Joined {date(participant.joinedAt)}</small></li>{/each}</ul>{:else}<p class="muted">No active participants recorded.</p>{/if}</section><section class="panel"><header class="panel-header"><h2>Approvals</h2><span class="count-badge">{pendingSessionApprovals.length}</span></header>{#if pendingSessionApprovals.length === 0}<p class="muted">No pending approval requests.</p>{:else}{#each pendingSessionApprovals as approval}<div class="approval"><strong>{approval.summary}</strong><small>{titleCase(approval.kind)}{approval.expiresAt ? ` · expires ${date(approval.expiresAt)}` : ''}</small>{#if approvalResponsesSupported}<div class="approval-actions"><button class="primary compact" type="button" onclick={() => void answerApproval(approval, 'approve_once')}>Approve</button><button class="secondary compact" type="button" onclick={() => void answerApproval(approval, 'deny')}>Deny</button></div>{:else}<p class="muted approval-readonly" role="status">Read-only: this runtime does not advertise approval responses.</p>{/if}</div>{/each}{/if}</section><section class="panel"><header class="panel-header"><h2>Lineage</h2><span class="muted">{snapshot.tree?.length ?? 0} roots</span></header><div class="legend"><span><i class="legend-dot full"></i>Full control</span><span><i class="legend-dot observed"></i>Observed</span><span><i class="legend-dot heuristic"></i>Heuristic</span></div><div class="tree"><Tree nodes={snapshot.tree ?? []} /></div></section><section class="panel mini-stats"><div><span>Runtime</span><strong>{snapshot.session.runtimeRegistrationId ?? '—'}</strong></div><div><span>Model</span><strong>{snapshot.session.modelId ?? '—'}</strong></div><div><span>Workspace</span><strong>{snapshot.session.workspaceId ?? '—'}</strong></div></section></aside></div>{:else}<div class="empty page-empty"><p>Loading session…</p></div>{/if}
        {:else if route.kind === 'agent'}
          <section class="page-heading"><div><a class="back-link" href="/" onclick={(event) => { event.preventDefault(); goto('/'); }}>← Overview</a><h1>{agentNode?.name ?? 'Agent detail'}</h1><p class="muted">Activation history and control boundary.</p></div></section><section class="panel agent-detail">{#if agentNode}<div class="agent-hero"><span class={`tree-dot ${agentNode.control === 'observe_only' ? 'observed' : agentNode.control === 'uncertain' ? 'heuristic' : 'full'}`}></span><div><h2>{agentNode.name}</h2><p class="muted">{titleCase(agentNode.state)} · {agentNode.evidence ?? 'platform'} evidence · {agentNode.control ?? 'full'} control</p></div></div><dl class="facts"><div><dt>Runtime</dt><dd>{agentNode.runtimeId ?? '—'}</dd></div><div><dt>Machine</dt><dd>{agentNode.machineId ?? '—'}</dd></div><div><dt>Activation</dt><dd>{agentNode.activationId ?? '—'}</dd></div><div><dt>Started</dt><dd>{date(agentNode.startedAt)}</dd></div></dl><p class="muted">Open the owning session to inspect messages, approvals, tools, and progress.</p>{#each snapshots.filter((item) => findNode(agentNode?.id, [item])) as owning}<a class="secondary button-link" href={`/sessions/${owning.session.id}`} onclick={(event) => { event.preventDefault(); goto(`/sessions/${owning.session.id}`); }}>Open session</a>{/each}{:else}<div class="empty"><p>Agent not found in the current snapshots.</p><span class="muted">Agents are progressively disclosed from a session lineage.</span></div>{/if}</section>
        {:else if route.kind === 'gateway'}
          <Gateway {user} />
        {:else if route.kind === 'admin'}
          <Admin {user} />
        {/if}
        </div>
        <footer class="legal-notice app-legal"><span>© 2026 Kyle Der Zweite and contributors. No warranty.</span><span><a href="/LICENSE" target="_blank" rel="noreferrer">MIT License</a> · <a href="/source" target="_blank" rel="noreferrer">source code</a></span></footer>
      </main>
    </div>
  </div>
{/if}

{#if createProjectOpen}
  <dialog bind:this={createProjectDialog} class="modal" aria-modal="true" aria-labelledby="create-project-title" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeCreateProject(); } }} oncancel={(event) => { event.preventDefault(); closeCreateProject(); }} onclose={handleCreateProjectClose}><header class="modal-header"><h2 id="create-project-title">New project</h2><button class="icon-button" type="button" aria-label="Close" onclick={closeCreateProject}><X size={18} /></button></header><form class="stack" onsubmit={(event) => { event.preventDefault(); void createProject(); }}><label>Name<input bind:this={createProjectFirstInput} bind:value={projectName} required /></label><label>Description <span class="muted">optional</span><textarea bind:value={projectDescription} rows="3"></textarea></label><button class="primary" type="submit">Create project</button></form></dialog>
{/if}
{#if createSessionOpen}
  <dialog bind:this={createSessionDialog} class="modal" aria-modal="true" aria-labelledby="create-session-title" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeCreateSession(); } }} oncancel={(event) => { event.preventDefault(); closeCreateSession(); }} onclose={handleCreateSessionClose}><header class="modal-header"><h2 id="create-session-title">New shared session</h2><button class="icon-button" type="button" aria-label="Close" onclick={closeCreateSession}><X size={18} /></button></header><form class="stack" onsubmit={(event) => { event.preventDefault(); void createSession(); }}><label>Title<input bind:this={createSessionFirstInput} bind:value={sessionTitle} required placeholder="Investigate the failing build" /></label><label>Runtime <span class="muted">optional</span><Select bind:value={sessionRuntimeRegistrationId} options={[{value: '', label: 'Collaboration only'}, ...runtimeRegistrations.map((runtime) => ({value: runtime.id, label: `${runtime.label} · ${runtime.kind}`}))]} /></label><p class="muted form-hint">Choose a runtime to send the first message to an allowlisted project repository. Workspace selection is automatic.</p><button class="primary" type="submit">Create session</button></form></dialog>
{/if}
