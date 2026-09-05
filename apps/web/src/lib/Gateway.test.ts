import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Gateway from './Gateway.svelte';
import type { User } from './types';

const member: User = { id: 'user-1', email: 'member@example.test', displayName: 'Member', role: 'member', status: 'active', teamId: 'team-1' };

describe('Gateway access and credential forms', () => {
  it('shows read-only guidance without credential forms to a member', () => {
    const html = render(Gateway, { props: { user: member } }).body;
    expect(html).toContain('An administrator manages connections');
    expect(html).not.toContain('name="managementSecret"');
    expect(html).not.toContain('Create connection');
    expect(html).toContain('Loading gateway data');
    expect(html).not.toContain('0 stored matches');
  });

  it('uses labeled password inputs for administrator credential entry', () => {
    const html = render(Gateway, { props: { user: { ...member, role: 'administrator' } } }).body;
    expect(html).toMatch(/Management credential<input[^>]*name="managementSecret"[^>]*type="password"/);
    expect(html).toMatch(/Catalog credential, if required<input[^>]*name="catalogSecret"[^>]*type="password"/);
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('cleared from this form on submit');
  });
});
