import type { FastifyInstance } from 'fastify';
import { getRun } from '../db.ts';

export function registerRunRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'run not found' });
    }
    return { run };
  });
}
