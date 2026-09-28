import type { FastifyInstance } from 'fastify';
import { getRun, listLogLines, listWorkflows } from '../db.ts';

export function registerRunLogsRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { workflow?: string } }>('/runs/:id/logs', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const workflow = request.query.workflow;
    if (workflow && !listWorkflows(run.id).some((item) => item.path === workflow))
      return reply.code(404).send({ error: 'workflow not found in run' });
    return { lines: listLogLines(run.id, workflow) };
  });
}
