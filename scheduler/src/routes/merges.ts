import type { FastifyInstance } from 'fastify';

export function registerMergesRoute(app: FastifyInstance) {
  app.post('/merges', async (_request, reply) =>
    reply.code(409).send({ error: 'Feature candidates integrate automatically after their checks pass.' }),
  );
}
