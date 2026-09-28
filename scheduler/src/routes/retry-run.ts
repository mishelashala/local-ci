import type { FastifyInstance } from 'fastify';
import { getRun, retryRun } from '../db.ts';
import { readBranchSha, readDevelopSha } from '../git-repo.ts';
import { remoteSha, synchronizeDevelop } from '../synchronization.ts';
import { repositoryFor } from './context.ts';

export function registerRetryRunRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/runs/:id/retry', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'run not found' });
    }
    const repository = repositoryFor(run.repository);
    if (!repository) {
      return reply.code(404).send({ error: 'repository not found' });
    }
    if (run.target === 'main') {
      return reply.code(409).send({ error: 'GitHub runs the develop → main tests' });
    }
    try {
      await synchronizeDevelop(repository.barePath, true);
    } catch (error) {
      return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
    }
    const base =
      run.target === 'main'
        ? readBranchSha(repository.barePath, 'main')
        : run.target === 'reconcile'
          ? remoteSha(repository.barePath, 'develop')
          : run.target === 'post-merge'
            ? run.baseSha
            : readDevelopSha(repository.barePath);
    const head =
      run.target === 'main' || run.target === 'reconcile'
        ? readDevelopSha(repository.barePath)
        : readBranchSha(repository.barePath, run.branch);
    if (run.target === 'post-merge' && readDevelopSha(repository.barePath) !== run.candidateSha) {
      return reply.code(409).send({ error: 'develop moved since the post-merge run' });
    }
    if (base !== run.baseSha || head !== run.headSha) {
      return reply.code(409).send({ error: 'branch SHAs moved; create a new validation' });
    }
    const next = retryRun(run.id);
    if (!next) {
      return reply.code(409).send({ error: 'run has no reusable candidate' });
    }
    return reply.code(201).send({ run: next });
  });
}
