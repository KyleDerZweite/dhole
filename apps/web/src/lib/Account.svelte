<script lang="ts">
  import { Check, GitBranch, KeyRound, LockKeyhole, ShieldCheck, UserRound } from '@lucide/svelte';
  import { api } from './api';
  import type { User } from './types';
  export let user: User;
  export let githubLink = false;
  let linkPassword = '';
  let currentPassword = '';
  let newPassword = '';
  let busy = false;
  let error = '';
  let message = '';

  async function link(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    const password = linkPassword;
    linkPassword = '';
    try { const result = await api.linkGitHub(password); location.assign(result.authorizeUrl); }
    catch (value) { error = value instanceof Error ? value.message : 'Could not start GitHub linking.'; busy = false; }
  }

  async function changePassword(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    const previous = currentPassword;
    const next = newPassword;
    currentPassword = '';
    newPassword = '';
    try { await api.changePassword(previous, next); message = 'Password changed. Dhole signed out your other browser sessions and revoked machine access. Approve your machines again to reconnect your agents.'; }
    catch (value) { error = value instanceof Error ? value.message : 'Could not change your password.'; }
    finally { busy = false; }
  }
</script>

<section class="page-heading"><div><span class="eyebrow">ACCESS</span><h1>Your account</h1><p class="muted">Manage your sign-in and connected accounts.</p></div></section>
{#if error}<p class="alert error" role="alert">{error}</p>{/if}
{#if message}<p class="alert success" role="status"><Check size={17} aria-hidden="true" />{message}</p>{/if}
<div class="account-layout">
  <section class="panel identity-panel"><div class="identity-avatar" aria-hidden="true"><UserRound size={29} /></div><h2>{user.displayName}</h2><p class="muted account-email">{user.email}</p><span class="account-role"><ShieldCheck size={14} aria-hidden="true" />{user.role === 'administrator' ? 'Administrator' : 'Member'}</span><dl><div><dt>Account status</dt><dd class:active={user.status === 'active'}>{user.status === 'active' ? 'Active' : user.status === 'pending' ? 'Pending' : 'Disabled'}</dd></div><div><dt>Sign-in method</dt><dd>Email &amp; password</dd></div>{#if user.createdAt}<div><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</dd></div>{/if}</dl><a class="secondary account-button" href="/connect">Manage machine access</a></section>
  <div class="account-sections">
    <section class="panel security-panel"><header class="panel-header"><div class="account-section-heading"><KeyRound size={20} aria-hidden="true" /><div><h2>Password &amp; security</h2><p class="muted">Sign in with your email and password.</p></div></div></header><div class="account-section-body"><details><summary>Change password</summary><div class="password-impact"><LockKeyhole size={17} aria-hidden="true" /><p>Changing your password signs out other browsers and revokes machine access. Approve your machines again afterward.</p></div><form class="stack" onsubmit={(event) => { event.preventDefault(); void changePassword(); }}>
      <label>Current password<input type="password" bind:value={currentPassword} autocomplete="current-password" required disabled={busy} /></label>
      <label>New password<input type="password" bind:value={newPassword} autocomplete="new-password" minlength="15" required disabled={busy} aria-describedby="password-help" /></label><p id="password-help" class="muted password-help">Use at least 15 characters. A few unrelated words work well.</p>
      <button class="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </form></details></div></section>
    {#if githubLink || user.github}<section class="panel"><header class="panel-header"><div class="account-section-heading"><GitBranch size={20} aria-hidden="true" /><div><h2>GitHub</h2><p class="muted">Link GitHub to use its repository features.</p></div></div><span class="status-pill">{user.github ? 'Connected' : 'Not connected'}</span></header><div class="account-section-body">
      {#if user.github}<p>Connected as <strong>{user.github.login}</strong>.</p><p class="muted">You sign in to Dhole with your email and password. Project access is managed separately.</p>{:else}<p class="muted">Link GitHub when you need repository features. Local projects and other Git hosts work without it.</p><details><summary>Connect GitHub</summary><form class="stack github-form" onsubmit={(event) => { event.preventDefault(); void link(); }}><label>Confirm your password<input type="password" bind:value={linkPassword} autocomplete="current-password" required disabled={busy} /></label><button class="secondary" type="submit" disabled={busy}><GitBranch size={16} aria-hidden="true" />{busy ? 'Connecting…' : 'Continue to GitHub'}</button></form></details>{/if}
    </div></section>{/if}
  </div>
</div>

<style>
  .account-layout { display: grid; grid-template-columns: minmax(230px, .7fr) minmax(0, 1.5fr); gap: 22px; align-items: start; max-width: 1100px; }
  .identity-panel { padding: 28px 24px 24px; text-align: center; }
  .identity-avatar { display: grid; place-items: center; width: 62px; height: 62px; margin: 0 auto 17px; border: 1px solid #5d4132; border-radius: 50%; background: #38291f; color: #dca17c; }
  .identity-panel h2 { margin: 0; font-size: 1.15rem; font-weight: 600; }
  .account-email { font-size: .82rem; overflow-wrap: anywhere; margin: 7px 0 15px; }
  .account-role { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 5px; padding: 5px 8px; color: var(--muted); font-size: .73rem; }
  dl { border-top: 1px solid var(--line); padding-top: 20px; margin: 25px 0 20px; display: grid; gap: 15px; }
  dl > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; text-align: left; font-size: .74rem; }
  dt { color: var(--muted); } dd { margin: 0; } dd.active { color: var(--green); }
  .account-button { display: block; font-size: .78rem; }
  .account-sections { display: grid; gap: 20px; }
  .account-section-heading { display: flex; gap: 12px; }
  .account-section-heading > :global(svg) { color: var(--muted); margin-top: 3px; flex: none; }
  .account-section-heading h2 { font-size: .95rem; }
  .account-section-heading p { margin: 7px 0 0; font-size: .79rem; line-height: 1.5; }
  .account-section-body { padding: 22px; font-size: .83rem; line-height: 1.6; }
  .account-section-body > p:first-child { margin-top: 0; }
  summary { cursor: pointer; color: var(--text); font-weight: 600; }
  .password-impact { display: flex; align-items: start; gap: 10px; color: var(--muted); padding: 15px 0 18px; }
  .password-impact > :global(svg) { margin-top: 3px; flex: none; color: var(--amber); }
  .password-impact p { margin: 0; font-size: .79rem; }
  .stack { max-width: 430px; }
  .stack button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; justify-self: start; }
  .password-help { font-size: .75rem; margin: -5px 0 0; }
  .github-form { margin-top: 18px; }
  @media (max-width: 780px) { .account-layout { grid-template-columns: 1fr; } .identity-panel { text-align: left; display: grid; grid-template-columns: auto 1fr; gap: 6px 17px; } .identity-avatar { grid-row: span 3; margin: 0; } .account-email { margin: 0; } .account-role { justify-self: start; } dl, .account-button { grid-column: 1 / -1; } dl { margin-block: 17px 7px; } }
</style>
