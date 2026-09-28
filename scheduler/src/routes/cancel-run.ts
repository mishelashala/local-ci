import type { FastifyInstance } from 'fastify'
import { cancelQueuedRun, getRun } from '../db.ts'
import { cancelActiveRun } from '../worker.ts'

export function registerCancelRunRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request, reply) => {
    const run = getRun(request.params.id)
    if (!run) return reply.code(404).send({ error: 'run not found' })
    if (!cancelQueuedRun(run.id) && !cancelActiveRun(run.id)) return reply.code(409).send({ error: 'run cannot be canceled' })
    return { canceled: run.id }
  })
}
