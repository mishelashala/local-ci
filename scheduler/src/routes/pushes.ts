import type { FastifyInstance } from 'fastify';
import {
  clearIntegrationControl,
  hasPassedCandidate,
  integrationControl,
  listRepositories,
  setIntegrationControl,
} from '../db.ts';
import { clearRepoCache, pushRef, readDevelopSha, readOrigin } from '../git-repo.ts';
import { withRepositoryLock } from '../integration.ts';
import { synchronizeBranch, synchronizeDevelop } from '../synchronization.ts';
import { ORIGIN_HELP, repositoryFor } from './context.ts';

export function registerPushesRoute(app: FastifyInstance) {
  app.post('/pushes', async (request, reply) => {
    const body = request.body as { repository?: unknown; branch?: unknown } | null;
    if (!body || body.branch !== 'develop') {
      return reply.code(409).send({ error: 'main changes go through a GitHub pull request' });
    }
    const repository = repositoryFor(body.repository) ?? listRepositories()[0];
    if (!repository) {
      return reply.code(404).send({ error: 'repository not found' });
    }
    return withRepositoryLock(repository.id, async () => {
      const repoPath = repository.barePath;
      const origin = readOrigin(repoPath);
      if (!origin) {
        return reply.code(409).send({ error: ORIGIN_HELP });
      }

      const control = integrationControl(repository.id);
      if (control) {
        return reply.code(409).send({ error: 'promotion is active; staging push is paused' });
      }
      const stagingSha = readDevelopSha(repoPath);
      if (stagingSha) {
        setIntegrationControl(repository.id, 'frozen', stagingSha, 'Sending tested develop to staging');
      }

      try {
        const develop = await synchronizeDevelop(repoPath, true);
        const main = await synchronizeBranch(repoPath, 'main');
        if (develop.relation === 'diverged' || main.relation === 'diverged') {
          if (stagingSha) {
            clearIntegrationControl(repository.id);
          }
          return reply.code(409).send({ error: 'GitHub branch diverged; reconcile before pushing' });
        }
      } catch (error) {
        if (stagingSha) {
          clearIntegrationControl(repository.id);
        }
        return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
      }

      const developSha = readDevelopSha(repoPath);
      if (!developSha || developSha !== stagingSha || !hasPassedCandidate(repository.id, developSha)) {
        clearIntegrationControl(repository.id);
        return reply
          .code(409)
          .send({ error: 'develop must still be the exact automatically integrated passing commit' });
      }
      const pushed = await pushRef(repoPath, developSha, 'refs/heads/develop');
      if ('error' in pushed) {
        clearIntegrationControl(repository.id);
        return reply.code(502).send({ error: pushed.error });
      }
      clearIntegrationControl(repository.id);
      clearRepoCache();
      return reply.code(201).send({ sha: developSha, remote: origin });
    });
  });
}
