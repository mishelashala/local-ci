import type { FastifyInstance } from 'fastify'
import { clearIntegrationControl, finishPromotion, integrationControl, pendingPromotion } from '../db.ts'
import { readDevelopSha } from '../git-repo.ts'
import { withRepositoryLock } from '../integration.ts'
import { remoteSha } from '../synchronization.ts'
import { repositoryFor } from './context.ts'

export function registerPromotionCancelRoute(app: FastifyInstance) {
  app.post('/promotion/cancel', async (request, reply) => {
    const body = request.body as { repository?: unknown } | null
    const repository = repositoryFor(body?.repository)
    if (!repository) return reply.code(404).send({ error: 'repository not found' })
    return withRepositoryLock(repository.id, () => {
      const control = integrationControl(repository.id)
      if (!control || control.mode === 'blocked') return reply.code(409).send({ error: 'no cancellable promotion' })
      const pending = pendingPromotion(repository.id)
      if (pending && remoteSha(repository.barePath, 'develop') === pending.mainSha && readDevelopSha(repository.barePath) !== pending.mainSha) {
        return reply.code(409).send({ error: 'GitHub reset completed but local develop has not; use Reset develop to finish recovery' })
      }
      if (pending) finishPromotion(repository.id)
      clearIntegrationControl(repository.id)
      return reply.code(200).send({ canceled: true })
    })
  })
}
