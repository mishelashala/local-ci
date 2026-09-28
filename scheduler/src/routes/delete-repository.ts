import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { activeRunIds, cancelQueuedRun, deleteRepository, getRepository } from '../db.ts'
import { clearRepoCache } from '../git-repo.ts'
import { bareRepo } from '../paths.ts'
import { cancelActiveRun } from '../worker.ts'
import { REPOSITORY_ID } from './context.ts'

export function registerDeleteRepositoryRoute(app: FastifyInstance) {
  app.delete<{ Params: { id: string } }>('/repositories/:id', async (request, reply) => {
    if (!REPOSITORY_ID.test(request.params.id)) return reply.code(400).send({ error: 'repository not found' })
    const repository = getRepository(request.params.id)
    if (!repository) return reply.code(404).send({ error: 'repository not found' })
    for (const run of activeRunIds(repository.id)) {
      cancelQueuedRun(run.id)
      cancelActiveRun(run.id)
    }
    const managedPath = resolve(bareRepo(repository.id))
    if (resolve(repository.barePath) === managedPath && existsSync(managedPath)) {
      try {
        rmSync(managedPath, { recursive: true, force: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return reply.code(409).send({ error: `Could not delete the local repository: ${message}` })
      }
    }
    if (!deleteRepository(repository.id)) return reply.code(404).send({ error: 'repository not found' })
    clearRepoCache()
    return { removed: repository.id }
  })
}
