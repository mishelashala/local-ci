import type { FastifyInstance } from 'fastify';
import { getRun } from '../db.ts';
import { clearRepoCache, compareAndSwapDevelop, readDevelopSha } from '../git-repo.ts';
import { assertRemoteUnchanged, synchronizeDevelop } from '../synchronization.ts';
import { repositoryFor } from './context.ts';

export function registerReconciliationsRoute(app: FastifyInstance) {
  app.post('/reconciliations', async (request, reply) => {
    const body = request.body as { runId?: unknown } | null;
    const run = typeof body?.runId === 'string' ? getRun(body.runId) : undefined;
    if (run?.target !== 'reconcile' || run.status !== 'passed' || !run.candidateSha)
      return reply.code(409).send({ error: 'passed reconciliation is required' });
    const repository = repositoryFor(run.repository);
    if (!repository) return reply.code(404).send({ error: 'repository not found' });
    const path = repository.barePath;
    try {
      await synchronizeDevelop(path, true);
      assertRemoteUnchanged(path, 'develop', run.baseSha);
      if (readDevelopSha(path) !== run.headSha)
        return reply.code(409).send({ error: 'local develop moved; revalidate' });
      compareAndSwapDevelop(path, run.candidateSha, run.headSha!);
      clearRepoCache();
      return reply.code(201).send({ develop: run.candidateSha });
    } catch (error) {
      return reply.code(409).send({ error: String(error) });
    }
  });
}
