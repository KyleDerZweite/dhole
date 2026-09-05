<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from './api';
  import Mark from './Mark.svelte';
  import type { AccountGrant } from './types';
  export let grant: AccountGrant;
  export let onclose: () => void;
  let emailHint = '';
  let teamName = '';
  let role = '';
  let expiresAt = '';
  let displayName = '';
  let password = '';
  let loading = true;
  let busy = false;
  let done = false;
  let error = '';

  onMount(() => { void review(); });
  async function review(): Promise<void> {
    try {
      if (grant.kind === 'invitation') {
        const { invitation } = await api.invitation(grant.token);
        emailHint = invitation.emailHint;
        teamName = invitation.teamName;
        role = invitation.role;
        expiresAt = invitation.expiresAt;
      } else {
        const { reset } = await api.passwordReset(grant.token);
        emailHint = reset.emailHint;
        expiresAt = reset.expiresAt;
      }
    } catch (value) { error = value instanceof Error ? value.message : 'This setup link is unavailable.'; }
    finally { loading = false; }
  }
  async function accept(): Promise<void> {
    busy = true;
    error = '';
    const next = password;
    password = '';
    try {
      if (grant.kind === 'invitation') await api.acceptInvitation(grant.token, displayName.trim(), next);
      else await api.acceptPasswordReset(grant.token, next);
      done = true;
    } catch (value) { error = value instanceof Error ? value.message : 'Unable to finish account setup.'; }
    finally { busy = false; }
  }
</script>

<main class="auth-shell" id="main-content" tabindex="-1"><section class="auth-panel">
  <div class="brand-lockup"><Mark size={42} /><h1>{done ? 'Ready to sign in' : grant.kind === 'invitation' ? 'Set up your account' : 'Reset your password'}</h1></div>
  {#if loading}<p role="status">Checking your setup link…</p>{:else if done}<p class="lede">{grant.kind === 'invitation' ? 'Your Dhole account is ready.' : 'Your password has changed and previous access has been revoked.'} Sign in with your email and new password.</p><button class="primary" type="button" onclick={onclose}>Go to sign in</button>{:else}
    {#if error}<p class="alert error" role="alert">{error}</p>{/if}
    {#if emailHint}<p class="lede">{teamName ? `${teamName} · ` : ''}{emailHint}</p>{#if role}<p class="muted">You will join as {role === 'administrator' ? 'an administrator' : 'a member'}.</p>{/if}<form class="stack" onsubmit={(event) => { event.preventDefault(); void accept(); }}>
      {#if grant.kind === 'invitation'}<label>Your name<input bind:value={displayName} autocomplete="name" required /></label>{/if}
      <label>New password <span class="muted">15+ characters</span><input type="password" bind:value={password} autocomplete="new-password" minlength="15" required /></label>
      <button class="primary" type="submit" disabled={busy}>{grant.kind === 'invitation' ? 'Create my account' : 'Set new password'}</button>
      <p class="muted">This link expires {new Date(expiresAt).toLocaleString()}.</p>
    </form>{/if}
    <button class="link-button" type="button" disabled={busy} onclick={onclose}>Back to sign in</button>
  {/if}
</section></main>
