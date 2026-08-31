import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../lib/events.js';
import { openDatabase } from '../lib/database.js';
import { secureIds, systemClock } from '../lib/clock.js';
import { verifyPassword } from '../lib/security.js';
import type { ServerContext } from '../lib/module.js';
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, DEMO_CREDENTIALS, DEMO_IDS, DEMO_MEMBER_EMAIL, DEMO_MEMBER_PASSWORD, seedDemo } from './index.js';

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function context(): ServerContext {
  const database = openDatabase(':memory:', systemClock);
  databases.push(database);
  return {
    database,
    clock: systemClock,
    ids: secureIds,
    events: new EventStore(database, systemClock, secureIds),
    config: {
      environment: 'test', host: '127.0.0.1', port: 4173, databasePath: ':memory:', publicOrigin: new URL('http://127.0.0.1:4173'),
      allowedHosts: new Set(['127.0.0.1']), demo: true, masterKeys: new Map(), gatewayAllowedHosts: new Set(['127.0.0.1']),
    },
  };
}

describe('offline demo seed', () => {
  it('is idempotent and creates the complete data shape', async () => {
    const server = context();
    const first = seedDemo(server);
    const second = seedDemo(server);
    expect(first.seeded).toBe(true);
    expect(second.seeded).toBe(false);
    expect(second.ids).toEqual(DEMO_IDS);
    expect(second.counts).toEqual(first.counts);
    expect(first.counts.users).toBe(2);
    expect(first.counts.teamMembers).toBe(2);
    expect(first.counts.projects).toBe(1);
    expect(first.counts.repositories).toBe(1);
    expect(first.counts.runtimes).toBe(4);
    expect(first.counts.participants).toBe(2);
    expect(first.counts.agents).toBe(4);
    expect(first.counts.edges).toBe(3);
    expect(first.counts.approvals).toBe(1);
    expect(first.counts.conflicts).toBe(1);
    expect(first.counts.gatewayRequests).toBe(3);
    expect(first.counts.benchmarks).toBe(2);
    expect(first.counts.benchmarkRuns).toBe(2);
    expect(first.counts.memoryGenerations).toBe(2);
    expect(first.counts.memoryProposals).toBe(1);
    expect(server.database.prepare('SELECT count(*) AS count FROM event_log WHERE project_id = ?').get(DEMO_IDS.project)).toEqual({ count: 21 });
    const approval = server.database.prepare('SELECT state, expires_at FROM approvals WHERE id = ?').get(DEMO_IDS.approval) as { state: string; expires_at: string };
    expect(approval.state).toBe('pending');
    expect(Date.parse(approval.expires_at) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);

    const users = server.database.prepare('SELECT email, password_hash FROM users WHERE id IN (?, ?) ORDER BY email').all(DEMO_IDS.admin, DEMO_IDS.member) as Array<{ email: string; password_hash: string }>;
    expect(users.map((user) => user.email)).toEqual([DEMO_ADMIN_EMAIL, DEMO_MEMBER_EMAIL]);
    expect(await verifyPassword(DEMO_ADMIN_PASSWORD, users[0]!.password_hash)).toBe(true);
    expect(await verifyPassword(DEMO_MEMBER_PASSWORD, users[1]!.password_hash)).toBe(true);
    expect(DEMO_CREDENTIALS.administrator.email).toBe(DEMO_ADMIN_EMAIL);
    expect(DEMO_CREDENTIALS.member.email).toBe(DEMO_MEMBER_EMAIL);
    expect(server.database.pragma('foreign_key_check')).toEqual([]);
  });

  it('never seeds production', () => {
    const server = context();
    server.config = { ...server.config, environment: 'production' };
    expect(() => seedDemo(server)).toThrow(/disabled in production/);
    expect(server.database.prepare('SELECT count(*) AS count FROM teams').get()).toEqual({ count: 0 });
  });
});
