<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, CheckCheck, ChevronRight, Copy, KeyRound, Monitor, RefreshCw, ShieldCheck, Terminal } from '@lucide/svelte';
  import { api } from './api';
  import type { DeviceCredential, DeviceRequest, User } from './types';

  export let user: User;
  let code = new URLSearchParams(location.search).get('user_code') ?? '';
  let request: DeviceRequest | null = null;
  let permissions: string[] = [];
  let devices: DeviceCredential[] = [];
  let error = '';
  let devicesError = '';
  let message = '';
  let busy = false;
  let loadingDevices = true;
  let copied = false;
  let pendingRevoke = '';
  let showHistory = false;
  const connectCommand = `dhole-node connect --server ${location.origin}`;
  const administratorPermissions = ['fleet:admin', 'gateway:ingest', 'gateway:manage'];
  const permissionLabels: Record<string, string> = {
    'projects:create': 'Create private projects for your repositories',
    'gateway:ingest': 'Collect gateway usage and account health',
    'gateway:manage': 'Manage gateway connections and model policy',
    'project:read': 'Read projects you can access',
    'coordination:write': 'Coordinate agent work in your projects',
    'fleet:admin': 'Enroll this machine for execution',
  };
  const isActive = (device: DeviceCredential) => !device.revokedAt && new Date(device.expiresAt).getTime() > Date.now();
  const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $: activeDevices = devices.filter(isActive);
  $: visibleDevices = showHistory ? devices : activeDevices;

  async function loadDevices(): Promise<void> {
    loadingDevices = true;
    devicesError = '';
    try { devices = await api.devices(); }
    catch (value) { devicesError = value instanceof Error ? value.message : 'Unable to load your connections.'; }
    finally { loadingDevices = false; }
  }

  async function review(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    request = null;
    try {
      request = await api.deviceRequest(code.trim());
      permissions = request.permissions.filter((permission) => !administratorPermissions.includes(permission) || user.role === 'administrator');
    } catch (value) { error = value instanceof Error ? value.message : 'Unable to load this connection request.'; }
    finally { busy = false; }
  }

  async function approve(): Promise<void> {
    if (!request || request.status !== 'pending' || busy) return;
    if (new Date(request.expiresAt).getTime() <= Date.now()) { error = 'This code has expired. Run the connection command again to get a new code.'; return; }
    busy = true;
    error = '';
    try {
      await api.approveDevice(code.trim(), permissions);
      request = { ...request, status: 'approved' };
      message = 'Connection approved. Return to your terminal to finish connecting.';
      await loadDevices();
    } catch (value) { error = value instanceof Error ? value.message : 'Unable to approve this machine.'; }
    finally { busy = false; }
  }

  async function revoke(device: DeviceCredential): Promise<void> {
    if (busy) return;
    busy = true;
    devicesError = '';
    try {
      await api.revokeDevice(device.id);
      devices = devices.map((item) => item.id === device.id ? { ...item, revokedAt: new Date().toISOString() } : item);
      pendingRevoke = '';
      message = `Access revoked for ${device.machineName}. Approve a new connection to reconnect its agents.`;
      await loadDevices();
    } catch (value) { devicesError = value instanceof Error ? value.message : 'Unable to revoke access.'; }
    finally { busy = false; }
  }

  async function copyCommand(): Promise<void> {
    try { await navigator.clipboard.writeText(connectCommand); copied = true; }
    catch { error = 'Copy is unavailable. Select and copy the command below.'; }
  }

  onMount(() => {
    void loadDevices();
    if (code) void review();
  });
</script>

<section class="page-heading"><div><span class="eyebrow">ACCESS</span><h1>Connections</h1><p class="muted">Approve your machine once. Your agents use the access you grant.</p></div><span class="connection-count"><span class="status-dot live"></span>{loadingDevices ? 'Loading connections…' : `${activeDevices.length} authorized ${activeDevices.length === 1 ? 'machine' : 'machines'}`}</span></section>
{#if message}<p class="alert success" role="status"><Check size={17} aria-hidden="true" />{message}</p>{/if}
<div class="connections-layout">
  <section class="panel connection-setup"><header class="panel-header"><div class="connection-heading"><Monitor size={21} aria-hidden="true" /><div><h2>Connect a machine</h2><p class="muted">One approval connects your local agents.</p></div></div></header><div class="connection-body">
    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
    {#if !request}<ol class="connect-steps"><li><span class="step-number">1</span><div><h3>Start from your terminal</h3><p class="muted">Run this on the machine your agents use.</p><div class="command-block"><Terminal size={15} aria-hidden="true" /><pre class="connect-command"><code>{connectCommand}</code></pre><button class="icon-button" type="button" aria-label={copied ? 'Command copied' : 'Copy connection command'} title={copied ? 'Copied' : 'Copy command'} onclick={() => void copyCommand()}>{#if copied}<CheckCheck size={16} />{:else}<Copy size={16} />{/if}</button></div>{#if copied}<span class="sr-only" role="status">Connection command copied.</span>{/if}</div></li><li><span class="step-number">2</span><div><h3>Review the connection</h3><p class="muted">Open the link from your terminal, or enter its code here.</p><form class="stack" onsubmit={(event) => { event.preventDefault(); void review(); }}><label>Connection code<input class="connection-code" bind:value={code} autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="Enter your code" required disabled={busy} /></label><button class="primary" type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking code…' : 'Review connection'}<ChevronRight size={16} aria-hidden="true" /></button></form></div></li></ol>
    {:else}<div class="device-review"><div class="review-machine"><span class:approved={request.status === 'approved'} class="machine-icon">{#if request.status === 'approved'}<ShieldCheck size={26} aria-hidden="true" />{:else}<Monitor size={26} aria-hidden="true" />{/if}</span><h3>{request.machineName}</h3><span class="request-code">{code}</span></div>
      {#if request.status === 'approved'}<div class="approved-state" role="status"><h3>Machine approved</h3><p class="muted">Return to your terminal to finish connecting. Your agents can then set up the tools they need.</p></div>{:else}<p class="review-hint muted">Check that this machine and code match your terminal. This request expires {date(request.expiresAt)}.</p><form class="stack" onsubmit={(event) => { event.preventDefault(); void approve(); }}><fieldset disabled={busy}><legend>Allow this machine to</legend>{#each request.permissions as permission}<label class="permission-option"><input type="checkbox" bind:group={permissions} value={permission} disabled={administratorPermissions.includes(permission) && user.role !== 'administrator'} /><span>{permissionLabels[permission] ?? permission}{#if administratorPermissions.includes(permission)}<small>Administrator permission</small>{/if}</span></label>{/each}</fieldset>{#if request.permissions.some((permission) => administratorPermissions.includes(permission)) && user.role !== 'administrator'}<p class="muted review-hint">An administrator must approve execution and gateway access. You can still grant access to your agent work.</p>{/if}<button class="primary" type="submit" disabled={busy || !permissions.length || new Date(request.expiresAt).getTime() <= Date.now()}><ShieldCheck size={17} aria-hidden="true" />{busy ? 'Approving…' : 'Approve this machine'}</button></form>{/if}
      <button class="link-button" type="button" disabled={busy} onclick={() => { request = null; code = ''; message = ''; error = ''; }}>Review another code</button>
    </div>{/if}
  </div><div class="connection-footnote"><KeyRound size={15} aria-hidden="true" /><span>You can revoke a machine's access at any time.</span></div></section>
  <section class="panel connections-list" aria-busy={loadingDevices}><header class="panel-header"><div><h2>Your machines</h2><p class="muted">Connections authorized through your account.</p></div><button class="icon-button" type="button" disabled={loadingDevices || busy} aria-label="Refresh connections" title="Refresh connections" onclick={() => void loadDevices()}><RefreshCw size={17} /></button></header>
    {#if devicesError}<div class="connections-error"><p class="alert error" role="alert">{devicesError}</p><button class="secondary compact" type="button" onclick={() => void loadDevices()}>Try again</button></div>{/if}
    {#if devices.length > activeDevices.length}<label class="show-history"><input type="checkbox" bind:checked={showHistory} /> Show expired and revoked connections</label>{/if}
    {#if loadingDevices && !devices.length}<div class="empty" role="status"><p>Loading your connections…</p></div>{:else if !visibleDevices.length}<div class="empty connections-empty"><Monitor size={29} aria-hidden="true" /><p>No authorized machines</p><span class="muted">Connect a machine to give your agents access. Your connections will appear here.</span></div>{:else}{#each visibleDevices as device (device.id)}<article class="connection-device"><div class="device-topline"><Monitor size={18} aria-hidden="true" /><div><h3>{device.machineName}</h3><span class:authorized={isActive(device)} class="device-status">{device.revokedAt ? 'Revoked' : isActive(device) ? 'Authorized' : 'Expired'}</span></div>{#if isActive(device)}<button class="secondary compact" type="button" disabled={busy} aria-label={`Revoke access for ${device.machineName}`} onclick={() => { pendingRevoke = device.id; }}>Revoke</button>{/if}</div><dl class="device-dates"><div><dt>Last used</dt><dd>{device.lastUsedAt ? date(device.lastUsedAt) : 'Not used yet'}</dd></div><div><dt>{device.revokedAt ? 'Revoked' : 'Expires'}</dt><dd>{date(device.revokedAt ?? device.expiresAt)}</dd></div></dl><details><summary>Granted permissions <span class="muted">{device.permissions.length}</span></summary><ul>{#each device.permissions as permission}<li>{permissionLabels[permission] ?? permission}</li>{/each}</ul></details>{#if pendingRevoke === device.id}<div class="revoke-confirm"><strong>Revoke access for {device.machineName}?</strong><p>Its agents will lose this connection. A new approval is required to reconnect.</p><div><button class="secondary compact" type="button" disabled={busy} onclick={() => { pendingRevoke = ''; }}>Cancel</button><button class="danger-button compact" type="button" disabled={busy} onclick={() => void revoke(device)}>{busy ? 'Revoking…' : 'Revoke access'}</button></div></div>{/if}</article>{/each}{/if}
  </section>
</div>

<style>
  .connection-count { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: .77rem; white-space: nowrap; padding-bottom: 3px; }
  .connections-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, 1fr); gap: 22px; align-items: start; }
  .connection-heading { display: flex; align-items: start; gap: 12px; }
  .connection-heading > :global(svg) { color: var(--muted); margin-top: 3px; }
  .panel-header h2 { font-size: .98rem; }
  .panel-header p { font-size: .78rem; line-height: 1.5; margin: 7px 0 0; }
  .connection-body { padding: 26px 22px; }
  .connect-steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 29px; }
  .connect-steps li { display: grid; grid-template-columns: 25px minmax(0, 1fr); gap: 12px; }
  .step-number { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--line-strong); color: var(--muted); font-size: .72rem; }
  .connect-steps h3 { margin: 2px 0 0; font-size: .88rem; font-weight: 600; }
  .connect-steps p { font-size: .78rem; line-height: 1.6; margin: 8px 0 14px; }
  .command-block { display: flex; align-items: center; gap: 9px; border: 1px solid var(--line); border-radius: 7px; background: #141414; padding: 10px; color: var(--muted); }
  .command-block > :global(svg) { flex: none; }
  .command-block .connect-command { padding: 0; margin: 0; background: transparent; border: 0; color: var(--text); font-size: .71rem; white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; min-width: 0; }
  .command-block .icon-button { flex: none; }
  .stack button.primary { display: flex; align-items: center; justify-content: center; gap: 8px; justify-self: start; }
  .connection-code { font: .88rem ui-monospace, monospace; letter-spacing: .06em; }
  .connection-footnote { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--line); padding: 16px 22px; color: var(--muted); font-size: .73rem; }
  .review-machine { display: flex; flex-direction: column; align-items: center; gap: 12px; padding-bottom: 22px; }
  .machine-icon { width: 52px; height: 52px; display: grid; place-items: center; background: var(--panel-raised); border: 1px solid var(--line-strong); border-radius: 12px; color: var(--muted); }
  .machine-icon.approved { color: var(--green); background: #84b79a0a; border-color: #84b79a40; }
  .review-machine h3 { margin: 0; font-size: 1rem; }
  .request-code { font: .87rem ui-monospace, monospace; letter-spacing: .13em; color: var(--muted); }
  .review-hint { line-height: 1.6; font-size: .79rem; margin: 0 0 20px; }
  fieldset { padding: 0; border: 0; margin: 0; display: grid; }
  legend { padding: 0 0 10px; font-size: .78rem; font-weight: 600; }
  .permission-option { display: flex; align-items: start; gap: 11px; border-bottom: 1px solid var(--line); padding: 11px 0; color: var(--text); font-size: .79rem; line-height: 1.4; }
  .permission-option input { width: 15px; height: 15px; margin-top: 2px; accent-color: var(--rust-bright); }
  .permission-option small { display: block; color: var(--muted); margin-top: 3px; font-size: .7rem; }
  .approved-state { text-align: center; }
  .approved-state h3 { font-size: .93rem; color: var(--green); }
  .approved-state p { font-size: .82rem; line-height: 1.6; }
  .connections-error { padding: 16px 20px; }
  .connections-empty { min-height: 250px; color: var(--muted); }
  .connections-empty p { color: var(--text); margin-top: 17px; font-size: .9rem; }
  .connections-empty span { max-width: 320px; line-height: 1.6; }
  .show-history { display: flex; align-items: center; gap: 8px; font-size: .72rem; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  .show-history input { width: 14px; height: 14px; accent-color: var(--rust-bright); }
  .connection-device { padding: 20px; border-bottom: 1px solid var(--line); }
  .connection-device:last-child { border-bottom: 0; }
  .device-topline { display: flex; align-items: center; gap: 11px; }
  .device-topline > :global(svg) { color: var(--muted); }
  .device-topline > div { flex: 1; min-width: 0; }
  .device-topline h3 { font-size: .87rem; font-weight: 600; margin: 0 0 5px; overflow-wrap: anywhere; }
  .device-status { color: var(--muted); font-size: .69rem; }
  .device-status.authorized { color: var(--green); }
  .device-dates { display: grid; gap: 7px; padding-left: 29px; font-size: .71rem; margin: 16px 0; }
  .device-dates > div { display: flex; flex-wrap: wrap; gap: 8px; }
  dt { min-width: 54px; color: var(--muted); } dd { margin: 0; color: var(--muted); }
  .connection-device details { padding-left: 29px; color: var(--muted); font-size: .75rem; }
  summary { cursor: pointer; }
  summary > span { padding-left: 5px; }
  ul { margin: 12px 0 0; padding-left: 17px; display: grid; gap: 7px; line-height: 1.5; }
  .revoke-confirm { padding: 14px; margin-top: 17px; border: 1px solid #79433c; border-radius: 7px; background: #321e1d; font-size: .8rem; }
  .revoke-confirm p { color: #d5afaa; font-size: .76rem; line-height: 1.5; }
  .revoke-confirm > div { display: flex; justify-content: end; gap: 8px; }
  @media (max-width: 900px) { .connections-layout { grid-template-columns: 1fr; } }
  @media (max-width: 500px) { .connection-count { white-space: normal; } .connection-body { padding-inline: 16px; } .connect-steps li { grid-template-columns: 1fr; } .step-number { display: none; } }
</style>
