import type { FastifyInstance } from 'fastify';
import {
  clearIntegrationControl,
  integrationControl,
  listRepositories,
  recordCandidate,
  setIntegrationControl,
} from '../db.ts';
import { createTemporaryMerge, mergeBranchMessage } from '../git-merge.ts';
import { readBranchSha, readDevelopSha, retainCandidate } from '../git-repo.ts';
import { withRepositoryLock } from '../integration.ts';
import { synchronizeBranch, synchronizeDevelop } from '../synchronization.ts';
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
      const frozenSha = readDevelopSha(repository.barePath);
      if (!frozenSha) {
        return reply.code(409).send({ error: 'develop is missing' });
      }
      setIntegrationControl(repository.id, 'frozen', frozenSha, 'Validating develop for promotion');
      const repoPath = repository.barePath;
      try {
        const develop = await synchronizeDevelop(repoPath, true);
        const main = await synchronizeBranch(repoPath, 'main');
        if (develop.relation === 'diverged' || main.relation === 'diverged' || readDevelopSha(repoPath) !== frozenSha) {
          clearIntegrationControl(repository.id);
          return reply.code(409).send({ error: 'branches changed during promotion setup; retry' });
        }
      } catch (error) {
        clearIntegrationControl(repository.id);
        return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
      }
      const mainSha = readBranchSha(repoPath, 'main');
      const developSha = readDevelopSha(repoPath);
      if (!mainSha || !developSha) {
        clearIntegrationControl(repository.id);
        return reply.code(409).send({ error: 'main or develop is missing. Connect the repository in the dashboard.' });
      }
      const merged = await createTemporaryMerge({
        bareRepo: repoPath,
        baseSha: mainSha,
        headSha: developSha,
        message: mergeBranchMessage('develop', 'main'),
      });
      if ('conflict' in merged) {
        clearIntegrationControl(repository.id);
        const run = recordCandidate({
          repository: repository.id,
          ref: 'refs/heads/develop',
          oldSha: mainSha,
          newSha: developSha,
          baseSha: mainSha,
          headSha: developSha,
          candidateSha: null,
          target: 'main',
          status: 'failed',
          logLine: 'merge conflict with main',
        });
        return reply.code(201).send({ run });
      }
      const sha = merged.sha.toLowerCase();
      retainCandidate(repoPath, sha);
      const run = recordCandidate({
        repository: repository.id,
        ref: 'refs/heads/develop',
        oldSha: mainSha,
        newSha: sha,
        baseSha: mainSha,
        headSha: developSha,
        candidateSha: sha,
        target: 'main',
        status: 'queued',
      });
      return reply.code(201).send({ run });
    });
  });
}
