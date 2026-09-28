import type { FastifyInstance } from 'fastify';
import { readBranchSha } from '../git-repo.ts';
import { DELETED, REF, repositoryFor } from './context.ts';

export function registerManualRunRoute(app: FastifyInstance) {
  app.post('/runs/manual', async (request, reply) => {
    const body = request.body as { repository?: unknown; branch?: unknown } | null;
    const repository = repositoryFor(body?.repository);
    const branch = body?.branch;
    if (!repository) return reply.code(404).send({ error: 'repository not found' });
    if (typeof branch !== 'string' || !REF.test(`refs/heads/${branch}`) || branch === 'main' || branch === 'develop') {
      return reply.code(400).send({ error: 'choose a feature branch' });
    }
    const sha = readBranchSha(repository.barePath, branch);
    if (!sha) return reply.code(404).send({ error: 'branch not found' });
    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        repository: repository.id,
        ref: `refs/heads/${branch}`,
        oldSha: DELETED,
        newSha: sha,
      },
    });
    return reply.code(response.statusCode).send(response.json());
  });
}
