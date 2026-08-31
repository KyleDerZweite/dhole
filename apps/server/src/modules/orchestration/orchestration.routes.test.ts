import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../lib/config.js';
import { createApplication } from '../../app.js';
import { OrchestrationService } from './service.js';

function config(): AppConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 4173,
    databasePath: ':memory:',
    publicOrigin: new URL('http://127.0.0.1:4173'),
    sourceUrl: new URL('http://127.0.0.1:4173'),
    allowedHosts: new Set(['127.0.0.1']),
    demo: true,
    masterKeys: new Map(),
    gatewayAllowedHosts: new Set(['127.0.0.1', 'localhost']),
  };
}

describe('orchestration routes', () => {
  it('does not expose a misleading execution start alias', async () => {
    const application = createApplication({ config: config(), seed: true });
    try {
      const login = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@demo.dhole.local', password: 'DholeDemoAdmin!2026' }),
      });
      expect(login.status).toBe(200);
      const { csrfToken } = await login.clone().json() as { csrfToken: string };
      const cookie = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''])
        .flatMap((value) => value.split(/,(?=\s*dhole_)/u))
        .map((value) => value.split(';')[0])
        .join('; ');
      const response = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/orchestration/executions/not-a-run/start', {
        method: 'POST',
        headers: { host: '127.0.0.1', cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(404);
    } finally {
      application.close();
    }
  });

  it('redacts unexpected orchestration failures behind a generic 500', async () => {
    const application = createApplication({ config: config(), seed: true });
    const original = OrchestrationService.prototype.listMachines;
    OrchestrationService.prototype.listMachines = (_projectId: string) => {
      throw new Error('provider authorization=Bearer super-secret /srv/tenant/private-key');
    };
    try {
      const login = await application.app.request('http://127.0.0.1:4173/api/auth/login', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@demo.dhole.local', password: 'DholeDemoAdmin!2026' }),
      });
      expect(login.status).toBe(200);
      const cookie = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') ?? ''])
        .flatMap((value) => value.split(/,(?=\s*dhole_)/u))
        .map((value) => value.split(';')[0])
        .join('; ');
      const response = await application.app.request('http://127.0.0.1:4173/api/projects/demo-project/orchestration/machines', {
        headers: { host: '127.0.0.1', cookie },
      });
      expect(response.status).toBe(500);
      const body = await response.json() as { error: string; message: string };
      expect(body).toEqual({ error: 'orchestration_request_failed', message: 'Request failed' });
      expect(JSON.stringify(body)).not.toContain('super-secret');
      expect(JSON.stringify(body)).not.toContain('/srv/tenant');
    } finally {
      OrchestrationService.prototype.listMachines = original;
      application.close();
    }
  });
});
