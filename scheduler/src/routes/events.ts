import type { FastifyInstance } from 'fastify';
import { integrationControl, recordCandidate } from '../db.ts';
import { createTemporaryMerge, mergeBranchMessage } from '../git-merge.ts';
import { readBranchSha, readDevelopSha, retainCandidate } from '../git-repo.ts';
import { withRepositoryLock } from '../integration.ts';
import { branchSync, synchronizeDevelop } from '../synchronization.ts';
import { asPush, DELETED, type PushBody, repositoryFor } from './context.ts';

export function registerEventsRoute(app: FastifyInstance) {
  app.post('/events', async (request, reply) => {
    const parsed = asPush(request.body as PushBody);
    if (typeof parsed === 'string') {
      return reply.code(400).send({ error: parsed });
    }
    const repository = repositoryFor(parsed.repository);
    if (!repository) {
      return reply.code(404).send({ error: 'repository is not registered' });
    }
    return withRepositoryLock(repository.id, async () => {
      const repoPath = repository.barePath;
      if (parsed.ref === 'refs/heads/develop' || parsed.ref === 'refs/heads/main') {
        return reply.code(400).send({ error: 'that branch moves only from the dashboard' });
      }
      if (parsed.newSha === DELETED) {
        return { ignored: 'branch delete' };
      }

      try {
        const sync = integrationControl(repository.id)
          ? branchSync(repoPath, 'develop')
          : await synchronizeDevelop(repoPath, true);
        if (sync.relation === 'diverged') {
          return reply.code(409).send({ error: 'develop diverged from GitHub; validate a reconciliation first' });
        }
      } catch (error) {
        return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` });
      }
      if (readBranchSha(repoPath, parsed.ref.slice('refs/heads/'.length)) !== parsed.newSha) {
        return reply.code(409).send({ error: 'branch moved since this push event' });
      }

      const developSha = readDevelopSha(repoPath);
      if (!developSha) {
        const run = recordCandidate({
          ...parsed,
          baseSha: null,
          headSha: parsed.newSha,
          candidateSha: null,
          status: 'failed',
          logLine: 'refs/heads/develop is missing. Connect the repository in the dashboard.',
        });
        return reply.code(201).send({ run });
      }

      const merged = await createTemporaryMerge({
        bareRepo: repoPath,
        baseSha: developSha,
        headSha: parsed.newSha,
        message: mergeBranchMessage(parsed.ref.slice('refs/heads/'.length), 'develop'),
      });
      if ('conflict' in merged) {
        const run = recordCandidate({
          ...parsed,
          baseSha: developSha,
          headSha: parsed.newSha,
          candidateSha: null,
          status: 'failed',
          logLine: 'merge conflict with develop',
        });
        return reply.code(201).send({ run });
      }

      retainCandidate(repoPath, merged.sha);
      const run = recordCandidate({
        ...parsed,
        newSha: merged.sha.toLowerCase(),
        baseSha: developSha,
        headSha: parsed.newSha,
        candidateSha: merged.sha.toLowerCase(),
        status: 'queued',
        taskId: parsed.ref.slice('refs/heads/'.length),
      });
      return reply.code(201).send({ run });
    });
  });
}
