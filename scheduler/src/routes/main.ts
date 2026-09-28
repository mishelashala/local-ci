import type { FastifyInstance } from 'fastify';
import { integrationControl, listRepositories } from '../db.ts';
import { pushDevelop, readOrigin } from '../git-repo.ts';
import { githubSlug, openDevelopPullRequest } from '../github-pr.ts';
import { withRepositoryLock } from '../integration.ts';
import { branchSync, fetchGitHub } from '../synchronization.ts';
import { repositoryFor } from './context.ts';

export function registerMainRoute(app: FastifyInstance) {
  app.post('/main', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null;
    const repository = repositoryFor(body?.repository) ?? listRepositories()[0];
    if (!repository) {
      return reply.code(404).send({ error: 'repository not found' });
    }
    return withRepositoryLock(repository.id, async () => {
      if (integrationControl(repository.id)) {
        return reply.code(409).send({ error: 'promotion or recovery is already active' });
      }
      const origin = readOrigin(repository.barePath);
      const slug = origin ? githubSlug(origin) : null;
      if (!slug) {
        return reply.code(409).send({ error: 'origin is not a GitHub repository' });
      }
      try {
        await fetchGitHub(repository.barePath, true);
      } catch (error) {
        return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
      }
      const develop = branchSync(repository.barePath, 'develop');
      if (
        develop.relation === 'diverged' ||
        develop.relation === 'github-missing' ||
        develop.relation === 'local-missing'
      ) {
        return reply.code(409).send({ error: `GitHub develop is ${develop.relation}` });
      }
      if (develop.relation === 'github-ahead') {
        return reply.code(409).send({ error: 'GitHub develop is ahead; sync before opening the pull request' });
      }
      if (develop.relation === 'local-ahead') {
        const pushed = await pushDevelop(repository.barePath);
        if ('error' in pushed) {
          return reply.code(502).send({ error: pushed.error });
        }
      }
      const opened = await openDevelopPullRequest(slug);
      if ('error' in opened) {
        return reply.code(502).send({ error: opened.error });
      }
      return reply.code(201).send({ url: opened.url });
    });
  });
}
