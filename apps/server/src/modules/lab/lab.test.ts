import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../lib/database.js';
import { EventStore } from '../../lib/events.js';
import { createOrchestrationBenchmarkFixture, createSkillBenchmarkFixture } from './types.js';
import { createBenchmarkInvocationService } from './service.js';

const clock = { now: () => new Date('2026-08-30T00:00:00.000Z') };
let sequence = 0;
const ids = { id: () => `lab-${++sequence}`, token: () => `token-${++sequence}` };

function setup(withEvents = false) {
  sequence = 0;
  const database = openDatabase(':memory:', clock);
  database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-1', 'Team', clock.now().toISOString());
  database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-1', 'user@example.test', 'User', 'hash', clock.now().toISOString(), clock.now().toISOString());
  database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('team-1', 'user-1', 'administrator', clock.now().toISOString());
  database.prepare('INSERT INTO projects(id, team_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-1', 'team-1', 'Project', '', 'user-1', clock.now().toISOString(), clock.now().toISOString());
  const events = withEvents ? new EventStore(database, clock, ids) : undefined;
  return { database, events, service: createBenchmarkInvocationService({ database, clock, ids, ...(events ? { events } : {}) }) };
}

function seedSkillVersion(database: ReturnType<typeof openDatabase>, id: string, projectId = 'project-1'): void {
  const skillId = `${id}-skill`;
  database.prepare('INSERT INTO skills(id, project_id, stable_key, name, created_at) VALUES (?, ?, ?, ?, ?)').run(skillId, projectId, id, id, clock.now().toISOString());
  database.prepare(`INSERT INTO skill_versions(id, skill_id, version, lifecycle, skill_markdown, manifest_json, content_hash, created_at)
    VALUES (?, ?, 1, 'draft', ?, '{}', ?, ?)`).run(id, skillId, `---\nname: ${id}\n---\n`, id, clock.now().toISOString());
}

describe('improvement lab', () => {
  it('rejects credential-bearing benchmark content before persistence', () => {
    const { database, service } = setup();
    const fixture = createSkillBenchmarkFixture();
    expect(() => service.createBenchmark({
      ...fixture,
      cases: [{ ...fixture.cases[0]!, prompt: 'Call the provider with apiKey=sk-testsecret' }],
    })).toThrow('must not contain credentials');
    expect(database.prepare('SELECT count(*) AS count FROM benchmarks').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_cases').get()).toEqual({ count: 0 });

    const benchmark = service.createBenchmark(fixture);
    expect(() => service.addCase(benchmark.id, {
      caseKey: 'nested-secret',
      prompt: 'A normal prompt',
      expected: { nested: { apiToken: 'hidden-value' } },
      fixture: {},
    })).toThrow('must not contain credentials');
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_cases WHERE benchmark_id = ?').get(benchmark.id)).toEqual({ count: 1 });
    database.close();
  });

  it('preserves normal benchmark text while checking for credentials', () => {
    const { database, service } = setup();
    const benchmark = service.createBenchmark({
      ...createSkillBenchmarkFixture(),
      stableKey: 'normal-benchmark-text',
      cases: [{
        caseKey: 'token-count',
        prompt: 'Track tokenCount for fixture@example.test without calling a provider.',
        expected: { tokenCount: 42 },
        fixture: { tokenCount: 42 },
      }],
    });
    const stored = service.listCases(benchmark.id)[0];
    expect(stored?.prompt).toBe('Track tokenCount for fixture@example.test without calling a provider.');
    expect(stored?.expected).toEqual({ tokenCount: 42 });
    expect(stored?.fixture).toEqual({ tokenCount: 42 });
    database.close();
  });

  it('audits Lab mutations with actor and target IDs without content payloads', () => {
    const { database, service } = setup();
    const benchmark = service.createBenchmark({
      ...createSkillBenchmarkFixture(),
      projectId: 'project-1',
      fixture: { fixtureMarker: 'PRIVATE_FIXTURE_MARKER' },
      cases: [{ caseKey: 'audit-case', prompt: 'PRIVATE_PROMPT_MARKER', expected: { expectedMarker: 'PRIVATE_EXPECTED_MARKER' }, fixture: { fixtureMarker: 'PRIVATE_FIXTURE_MARKER' } }],
    }, 'user-1');
    const addedCase = service.addCase(benchmark.id, { caseKey: 'added-case', prompt: 'PRIVATE_ADD_PROMPT_MARKER', expected: { expectedMarker: 'PRIVATE_ADD_EXPECTED_MARKER' }, fixture: { fixtureMarker: 'PRIVATE_ADD_FIXTURE_MARKER' } }, 'user-1');
    const provider = service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Audit provider', baseUrl: 'http://127.0.0.1:9999', config: { apiKey: 'PRIVATE_PROVIDER_SECRET' } }, 'user-1');
    const model = service.registerModel({ providerId: provider.id, modelKey: 'audit-model', displayName: 'Audit model', declaredCapabilities: {}, enabled: false }, 'user-1');
    service.recordCapabilityProbe({ modelId: model.id, capability: 'tools', outcome: 'unknown', evidence: { marker: 'PRIVATE_EVIDENCE_MARKER' } }, 'user-1');
    service.recordPromotionDecision({ subjectType: 'model', subjectVersionId: model.id, decision: 'canary', reason: 'PRIVATE_REASON_MARKER', decidedBy: 'user-1' });

    const rows = database.prepare("SELECT actor_type, actor_id, action, target_type, target_id, project_id, detail_json FROM audit_records WHERE action LIKE 'lab.%' ORDER BY rowid").all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.action)).toEqual([
      'lab.benchmark.create', 'lab.benchmark.case.add', 'lab.provider.register', 'lab.model.register', 'lab.model.probe', 'lab.promotion.decide',
    ]);
    expect(rows.map((row) => row.target_id)).toEqual([benchmark.id, addedCase.id, provider.id, model.id, model.id, model.id]);
    expect(rows.every((row) => row.actor_type === 'user' && row.actor_id === 'user-1')).toBe(true);
    expect(rows[0]?.project_id).toBe('project-1');
    const auditJson = JSON.stringify(rows);
    expect(auditJson).not.toContain('PRIVATE_PROMPT_MARKER');
    expect(auditJson).not.toContain('PRIVATE_EXPECTED_MARKER');
    expect(auditJson).not.toContain('PRIVATE_FIXTURE_MARKER');
    expect(auditJson).not.toContain('PRIVATE_EVIDENCE_MARKER');
    expect(auditJson).not.toContain('PRIVATE_REASON_MARKER');
    expect(auditJson).not.toContain('PRIVATE_PROVIDER_SECRET');
    database.close();
  });

  it('rolls back each Lab mutation when its audit insert fails', () => {
    const { database, service } = setup();
    const failAudit = () => database.exec(`CREATE TRIGGER fail_lab_audit BEFORE INSERT ON audit_records WHEN NEW.action LIKE 'lab.%' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
    const dropFailAudit = () => database.exec('DROP TRIGGER fail_lab_audit');

    failAudit();
    expect(() => service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' }, 'user-1')).toThrow('forced audit failure');
    expect(database.prepare('SELECT count(*) AS count FROM benchmarks').get()).toEqual({ count: 0 });
    dropFailAudit();

    const benchmark = service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' }, 'user-1');
    failAudit();
    expect(() => service.addCase(benchmark.id, { caseKey: 'audit-failure', prompt: 'normal', expected: { ok: true }, fixture: {} }, 'user-1')).toThrow('forced audit failure');
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_cases WHERE benchmark_id = ?').get(benchmark.id)).toEqual({ count: 1 });
    dropFailAudit();

    failAudit();
    expect(() => service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Rollback provider', baseUrl: 'http://127.0.0.1:9999' }, 'user-1')).toThrow('forced audit failure');
    expect(database.prepare("SELECT count(*) AS count FROM providers WHERE name = 'Rollback provider'").get()).toEqual({ count: 0 });
    dropFailAudit();

    const provider = service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Rollback model provider', baseUrl: 'http://127.0.0.1:9999' }, 'user-1');
    failAudit();
    expect(() => service.registerModel({ providerId: provider.id, modelKey: 'rollback-model', displayName: 'Rollback model', declaredCapabilities: {}, enabled: false }, 'user-1')).toThrow('forced audit failure');
    expect(database.prepare('SELECT count(*) AS count FROM models WHERE model_key = ?').get('rollback-model')).toEqual({ count: 0 });
    dropFailAudit();

    const model = service.registerModel({ providerId: provider.id, modelKey: 'rollback-probe-model', displayName: 'Rollback probe model', declaredCapabilities: {}, enabled: false }, 'user-1');
    failAudit();
    expect(() => service.recordCapabilityProbe({ modelId: model.id, capability: 'tools', outcome: 'supported', evidence: {} }, 'user-1')).toThrow('forced audit failure');
    expect(database.prepare('SELECT count(*) AS count FROM model_capability_probes WHERE model_id = ?').get(model.id)).toEqual({ count: 0 });
    expect(database.prepare('SELECT measured_capabilities_json FROM models WHERE id = ?').get(model.id)).toEqual({ measured_capabilities_json: '{}' });
    dropFailAudit();

    failAudit();
    expect(() => service.recordPromotionDecision({ subjectType: 'model', subjectVersionId: model.id, decision: 'reject', reason: 'rollback', decidedBy: 'user-1' })).toThrow('forced audit failure');
    expect(database.prepare('SELECT count(*) AS count FROM promotion_decisions WHERE subject_version_id = ?').get(model.id)).toEqual({ count: 0 });
    dropFailAudit();
    database.close();
  });

  it('stores deterministic skill baseline/candidate results and independent dimensions', () => {
    const { database, service } = setup();
    const benchmark = service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' });
    const run = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'skill:v1', config: { apiToken: 'secret' } }, candidate: { reference: 'skill:v2', config: {} }, createdBy: 'user-1', seed: 'same' });
    expect(run.run.state).toBe('completed');
    expect(run.ordering.quality[0]).toBe('candidate');
    expect(run.dimensions.some((row) => row.variant === 'baseline' && row.dimension === 'acceptance' && row.booleanValue === false)).toBe(true);
    expect(run.dimensions.some((row) => row.variant === 'candidate' && row.dimension === 'acceptance' && row.booleanValue === true)).toBe(true);
    expect(JSON.stringify(run.run.baseline)).not.toContain('secret');
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_dimension_results WHERE run_id = ?').get(run.run.id)).toEqual({ count: 18 });
    database.close();
  });

  it('keeps human promotion decisions append-only and does not auto-promote', () => {
    const { database, service } = setup();
    seedSkillVersion(database, 'skill-v2');
    const benchmark = service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' });
    const run = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'v1' }, candidate: { reference: 'v2' }, createdBy: 'user-1' });
    service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'skill-v2', benchmarkRunId: run.run.id, decision: 'reject', reason: 'Needs review', decidedBy: 'user-1' });
    service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'skill-v2', benchmarkRunId: run.run.id, decision: 'canary', reason: 'Limited canary', decidedBy: 'user-1' });
    expect(database.prepare('SELECT count(*) AS count FROM promotion_decisions').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT count(*) AS count FROM skill_versions').get()).toEqual({ count: 1 });
    database.close();
  });

  it('commits project benchmark completion and event atomically', () => {
    const { database, service } = setup(true);
    const benchmark = service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' });
    const comparison = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'v1' }, candidate: { reference: 'v2' }, createdBy: 'user-1' });
    expect(comparison.run.state).toBe('completed');
    expect(database.prepare('SELECT state FROM benchmark_runs WHERE id = ?').get(comparison.run.id)).toEqual({ state: 'completed' });
    expect(database.prepare("SELECT event_kind, aggregate_id FROM event_log WHERE event_kind = 'benchmark.completed'").all()).toEqual([{ event_kind: 'benchmark.completed', aggregate_id: comparison.run.id }]);
  });

  it('rolls back project benchmark completion when event append fails', () => {
    const { database, events, service } = setup(true);
    const benchmark = service.createBenchmark({ ...createSkillBenchmarkFixture(), projectId: 'project-1' });
    const append = vi.spyOn(events!, 'append').mockImplementation(() => { throw new Error('forced event append failure'); });
    expect(() => service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'v1' }, candidate: { reference: 'v2' }, createdBy: 'user-1' })).toThrow('forced event append failure');
    const run = service.listRuns(benchmark.id)[0];
    expect(run?.state).toBe('failed');
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'benchmark.completed'").get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM benchmark_case_runs WHERE run_id = ?').get(run?.id)).toEqual({ count: 2 });
    append.mockRestore();
    database.close();
  });

  it('commits project promotion row and decision event atomically', () => {
    const { database, service } = setup(true);
    seedSkillVersion(database, 'skill-v1');
    const decision = service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'skill-v1', decision: 'canary', reason: 'Authorization: Bearer abc.def password="promotion-secret"', decidedBy: 'user-1' });
    expect(database.prepare('SELECT id, decision FROM promotion_decisions').all()).toEqual([{ id: decision.id, decision: 'canary' }]);
    expect(database.prepare("SELECT event_kind, aggregate_id FROM event_log WHERE event_kind = 'candidate.decided'").all()).toEqual([{ event_kind: 'candidate.decided', aggregate_id: 'skill-v1' }]);
    const event = database.prepare("SELECT payload_json FROM event_log WHERE event_kind = 'candidate.decided'").get() as { payload_json: string };
    expect(event.payload_json).not.toContain('promotion-secret');
    expect(service.listPromotionDecisions('skill-v1')[0]?.reason).not.toContain('promotion-secret');
    expect(database.prepare('SELECT reason FROM promotion_decisions WHERE id = ?').get(decision.id)).toEqual({ reason: 'Authorization: [REDACTED] password=[REDACTED]' });
  });

  it('rolls back project promotion row when decision event append fails', () => {
    const { database, events, service } = setup(true);
    seedSkillVersion(database, 'skill-v1');
    const append = vi.spyOn(events!, 'append').mockImplementation(() => { throw new Error('forced event append failure'); });
    expect(() => service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'skill-v1', decision: 'reject', reason: 'Needs review', decidedBy: 'user-1' })).toThrow('forced event append failure');
    expect(database.prepare('SELECT count(*) AS count FROM promotion_decisions').get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_kind = 'candidate.decided'").get()).toEqual({ count: 0 });
    append.mockRestore();
    database.close();
  });

  it('rejects unknown or cross-project promotion subjects', () => {
    const { database, service } = setup();
    seedSkillVersion(database, 'skill-v1');
    expect(() => service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'missing-version', decision: 'reject', reason: 'Invalid subject', decidedBy: 'user-1' })).toThrow('Promotion subject not found');
    database.prepare('INSERT INTO projects(id, team_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-2', 'team-1', 'Other project', '', 'user-1', clock.now().toISOString(), clock.now().toISOString());
    seedSkillVersion(database, 'skill-v2', 'project-2');
    expect(() => service.recordPromotionDecision({ projectId: 'project-1', subjectType: 'skill', subjectVersionId: 'skill-v2', decision: 'reject', reason: 'Wrong project', decidedBy: 'user-1' })).toThrow('outside the requested project');
    expect(database.prepare('SELECT count(*) AS count FROM promotion_decisions').get()).toEqual({ count: 0 });
    database.close();
  });

  it('hides projectless model decisions from other provider teams', () => {
    const { database, service } = setup();
    const teamOneProvider = service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Team one', baseUrl: 'http://127.0.0.1:9001' });
    const teamOneModel = service.registerModel({ providerId: teamOneProvider.id, modelKey: 'model-one', displayName: 'Model one', declaredCapabilities: {}, enabled: false });
    service.recordPromotionDecision({ subjectType: 'model', subjectVersionId: teamOneModel.id, decision: 'canary', reason: 'Team one review', decidedBy: 'user-1' });

    database.prepare('INSERT INTO teams(id, name, created_at) VALUES (?, ?, ?)').run('team-2', 'Other team', clock.now().toISOString());
    database.prepare('INSERT INTO users(id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('user-2', 'other@example.test', 'Other', 'hash', clock.now().toISOString(), clock.now().toISOString());
    database.prepare('INSERT INTO team_members(team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('team-2', 'user-2', 'administrator', clock.now().toISOString());
    const teamTwoProvider = service.registerProvider({ teamId: 'team-2', kind: 'openai-compatible', name: 'Team two', baseUrl: 'http://127.0.0.1:9002' });
    const teamTwoModel = service.registerModel({ providerId: teamTwoProvider.id, modelKey: 'model-two', displayName: 'Model two', declaredCapabilities: {}, enabled: false });
    service.recordPromotionDecision({ subjectType: 'model', subjectVersionId: teamTwoModel.id, decision: 'canary', reason: 'Team two review', decidedBy: 'user-2' });

    expect(service.listPromotionDecisions(undefined, 'team-1').filter((decision) => decision.subjectType === 'model').map((decision) => decision.subjectVersionId)).toEqual([teamOneModel.id]);
    expect(service.listPromotionDecisions(undefined, 'team-2').filter((decision) => decision.subjectType === 'model').map((decision) => decision.subjectVersionId)).toEqual([teamTwoModel.id]);
    database.close();
  });

  it('treats projectless administrator benchmarks and runs as installation-global', () => {
    const { database, service } = setup();
    // The HTTP route permits this projectless artifact only for administrators;
    // once created, its benchmark and run are intentionally installation-global.
    const benchmark = service.createBenchmark(createSkillBenchmarkFixture());
    const run = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'v1' }, candidate: { reference: 'v2' }, createdBy: 'user-1' });
    expect(service.listBenchmarks().some((item) => item.id === benchmark.id && item.projectId === undefined)).toBe(true);
    expect(service.listRuns(benchmark.id).some((item) => item.id === run.run.id)).toBe(true);
    database.close();
  });

  it('stores orchestration acceptance, duplicate/overlap, duration and request dimensions', () => {
    const { database, service } = setup();
    const benchmark = service.createBenchmark({ ...createOrchestrationBenchmarkFixture(), projectId: 'project-1' });
    const run = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'single-agent' }, candidate: { reference: 'director-workers' }, createdBy: 'user-1', seed: 'repeatable' });
    expect(run.caseRuns).toHaveLength(2);
    expect(run.caseRuns.every((caseRun) => caseRun.status === 'passed')).toBe(true);
    expect(run.dimensions.some((row) => row.variant === 'candidate' && row.dimension === 'request_count' && row.numericValue === 3)).toBe(true);
    expect(run.dimensions.some((row) => row.variant === 'candidate' && row.dimension === 'duration_ms' && row.numericValue === 72)).toBe(true);
    expect(run.dimensions.some((row) => row.variant === 'candidate' && row.dimension === 'duplicate_work')).toBe(true);
    const repeat = service.runBenchmark({ benchmarkId: benchmark.id, baseline: { reference: 'single-agent' }, candidate: { reference: 'director-workers' }, createdBy: 'user-1', seed: 'repeatable' });
    expect(repeat.caseRuns.map((caseRun) => [caseRun.variant, caseRun.durationMs, caseRun.requestCount])).toEqual(run.caseRuns.map((caseRun) => [caseRun.variant, caseRun.durationMs, caseRun.requestCount]));
    database.close();
  });

  it('keeps model intake measured and recommendation-only', () => {
    const { database, service } = setup();
    const provider = service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Fixture', baseUrl: 'http://127.0.0.1:9999', config: { apiKey: 'do-not-store' } });
    const model = service.registerModel({ providerId: provider.id, modelKey: 'fixture-model', displayName: 'Fixture model', declaredCapabilities: { tools: true }, enabled: false });
    service.recordCapabilityProbe({ modelId: model.id, capability: 'tools', outcome: 'supported', latencyMs: 5, evidence: { apiToken: 'hidden' } });
    service.recordCapabilityProbe({ modelId: model.id, capability: 'vision', outcome: 'unknown', evidence: {} });
    const recommendation = service.routingRecommendations({ requiredCapabilities: ['tools', 'vision'], includeDisabled: true });
    expect(recommendation[0]?.capabilityStatus).toEqual({ tools: 'supported', vision: 'unknown' });
    expect(recommendation[0]?.enabled).toBe(false);
    expect(database.prepare('SELECT count(*) AS count FROM model_capability_probes').get()).toEqual({ count: 2 });
    expect(JSON.stringify(database.prepare('SELECT config_json FROM providers').get())).not.toContain('do-not-store');
    database.close();
  });

  it('rejects credentialed provider URLs and bounds/redacts probe evidence', () => {
    const { database, service } = setup();
    expect(() => service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'FTP', baseUrl: 'ftp://example.test/api' })).toThrow('HTTP(S)');
    expect(() => service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Credentialed', baseUrl: 'https://user:password@example.test/api' })).toThrow('without embedded credentials');
    expect(database.prepare('SELECT count(*) AS count FROM providers').get()).toEqual({ count: 0 });
    const provider = service.registerProvider({ teamId: 'team-1', kind: 'openai-compatible', name: 'Fixture', baseUrl: 'http://127.0.0.1:9999' });
    const model = service.registerModel({ providerId: provider.id, modelKey: 'fixture-model', displayName: 'Fixture model', declaredCapabilities: {}, enabled: false });
    service.recordCapabilityProbe({ modelId: model.id, capability: 'tools', outcome: 'unknown', errorSummary: 'Bearer abc.def password="probe-secret"', evidence: { nested: { apiToken: 'hidden-token', deep: { password: 'hidden-password', payload: 'x'.repeat(30_000) } } } });
    const stored = database.prepare('SELECT error_summary, evidence_json FROM model_capability_probes WHERE model_id = ?').get(model.id) as { error_summary: string; evidence_json: string };
    expect(stored.error_summary).not.toContain('probe-secret');
    expect(stored.evidence_json).not.toContain('hidden-token');
    expect(stored.evidence_json).not.toContain('hidden-password');
    expect(stored.evidence_json.length).toBeLessThan(20_000);
    const history = service.probeHistory(model.id);
    expect(history[0]?.evidence).toMatchObject({ nested: { apiToken: '[REDACTED]' } });
    expect(history[0]?.errorSummary).not.toContain('probe-secret');
    database.close();
  });
});
