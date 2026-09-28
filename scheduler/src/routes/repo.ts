import type { FastifyInstance } from 'fastify'
import { listRepositories } from '../db.ts'
import { repositoryFor, snapshotFor } from './context.ts'

export function registerRepoRoute(app: FastifyInstance) {
  app.get<{ Querystring: { repository?: string } }>('/repo', async (request, reply) => {
    const selected = repositoryFor(request.query.repository) ?? listRepositories()[0]
    if (!selected) return reply.code(404).send({ error: 'no repositories registered' })
    return snapshotFor(selected)
  })
}
