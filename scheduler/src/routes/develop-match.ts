import type { FastifyInstance } from 'fastify';
import { integrationControl } from '../db.ts';
import { matchLocalDevelop } from '../synchronization.ts';
import { repositoryFor, snapshotFor } from './context.ts';

export function registerDevelopMatchRoute(app: FastifyInstance) {
  app.post('/develop/match', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null;
    const repository = repositoryFor(body?.repository);
    if (!repository) {
      return reply.code(404).send({ error: 'repository not found' });
    }
    if (integrationControl(repository.id)) {
      return reply.code(409).send({ error: 'promotion or recovery is active' });
    }
    const path = repository.barePath;
    try {
      const after = await matchLocalDevelop(path);
      if (after.relation === 'local-ahead') {
        return reply
          .code(409)
          .send({ error: 'local develop is ahead of GitHub; matching it would drop those commits' });
      }
      if (after.relation === 'github-missing') {
        return reply.code(409).send({ error: 'GitHub develop was not fetched' });
      }
      if (after.relation !== 'same') {
        return reply.code(409).send({ error: 'local develop was not moved' });
      }
      return snapshotFor(repository);
    } catch (error) {
      return reply.code(409).send({ error: String(error) });
    }
  });
}
