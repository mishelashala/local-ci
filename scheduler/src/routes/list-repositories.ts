import type { FastifyInstance } from 'fastify';
import { listRepositories } from '../db.ts';
import { snapshotFor } from './context.ts';

export function registerListRepositoriesRoute(app: FastifyInstance) {
  app.get<{ Querystring: { sync?: string } }>('/repositories', async (request) => {
    const sync = request.query.sync === '1';
    return { repositories: await Promise.all(listRepositories().map((repository) => snapshotFor(repository, sync))) };
  });
}
