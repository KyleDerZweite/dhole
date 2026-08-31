import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, DholeModule, ServerContext } from '../../lib/module.js';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  MemoryDecisionInputSchema,
  MemoryFoldInputSchema,
  MemoryPackInputSchema,
  MemoryProposalInputSchema,
  MemoryReadOptionsSchema,
} from './types.js';
import { MemoryService } from './service.js';

export * from './types.js';
export * from './service.js';

export function createMemoryModule(): DholeModule {
  return {
    id: 'memory',
    register(app, context: ServerContext) {
      const memory = new MemoryService(context.database, context.clock, context.ids, context.events);
      const userId = (c: Context<AppEnvironment>): string => {
        const user = c.get('user');
        if (!user) throw new HttpError(401, 'authentication_required', 'Authentication is required');
        return user.id;
      };

      app.get('/api/projects/:projectId/memory/packs', (c) => c.json(memory.listPacks(c.req.param('projectId'), userId(c))));
      app.post('/api/projects/:projectId/memory/packs', async (c) => {
        const result = memory.createPack(c.req.param('projectId'), await parseJson(c, MemoryPackInputSchema), userId(c));
        return c.json(result, 201);
      });
      app.get('/api/projects/:projectId/memory/search', (c) => {
        const query = c.req.query('q') ?? '';
        const includeArchived = c.req.query('archived') === 'true';
        const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
        return c.json(memory.search(c.req.param('projectId'), query, userId(c), {
          includeArchived,
          ...(limit === undefined ? {} : { limit }),
        }));
      });
      app.get('/api/memory/packs/:packId', (c) => c.json(memory.getPack(c.req.param('packId'), userId(c))));
      app.get('/api/memory/packs/:packId/generations', (c) => c.json(memory.listGenerations(c.req.param('packId'), userId(c))));
      app.get('/api/memory/packs/:packId/proposals', (c) => c.json(memory.listProposals(c.req.param('packId'), userId(c))));
      app.get('/api/memory/packs/:packId/context', (c) => {
        const options = MemoryReadOptionsSchema.parse({
          generationId: c.req.query('generationId'),
          includeArchived: c.req.query('archived') === 'true',
          maxEntries: c.req.query('maxEntries') ? Number(c.req.query('maxEntries')) : undefined,
          maxChars: c.req.query('maxChars') ? Number(c.req.query('maxChars')) : undefined,
        });
        return c.json(memory.readContext(c.req.param('packId'), options, userId(c)));
      });
      app.post('/api/memory/packs/:packId/proposals', async (c) => {
        const result = memory.propose(c.req.param('packId'), await parseJson(c, MemoryProposalInputSchema), userId(c));
        return c.json(result, 201);
      });
      app.post('/api/memory/proposals/:proposalId/decision', async (c) => {
        const input = await parseJson(c, MemoryDecisionInputSchema);
        const result = memory.decideProposal(c.req.param('proposalId'), {
          decision: input.decision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }, userId(c));
        return c.json(result);
      });
      app.post('/api/memory/packs/:packId/fold', async (c) => {
        const result = memory.fold(c.req.param('packId'), await parseJson(c, MemoryFoldInputSchema), userId(c));
        return c.json(result, 201);
      });
      app.post('/api/memory/packs/:packId/clear', async (c) => {
        const body = await parseJson(c, MemoryFoldInputSchema.pick({ baseGenerationId: true }));
        return c.json(memory.clear(c.req.param('packId'), userId(c), body.baseGenerationId), 201);
      });
      app.post('/api/memory/packs/:packId/activate', async (c) => {
        const body = await parseJson(c, z.object({ generationId: z.string().min(1).max(160), baseGenerationId: z.string().min(1).max(160).optional() }));
        return c.json(memory.activateGeneration(c.req.param('packId'), body.generationId, userId(c), body.baseGenerationId));
      });
    },
  };
}

export const memoryModule: DholeModule = createMemoryModule();
