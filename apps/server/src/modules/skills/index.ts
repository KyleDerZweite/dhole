import type { Context } from 'hono';
import { HttpError, parseJson } from '../../lib/http.js';
import type { AppEnvironment, DholeModule, ServerContext } from '../../lib/module.js';
import { SkillsService } from './service.js';
import { SkillLifecycleInputSchema, SkillProposalInputSchema } from './types.js';

export * from './types.js';
export * from './parser.js';
export * from './service.js';

export function createSkillsModule(): DholeModule {
  return {
    id: 'skills',
    register(app, context: ServerContext) {
      const skills = new SkillsService(context.database, context.clock, context.ids);
      const userId = (c: Context<AppEnvironment>): string => {
        const user = c.get('user');
        if (!user) throw new HttpError(401, 'authentication_required', 'Authentication is required');
        return user.id;
      };
      app.get('/api/projects/:projectId/skills', (c) => c.json(skills.listSkills(c.req.param('projectId'), userId(c))));
      app.get('/api/skills', (c) => c.json(skills.listSkills(null, userId(c))));
      app.get('/api/skills/:skillId', (c) => c.json(skills.getSkill(c.req.param('skillId'), userId(c))));
      app.get('/api/skills/:skillId/versions', (c) => c.json(skills.listVersions(c.req.param('skillId'), userId(c))));
      app.get('/api/skills/versions/:versionId', (c) => c.json(skills.getVersion(c.req.param('versionId'), userId(c))));
      app.post('/api/skills/proposals', async (c) => {
        const input = await parseJson(c, SkillProposalInputSchema);
        return c.json(skills.propose(input, userId(c)), 201);
      });
      app.post('/api/projects/:projectId/skills/proposals', async (c) => {
        const input = await parseJson(c, SkillProposalInputSchema.extend({ projectId: SkillProposalInputSchema.shape.projectId.default(c.req.param('projectId')) }));
        return c.json(skills.propose({ ...input, projectId: c.req.param('projectId') }, userId(c)), 201);
      });
      app.post('/api/skills/versions/:versionId/lifecycle', async (c) => {
        const input = await parseJson(c, SkillLifecycleInputSchema);
        return c.json(skills.setLifecycle(c.req.param('versionId'), input.lifecycle, userId(c)));
      });
      app.post('/api/skills/versions/:versionId/activate', (c) => c.json(skills.activate(c.req.param('versionId'), userId(c))));
      app.post('/api/skills/versions/:versionId/deprecate', (c) => c.json(skills.deprecate(c.req.param('versionId'), userId(c))));
    },
  };
}

export const skillsModule: DholeModule = createSkillsModule();
