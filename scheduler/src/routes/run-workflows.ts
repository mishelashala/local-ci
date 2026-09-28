import type { FastifyInstance } from 'fastify'
import { getRun, listWorkflows } from '../db.ts'

export function registerRunWorkflowsRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/runs/:id/workflows', async (request, reply) => {
    if (!getRun(request.params.id)) return reply.code(404).send({ error: 'run not found' })
    return { workflows: listWorkflows(request.params.id) }
  })
}
