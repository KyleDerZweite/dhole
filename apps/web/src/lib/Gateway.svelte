<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, ArrowRight, Boxes, CheckCheck, ChevronLeft, ChevronRight, CircleAlert, Clock3, Download, Gauge, KeyRound, Link2, Plus, RefreshCw, Search, Settings2, ShieldCheck, Users } from '@lucide/svelte';
  import Select from './Select.svelte';
  import { summarizeUsage } from './gateway-view';
  import type { User } from './types';
  import { gatewayApi } from './gateway-api';
  import type { Account, Catalog, CatalogToken, Collection, ConfigChange, ConfigPreview, Connection, ConnectionUpdate, GatewayConfig, ManagementHistory, OAuthFlow, RequestFilters, RequestPage, Revision, Usage } from './gateway-types';

  export let user: User | null = null;
  let connections: Connection[] = [];
  let selectedId = '';
  let connection: Connection | undefined;
  let catalog: Catalog | null = null;
  let accounts: Account[] | null = null;
  let collection: Collection | null = null;
  let requests: RequestPage | null = null;
  let usage: Usage | null = null;
  let revisions: Revision[] | null = null;
  let tokens: CatalogToken[] | null = null;
  let issuedToken: { token: string; endpoint: string; expiresAt: string } | null = null;
  let errors: Record<string, string> = {};
  let loading = true;
  let busy = false;
  let message = '';
  let generation = 0;
  let provider = '';
  let model = '';
  let authIndex = '';
  let failed = '';
  let confidence = '';
  let occurredFrom = '';
  let occurredTo = '';
  let bucket: 'hour' | 'day' = 'day';
  let groupBy: 'none' | 'provider' | 'model' | 'authIndex' = 'none';
  let exportCursor: string | undefined;
  let clientVersion = '';
  let modelSearch = '';
  let modelLimit = 10;
  let deletionConfirmed = false;
  let pruneConfirmed = false;
  let config: GatewayConfig | null = null;
  let configPreview: ConfigPreview | null = null;
  let configChange: ConfigChange | null = null;
  let configSetting: ConfigChange['setting'] = 'request-retry';
  let managementHistory: ManagementHistory | null = null;
  let accountChange: { accountId: string; label: string; expectedDisabled: boolean; disabled: boolean } | null = null;
  let oauthFlow: OAuthFlow | null = null;
  let authorizationUrl = '';
  let oauthTimer: ReturnType<typeof setTimeout> | undefined;
  let oauthVersion = 0;
  type Section = 'overview' | 'models' | 'accounts' | 'activity' | 'connections' | 'settings';
  let section: Section = 'overview';
  let showCreateConnection = false;
  let accountSearch = '';
  let appliedHistoryFilters = false;
  let appliedHistoryRange = 'All retained history';
  let modelPolicy = '';
  const sections = [
    { id: 'overview', label: 'Overview', icon: Gauge },
    { id: 'models', label: 'Models & clients', icon: Boxes },
    { id: 'accounts', label: 'Accounts', icon: Users },
    { id: 'activity', label: 'Requests & usage', icon: Activity },
    { id: 'connections', label: 'Connections', icon: Link2 },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ] as const;
  let connectionEdit: { input: ConnectionUpdate; changes: Array<{ field: string; before: string; after: string }> } | null = null;

  $: isAdmin = user?.role === 'administrator';
  $: connection = connections.find((item) => item.id === selectedId);
  $: active = Boolean(connection?.enabled && !connection.deletedAt && !connection.archivedAt);
  $: matchingModels = catalog?.models.filter((item) => `${item.modelKey} ${item.displayName}`.toLowerCase().includes(modelSearch.toLowerCase()) && (!modelPolicy || (modelPolicy === 'enabled' ? item.enabled : modelPolicy === 'disabled' ? !item.enabled : !item.available))) ?? [];
  $: matchingAccounts = accounts?.filter((item) => `${item.label ?? ''} ${item.authIndex} ${item.provider}`.toLowerCase().includes(accountSearch.toLowerCase())) ?? [];
  $: navigation = sections.filter((item) => item.id !== 'settings' || isAdmin);
  $: summary = summarizeUsage(usage);
  $: enabledModels = catalog?.models.filter((item) => item.enabled && item.available).length;
  $: healthyConnections = connections.filter((item) => item.enabled && !item.archivedAt && !item.deletedAt && item.status === 'healthy').length;
  $: if (!isAdmin && section === 'settings') section = 'overview';
  $: visibleModels = matchingModels.slice(0, modelLimit);

  onMount(() => { void load(); return () => { generation++; issuedToken = null; clearTimeout(oauthTimer); authorizationUrl = ''; oauthFlow = null; }; });

  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Gateway request failed.';
  const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not observed';
  const count = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString();
  const cost = (value: number | null | undefined) => value == null ? 'Unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value / 1_000_000);
  const fields = (form: HTMLFormElement) => new FormData(form);
  const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();

  function navigateTabs(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...(event.currentTarget as HTMLElement).parentElement!.querySelectorAll<HTMLButtonElement>('[role=tab]:not(:disabled)')];
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index]?.focus(); tabs[index]?.click();
  }

  function filters(): RequestFilters {
    return { connectionId: selectedId, provider, model, authIndex, failed, correlationConfidence: confidence,
      ...(occurredFrom ? { occurredFrom: new Date(occurredFrom).toISOString() } : {}),
      ...(occurredTo ? { occurredTo: new Date(occurredTo).toISOString() } : {}) };
  }

  async function read<T>(name: string, work: () => Promise<T>, assign: (value: T) => void, version: number): Promise<void> {
    try { const value = await work(); if (version === generation) assign(value); }
    catch (error) { if (version === generation) errors = { ...errors, [name]: errorMessage(error) }; }
  }

  async function load(): Promise<void> {
    loading = true;
    errors = {};
    try {
      connections = await gatewayApi.connections();
      if (!connections.some((item) => item.id === selectedId)) selectedId = connections.find((item) => !item.deletedAt && !item.archivedAt)?.id ?? connections[0]?.id ?? '';
      await loadDetail();
    } catch (error) { errors = { ...errors, connections: errorMessage(error) }; }
    finally { loading = false; }
  }

  async function loadDetail(): Promise<void> {
    const version = ++generation;
    const id = selectedId;
    captureHistoryScope();
    catalog = null; accounts = null; collection = null; requests = null; usage = null; revisions = null; tokens = null;
    issuedToken = null; exportCursor = undefined; deletionConfirmed = false; pruneConfirmed = false; errors = {}; loading = true;
    config = null; configPreview = null; configChange = null; accountChange = null; managementHistory = null;
    clearTimeout(oauthTimer); oauthFlow = null; authorizationUrl = ''; oauthVersion++; connectionEdit = null; modelLimit = 10;
    if (!id) { loading = false; return; }
    await Promise.all([
      read('catalog', () => gatewayApi.catalog(id), (value) => { catalog = value; }, version),
      read('accounts', () => gatewayApi.accounts(id), (value) => { accounts = value; }, version),
      read('collection', () => gatewayApi.collection(id), (value) => { collection = value; }, version),
      read('requests', () => gatewayApi.requests(filters()), (value) => { requests = value; }, version),
      read('usage', () => gatewayApi.usage(filters(), bucket, groupBy), (value) => { usage = value; }, version),
    ]);
    if (version === generation) loading = false;
  }

  async function act(work: () => Promise<unknown>, success: string, refresh = true): Promise<void> {
    busy = true; message = ''; errors = { ...errors, action: '' };
    try { await work(); if (refresh) await load(); if (success) message = success; }
    catch (error) { errors = { ...errors, action: errorMessage(error) }; }
    finally { busy = false; }
  }

  function clearPasswords(form: HTMLFormElement): void {
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = '';
  }

  async function createConnection(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = fields(form);
    clearPasswords(form);
    await act(async () => {
      const created = await gatewayApi.create({ name: field(data, 'name'), baseUrl: field(data, 'baseUrl'), managementSecret: String(data.get('managementSecret') ?? ''),
        ...(data.get('catalogSecret') ? { catalogSecret: String(data.get('catalogSecret')) } : {}), enabled: data.has('enabled'), retentionDays: Number(data.get('retentionDays')) });
      data.delete('managementSecret'); data.delete('catalogSecret'); selectedId = created.id; form.reset(); section = 'models'; showCreateConnection = false;
    }, 'Connection created. Refresh its catalog to discover models.');
    data.delete('managementSecret'); data.delete('catalogSecret');
  }

  async function rotateSecrets(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!connection) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = fields(form);
    clearPasswords(form);
    await act(() => gatewayApi.rotate(connection!.id, { expectedRevision: connection!.revision,
      ...(data.get('managementSecret') ? { managementSecret: String(data.get('managementSecret')) } : {}),
      ...(data.get('catalogSecret') ? { catalogSecret: String(data.get('catalogSecret')) } : {}) }), 'Supplied credentials rotated. Previous values cannot be restored.');
    data.delete('managementSecret'); data.delete('catalogSecret');
  }

  function editConnection(event: SubmitEvent): void {
    event.preventDefault(); if (!connection) return;
    const data = fields(event.currentTarget as HTMLFormElement);
    const next = { name: field(data, 'name'), baseUrl: field(data, 'baseUrl'), enabled: data.has('enabled'), retentionDays: Number(data.get('retentionDays')) };
    connectionEdit = { input: { expectedRevision: connection.revision, ...next }, changes: (Object.keys(next) as Array<keyof typeof next>)
      .filter((key) => next[key] !== connection![key]).map((key) => ({ field: key, before: String(connection![key]), after: String(next[key]) })) };
  }

  function captureHistoryScope(): void {
    appliedHistoryFilters = Boolean(provider || model || authIndex || failed || confidence || occurredFrom || occurredTo);
    appliedHistoryRange = occurredFrom || occurredTo ? `${occurredFrom ? date(occurredFrom) : 'Oldest retained'} to ${occurredTo ? date(occurredTo) : 'latest retained'}` : 'All retained history';
  }

  function resetHistory(): void {
    provider = ''; model = ''; authIndex = ''; failed = ''; confidence = ''; occurredFrom = ''; occurredTo = '';
    void refreshHistory();
  }

  async function refreshHistory(offset = 0): Promise<void> {
    captureHistoryScope();
    const version = generation;
    errors = { ...errors, requests: '', usage: '' }; requests = null; usage = null; exportCursor = undefined;
    await Promise.all([
      read('requests', () => gatewayApi.requests(filters(), offset), (value) => { requests = value; }, version),
      read('usage', () => gatewayApi.usage(filters(), bucket, groupBy), (value) => { usage = value; }, version),
    ]);
  }

  async function download(): Promise<void> {
    await act(async () => {
      const result = await gatewayApi.export(filters(), exportCursor);
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.items, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `gateway-requests-${selectedId}.json`; link.click(); URL.revokeObjectURL(url);
      exportCursor = result.nextCursor ?? undefined;
      message = `Exported ${result.items.length} sanitized records.${result.nextCursor ? ' More records are available in the next page.' : ' Export complete.'}`;
    }, '', false);
  }

  async function issueToken(event: SubmitEvent): Promise<void> {
    event.preventDefault(); issuedToken = null;
    const data = fields(event.currentTarget as HTMLFormElement);
    await act(async () => {
      issuedToken = await gatewayApi.issueToken(selectedId, { name: field(data, 'name'), client: field(data, 'client') as 'generic' | 'opencode' | 'codex', expiresInDays: Number(data.get('expiresInDays')) });
      tokens = (await gatewayApi.tokens(selectedId)).tokens;
    }, 'Catalog credential issued. Copy it now, then dismiss it.', false);
  }

  async function loadRevisions(): Promise<void> {
    await read('revisions', () => gatewayApi.revisions(selectedId), (value) => { revisions = value; }, generation);
  }

  async function previewConfig(event: SubmitEvent): Promise<void> {
    event.preventDefault(); if (!connection || !config) return;
    const data = fields(event.currentTarget as HTMLFormElement);
    const input: ConfigChange = { expectedRevision: connection.revision, expectedConfigRevision: config.revision, setting: configSetting, value: configSetting === 'routing/strategy' ? field(data, 'value') : Number(data.get('value')) };
    configChange = null; configPreview = null;
    await act(async () => { configPreview = await gatewayApi.previewConfig(selectedId, input); configChange = input; }, '', false);
  }

  async function pollOAuth(): Promise<void> {
    if (!oauthFlow || !['pending', 'submitted'].includes(oauthFlow.status)) return;
    const version = generation;
    const attempt = oauthVersion;
    const flowId = oauthFlow.id;
    try {
      const value = await gatewayApi.oauth(selectedId, flowId);
      if (version !== generation || attempt !== oauthVersion || flowId !== oauthFlow?.id) return;
      oauthFlow = value;
      if (['pending', 'submitted'].includes(value.status)) oauthTimer = setTimeout(() => { void pollOAuth(); }, 2000);
      else authorizationUrl = '';
    } catch (error) { if (version === generation && attempt === oauthVersion) errors = { ...errors, oauth: errorMessage(error) }; }
  }

  async function startOAuth(event: SubmitEvent): Promise<void> {
    event.preventDefault(); if (!connection) return;
    const version = generation;
    const data = fields(event.currentTarget as HTMLFormElement);
    await act(async () => {
      oauthVersion++;
      const result = await gatewayApi.startOAuth(selectedId, connection!.revision, field(data, 'provider') as OAuthFlow['provider']);
      if (version !== generation) return;
      oauthFlow = result; authorizationUrl = result.authorizationUrl; errors = { ...errors, oauth: '' };
      clearTimeout(oauthTimer); oauthTimer = setTimeout(() => { void pollOAuth(); }, 2000);
    }, 'Consent flow started. Open the provider page to continue.', false);
  }

  async function submitOAuth(event: SubmitEvent): Promise<void> {
    event.preventDefault(); if (!oauthFlow) return;
    const version = generation;
    const form = event.currentTarget as HTMLFormElement;
    const data = fields(form); clearPasswords(form);
    clearTimeout(oauthTimer); oauthVersion++;
    await act(async () => { oauthFlow = await gatewayApi.oauthCallback(selectedId, oauthFlow!.id, String(data.get('redirectUrl') ?? '')); data.delete('redirectUrl'); }, 'Callback submitted to CLIProxyAPI.', false);
    data.delete('redirectUrl');
    if (version === generation) oauthTimer = setTimeout(() => { void pollOAuth(); }, 2000);
  }
</script>

<section class="gateway" aria-label="Gateway management">
  <header class="page-heading">
    <div><p class="eyebrow">GATEWAY</p><h1>Proxy control</h1><p class="muted">Manage connections, model access and observed usage.</p></div>
    <div class="heading-actions"><button class="secondary compact" onclick={load} disabled={loading || busy}><RefreshCw size={15} /> Refresh saved data</button>{#if isAdmin}<button class="primary compact" onclick={() => { section = 'connections'; showCreateConnection = true; }}><Plus size={16} /> Add connection</button>{/if}</div>
  </header>
  {#if message}<p class="notice" role="status"><CheckCheck size={17} /> {message}</p>{/if}
  {#if errors.action}<p class="error" role="alert">{errors.action}</p>{/if}
  {#if errors.connections}<p class="error" role="alert">Connections unavailable. {errors.connections}</p>{/if}
  {#if loading}<p class="loading-note" role="status"><RefreshCw size={14} /> Loading gateway data…</p>{/if}
  {#if !isAdmin}<p class="hint">You can inspect gateway data. An administrator manages connections, model policy and credentials.</p>{/if}
  <div class="gateway-toolbar">
    {#if connections.length}<label class="connection-select">Selected connection<Select bind:value={selectedId} onchange={loadDetail} disabled={busy || loading} options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.deletedAt ? 'removed' : item.archivedAt ? 'archived' : item.status}` }))} /></label>{/if}
    {#if connection}<div class="connection-context"><span class="status" class:warning={!active || connection.status !== 'healthy'}><span class="health-dot"></span>{connection.deletedAt ? 'Removed' : connection.archivedAt ? 'Archived' : connection.enabled ? connection.status : 'Disabled'}</span><span class="mono muted">{connection.baseUrl}</span></div>{/if}
  </div>
  <div class="gateway-tabs" role="tablist" aria-label="Gateway sections">
    {#each navigation as item}<button id={`gateway-tab-${item.id}`} role="tab" onkeydown={navigateTabs} aria-selected={section === item.id} aria-controls={`gateway-panel-${item.id}`} tabindex={section === item.id ? 0 : -1} disabled={!connection && item.id !== 'overview' && item.id !== 'connections'} class:active-tab={section === item.id} onclick={() => { section = item.id; }}><item.icon size={17} /><span>{item.label}</span></button>{/each}
  </div>

  <div class="tab-content" id="gateway-panel-overview" role="tabpanel" aria-labelledby="gateway-tab-overview" hidden={section !== 'overview'} tabindex="0">
    {#if connection}
      <div class="section-heading"><div><h2>Connection overview</h2><p class="hint">{connection.name} · Saved observations. Last management check {date(connection.lastCheckedAt)}.</p></div><span class="scope-label"><Clock3 size={14} /> {connection.retentionDays} day retention</span></div>
      <div class="gateway-metrics">
        <article class="gateway-metric"><span><Boxes size={16} /> Models ready</span><strong>{count(enabledModels)}</strong><small>{catalog ? `${catalog.models.length} catalog models · ${catalog.status}` : errors.catalog ? 'Catalog unavailable' : 'Waiting for catalog'}</small></article>
        <article class="gateway-metric"><span><Users size={16} /> Accounts observed</span><strong>{count(accounts?.length)}</strong><small>{accounts ? `${accounts.filter((item) => item.disabled).length} disabled · quota may be unknown` : errors.accounts ? 'Accounts unavailable' : 'Waiting for account metadata'}</small></article>
        <article class="gateway-metric"><span><Activity size={16} /> Retained requests</span><strong>{count(collection?.retainedRequests)}</strong><small>{collection ? 'Pushed or imported history' : errors.collection ? 'Collection state unavailable' : 'Waiting for collection state'}</small></article>
        <article class="gateway-metric"><span><Link2 size={16} /> Healthy connections</span><strong>{healthyConnections}<small> / {connections.length}</small></strong><small>All connections · last observed state</small></article>
      </div>
      <div class="overview-grid">
        <article class="panel activity-overview">
          <div class="section-heading"><div><h2>Request activity</h2><p class="hint">{appliedHistoryRange}{appliedHistoryFilters ? ' · Filtered' : ''} · {usage?.bucket === 'hour' ? 'Hourly' : 'Daily'} buckets</p></div><button class="text-action" onclick={() => { section = 'activity'; }}>View requests <ArrowRight size={15} /></button></div>
          {#if errors.usage}<p class="error">Usage unavailable. {errors.usage}</p>{:else if summary && summary.requests}
            <div class="activity-totals"><strong>{count(summary.requests)} <span>stored requests</span></strong><span class:warning={summary.failures > 0}>{count(summary.failures)} failed · {((summary.requests - summary.failures) / summary.requests * 100).toFixed(1)}% succeeded</span></div>
            {#if usage?.truncated}<p class="notice">Usage is partial. Narrow the time range in Requests & usage.</p>{/if}
            <figure class="activity-chart" aria-label="Stored request volume over time"><div class="chart-bars">{#each summary.bars as bar}<div class="chart-column" title={`${date(bar.bucketStart)}: ${bar.requests} requests, ${bar.failures} failures`}><span class="chart-value">{count(bar.requests)}</span><div class="chart-track"><div class="chart-bar" style:height={`${bar.requests / summary.maxRequests * 100}%`}><span class="chart-failures" style:height={`${bar.requests ? bar.failures / bar.requests * 100 : 0}%`}></span></div></div><span class="chart-label">{new Date(bar.bucketStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{#if usage?.bucket === 'hour'}<br />{new Date(bar.bucketStart).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}{/if}</span></div>{/each}</div><figcaption><span><i class="legend-requests"></i> Requests <i class="legend-failures"></i> Failures</span><span>Latest {summary.bars.length} observed periods</span></figcaption></figure>
          {:else if summary}<div class="gateway-empty"><Activity size={30} /><h3>No stored requests yet</h3><p>Request history appears when records are pushed or imported. The proxy may still be serving traffic.</p><button class="secondary compact" onclick={() => { section = 'activity'; }}>Inspect collection state <ArrowRight size={15} /></button></div>{:else}<p class="empty">Loading request activity…</p>{/if}
        </article>
        <article class="panel readiness"><div class="section-heading"><div><h2>Connection readiness</h2><p class="hint">Check each step before connecting clients.</p></div><ShieldCheck size={19} /></div>
          <div class="readiness-row"><Link2 size={18} /><div><strong>Management connection</strong><p>{active ? connection.status : 'Connection inactive'}</p></div><span class="status" class:warning={!active || connection.status !== 'healthy'}>{active && connection.status === 'healthy' ? 'Ready' : 'Review'}</span></div>
          <button class="readiness-row" onclick={() => { section = 'models'; }}><Boxes size={18} /><div><strong>Model catalog</strong><p>{catalog ? catalog.stale ? 'Snapshot is stale' : `${count(enabledModels)} enabled and available` : 'No catalog data available'}</p></div><ArrowRight size={16} /></button>
          <button class="readiness-row" onclick={() => { section = 'accounts'; }}><Users size={18} /><div><strong>Provider accounts</strong><p>{accounts ? `${accounts.length} observed · inspect quota and cooldowns` : 'No account data available'}</p></div><ArrowRight size={16} /></button>
          <button class="readiness-row" onclick={() => { section = 'models'; }}><KeyRound size={18} /><div><strong>Connect a client</strong><p>Catalog credentials and client guidance</p></div><ArrowRight size={16} /></button>
          {#if isAdmin && active}<div class="actions"><button class="secondary compact" disabled={busy} onclick={() => act(async () => { const result = await gatewayApi.health(selectedId); if (!result.ok) throw new Error(`Management health check returned HTTP ${result.status}.`); }, 'Management endpoint responded successfully.')}><ShieldCheck size={15} /> Check management health</button></div>{/if}
        </article>
      </div>
      {#if collection}<p class="observation-note"><CircleAlert size={16} /><span>{collection.message} Last stored {date(collection.lastStoredAt)}. Refreshing saved data does not collect live traffic.</span></p>{/if}
    {:else if !loading && !errors.connections}<div class="panel gateway-empty"><Link2 size={34} /><h2>Connect your first proxy</h2><p>Add an existing CLIProxyAPI connection to manage its catalog, accounts and request history.</p>{#if isAdmin}<button class="primary compact" onclick={() => { section = 'connections'; showCreateConnection = true; }}><Plus size={16} /> Add connection</button>{:else}<p>An administrator can add a connection.</p>{/if}</div>{/if}
  </div>

  <div class="panel" id="gateway-panel-connections" role="tabpanel" aria-labelledby="gateway-tab-connections" hidden={section !== 'connections'} tabindex="0">
    <div class="section-heading"><div><h2>Connections</h2><p class="hint">Manage existing CLIProxyAPI instances from the central server.</p></div><span class="scope-label">{count(connections.length)} configured</span></div>
    {#if connections.length}<div class="table-scroll"><table><thead><tr><th>Name / endpoint</th><th>Status</th><th>Last checked</th><th>Action</th></tr></thead><tbody>{#each connections as item}<tr><td><strong>{item.name}</strong><br /><span class="mono hint">{item.baseUrl}</span></td><td><span class="status" class:warning={!item.enabled || item.status !== 'healthy'}>{item.deletedAt ? 'Removed' : item.archivedAt ? 'Archived' : item.enabled ? item.status : 'Disabled'}</span></td><td>{date(item.lastCheckedAt)}</td><td><button class="secondary compact" disabled={busy || loading} onclick={() => { selectedId = item.id; section = 'overview'; void loadDetail(); }}>Open <ArrowRight size={15} /></button></td></tr>{/each}</tbody></table></div>{:else if !loading && !errors.connections}<p class="empty">No gateway connections configured.</p>{/if}
    {#if isAdmin}
    <details class="inset create-connection" bind:open={showCreateConnection}><summary><Plus size={16} /> Add connection</summary>
      <form class="form-grid" onsubmit={createConnection} autocomplete="off">
        <label>Name<input name="name" required maxlength="120" /></label>
        <label>CLIProxyAPI base URL<input name="baseUrl" type="url" required maxlength="2048" placeholder="http://127.0.0.1:8317" /></label>
        <label>Management credential<input name="managementSecret" type="password" required maxlength="16384" autocomplete="new-password" /></label>
        <label>Catalog credential, if required<input name="catalogSecret" type="password" maxlength="16384" autocomplete="new-password" /></label>
        <label>Retention days<input name="retentionDays" type="number" min="1" max="3650" value="30" required /></label>
        <label class="check"><input name="enabled" type="checkbox" checked /> Enable connection</label>
        <p class="hint wide">Credentials are sent once to Dhole over HTTPS and cleared from this form on submit. Newly discovered models start disabled.</p>
        <div><button class="primary compact" disabled={busy}>Create connection</button></div>
      </form>
    </details>
    {/if}
  </div>

  {#if connection}
    {#if connection.lastErrorSummary}<p class="error" role="status">{connection.lastErrorSummary}</p>{/if}

    <div class="panel" id="gateway-panel-models" role="tabpanel" aria-labelledby="gateway-tab-models" hidden={section !== 'models'} tabindex="0"><div class="section-heading"><div><h2>Models & clients</h2><p class="hint">Choose the models available to agents and connect their clients.</p></div><span class="scope-label">{catalog ? `${catalog.status} · ${count(enabledModels)} ready` : errors.catalog ? 'Unavailable' : 'Loading'}</span></div>
      {#if errors.catalog}<p class="error">{errors.catalog}</p>{/if}
      {#if catalog}
        {#if catalog.error}<p class="error" role="status">{catalog.error.message} {catalog.snapshot ? 'Showing the last successful snapshot.' : 'No successful snapshot exists.'}</p>{/if}
        {#if catalog.stale}<p class="notice">Catalog metadata is stale. Last success {date(catalog.lastSuccessAt)}.</p>{/if}
        {#if !catalog.connectionEnabled || !catalog.providerEnabled}<p class="notice">The connection or linked provider is disabled. Models are unavailable to Dhole clients.</p>{/if}
        {#if catalog.snapshot}
          <dl class="metadata"><div><dt>Observed</dt><dd>{date(catalog.snapshot.observedAt)}</dd></div><div><dt>Source</dt><dd class="mono">{catalog.snapshot.source.baseUrl}{catalog.snapshot.source.endpoint}</dd></div><div><dt>Shape</dt><dd>{catalog.snapshot.source.shape}{catalog.snapshot.source.clientVersion ? ` · client ${catalog.snapshot.source.clientVersion}` : ''}</dd></div><div><dt>Provider</dt><dd class="mono">{catalog.providerId}</dd></div></dl>
          <details class="inset"><summary>Snapshot diff · +{catalog.snapshot.diff.added.length} / −{catalog.snapshot.diff.removed.length} / {catalog.snapshot.diff.changed.length} changed</summary><p class="mono hint">Snapshot {catalog.snapshot.id}<br />SHA-256 {catalog.snapshot.contentHash}</p>{#each Object.entries(catalog.snapshot.diff) as [kind, ids]}<p><strong>{kind}</strong> {ids.length ? ids.join(', ') : 'None'}</p>{/each}</details>
        {:else}<p class="empty">No catalog observed. An administrator can refresh it from CLIProxyAPI.</p>{/if}
        {#if isAdmin && active}<form class="inline-form" onsubmit={(event) => { event.preventDefault(); void act(async () => { catalog = await gatewayApi.refreshCatalog(selectedId, clientVersion.trim() || undefined); }, 'Catalog refresh finished.', false); }}><label>Codex client version, optional<input bind:value={clientVersion} maxlength="80" placeholder="Use installed version for the rich catalog" /></label><button class="secondary compact" disabled={busy}><RefreshCw size={15} /> Refresh catalog</button></form>{/if}
        <p class="hint">Enablement controls Dhole selection and catalog projections. It does not block clients calling CLIProxyAPI directly. Capability evidence is administrator-submitted and unverified; it is separate from advertised metadata.</p>
        <div class="search-toolbar"><label class="search-field"><span class="sr-only">Find model</span><Search size={17} /><input type="search" bind:value={modelSearch} oninput={() => { modelLimit = 10; }} placeholder="Search models by ID or name…" /></label><label><span class="sr-only">Model policy filter</span><Select bind:value={modelPolicy} onchange={() => { modelLimit = 10; }} options={[{ value: '', label: 'All model policies' }, { value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }, { value: 'unavailable', label: 'Unavailable' }]} /></label></div>
        <div class="table-scroll"><table><thead><tr><th>Model</th><th>Selection policy</th><th>Clients</th><th>Evidence</th></tr></thead><tbody>
          {#each visibleModels as item}<tr><td><strong>{item.displayName}</strong><br /><span class="mono hint">{item.modelKey}</span>{#if !item.available}<br /><span class="warning">Unavailable</span>{/if}</td><td>{#if isAdmin && active}<label class="check"><input type="checkbox" checked={item.enabled} disabled={busy} onchange={(event) => act(async () => { catalog = await gatewayApi.modelPolicy(selectedId, item.modelId, event.currentTarget.checked); }, 'Model policy saved.', false)} />Enabled</label>{:else}{item.enabled ? 'Enabled' : 'Disabled'}{/if}</td><td>{Object.entries(item.compatibility).filter(([, supported]) => supported).map(([client]) => client === 'generic' ? 'OpenAI' : client).join(', ') || 'None'}</td><td><details class="evidence"><summary>Capabilities</summary><p class="hint">Advertised by CLIProxyAPI</p><pre>{JSON.stringify(item.declared, null, 2)}</pre><p class="hint">Submitted capability evidence, unverified</p>{#if Object.keys(item.measuredCapabilities).length}<pre>{JSON.stringify(item.measuredCapabilities, null, 2)}</pre>{:else}<p class="hint">No submitted capability evidence.</p>{/if}</details></td></tr>{/each}
        </tbody></table></div>
        {#if catalog.models.length && !visibleModels.length}<p class="empty">No models match this search.</p>{/if}
        {#if matchingModels.length > visibleModels.length}<div class="actions"><span class="hint">Showing {visibleModels.length} of {matchingModels.length} matching models.</span><button class="secondary compact" onclick={() => { modelLimit += 25; }}>Show more models</button></div>{/if}
        <details class="inset"><summary>Client connection guidance</summary><p>Inference clients call CLIProxyAPI directly. OpenCode can pull Dhole's effective catalog at startup with a scoped catalog credential.</p><p>Native Codex discovers models through its own provider catalog behavior. Use its supported native configuration; Dhole's optional Codex projection describes compatible metadata.</p>
          {#if isAdmin && active}
            <form class="form-grid" onsubmit={issueToken}><label>Catalog credential name<input name="name" required maxlength="120" placeholder="OpenCode workstation" /></label><label>Client<Select name="client" value="opencode" options={[{ value: 'opencode', label: 'OpenCode' }, { value: 'generic', label: 'Generic OpenAI' }, { value: 'codex', label: 'Codex projection' }]} /></label><label>Expires in days<input name="expiresInDays" type="number" min="1" max="30" value="7" required /></label><div class="form-action"><button class="secondary compact" disabled={busy}>Issue read-only catalog credential</button></div></form>
            {#if issuedToken}<div class="token-box"><p>Copy once. This credential reads model metadata only and expires {date(issuedToken.expiresAt)}.</p><label>Catalog endpoint<input readonly value={issuedToken.endpoint} /></label><label>One-time catalog credential<input type="password" readonly value={issuedToken.token} autocomplete="off" /></label><div class="actions"><button class="secondary compact" onclick={() => act(() => navigator.clipboard.writeText(issuedToken!.token), 'Catalog credential copied.', false)}>Copy credential</button><button class="secondary compact" onclick={() => { issuedToken = null; }}>Dismiss credential</button></div></div>{/if}
            <button class="secondary compact" disabled={busy} onclick={() => act(async () => { tokens = (await gatewayApi.tokens(selectedId)).tokens; }, '', false)}>List catalog credentials</button>
            {#if tokens}<ul class="token-list">{#each tokens as token}<li><span>{token.name} · {token.client} · {token.revokedAt ? 'Revoked' : `Expires ${date(token.expiresAt)}`}</span>{#if !token.revokedAt}<button class="secondary compact" disabled={busy} onclick={() => act(async () => { await gatewayApi.revokeToken(selectedId, token.id); tokens = (await gatewayApi.tokens(selectedId)).tokens; }, 'Catalog credential revoked.', false)}>Revoke</button>{/if}</li>{/each}</ul>{/if}
          {/if}
        </details>
      {/if}
    </div>

    <div class="panel" id="gateway-panel-accounts" role="tabpanel" aria-labelledby="gateway-tab-accounts" hidden={section !== 'accounts'} tabindex="0"><div class="section-heading"><div><h2>Provider accounts</h2><p class="hint">Inspect availability, reported quota and provider consent.</p></div><span class="scope-label">{accounts ? `${accounts.length} observed` : errors.accounts ? 'Unavailable' : 'Loading'}</span></div>
      {#if errors.accounts}<p class="error">{errors.accounts}</p>{/if}
      {#if active}<button class="secondary compact" disabled={busy} onclick={() => act(async () => { accounts = (await gatewayApi.refreshAccounts(selectedId)).accounts; }, 'Account metadata refreshed from CLIProxyAPI.', false)}><RefreshCw size={15} /> Refresh account metadata</button>{/if}
      {#if accounts}<label class="search-field"><span class="sr-only">Find account</span><Search size={17} /><input type="search" bind:value={accountSearch} placeholder="Search by account or provider…" /></label><p class="hint">Stored usage and management observations describe account state. Refresh reads cached proxy state without probing a provider. Missing quota data means unknown capacity.</p><div class="table-scroll"><table><thead><tr><th>Account</th><th>Provider</th><th>Health</th><th>Quota and cooldown</th>{#if isAdmin}<th>Action</th>{/if}</tr></thead><tbody>{#each matchingAccounts as account}<tr><td>{account.label || account.authIndex}<br /><span class="hint">{date(account.observedAt)}</span></td><td>{account.provider}</td><td>{account.status}</td><td>{#if Object.keys(account.quota).length}<pre>{JSON.stringify(account.quota, null, 2)}</pre>{:else}<span class="hint">Quota unknown</span>{/if}<p class="hint">{account.cooldownUntil ? `Cooldown until ${date(account.cooldownUntil)}` : 'No cooldown reported'}</p></td>{#if isAdmin}<td>{#if active && account.managementSupported && typeof account.disabled === 'boolean'}<button class="secondary compact" disabled={busy} onclick={() => { accountChange = { accountId: account.id, label: account.label || account.authIndex, expectedDisabled: account.disabled!, disabled: !account.disabled }; }}>Review {account.disabled ? 'enable' : 'disable'}</button>{:else}<span class="hint">No supported action</span>{/if}</td>{/if}</tr>{/each}</tbody></table></div>{#if !accounts.length}<p class="empty">No account observations stored.</p>{:else if !matchingAccounts.length}<p class="empty">No accounts match this search.</p>{/if}{/if}
      {#if isAdmin && accountChange}<div class="notice"><p>Change account {accountChange.label} from {accountChange.expectedDisabled ? 'disabled' : 'enabled'} to {accountChange.disabled ? 'disabled' : 'enabled'} in CLIProxyAPI. This changes routing availability for the account.</p><div class="actions"><button class="secondary compact" disabled={busy} onclick={() => act(async () => { accounts = (await gatewayApi.accountStatus(selectedId, accountChange!.accountId, { expectedRevision: connection!.revision, expectedDisabled: accountChange!.expectedDisabled, disabled: accountChange!.disabled })).accounts; accountChange = null; }, 'Account status changed.', false)}>Apply account change</button><button class="secondary compact" onclick={() => { accountChange = null; }}>Cancel</button></div></div>{/if}
      {#if isAdmin && active}<details class="inset"><summary>Add account through provider consent</summary><p class="hint">CLIProxyAPI handles the provider exchange and stores account credentials. This flow expires after five minutes.</p>
        {#if !oauthFlow || !['pending', 'submitted'].includes(oauthFlow.status)}<form class="inline-form" onsubmit={startOAuth}><label>Provider<Select name="provider" value="codex" options={[{ value: 'codex', label: 'Codex' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'antigravity', label: 'Antigravity' }]} /></label><button class="secondary compact" disabled={busy}>Start consent flow</button></form>{/if}
        {#if errors.oauth}<p class="error">{errors.oauth}</p><button class="secondary compact" onclick={() => { errors = { ...errors, oauth: '' }; void pollOAuth(); }}>Retry status check</button>{/if}
        {#if oauthFlow}<p role="status">{oauthFlow.provider} · {oauthFlow.status} · expires {date(oauthFlow.expiresAt)}</p>
          {#if authorizationUrl && oauthFlow.status === 'pending'}<p><a class="secondary compact consent-link" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Open provider consent</a></p><p class="hint">After consent, the provider redirects to localhost. If that page cannot load, copy the full callback URL from its address bar and paste it below. Submit the URL only to Dhole. The input clears immediately.</p><form class="inline-form" onsubmit={submitOAuth} autocomplete="off"><label>Provider callback URL<input name="redirectUrl" type="password" required maxlength="16384" autocomplete="new-password" /></label><button class="secondary compact" disabled={busy}>Submit callback</button></form>{/if}
          {#if ['pending', 'submitted'].includes(oauthFlow.status)}<button class="secondary compact" disabled={busy} onclick={() => act(async () => { oauthVersion++; oauthFlow = await gatewayApi.cancelOAuth(selectedId, oauthFlow!.id); authorizationUrl = ''; clearTimeout(oauthTimer); }, 'Consent flow cancelled.', false)}>Cancel consent flow</button>{:else if oauthFlow.status === 'complete'}<p class="notice">Account consent completed. Refresh account metadata to inspect its state.</p>{/if}
        {/if}
      </details>{/if}
    </div>

    <div class="panel" id="gateway-panel-activity" role="tabpanel" aria-labelledby="gateway-tab-activity" hidden={section !== 'activity'} tabindex="0"><div class="section-heading"><div><h2>Requests & usage</h2><p class="hint">Explore stored traffic by provider, model, account and time.</p></div><span class="scope-label">{requests ? `${count(requests.total)} stored matches` : errors.requests ? 'Unavailable' : 'Loading'}</span></div>
      <div class="gateway-metrics usage-metrics">
        <article class="gateway-metric"><span>Stored requests</span><strong>{count(summary?.requests)}</strong><small>{summary ? `${count(summary.failures)} failed` : 'Awaiting usage'}</small></article>
        <article class="gateway-metric"><span>Total tokens</span><strong>{count(summary?.tokens)}</strong><small>Input and output tokens</small></article>
        <article class="gateway-metric"><span>Estimated cost</span><strong>{cost(summary?.estimatedCostMicrousd)}</strong><small>{summary ? `${count(summary.unpricedRequests)} requests unpriced` : 'Awaiting pricing observations'}</small></article>
        <article class="gateway-metric"><span>Mean latency</span><strong>{summary?.averageDurationMs == null ? 'Unknown' : `${count(Math.round(summary.averageDurationMs))} ms`}</strong><small>{summary ? `${count(summary.measuredRequests)} measured requests` : 'Awaiting latency observations'}</small></article>
      </div>
      <p class="hint">{appliedHistoryRange}. {appliedHistoryFilters ? 'Metrics use the applied request filters.' : ''} {usage?.truncated ? 'Usage is partial. Narrow the time range for a complete rollup.' : ''}</p>
      {#if errors.collection}<p class="error">Collection state unavailable. {errors.collection}</p>{/if}
      {#if collection}<p class="hint">{collection.message} Last stored {date(collection.lastStoredAt)}. {count(collection.retainedRequests)} retained records.</p>{/if}
      <form class="filters" onsubmit={(event) => { event.preventDefault(); void refreshHistory(); }}>
        <label>Provider<input bind:value={provider} /></label><label>Model<input bind:value={model} /></label><label>Account index<input bind:value={authIndex} /></label><label>Result<Select bind:value={failed} options={[{ value: '', label: 'Any result' }, { value: 'true', label: 'Failed' }, { value: 'false', label: 'Succeeded' }]} /></label>
        <label>From<input type="datetime-local" bind:value={occurredFrom} /></label><label>To<input type="datetime-local" bind:value={occurredTo} /></label><label>Correlation<Select bind:value={confidence} options={[{ value: '', label: 'Any correlation' }, ...['exact', 'high', 'medium', 'low', 'none'].map((value) => ({ value, label: value }))]} /></label><div class="form-action"><button class="secondary compact" disabled={busy}>Apply filters</button><button type="button" class="text-action" onclick={resetHistory} disabled={busy}>Reset</button></div>
      </form>
      {#if errors.requests}<p class="error">Request history unavailable. {errors.requests}</p>{/if}
      {#if requests}
        <div class="table-scroll"><table><thead><tr><th>Time / model</th><th>Result</th><th>Tokens in / out</th><th>Latency</th><th>Estimated cost</th><th>Correlation</th></tr></thead><tbody>{#each requests.items as item}<tr><td>{date(item.occurredAt)}<br /><span class="mono">{item.model}</span><br /><span class="hint">{item.provider} · {item.authIndex ?? 'Account unknown'}</span></td><td><span class:warning={item.failed}>{item.failed ? 'Failed' : 'Succeeded'}</span> {item.statusCode ?? ''}{#if item.failureCategory}<br />{item.failureCategory}{/if}{#if item.failureSummary}<details class="evidence"><summary>Failure detail</summary><p>{item.failureSummary}</p></details>{/if}</td><td>{count(item.inputTokens)} / {count(item.outputTokens)}</td><td>{item.durationMs == null ? 'Unknown' : `${count(item.durationMs)} ms`}<br /><span class="hint">TTFT {item.ttftMs == null ? 'unknown' : `${count(item.ttftMs)} ms`}</span></td><td>{cost(item.estimatedCostMicrousd)}</td><td><details class="evidence"><summary>{item.correlationConfidence ?? 'none'}</summary><p>{item.correlationReason ?? 'No correlation evidence.'}</p>{#if item.sessionId}<p class="mono hint">Session {item.sessionId}</p>{/if}</details></td></tr>{/each}</tbody></table></div>
        {#if !requests.items.length}<p class="empty">No stored requests match these filters. This does not establish zero upstream traffic.</p>{/if}
        <div class="actions"><button class="secondary compact" disabled={busy || requests.offset === 0} onclick={() => refreshHistory(Math.max(0, requests!.offset - requests!.limit))}><ChevronLeft size={15} /> Previous</button><span class="hint">{count(requests.offset + (requests.items.length ? 1 : 0))}–{count(requests.offset + requests.items.length)} of {count(requests.total)}</span><button class="secondary compact" disabled={busy || requests.nextOffset === null} onclick={() => refreshHistory(requests!.nextOffset!)}>Next <ChevronRight size={15} /></button><button class="secondary compact" disabled={busy} onclick={download}><Download size={15} /> {exportCursor ? 'Export next 500 records' : 'Export up to 500 records'}</button></div>
      {/if}
      <details class="inset" open><summary>Usage over time</summary><form class="inline-form" onsubmit={(event) => { event.preventDefault(); void refreshHistory(); }}><label>Bucket<Select bind:value={bucket} options={[{ value: 'day', label: 'Day' }, { value: 'hour', label: 'Hour' }]} /></label><label>Group by<Select bind:value={groupBy} options={[{ value: 'none', label: 'All matching requests' }, { value: 'provider', label: 'Provider' }, { value: 'model', label: 'Model' }, { value: 'authIndex', label: 'Account index' }]} /></label><button class="secondary compact">Update usage</button></form>
        {#if errors.usage}<p class="error">Usage unavailable. {errors.usage}</p>{/if}
        {#if usage}<p class="hint">Stored observations only. Costs are estimates, and rows identify requests without pricing. Missing latency is unknown.</p>{#if usage.truncated}<p class="notice">Result limit reached. Narrow the time range to see a complete rollup.</p>{/if}<div class="table-scroll"><table><thead><tr><th>Period / group</th><th>Requests / failures</th><th>Tokens in / out</th><th>Mean latency</th><th>Estimated cost</th></tr></thead><tbody>{#each usage.items as item}<tr><td>{date(item.bucketStart)}{#if item.group}<br />{item.group}{/if}</td><td>{count(item.requests)} / {count(item.failures)}</td><td>{count(item.inputTokens)} / {count(item.outputTokens)}</td><td>{item.averageDurationMs == null ? 'Unknown' : `${count(Math.round(item.averageDurationMs))} ms`}<br /><span class="hint">{count(item.measuredRequests)} measured</span></td><td>{cost(item.estimatedCostMicrousd)}<br /><span class="hint">{count(item.unpricedRequests)} unpriced</span></td></tr>{/each}</tbody></table></div>{#if !usage.items.length}<p class="empty">No stored usage in this range.</p>{/if}{/if}
      </details>
    </div>

    {#if isAdmin}
      <div class="panel" id="gateway-panel-settings" role="tabpanel" aria-labelledby="gateway-tab-settings" hidden={section !== 'settings'} tabindex="0"><div class="section-heading"><div><h2>Connection settings</h2><p class="hint">Review proxy policy, connection changes and their history.</p></div><span class="scope-label"><ShieldCheck size={14} /> Administrator</span></div>
        {#if active}
          <div class="actions"><button class="secondary compact" disabled={busy} onclick={() => act(async () => { await gatewayApi.sync(selectedId); }, 'Sync finished. Request history changes only when records are pushed or imported.')}><RefreshCw size={15} /> Sync metadata</button><span class="hint">Refresh proxy observations without collecting request history.</span></div>
          <details class="inset"><summary>CLIProxyAPI routing and retry settings</summary><p class="hint">Read current values, preview one change, then apply it. Dhole checks the observed revision before writing. CLIProxyAPI does not provide an atomic compare-and-swap, so another writer can still race the change.</p>
            <button class="secondary compact" disabled={busy} onclick={() => act(async () => { config = await gatewayApi.config(selectedId); configPreview = null; configChange = null; }, 'Proxy settings loaded.', false)}>Read current proxy settings</button>
            {#if config}<p class="hint">Observed {date(config.observedAt)}</p><details class="inset"><summary>Sanitized values</summary><pre>{JSON.stringify(config.values, null, 2)}</pre></details>
              <form class="inline-form" onsubmit={previewConfig} onchange={() => { configPreview = null; configChange = null; }}><label>Setting<Select bind:value={configSetting} options={[{ value: 'request-retry', label: 'Request retries' }, { value: 'max-retry-credentials', label: 'Maximum retry credentials' }, { value: 'max-retry-interval', label: 'Maximum retry interval in seconds' }, { value: 'routing/strategy', label: 'Routing strategy' }]} /></label>{#key configSetting}<label>New value{#if configSetting === 'routing/strategy'}<Select name="value" value={config.values['routing/strategy']} options={[{ value: 'round-robin', label: 'Round robin' }, { value: 'weighted-round-robin', label: 'Weighted round robin' }, { value: 'fill-first', label: 'Fill first' }]} />{:else}<input name="value" type="number" min="0" max={configSetting === 'max-retry-interval' ? 3600 : 100} value={config.values[configSetting]} required />{/if}</label>{/key}<button class="secondary compact" disabled={busy}>Preview change</button></form>
              {#if configPreview && configChange}<div class="notice">{#each configPreview.changes as change}<p>{change.setting} · {change.before} → {change.after}</p>{/each}<button class="secondary compact" disabled={busy} onclick={() => act(async () => { config = await gatewayApi.applyConfig(selectedId, configChange!); configChange = null; configPreview = null; }, 'Reviewed proxy setting applied.', false)}>Apply reviewed change</button></div>{/if}
            {/if}
          </details>
        {/if}
        {#if !connection.deletedAt}
          {#key `${connection.id}:${connection.revision}`}<form class="form-grid" onsubmit={editConnection} onchange={() => { connectionEdit = null; }}><label>Name<input name="name" value={connection.name} required maxlength="120" /></label><label>CLIProxyAPI base URL<input name="baseUrl" type="url" value={connection.baseUrl} required maxlength="2048" /></label><label>Retention days<input name="retentionDays" type="number" min="1" max="3650" value={connection.retentionDays} required /></label><label class="check"><input name="enabled" type="checkbox" checked={connection.enabled} />Enabled</label><div><button class="secondary compact" disabled={busy}>Preview connection changes</button></div></form>{/key}
          {#if connectionEdit}<div class="notice">{#each connectionEdit.changes as change}<p>{change.field} · {change.before} → {change.after}</p>{/each}{#if connectionEdit.changes.length}<button class="secondary compact" disabled={busy} onclick={() => act(() => gatewayApi.update(selectedId, connectionEdit!.input), 'Connection settings saved.')}>Save reviewed revision {connection.revision + 1}</button>{:else}<p>No metadata changes.</p>{/if}</div>{/if}
          <details class="inset"><summary>Rotate credentials</summary><p class="hint">Management {connection.managementConfigured ? 'configured' : 'missing'} · Catalog {connection.catalogConfigured ? 'configured' : 'not configured'}. Only supplied values rotate. Previous secrets cannot be recovered by rollback.</p><form class="form-grid" onsubmit={rotateSecrets} autocomplete="off"><label>New management credential<input name="managementSecret" type="password" maxlength="16384" autocomplete="new-password" /></label><label>New catalog credential<input name="catalogSecret" type="password" maxlength="16384" autocomplete="new-password" /></label><div><button class="secondary compact" disabled={busy}>Rotate supplied credentials</button></div></form></details>
        {/if}
        <details class="inset" ontoggle={(event) => { if (event.currentTarget.open && !revisions) void loadRevisions(); }}><summary>Configuration revisions and rollback</summary><p class="hint">Rollback restores connection metadata. History is immutable; credentials are never restored.</p>{#if errors.revisions}<p class="error">{errors.revisions}</p>{/if}{#if revisions}<div class="table-scroll"><table><thead><tr><th>Revision</th><th>Metadata</th><th>Action</th></tr></thead><tbody>{#each revisions as revision}<tr><td>{revision.revision} · {revision.action}<br /><span class="hint">{date(revision.createdAt)}</span></td><td><details class="evidence"><summary>{revision.metadata.name} · {revision.metadata.enabled ? 'enabled' : 'disabled'}</summary><pre>{JSON.stringify(revision.metadata, null, 2)}</pre></details></td><td>{#if revision.revision !== connection.revision && !connection.deletedAt && !revision.metadata.deletedAt}<button class="secondary compact" disabled={busy} onclick={() => act(() => gatewayApi.rollback(selectedId, connection!.revision, revision.revision), `Restored metadata from revision ${revision.revision}.`)}>Restore metadata</button>{/if}</td></tr>{/each}</tbody></table></div>{/if}</details>
        {#if !connection.deletedAt}<details class="inset"><summary>Archive or remove connection</summary><p class="hint">Archiving disables the connection. Removing it also deletes its stored credentials. Stored requests and audit history remain.</p><div class="actions">{#if !connection.archivedAt}<button class="secondary compact" disabled={busy} onclick={() => act(() => gatewayApi.archive(selectedId, connection!.revision), 'Connection archived.')}>Archive connection</button>{/if}<label class="check"><input type="checkbox" bind:checked={deletionConfirmed} />Remove this connection and its credentials</label><button class="danger-button compact" disabled={busy || !deletionConfirmed} onclick={() => act(() => gatewayApi.remove(selectedId, connection!.revision), 'Connection removed; history retained.')}>Remove connection</button></div></details>{/if}
        <details class="inset"><summary>Retention cleanup</summary><p class="hint">Delete up to 1,000 request-detail rows older than the {connection.retentionDays} day retention period. Deduplication records and audit history remain.</p><label class="check"><input type="checkbox" bind:checked={pruneConfirmed} />Delete expired request details</label><button class="danger-button compact" disabled={busy || !pruneConfirmed} onclick={() => act(async () => { const result = await gatewayApi.prune(selectedId); message = `${result.deleted} request details deleted. ${result.remainingEligible} expired records remain.`; }, '')}>Prune expired details</button></details>
        <details class="inset"><summary>Proxy management history</summary><button class="secondary compact" disabled={busy} onclick={() => act(async () => { managementHistory = await gatewayApi.managementHistory(selectedId); }, '', false)}>Read management history</button>{#if managementHistory}{#each managementHistory as entry}<details class="inset"><summary>{entry.action} · {entry.outcome} · {date(entry.createdAt)}</summary><p class="hint">Before</p><pre>{JSON.stringify(entry.before, null, 2)}</pre><p class="hint">After</p><pre>{JSON.stringify(entry.after, null, 2)}</pre></details>{/each}{#if !managementHistory.length}<p class="empty">No proxy management changes recorded.</p>{/if}{/if}</details>
      </div>
    {/if}
  {/if}
</section>

<style>
  .gateway { max-width: 1400px; min-width: 0; }
  .gateway [hidden] { display: none !important; }
  .gateway-toolbar { display: flex; gap: 22px; align-items: end; flex-wrap: wrap; margin-bottom: 22px; }
  .connection-select { width: min(360px, 100%); }
  .connection-context { display: flex; align-items: center; gap: 12px; min-height: 40px; flex-wrap: wrap; }
  .connection-context .mono { max-width: 400px; }
  .gateway-tabs { display: flex; border-bottom: 1px solid var(--line); gap: 6px; overflow-x: auto; margin-bottom: 24px; scrollbar-width: thin; }
  .gateway-tabs button { display: inline-flex; align-items: center; gap: 8px; padding: 14px 13px; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; color: var(--muted); font-size: .82rem; white-space: nowrap; }
  .gateway-tabs button:hover:not(:disabled) { color: var(--text); background: var(--panel); }
  .gateway-tabs button.active-tab { color: var(--rust-bright); border-bottom-color: var(--rust-bright); }
  .gateway-tabs button:focus-visible { outline-offset: -3px; }
  .tab-content { min-width: 0; }
  .section-heading { display: flex; align-items: start; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
  .section-heading h2 { margin: 0; font-size: 1rem; font-weight: 650; letter-spacing: -.015em; }
  .section-heading p { margin: 7px 0 0; }
  .scope-label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .74rem; white-space: nowrap; }
  .gateway-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 0 0 24px; }
  .gateway-metric { min-width: 0; display: grid; align-content: start; gap: 12px; padding: 20px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .gateway-metric > span { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .79rem; }
  .gateway-metric > span :global(svg) { color: var(--rust-bright); }
  .gateway-metric > strong { font-size: clamp(1.4rem, 2.2vw, 2rem); letter-spacing: -.045em; font-weight: 620; overflow-wrap: anywhere; }
  .gateway-metric small { color: var(--muted); font-size: .72rem; line-height: 1.45; letter-spacing: normal; font-weight: 400; }
  .gateway-metric > strong small { font-size: 1rem; }
  .overview-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(300px, 1fr); gap: 18px; }
  .panel { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 24px; margin: 0; min-width: 0; }
  .overview-grid > .panel { padding: 22px; }
  .readiness-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 17px 0; text-align: left; border-bottom: 1px solid var(--line); }
  .readiness-row > :global(svg):first-child { color: var(--muted); flex: none; }
  .readiness-row > div { flex: 1; }
  .readiness-row strong { font-size: .8rem; font-weight: 550; }
  .readiness-row p { font-size: .73rem; line-height: 1.45; color: var(--muted); margin: 5px 0 0; }
  button.readiness-row:hover strong { color: var(--rust-bright); }
  .readiness-row > :global(svg):last-child { color: var(--muted); }
  .readiness .actions { margin-bottom: 0; }
  .activity-totals { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 14px; font-size: .74rem; color: var(--muted); }
  .activity-totals strong { color: var(--text); font-size: 1.5rem; letter-spacing: -.03em; }
  .activity-totals strong span { color: var(--muted); font-size: .75rem; font-weight: 400; letter-spacing: normal; }
  .activity-chart { margin: 30px 0 0; }
  .chart-bars { display: flex; gap: clamp(4px, 1vw, 14px); min-height: 210px; }
  .chart-column { display: flex; flex-direction: column; flex: 1; min-width: 0; text-align: center; }
  .chart-value { color: var(--muted); font-size: .65rem; margin-bottom: 8px; }
  .chart-track { display: flex; align-items: end; height: 160px; border-bottom: 1px solid var(--line-strong); background: repeating-linear-gradient(to top, transparent, transparent 39px, var(--line) 40px); }
  .chart-bar { width: 100%; min-height: 1px; max-width: 58px; margin-inline: auto; background: var(--rust-bright); border-radius: 4px 4px 0 0; position: relative; opacity: .85; overflow: hidden; }
  .chart-failures { display: block; width: 100%; background: var(--red); position: absolute; bottom: 0; }
  .chart-label { margin-top: 10px; font-size: .62rem; line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
  figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 20px; font-size: .7rem; color: var(--muted); }
  figcaption span:first-child { display: flex; align-items: center; gap: 7px; }
  figcaption i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .legend-requests { background: var(--rust-bright); }
  .legend-failures { background: var(--red); margin-left: 8px; }
  .observation-note { display: flex; align-items: start; gap: 9px; margin-top: 18px; color: var(--muted); font-size: .75rem; line-height: 1.6; }
  .observation-note :global(svg) { flex: none; margin-top: 2px; }
  .gateway-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; min-height: 290px; gap: 12px; }
  .gateway-empty > :global(svg) { color: var(--muted); }
  .gateway-empty h2, .gateway-empty h3 { margin: 0; font-size: 1rem; }
  .gateway-empty p { color: var(--muted); font-size: .82rem; max-width: 400px; line-height: 1.6; margin: 0 0 6px; }
  .text-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: var(--rust-bright); font-size: .78rem; padding: 4px 0; }
  .text-action:hover { text-decoration: underline; }
  .loading-note { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .8rem; margin-bottom: 18px; }
  .search-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 14px; align-items: center; margin: 22px 0 14px; }
  .search-field { position: relative; }
  .search-field > :global(svg) { position: absolute; left: 12px; top: 12px; color: var(--muted); pointer-events: none; }
  .search-field input { padding-left: 39px; }
  .usage-metrics { margin-bottom: 14px; }
  .usage-metrics .gateway-metric { background: var(--bg); padding: 16px; }
  .usage-metrics .gateway-metric > strong { font-size: 1.45rem; }
  summary { cursor: pointer; font-weight: 550; }
  .create-connection > summary { color: var(--rust-bright); }
  .create-connection > summary :global(svg) { vertical-align: text-bottom; }
  .status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--line-strong); border-radius: 6px; font-size: .72rem; color: var(--green); white-space: nowrap; }
  .health-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .hint { color: var(--muted); font-size: .78rem; line-height: 1.55; }
  .mono { font-family: ui-monospace, monospace; overflow-wrap: anywhere; font-size: .78rem; }
  .warning { color: var(--amber); }
  .notice, .error { padding: 12px; border: 1px solid var(--line-strong); border-left: 3px solid var(--amber); border-radius: 6px; background: var(--panel-raised); line-height: 1.5; font-size: .84rem; }
  .notice > :global(svg) { vertical-align: text-bottom; margin-right: 5px; color: var(--green); }
  .error { border-left-color: var(--red); color: #ffd5d0; }
  .empty { display: block; min-height: 0; color: var(--muted); padding: 18px 0; font-size: .85rem; }
  .form-grid, .filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 20px 0; }
  .filters { grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 20px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
  .wide { grid-column: 1 / -1; }
  .check { display: flex; align-items: center; gap: 8px; }
  .check input { width: auto; accent-color: var(--rust-bright); }
  .form-action { display: flex; align-self: end; align-items: center; gap: 14px; }
  .inline-form, .actions { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
  .inline-form label { flex: 1; min-width: 180px; }
  .actions { align-items: center; }
  .metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; font-size: .8rem; }
  dt { color: var(--muted); margin-bottom: 5px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .inset { border-top: 1px solid var(--line); padding: 18px 0 0; margin-top: 22px; }
  .inset > summary { font-size: .84rem; }
  .inset[open] > summary { margin-bottom: 16px; }
  .inset > p { font-size: .83rem; line-height: 1.6; }
  .table-scroll { overflow-x: auto; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; text-align: left; font-size: .8rem; }
  th, td { padding: 16px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; white-space: nowrap; padding-top: 12px; padding-bottom: 12px; }
  th:first-child, td:first-child { padding-left: 0; }
  td { line-height: 1.55; }
  td strong { font-weight: 550; }
  tbody tr:hover { background: color-mix(in srgb, var(--panel-raised) 55%, transparent); }
  pre { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .74rem; max-width: 380px; }
  .evidence summary { font-size: .76rem; font-weight: 400; }
  .token-box { padding: 16px; margin: 16px 0; border: 1px solid var(--amber); border-radius: 8px; }
  .token-box label { margin-top: 10px; }
  .token-list { list-style: none; padding: 0; }
  .token-list li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: .8rem; }
  @media (max-width: 1100px) { .overview-grid { grid-template-columns: 1fr; } .gateway-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 650px) { .page-heading { align-items: start; flex-direction: column; gap: 16px; } .heading-actions { flex-wrap: wrap; } .section-heading { flex-wrap: wrap; gap: 10px; } .gateway-toolbar { gap: 12px; } .connection-context { gap: 8px; } .panel, .overview-grid > .panel { padding: 18px; } .gateway-tabs { gap: 0; margin-inline: -4px; } .gateway-tabs button { padding-inline: 10px; } .gateway-metric { padding: 16px; } .search-toolbar, .form-grid, .filters, .metadata { grid-template-columns: 1fr; } .filters { padding: 14px; } .chart-bars { gap: 5px; } .chart-label { font-size: .56rem; } }
  @media (prefers-reduced-motion: reduce) { .gateway :global(*) { scroll-behavior: auto; } }
</style>
