import type { FastifyInstance } from 'fastify';
import { recordCandidate } from '../db.ts';
import { createTemporaryMerge } from '../git-merge.ts';
import { retainCandidate } from '../git-repo.ts';
import { branchSync, synchronizeDevelop } from '../synchronization.ts';
import { repositoryFor } from './context.ts';

export function registerReconcileRoute(app: FastifyInstance) {
  app.post('/reconcile', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null;
    const repository = repositoryFor(body?.repository);
    if (!repository) {
      return reply.code(404).send({ error: 'repository not found' });
    }
    const path = repository.barePath;
    try {
      await synchronizeDevelop(path, true);
    } catch (error) {
      return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
    }
    const sync = branchSync(path, 'develop');
    if (sync.relation !== 'diverged' || !sync.local || !sync.github) {
      return reply.code(409).send({ error: 'develop is not diverged' });
    }
    const merged = await createTemporaryMerge({
      bareRepo: path,
      baseSha: sync.github,
      headSha: sync.local,
      message: 'Merge GitHub develop into local develop',
    });
    if ('conflict' in merged) {
      return reply.code(409).send({ error: 'reconciliation has merge conflicts; resolve in your working copy' });
    }
    retainCandidate(path, merged.sha);
    const run = recordCandidate({
      repository: repository.id,
      ref: 'refs/heads/develop',
      oldSha: sync.github,
      newSha: merged.sha,
      baseSha: sync.github,
      headSha: sync.local,
      candidateSha: merged.sha,
      target: 'reconcile',
      status: 'queued',
    });
    return reply.code(201).send({ run });
  });
}
