import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getRun, integrationControl, listLogLines, smokeForCandidate } from '../db.ts';
import { workRoot } from '../paths.ts';

export function registerRunResultRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/runs/:id/result', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'run not found' });
    }
    const lines = listLogLines(run.id);
    const smoke =
      run.target === 'develop' && run.candidateSha ? smokeForCandidate(run.repository, run.candidateSha) : undefined;
    const control = integrationControl(run.repository);
    const status =
      run.status === 'failed'
        ? 'failed'
        : run.integratedAt
          ? control?.mode === 'blocked'
            ? 'blocked'
            : (smoke && smoke.status !== 'passed') ||
                (control?.developSha === run.candidateSha && control.reason === 'Post-merge smoke check')
              ? 'verifying'
              : 'integrated'
          : run.status;
    return {
      runId: run.id,
      repository: run.repository,
      taskId: run.taskId ?? run.branch,
      branch: run.branch,
      headSha: run.headSha,
      candidateSha: run.candidateSha,
      status,
      smokeRunId: smoke?.id ?? null,
      exitCode: run.exitCode,
      failure: run.status === 'failed' ? lines.filter((line) => /error:|fail|conflict/i.test(line)).slice(-8) : [],
      artifactDirectory: join(workRoot, 'artifacts', run.id),
      logsUrl: `/api/runs/${encodeURIComponent(run.id)}/logs`,
    };
  });
}
