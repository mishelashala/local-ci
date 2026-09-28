import type { FastifyInstance } from 'fastify'
import { synchronizeBranch, synchronizeDevelop } from '../synchronization.ts'
import { repositoryFor, snapshotFor } from './context.ts'

export function registerSyncRoute(app: FastifyInstance) {
  app.post('/sync', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null
    const repository = repositoryFor(body?.repository)
    if (!repository) return reply.code(404).send({ error: 'repository not found' })
    try {
      await synchronizeDevelop(repository.barePath, true)
      await synchronizeBranch(repository.barePath, 'main')
      return snapshotFor(repository)
    } catch (error) { return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` }) }
  })
}
