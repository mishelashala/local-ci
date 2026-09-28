import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import {
  clearIntegrationControl,
  finishPromotion,
  integrationControl,
  pendingPromotion,
  setIntegrationControl,
} from '../db.ts';
import { clearRepoCache, compareAndSwapDevelop, readBranchSha, readDevelopSha } from '../git-repo.ts';
import { withRepositoryLock } from '../integration.ts';
import { assertRemoteUnchanged, remoteSha, synchronizeBranch, synchronizeDevelop } from '../synchronization.ts';
import { repositoryFor } from './context.ts';

export function registerResetDevelopRoute(app: FastifyInstance) {
  app.post('/reset-develop', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null;
    const repository = repositoryFor(body?.repository);
    if (!repository) return reply.code(404).send({ error: 'repository not found' });
    return withRepositoryLock(repository.id, async () => {
      const promotion = pendingPromotion(repository.id);
      if (!promotion) return reply.code(409).send({ error: 'no pending promotion' });
      if (!integrationControl(repository.id))
        return reply.code(409).send({ error: 'promotion freeze is missing; resolve recovery before reset' });
      const path = repository.barePath;
      try {
        await synchronizeDevelop(path, true);
        await synchronizeBranch(path, 'main');
        assertRemoteUnchanged(path, 'main', promotion.mainSha);
        if (readBranchSha(path, 'main') !== promotion.mainSha) {
          return reply.code(409).send({ error: 'local branches moved since promotion' });
        }
        const githubSha = remoteSha(path, 'develop');
        let result = 'Remote develop already reset';
        if (githubSha !== promotion.mainSha) {
          assertRemoteUnchanged(path, 'develop', promotion.githubDevelopSha);
          if (readDevelopSha(path) !== promotion.developSha)
            return reply.code(409).send({ error: 'local develop moved since promotion' });
          const lease = `--force-with-lease=refs/heads/develop:${promotion.githubDevelopSha ?? ''}`;
          result = execFileSync(
            'git',
            [`--git-dir=${path}`, 'push', lease, 'origin', `${promotion.mainSha}:refs/heads/develop`],
            { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
          );
        }
        if (readDevelopSha(path) === promotion.developSha && promotion.mainSha !== promotion.developSha) {
          compareAndSwapDevelop(path, promotion.mainSha, promotion.developSha);
        } else if (readDevelopSha(path) !== promotion.mainSha) {
          setIntegrationControl(
            repository.id,
            'blocked',
            promotion.developSha,
            'Remote reset completed but local develop moved; reconcile manually',
          );
          return reply.code(409).send({ error: 'remote reset completed but local develop moved; recovery required' });
        }
        finishPromotion(repository.id);
        clearIntegrationControl(repository.id);
        clearRepoCache();
        return reply.code(201).send({ develop: promotion.mainSha, result });
      } catch (error) {
        return reply.code(409).send({ error: `reset blocked: ${String(error)}` });
      }
    });
  });
}
