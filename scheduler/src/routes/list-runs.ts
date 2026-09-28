import type { FastifyInstance } from 'fastify'
import { listRuns, listRunsForRepository } from '../db.ts'
import { repositoryFor } from './context.ts'

export function registerListRunsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { repository?: string } }>('/runs', async (request, reply) => {
    if (request.query.repository) {
      if (!repositoryFor(request.query.repository)) return reply.code(404).send({ error: 'repository not found' })
      return { runs: listRunsForRepository(request.query.repository) }
    }
    return { runs: listRuns() }
  })
}
