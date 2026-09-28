import type { FastifyInstance } from 'fastify'
import {
  clearIntegrationControl,
  findPassedMain,
  hasPassedCandidate,
  integrationControl,
  listRepositories,
  pendingPromotion,
  savePromotion,
  setIntegrationControl,
} from '../db.ts'
import { clearRepoCache, compareAndSwapRef, pushRef, readBranchSha, readDevelopSha, readOrigin } from '../git-repo.ts'
import { withRepositoryLock } from '../integration.ts'
import { remoteSha, synchronizeBranch, synchronizeDevelop } from '../synchronization.ts'
import { ORIGIN_HELP, repositoryFor } from './context.ts'

export function registerPushesRoute(app: FastifyInstance) {
  app.post('/pushes', async (request, reply) => {
    const body = request.body as { repository?: unknown; branch?: unknown } | null
    if (!body || (body.branch !== 'develop' && body.branch !== 'main')) {
      return reply.code(400).send({ error: 'branch must be develop or main' })
    }
    const repository = repositoryFor(body.repository) ?? listRepositories()[0]
    if (!repository) return reply.code(404).send({ error: 'repository not found' })
    return withRepositoryLock(repository.id, async () => {
      const repoPath = repository.barePath
      const origin = readOrigin(repoPath)
      if (!origin) return reply.code(409).send({ error: ORIGIN_HELP })

      const control = integrationControl(repository.id)
      if (body.branch === 'develop' && control) return reply.code(409).send({ error: 'promotion is active; staging push is paused' })
      if (body.branch === 'main' && (!control || control.mode !== 'frozen')) return reply.code(409).send({ error: 'validate a frozen promotion first' })
      const stagingSha = body.branch === 'develop' ? readDevelopSha(repoPath) : null
      if (stagingSha) setIntegrationControl(repository.id, 'frozen', stagingSha, 'Sending tested develop to staging')

      try {
        const develop = await synchronizeDevelop(repoPath, true)
        const main = await synchronizeBranch(repoPath, 'main')
        if (develop.relation === 'diverged' || main.relation === 'diverged') {
          if (stagingSha) clearIntegrationControl(repository.id)
          return reply.code(409).send({ error: 'GitHub branch diverged; reconcile before pushing' })
        }
      } catch (error) { if (stagingSha) clearIntegrationControl(repository.id); return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` }) }

      if (body.branch === 'develop') {
        const developSha = readDevelopSha(repoPath)
        if (!developSha || developSha !== stagingSha || !hasPassedCandidate(repository.id, developSha)) {
          clearIntegrationControl(repository.id)
          return reply.code(409).send({ error: 'develop must still be the exact automatically integrated passing commit' })
        }
        const pushed = await pushRef(repoPath, developSha, 'refs/heads/develop')
        if ('error' in pushed) { clearIntegrationControl(repository.id); return reply.code(502).send({ error: pushed.error }) }
        clearIntegrationControl(repository.id)
        clearRepoCache()
        return reply.code(201).send({ sha: developSha, remote: origin })
      }

      const mainSha = readBranchSha(repoPath, 'main')
      const developSha = readDevelopSha(repoPath)
      if (pendingPromotion(repository.id)) return reply.code(409).send({ error: 'finish or release the previous promotion first' })
      if (control?.developSha !== developSha) return reply.code(409).send({ error: 'frozen develop changed; cancel and validate again' })
      if (!mainSha || !developSha) {
        return reply.code(409).send({ error: 'main or develop is missing. Connect the repository in the dashboard.' })
      }
      const candidate = findPassedMain(repository.id, mainSha, developSha)
      if (!candidate) return reply.code(409).send({ error: 'develop → main has not passed against the current branches' })
      const pushed = await pushRef(repoPath, candidate, 'refs/heads/main')
      if ('error' in pushed) return reply.code(502).send({ error: pushed.error })
      if (candidate !== mainSha) {
        try {
          compareAndSwapRef(repoPath, 'refs/heads/main', candidate, mainSha)
        } catch {
          return reply.code(409).send({ error: 'GitHub main updated, but local main moved during the push' })
        }
      }
      savePromotion(repository.id, candidate, developSha, remoteSha(repoPath, 'develop'))
      setIntegrationControl(repository.id, 'frozen', developSha, 'Main pushed; reset develop or release promotion')
      clearRepoCache()
      return reply.code(201).send({ sha: candidate, remote: origin })
    })
  })
}
