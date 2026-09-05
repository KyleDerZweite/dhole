import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, loadOverview } from './api';

const user = { id: 'u1', displayName: 'A person', email: 'person@example.test', role: 'administrator', status: 'active', teamId: 't1' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('web boundary contracts', () => {
  it('supports native sign-in without a GitHub connection and sends bootstrap proof only in its header', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ mode: 'password', password: true, bootstrap: true, bootstrapTokenRequired: true, github: false, githubLink: false })).mockResolvedValueOnce(json({ user, csrfToken: 'csrf-value' }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('sessionStorage', { setItem: vi.fn() });
    expect(await api.authMethods()).toMatchObject({ password: true, github: false, githubLink: false });
    await api.bootstrap({ email: user.email, displayName: user.displayName, password: 'test-only-password', teamName: 'Example' }, 'test-only-setup-proof');
    const options = fetcher.mock.calls[1]![1];
    expect(options.headers.get('x-dhole-bootstrap-token')).toBe('test-only-setup-proof');
    expect(options.body).not.toContain('test-only-setup-proof');
  });

  it('consumes account setup grants without browser session cookies or CSRF state', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ invitation: { emailHint: 'p***@example.test', teamName: 'Example', role: 'member', expiresAt: '2026-09-06T12:00:00.000Z' } })).mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('document', { cookie: 'dhole_csrf=another-session' });
    await api.invitation('test-only-grant');
    await api.acceptInvitation('test-only-grant', 'New member', 'test-only-password');
    await api.acceptPasswordReset('test-only-reset', 'another-test-password');
    for (const [, options] of fetcher.mock.calls) {
      expect(options.credentials).toBe('omit');
      expect(options.headers.has('x-csrf-token')).toBe(false);
    }
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ token: 'test-only-grant', displayName: 'New member', password: 'test-only-password' });
  });

  it('loads Core sessions and machines while optional modules are disabled', async () => {
    const responses: Record<string, unknown> = {
      '/api/projects': { projects: [{ id: 'p1', name: 'Project' }] },
      '/api/projects/p1/sessions': { sessions: [{ id: 's1', projectId: 'p1' }] },
      '/api/sessions/s1/snapshot': { session: { id: 's1', projectId: 'p1' }, messages: [] },
      '/api/machines': [{ id: 'm1' }],
      '/api/projects/p1/runtime-registrations': { registrations: [{ id: 'r1', machineId: 'm1' }] },
    };
    const fetcher = vi.fn(async (path: string) => {
      expect(path in responses).toBe(true);
      return json(responses[path]);
    });
    vi.stubGlobal('fetch', fetcher);
    const overview = await loadOverview(['core', 'access']);
    expect(fetcher.mock.calls.map(([path]) => path).sort()).toEqual(Object.keys(responses).sort());
    expect(overview).toMatchObject({ projects: [{ id: 'p1' }], sessions: [{ id: 's1' }], snapshots: [{ session: { id: 's1' } }], machines: [{ id: 'm1' }], runtimes: [{ id: 'r1' }], gatewaySummary: null });
  });

  it('surfaces a Core session failure instead of showing empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ projects: [{ id: 'p1', name: 'Project' }] })).mockResolvedValueOnce(json({ error: { code: 'sessions_failed', message: 'Sessions unavailable' } }, 503)));
    await expect(loadOverview(['core', 'access'])).rejects.toMatchObject({ status: 503, message: 'Sessions unavailable' });
  });

  it('uses the direct session and lease token response shapes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: 's1', projectId: 'p1', title: 'Shared work', state: 'idle' })).mockResolvedValueOnce(json({ token: 'lease-value', expiresAt: '2026-09-05T12:00:00.000Z' }));
    vi.stubGlobal('fetch', fetcher);
    expect((await api.createSession('p1', { title: 'Shared work' })).id).toBe('s1');
    expect((await api.acquireLease('s1')).token).toBe('lease-value');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/projects/p1/sessions', '/api/sessions/s1/steering/lease']);
  });

  it('reads Coordination claim intent from the server scope object', async () => {
    const response = {
      project: 'p1', now: '2026-09-05T12:00:00.000Z',
      sessions: [{ id: 'agent1', agent: 'worker', active: true }],
      claims: [{ id: 'claim1', status: 'in-progress', coordinationSessionId: 'agent1', updatedAt: '2026-09-05T12:00:00.000Z', scope: { intent: 'Repair the adapter', task: 'Fix runtime replay', files: ['src/adapter.ts'], components: [] } }],
      completed: [], conflicts: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(response)));
    expect((await api.coordination('p1')).claims[0]?.scope).toEqual(response.claims[0]!.scope);
  });

  it('rejects external navigation and unexpected GitHub authorization URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ authorizeUrl: 'https://other.example/login' })).mockResolvedValueOnce(json({ enabledModules: ['gateway'], modules: [{ id: 'gateway', dependencies: [], contributions: { navigation: [{ id: 'gateway', label: 'Gateway', path: '//other.example' }], webSockets: [], jobs: [] } }] })));
    await expect(api.linkGitHub('fixture-password')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.modules()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('sends browser device approval and user status edits with CSRF', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('document', { cookie: 'dhole_csrf=csrf-value' });
    await api.approveDevice('ABCD-EFGH', ['project:read']);
    expect(await api.updateUser('u2', { status: 'active' })).toEqual({ ok: true });
    const approval = fetcher.mock.calls[0]!;
    expect(approval[0]).toBe('/api/auth/device/approve');
    expect(JSON.parse(approval[1].body)).toEqual({ userCode: 'ABCD-EFGH', permissions: ['project:read'] });
    expect(approval[1].headers.get('x-csrf-token')).toBe('csrf-value');
    expect(fetcher.mock.calls[1]![0]).toBe('/api/users/u2');
    expect(fetcher.mock.calls[1]![1].method).toBe('PATCH');
  });
});
