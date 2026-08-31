import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnvironment, AuthenticatedUser, DholeApp, DholeModule, ServerContext } from '../../lib/module.js';
import { HttpError, parseJson } from '../../lib/http.js';
import { BenchmarkDefinitionInputSchema, BenchmarkCaseInputSchema, CapabilityProbeInputSchema, ModelCatalogRecordInputSchema, PromotionDecisionInputSchema, RoutingRecommendationInputSchema, RunBenchmarkInputSchema, createOrchestrationBenchmarkFixture, createSkillBenchmarkFixture } from './types.js';
import { BenchmarkInvocationService, createBenchmarkInvocationService, parseOpenRouterCatalog } from './service.js';

export * from './types.js';
export * from './executor.js';
export * from './service.js';

function currentUser(context: Context<AppEnvironment>): AuthenticatedUser {
  const user = context.get('user');
  if (!user?.id) throw new HttpError(401, 'authentication_required', 'Authentication is required');
  return user;
}

function routeService(context: ServerContext): BenchmarkInvocationService {
  return createBenchmarkInvocationService(context);
}

/** Compile-time registered Improvement Lab module. */
export const labModule: DholeModule = {
  id: 'lab',
  register(app: DholeApp, context: ServerContext): void {
    const service = routeService(context);
    const projectAllowed = (user: AuthenticatedUser, projectId: string | undefined): boolean => !projectId || Boolean(context.database.prepare('SELECT id FROM projects WHERE id = ? AND team_id = ?').get(projectId, user.teamId));
    const benchmarkAllowed = (user: AuthenticatedUser, benchmarkId: string): boolean => Boolean(context.database.prepare('SELECT b.id FROM benchmarks b LEFT JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND (b.project_id IS NULL OR p.team_id = ?)').get(benchmarkId, user.teamId));
    const runAllowed = (user: AuthenticatedUser, runId: string): boolean => Boolean(context.database.prepare('SELECT br.id FROM benchmark_runs br JOIN benchmarks b ON b.id = br.benchmark_id LEFT JOIN projects p ON p.id = b.project_id WHERE br.id = ? AND (b.project_id IS NULL OR p.team_id = ?)').get(runId, user.teamId));
    const providerAllowed = (user: AuthenticatedUser, providerId: string): boolean => Boolean(context.database.prepare('SELECT id FROM providers WHERE id = ? AND team_id = ?').get(providerId, user.teamId));
    const modelAllowed = (user: AuthenticatedUser, modelId: string): boolean => Boolean(context.database.prepare('SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ? AND p.team_id = ?').get(modelId, user.teamId));

    app.get('/api/lab/fixtures/skill', (c) => c.json(createSkillBenchmarkFixture()));
    app.get('/api/lab/fixtures/orchestration', (c) => c.json(createOrchestrationBenchmarkFixture()));

    app.get('/api/lab/benchmarks', (c) => {
      const actor = currentUser(c);
      const requestedProject = c.req.query('projectId');
      if (!projectAllowed(actor, requestedProject)) throw new HttpError(404, 'project_not_found', 'Project not found');
      return c.json(service.listBenchmarks(requestedProject).filter((benchmark) => projectAllowed(actor, benchmark.projectId)));
    });
    app.post('/api/lab/benchmarks', async (c) => {
      const actor = currentUser(c);
      const body = await parseJson(c, BenchmarkDefinitionInputSchema);
      // Projectless benchmarks (and their runs) are installation-global
      // artifacts and may only be created by an administrator.
      if (!body.projectId && actor.role !== 'administrator') throw new HttpError(403, 'project_required', 'Members must scope benchmarks to a project');
      if (!projectAllowed(actor, body.projectId)) throw new HttpError(404, 'project_not_found', 'Project not found');
      return c.json(service.createBenchmark(body, actor.id), 201);
    });
    app.get('/api/lab/benchmarks/:benchmarkId', (c) => {
      if (!benchmarkAllowed(currentUser(c), c.req.param('benchmarkId'))) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
      const result = service.getBenchmark(c.req.param('benchmarkId'));
      if (!result) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
      return c.json({ benchmark: result, cases: service.listCases(result.id) });
    });
    app.post('/api/lab/benchmarks/:benchmarkId/cases', async (c) => {
      if (!benchmarkAllowed(currentUser(c), c.req.param('benchmarkId'))) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
      const body = await parseJson(c, BenchmarkCaseInputSchema);
      return c.json(service.addCase(c.req.param('benchmarkId'), body, currentUser(c).id), 201);
    });
    app.post('/api/lab/benchmarks/:benchmarkId/runs', async (c) => {
      const actor = currentUser(c);
      const benchmark = service.getBenchmark(c.req.param('benchmarkId'));
      if (!benchmark || !benchmarkAllowed(actor, benchmark.id)) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
      // Projectless benchmarks and runs are installation-global artifacts;
      // only administrators may create either kind of record.
      if (!benchmark.projectId && actor.role !== 'administrator') throw new HttpError(403, 'project_required', 'Members must scope benchmark runs to a project');
      const userId = actor.id;
      const bodySchema = RunBenchmarkInputSchema.omit({ benchmarkId: true, createdBy: true });
      const body = await parseJson(c, bodySchema);
      return c.json(service.runBenchmark({ ...body, benchmarkId: c.req.param('benchmarkId'), createdBy: userId }), 201);
    });
    app.get('/api/lab/runs', (c) => {
      const actor = currentUser(c);
      const benchmarkId = c.req.query('benchmarkId');
      if (benchmarkId && !benchmarkAllowed(actor, benchmarkId)) throw new HttpError(404, 'benchmark_not_found', 'Benchmark not found');
      return c.json(service.listRuns(benchmarkId).filter((run) => runAllowed(actor, run.id)));
    });
    app.get('/api/lab/runs/:runId', (c) => {
      if (!runAllowed(currentUser(c), c.req.param('runId'))) throw new HttpError(404, 'benchmark_run_not_found', 'Benchmark run not found');
      try {
        return c.json(service.compareRun(c.req.param('runId')));
      } catch {
        throw new HttpError(404, 'benchmark_run_not_found', 'Benchmark run not found');
      }
    });
    app.get('/api/lab/runs/:runId/comparison', (c) => {
      if (!runAllowed(currentUser(c), c.req.param('runId'))) throw new HttpError(404, 'benchmark_run_not_found', 'Benchmark run not found');
      try {
        return c.json(service.compareRun(c.req.param('runId')));
      } catch {
        throw new HttpError(404, 'benchmark_run_not_found', 'Benchmark run not found');
      }
    });
    app.post('/api/lab/promotions', async (c) => {
      const actor = currentUser(c);
      const userId = actor.id;
      const bodySchema = PromotionDecisionInputSchema.omit({ decidedBy: true });
      const body = await parseJson(c, bodySchema);
      if (!projectAllowed(actor, body.projectId) || (body.benchmarkRunId && !runAllowed(actor, body.benchmarkRunId))) throw new HttpError(404, 'promotion_subject_not_found', 'Promotion subject not found');
      return c.json(service.recordPromotionDecision({ ...body, decidedBy: userId }), 201);
    });
    app.get('/api/lab/promotions', (c) => {
      const actor = currentUser(c);
      return c.json(service.listPromotionDecisions(c.req.query('subjectVersionId'), actor.teamId).filter((decision) => projectAllowed(actor, decision.projectId)));
    });

    app.post('/api/lab/providers', async (c) => {
      const actor = currentUser(c);
      if (actor.role !== 'administrator') throw new HttpError(403, 'administrator_required', 'Administrator access is required');
      const body = await parseJson(c, z.object({ kind: z.string().min(1).max(80), name: z.string().min(1).max(240), baseUrl: z.url().optional(), config: z.record(z.string(), z.unknown()).optional() }));
      return c.json(service.registerProvider({ ...body, teamId: actor.teamId }, actor.id), 201);
    });

    app.post('/api/lab/models/probes', async (c) => {
      const actor = currentUser(c);
      const body = await parseJson(c, CapabilityProbeInputSchema);
      if (!modelAllowed(actor, body.modelId)) throw new HttpError(404, 'model_not_found', 'Model not found');
      return c.json(service.recordCapabilityProbe(body, actor.id), 201);
    });
    app.get('/api/lab/models/recommendations', (c) => {
      const actor = currentUser(c);
      const raw = c.req.query('requiredCapabilities');
      const requiredCapabilities = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [];
      const includeDisabled = c.req.query('includeDisabled') !== 'false';
      return c.json(service.routingRecommendations(RoutingRecommendationInputSchema.parse({ requiredCapabilities, includeDisabled })).filter((item) => providerAllowed(actor, item.providerId)));
    });
    app.get('/api/lab/models/:modelId/probes', (c) => { if (!modelAllowed(currentUser(c), c.req.param('modelId'))) throw new HttpError(404, 'model_not_found', 'Model not found'); return c.json(service.probeHistory(c.req.param('modelId'))); });
    app.post('/api/lab/models', async (c) => {
      const actor = currentUser(c);
      const body = await parseJson(c, ModelCatalogRecordInputSchema);
      if (!providerAllowed(actor, body.providerId)) throw new HttpError(404, 'provider_not_found', 'Provider not found');
      return c.json(service.registerModel(body, actor.id), 201);
    });
    app.post('/api/lab/models/catalog', async (c) => {
      const actor = currentUser(c);
      const body = await parseJson(c, z.object({ providerId: z.string().min(1).max(160), catalog: z.unknown() }));
      if (!providerAllowed(actor, body.providerId)) throw new HttpError(404, 'provider_not_found', 'Provider not found');
      return c.json(service.ingestCatalog(body.providerId, body.catalog, actor.id), 201);
    });
    app.post('/api/lab/providers/:providerId/catalog', async (c) => {
      if (!providerAllowed(currentUser(c), c.req.param('providerId'))) throw new HttpError(404, 'provider_not_found', 'Provider not found');
      const raw = await parseJson(c, z.unknown());
      const payload = raw !== null && typeof raw === 'object' && 'catalog' in raw ? (raw as { catalog: unknown }).catalog : raw;
      const entries = parseOpenRouterCatalog(payload);
      const actor = currentUser(c);
      return c.json(entries.map((entry) => service.registerModel({ providerId: c.req.param('providerId'), ...entry }, actor.id)), 201);
    });
  },
};

/** Alias used by the MCP bridge to invoke exactly the HTTP benchmark service. */
export { createBenchmarkInvocationService as benchmarkInvocationService };
