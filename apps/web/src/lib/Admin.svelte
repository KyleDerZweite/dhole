<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Check, Copy, KeyRound, MailPlus, RefreshCw, Search, ShieldCheck, UserRound, UsersRound, X } from '@lucide/svelte';
  import { api } from './api';
  import Select from './Select.svelte';
  import type { User } from './types';

  export let user: User;
  let users: User[] = [];
  let loading = true;
  let error = '';
  let message = '';
  let search = '';
  let status = 'all';
  let role = 'all';
  let busy = false;
  let dialogError = '';
  let inviteDialog: HTMLDialogElement;
  let memberDialog: HTMLDialogElement;
  let emailInput: HTMLInputElement;
  let inviteEmail = '';
  let inviteRole = 'member';
  let selected: User | null = null;
  let editedRole = 'member';
  let confirmation: 'role' | 'disable' | null = null;
  let grant: { url: string; expiresAt: string; recipient: string; kind: 'invitation' | 'reset' } | null = null;
  let copied = false;
  const roles = [{ value: 'member', label: 'Member' }, { value: 'administrator', label: 'Administrator' }];

  $: active = users.filter((item) => item.status === 'active');
  $: administratorCount = active.filter((item) => item.role === 'administrator').length;
  $: filtered = users.filter((item) => (status === 'all' || item.status === status) && (role === 'all' || item.role === role) && `${item.displayName} ${item.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  $: lastAdministrator = selected?.role === 'administrator' && selected.status === 'active' && administratorCount <= 1;

  const displayError = (value: unknown) => value instanceof Error ? value.message : 'Unable to complete this action.';
  const date = (value?: string) => value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unavailable';
  const initials = (value: string) => value.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try { users = await api.users(); }
    catch (value) { error = displayError(value); }
    finally { loading = false; }
  }

  function clearDialog(): void { dialogError = ''; grant = null; copied = false; confirmation = null; }
  async function openInvite(): Promise<void> {
    clearDialog();
    inviteEmail = '';
    inviteRole = 'member';
    inviteDialog.showModal();
    await tick();
    emailInput?.focus();
  }
  function openMember(item: User): void {
    clearDialog();
    selected = item;
    editedRole = item.role;
    memberDialog.showModal();
  }
  function close(dialog: HTMLDialogElement): void { if (!busy) { dialog.close(); clearDialog(); } }

  async function invite(): Promise<void> {
    if (busy || !['member', 'administrator'].includes(inviteRole)) return;
    busy = true;
    dialogError = '';
    try {
      const result = await api.inviteUser(inviteEmail.trim(), inviteRole as User['role']);
      grant = { url: result.invitation.setupUrl, expiresAt: result.invitation.expiresAt, recipient: result.invitation.email, kind: 'invitation' };
    } catch (value) { dialogError = displayError(value); }
    finally { busy = false; }
  }

  async function update(changes: { role?: User['role']; status?: User['status'] }): Promise<void> {
    if (!selected || busy || selected.id === user.id) return;
    busy = true;
    dialogError = '';
    try {
      const target = selected;
      await api.updateUser(target.id, changes);
      selected = { ...target, ...changes };
      users = users.map((item) => item.id === target.id ? { ...item, ...changes } : item);
      confirmation = null;
      message = changes.role ? `${target.displayName} is now ${changes.role === 'administrator' ? 'an administrator' : 'a member'}. Their previous access has been revoked.` : changes.status === 'disabled' ? `${target.displayName}'s account is disabled. Their previous access has been revoked.` : `${target.displayName}'s account is active. They can sign in again.`;
      memberDialog.close();
      clearDialog();
      await refresh();
    } catch (value) { dialogError = displayError(value); }
    finally { busy = false; }
  }

  async function resetPassword(): Promise<void> {
    if (!selected || busy || selected.status !== 'active' || selected.role !== 'member') return;
    busy = true;
    dialogError = '';
    try {
      const result = await api.resetUserPassword(selected.id);
      grant = { url: result.reset.setupUrl, expiresAt: result.reset.expiresAt, recipient: selected.email, kind: 'reset' };
    } catch (value) { dialogError = displayError(value); }
    finally { busy = false; }
  }

  async function copyGrant(): Promise<void> {
    if (!grant) return;
    try { await navigator.clipboard.writeText(grant.url); copied = true; }
    catch { dialogError = 'Copy is unavailable. Select and copy the link below.'; }
  }

  onMount(() => { void refresh(); });
</script>

<section class="page-heading">
  <div><span class="eyebrow">ACCESS</span><h1>People &amp; access</h1><p class="muted">Manage accounts and who can administer this workspace.</p></div>
  <button class="primary" type="button" onclick={() => void openInvite()}><MailPlus size={17} aria-hidden="true" /> Invite a person</button>
</section>
{#if error}<div class="alert error" role="alert">{error}<button class="secondary compact" type="button" onclick={() => void refresh()}>Try again</button></div>{/if}
{#if message}<div class="alert success" role="status"><Check size={16} aria-hidden="true" />{message}<button class="icon-button dismiss" type="button" aria-label="Dismiss notification" onclick={() => { message = ''; }}><X size={16} /></button></div>{/if}
<div class="people-metrics" aria-label="Account summary">
  <div><UsersRound size={18} aria-hidden="true" /><span>Active people<strong>{loading ? '…' : active.length}</strong></span></div>
  <div><ShieldCheck size={18} aria-hidden="true" /><span>Administrators<strong>{loading ? '…' : administratorCount}</strong></span></div>
  <div><UserRound size={18} aria-hidden="true" /><span>Disabled accounts<strong>{loading ? '…' : users.filter((item) => item.status === 'disabled').length}</strong></span></div>
</div>
<section class="panel people-panel" aria-busy={loading}>
  <header class="panel-header"><div><h2>People <span class="muted">{users.length}</span></h2><p class="muted">Members use the projects they belong to. Administrators manage workspace access.</p></div><button class="secondary compact" type="button" disabled={loading || busy} onclick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" /> Refresh</button></header>
  <div class="people-toolbar">
    <label class="people-search"><span class="sr-only">Search people by name or email</span><Search size={17} aria-hidden="true" /><input type="search" bind:value={search} placeholder="Search name or email…" /></label>
    <label><span class="sr-only">Filter by role</span><Select bind:value={role} aria-label="Filter by role" options={[{ value: 'all', label: 'All roles' }, ...roles]} /></label>
    <label><span class="sr-only">Filter by status</span><Select bind:value={status} aria-label="Filter by status" options={[{ value: 'all', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'disabled', label: 'Disabled' }]} /></label>
  </div>
  {#if loading && !users.length}<div class="empty" role="status"><p>Loading people…</p></div>
  {:else if !filtered.length}<div class="empty"><UsersRound size={26} aria-hidden="true" /><p>{users.length ? 'No people match these filters' : 'No accounts to show'}</p><span class="muted">{users.length ? 'Try another name, email, role, or status.' : 'Refresh to load the workspace accounts.'}</span>{#if search || status !== 'all' || role !== 'all'}<button class="link-button" type="button" onclick={() => { search = ''; status = 'all'; role = 'all'; }}>Clear filters</button>{/if}</div>
  {:else}<div class="people-table-wrap"><table class="people-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col" class="joined-column">Joined</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
    {#each filtered as item (item.id)}<tr><td><div class="person-identity"><span class="person-avatar" aria-hidden="true">{initials(item.displayName)}</span><span><strong>{item.displayName}{#if item.id === user.id}<span class="you-label">You</span>{/if}</strong><small>{item.email}</small></span></div></td><td><span class="person-role">{#if item.role === 'administrator'}<ShieldCheck size={14} aria-hidden="true" />{/if}{item.role === 'administrator' ? 'Administrator' : 'Member'}</span></td><td><span class={`person-status ${item.status}`}><span></span>{item.status === 'active' ? 'Active' : item.status === 'pending' ? 'Pending' : 'Disabled'}</span></td><td class="joined-column muted">{date(item.createdAt)}</td><td><button class="secondary compact" type="button" aria-label={`Manage ${item.displayName}`} disabled={busy} onclick={() => openMember(item)}>Manage</button></td></tr>{/each}
  </tbody></table></div><div class="people-footer">Showing {filtered.length} of {users.length} people</div>{/if}
</section>
<p class="access-note"><ShieldCheck size={15} aria-hidden="true" /> Machine approvals and their permissions are managed in <a href="/connect">Connections</a>.</p>

{#snippet grantContent()}
  {#if grant}<div class="grant-result"><span class="grant-check"><Check size={22} aria-hidden="true" /></span><h3>{grant.kind === 'invitation' ? 'Invitation ready' : 'Reset link ready'}</h3><p class="muted">Share this private link with <strong>{grant.recipient}</strong>. {grant.kind === 'invitation' ? 'They will choose their own password. Their account appears here after they join.' : 'They will choose a new password. Their previous access is revoked when they use the link.'}</p><label>Private setup link<input class="grant-input" readonly value={grant.url} onclick={(event) => event.currentTarget.select()} /></label><button class="secondary" type="button" onclick={() => void copyGrant()}>{#if copied}<Check size={16} aria-hidden="true" /> Copied{:else}<Copy size={16} aria-hidden="true" /> Copy link{/if}</button><p class="muted grant-expiry">Expires {new Date(grant.expiresAt).toLocaleString()}. This link is only shown until you close this dialog.</p>{#if copied}<span class="sr-only" role="status">Setup link copied.</span>{/if}</div>{/if}
{/snippet}

<dialog bind:this={inviteDialog} class="modal access-modal" aria-labelledby="invite-person-title" oncancel={(event) => { if (busy) event.preventDefault(); }} onclose={clearDialog}>
  <header class="modal-header"><h2 id="invite-person-title">Invite a person</h2><button class="icon-button" type="button" aria-label="Close invitation" disabled={busy} onclick={() => close(inviteDialog)}><X size={19} /></button></header>
  {#if dialogError}<p class="alert error" role="alert">{dialogError}</p>{/if}
  {#if grant}{@render grantContent()}{:else}<form class="stack" onsubmit={(event) => { event.preventDefault(); void invite(); }}><p class="muted">Create a private invitation. No email is sent automatically.</p><label>Email address<input bind:this={emailInput} type="email" autocomplete="email" bind:value={inviteEmail} required disabled={busy} /></label><label>Workspace role<Select bind:value={inviteRole} options={roles} disabled={busy} aria-label="Workspace role" /></label><p class="role-description muted">{inviteRole === 'administrator' ? 'Administrators can invite people, manage accounts, and administer the workspace.' : 'Members can work in projects they belong to. They cannot manage workspace access.'}</p><div class="dialog-actions"><button class="secondary" type="button" disabled={busy} onclick={() => close(inviteDialog)}>Cancel</button><button class="primary" type="submit" disabled={busy}><MailPlus size={16} aria-hidden="true" />{busy ? 'Creating invitation…' : 'Create invitation'}</button></div></form>{/if}
</dialog>

<dialog bind:this={memberDialog} class="modal access-modal" aria-labelledby="manage-person-title" oncancel={(event) => { if (busy) event.preventDefault(); }} onclose={clearDialog}>
  <header class="modal-header"><h2 id="manage-person-title">Manage person</h2><button class="icon-button" type="button" aria-label="Close person details" disabled={busy} onclick={() => close(memberDialog)}><X size={19} /></button></header>
  {#if dialogError}<p class="alert error" role="alert">{dialogError}</p>{/if}
  {#if grant}{@render grantContent()}{:else if selected}
    <div class="member-heading"><span class="person-avatar" aria-hidden="true">{initials(selected.displayName)}</span><div><h3>{selected.displayName}</h3><p class="muted">{selected.email}</p></div></div>
    {#if confirmation}<div class="confirm-action"><h3>{confirmation === 'disable' ? `Disable ${selected.displayName}'s account?` : `Change ${selected.displayName}'s role?`}</h3><p class="muted">{confirmation === 'disable' ? 'They will lose access to this workspace. Their browser sessions, machine connections, and outstanding setup links will be revoked.' : `Their role will change to ${editedRole}. Their browser sessions, machine connections, and outstanding setup links will be revoked. They will need to sign in and approve their machines again.`}</p><div class="dialog-actions"><button class="secondary" type="button" disabled={busy} onclick={() => { confirmation = null; }}>Cancel</button><button class={confirmation === 'disable' ? 'danger-button' : 'primary'} type="button" disabled={busy} onclick={() => void update(confirmation === 'disable' ? { status: 'disabled' } : { role: editedRole as User['role'] })}>{busy ? 'Saving…' : confirmation === 'disable' ? 'Disable account' : 'Change role'}</button></div></div>
    {:else}<div class="stack member-settings"><label>Workspace role<Select bind:value={editedRole} options={roles} aria-label={`Role for ${selected.displayName}`} disabled={busy || selected.id === user.id || lastAdministrator} /></label>{#if editedRole !== selected.role}<button class="secondary" type="button" disabled={busy} onclick={() => { confirmation = 'role'; }}>Review role change</button>{/if}
      <div class="account-access-row"><div><strong>Account access</strong><p class="muted">{selected.status === 'disabled' ? 'Disabled. This person cannot sign in.' : selected.status === 'pending' ? 'Pending approval.' : 'Active. This person can sign in.'}</p></div>{#if selected.id !== user.id}{#if selected.status !== 'active'}<button class="secondary compact" type="button" disabled={busy} onclick={() => void update({ status: 'active' })}>{busy ? 'Saving…' : selected.status === 'pending' ? 'Approve' : 'Enable account'}</button>{:else}<button class="danger-button compact" type="button" disabled={busy || lastAdministrator} onclick={() => { confirmation = 'disable'; }}>Disable account</button>{/if}{/if}</div>
      {#if selected.id === user.id}<p class="muted">Your own role and account status are protected here. Manage your password in <a class="inline-link" href="/account">Your account</a>.</p>{:else if lastAdministrator}<p class="muted">Keep at least one active administrator.</p>{/if}
      {#if selected.role === 'member' && selected.status === 'active'}<div class="account-access-row"><div><strong>Password recovery</strong><p class="muted">Create a private link so this person can choose a new password.</p></div><button class="secondary compact" type="button" disabled={busy} onclick={() => void resetPassword()}><KeyRound size={15} aria-hidden="true" />{busy ? 'Creating…' : 'Create reset link'}</button></div>{:else if selected.role === 'administrator' && selected.id !== user.id}<p class="muted">Administrators manage their own password recovery.</p>{/if}
    </div>{/if}
  {/if}
</dialog>

<style>
  button.primary, button.secondary, button.danger-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  .people-metrics { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: 10px; background: var(--panel); margin-bottom: 24px; }
  .people-metrics > div { display: flex; gap: 13px; padding: 22px; color: var(--muted); border-right: 1px solid var(--line); }
  .people-metrics > div:last-child { border: 0; }
  .people-metrics span { display: grid; gap: 8px; font-size: .78rem; }
  .people-metrics strong { color: var(--text); font-size: 1.7rem; line-height: 1; font-weight: 600; }
  .people-panel .panel-header { align-items: center; }
  .panel-header h2 > span { margin-left: 6px; font-size: .82rem; font-weight: 400; }
  .panel-header p { margin: 8px 0 0; font-size: .78rem; line-height: 1.5; }
  .people-toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) 160px 160px; gap: 10px; padding: 18px 20px; }
  .people-search { position: relative; }
  .people-search :global(svg) { position: absolute; top: 12px; left: 12px; color: var(--muted); }
  .people-search input { padding-left: 38px; }
  .people-table-wrap { overflow-x: auto; }
  .people-table { width: 100%; border-collapse: collapse; font-size: .79rem; text-align: left; }
  .people-table th { color: var(--muted); font-size: .71rem; font-weight: 500; padding: 12px 20px; border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); }
  .people-table td { padding: 18px 20px; border-bottom: 1px solid var(--line); }
  .people-table tbody tr:hover { background: #ffffff03; }
  .people-table td:last-child { text-align: right; }
  .person-identity { display: flex; align-items: center; gap: 11px; }
  .person-identity > span:last-child { display: grid; gap: 4px; }
  .person-identity strong { display: flex; align-items: center; gap: 7px; font-weight: 600; white-space: nowrap; }
  .person-identity small { color: var(--muted); font-size: .75rem; }
  .person-avatar { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 50%; background: #34302d; color: #d6b5a2; font-size: .76rem; font-weight: 650; }
  .you-label { color: var(--muted); padding: 2px 5px; background: var(--panel-raised); border: 1px solid var(--line); border-radius: 4px; font-size: .6rem; font-weight: 400; }
  .person-role, .person-status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .person-role { color: var(--muted); }
  .person-status { border: 1px solid var(--line); border-radius: 5px; padding: 4px 7px; font-size: .7rem; color: var(--muted); }
  .person-status > span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .person-status.active { color: var(--green); background: #84b79a08; }
  .person-status.pending { color: var(--amber); }
  .people-footer { padding: 14px 20px; color: var(--muted); font-size: .73rem; }
  .access-note { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); margin-top: 17px; font-size: .75rem; }
  .access-note a, .inline-link { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
  .access-modal { width: min(530px, calc(100% - 32px)); }
  .access-modal p { line-height: 1.55; font-size: .82rem; }
  .role-description { margin-top: -3px; }
  .dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; margin-top: 12px; }
  .member-heading { display: flex; align-items: center; gap: 12px; padding-bottom: 22px; margin-bottom: 20px; border-bottom: 1px solid var(--line); }
  .member-heading h3 { margin: 0; font-size: 1rem; }
  .member-heading p { margin: 4px 0 0; }
  .member-settings { gap: 20px; }
  .account-access-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-top: 1px solid var(--line); padding-top: 19px; }
  .account-access-row strong { font-size: .84rem; }
  .account-access-row p { margin: 5px 0 0; }
  .account-access-row button { flex: none; }
  .confirm-action h3 { font-size: 1rem; }
  .grant-result { display: grid; gap: 12px; }
  .grant-result h3, .grant-result p { margin: 0; }
  .grant-result .secondary { justify-self: start; }
  .grant-check { display: grid; place-items: center; width: 42px; height: 42px; background: #84b79a12; color: var(--green); border-radius: 50%; }
  .grant-input { font: .75rem ui-monospace, monospace; }
  .grant-expiry { font-size: .73rem !important; }
  @media (max-width: 1050px) { .joined-column { display: none; } .people-table td, .people-table th { padding-inline: 14px; } }
  @media (max-width: 650px) { .people-metrics > div { padding: 15px 10px; gap: 7px; } .people-metrics > div > :global(svg) { display: none; } .people-metrics strong { font-size: 1.4rem; } .people-metrics span { font-size: .68rem; } .people-toolbar { grid-template-columns: 1fr 1fr; padding: 14px; } .people-search { grid-column: 1 / -1; } .people-table { min-width: 550px; } .account-access-row { align-items: start; flex-direction: column; } .panel-header { padding-inline: 14px; } }
</style>
