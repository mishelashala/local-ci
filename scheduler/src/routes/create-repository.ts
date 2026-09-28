import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { saveRepository } from '../db.ts'
import { clearRepoCache, readBranchSha } from '../git-repo.ts'
import { bareRepo, hookSourceRoot, repositoryRoot } from '../paths.ts'
import { remoteSha } from '../synchronization.ts'
import { GITHUB_REMOTE, snapshotFor } from './context.ts'

export function registerCreateRepositoryRoute(app: FastifyInstance) {
  app.post('/repositories', async (request, reply) => {
    const body = request.body as { name?: unknown; github?: unknown } | null
    const github = typeof body?.github === 'string' ? body.github.trim() : ''
    const providedName = typeof body?.name === 'string' ? body.name.trim() : ''
    const remoteName = github.match(/([^/:]+?)(?:\.git)?$/)?.[1] ?? ''
    const name = providedName || remoteName
    const id = randomUUID()
    if (!GITHUB_REMOTE.test(github)) return reply.code(400).send({ error: 'Use a git@, ssh://, or https:// remote.' })
    if (name.length < 1 || name.length > 100) return reply.code(400).send({ error: 'Repository name is required.' })
    const path = bareRepo(id)
    mkdirSync(repositoryRoot, { recursive: true })
    let initialized = false
    try {
      execFileSync('git', ['init', '--bare', '-b', 'main', path], { stdio: 'ignore' })
      initialized = true
      execFileSync('git', [`--git-dir=${path}`, 'remote', 'add', 'origin', github], { stdio: 'ignore' })
      execFileSync('git', [`--git-dir=${path}`, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      for (const branch of ['main', 'develop']) {
        const sha = remoteSha(path, branch as 'main' | 'develop')
        if (sha) execFileSync('git', [`--git-dir=${path}`, 'update-ref', `refs/heads/${branch}`, sha], { stdio: 'ignore' })
      }
      if (!readBranchSha(path, 'main')) {
        const head = execFileSync('git', [`--git-dir=${path}`, 'ls-remote', '--symref', 'origin', 'HEAD'], { encoding: 'utf8' })
          .match(/ref: refs\/heads\/([^\s]+)/)?.[1]
        const headSha = head ? execFileSync('git', [`--git-dir=${path}`, 'rev-parse', `refs/remotes/origin/${head}`], { encoding: 'utf8' }).trim() : null
        if (headSha) execFileSync('git', [`--git-dir=${path}`, 'update-ref', 'refs/heads/main', headSha], { stdio: 'ignore' })
      }
      const main = readBranchSha(path, 'main')
      if (main && !readBranchSha(path, 'develop')) execFileSync('git', [`--git-dir=${path}`, 'update-ref', 'refs/heads/develop', main], { stdio: 'ignore' })
      for (const hook of ['post-receive', 'pre-receive']) {
        copyFileSync(join(hookSourceRoot, hook), join(path, 'hooks', hook))
        execFileSync('chmod', ['+x', join(path, 'hooks', hook)])
      }
      const repository = saveRepository({ id, name, barePath: path, origin: github })
      clearRepoCache()
      return reply.code(201).send({ repository: await snapshotFor(repository!) })
    } catch (error) {
      if (initialized) rmSync(path, { recursive: true, force: true })
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({ error: `Could not connect repository: ${message}` })
    }
  })
}
