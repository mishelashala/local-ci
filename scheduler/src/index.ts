import Fastify from 'fastify'
import { createTemporaryMerge } from './git-merge.ts'
import {
  clearRepoCache,
  compareAndSwapDevelop,
  compareAndSwapRef,
  currentRepoSnapshot,
  pushDevelop,
  pushRef,
  readBranchSha,
  readDevelopSha,
  readOrigin,
} from './git-repo.ts'
import { bareRepo } from './paths.ts'
import {
  getRun,
  findPassedMain,
  hasPassedCandidate,
  listLogLines,
  listRuns,
  markRunStale,
  recordCandidate,
} from './db.ts'
import { startWorker } from './worker.ts'

const ORIGIN_HELP = 'Set "github" in ci.config.json to the sample app GitHub remote, then run ./scripts/setup-ci.sh'
const DELETED = '0000000000000000000000000000000000000000'
const SHA = /^[0-9a-f]{40}$/
const REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/

type PushBody = {
  repository?: unknown
  ref?: unknown
  oldSha?: unknown
  newSha?: unknown
}

function asPush(body: PushBody) {
  if (typeof body.repository !== 'string' || body.repository.length === 0 || body.repository.length > 80) {
    return 'repository is required'
  }
  if (typeof body.ref !== 'string' || !REF.test(body.ref)) return 'ref must be a branch'
  if (typeof body.oldSha !== 'string' || !SHA.test(body.oldSha)) return 'oldSha must be a SHA'
  if (typeof body.newSha !== 'string' || !SHA.test(body.newSha)) return 'newSha must be a SHA'
  return {
    repository: body.repository,
    ref: body.ref,
    oldSha: body.oldSha,
    newSha: body.newSha,
  }
}

const app = Fastify({ logger: true })

app.get('/health', async () => ({ ok: true }))

app.get('/repo', async () => currentRepoSnapshot(bareRepo))

app.get('/runs', async () => ({ runs: listRuns() }))

app.get<{ Params: { id: string } }>('/runs/:id/logs', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  return { lines: listLogLines(run.id) }
})

app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  return { run }
})

app.post('/events', async (request, reply) => {
  const parsed = asPush(request.body as PushBody)
  if (typeof parsed === 'string') return reply.code(400).send({ error: parsed })
  if (parsed.ref === 'refs/heads/develop' || parsed.ref === 'refs/heads/main') {
    return reply.code(400).send({ error: 'that branch moves only from the dashboard' })
  }
  if (parsed.newSha === DELETED) return { ignored: 'branch delete' }

  const developSha = readDevelopSha(bareRepo)
  if (!developSha) {
    const run = recordCandidate({
      ...parsed,
      baseSha: null,
      headSha: parsed.newSha,
      candidateSha: null,
      status: 'failed',
      logLine: 'refs/heads/develop is missing. Run ./scripts/setup-ci.sh',
    })
    return reply.code(201).send({ run })
  }

  const merged = await createTemporaryMerge({
    bareRepo,
    baseSha: developSha,
    headSha: parsed.newSha,
  })
  if ('conflict' in merged) {
    const run = recordCandidate({
      ...parsed,
      baseSha: developSha,
      headSha: parsed.newSha,
      candidateSha: null,
      status: 'failed',
      logLine: 'merge conflict with develop',
    })
    return reply.code(201).send({ run })
  }

  const run = recordCandidate({
    ...parsed,
    newSha: merged.sha.toLowerCase(),
    baseSha: developSha,
    headSha: parsed.newSha,
    candidateSha: merged.sha.toLowerCase(),
    status: 'queued',
  })
  return reply.code(201).send({ run })
})

app.post('/merges', async (request, reply) => {
  const body = request.body as { runId?: unknown } | null
  if (!body || typeof body.runId !== 'string' || body.runId.length === 0) {
    return reply.code(400).send({ error: 'runId is required' })
  }
  const run = getRun(body.runId)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  if (run.target === 'main') {
    return reply.code(409).send({ error: 'this run promotes main. Use Push main to GitHub' })
  }
  if (run.status !== 'passed' || run.trigger !== 'candidate') {
    return reply.code(409).send({ error: 'run is not a passed merge candidate' })
  }
  if (!run.candidateSha || !SHA.test(run.candidateSha) || !run.baseSha || !SHA.test(run.baseSha) || !run.headSha || !SHA.test(run.headSha)) {
    return reply.code(409).send({ error: 'run is missing merge SHAs' })
  }
  const developSha = readDevelopSha(bareRepo)
  if (developSha !== run.baseSha) {
    if (developSha !== run.candidateSha) markRunStale(run.id)
    return reply.code(409).send({ error: 'develop moved since this run' })
  }
  const head = readBranchSha(bareRepo, run.branch)
  if (head !== run.headSha) {
    return reply.code(409).send({ error: 'the branch tip moved since this run' })
  }
  try {
    compareAndSwapDevelop(bareRepo, run.candidateSha, run.baseSha)
  } catch {
    const current = readDevelopSha(bareRepo)
    if (current !== run.candidateSha) markRunStale(run.id)
    return reply.code(409).send({ error: 'develop moved since this run' })
  }
  clearRepoCache()
  return reply.code(201).send({ develop: run.candidateSha })
})

app.post('/main', async (_request, reply) => {
  const mainSha = readBranchSha(bareRepo, 'main')
  const developSha = readDevelopSha(bareRepo)
  if (!mainSha || !developSha) {
    return reply.code(409).send({ error: 'main or develop is missing. Run ./scripts/setup-ci.sh' })
  }
  const merged = await createTemporaryMerge({ bareRepo, baseSha: mainSha, headSha: developSha })
  if ('conflict' in merged) {
    const run = recordCandidate({
      repository: 'sample-app',
      ref: 'refs/heads/develop',
      oldSha: mainSha,
      newSha: developSha,
      baseSha: mainSha,
      headSha: developSha,
      candidateSha: null,
      target: 'main',
      status: 'failed',
      logLine: 'merge conflict with main',
    })
    return reply.code(201).send({ run })
  }
  const sha = merged.sha.toLowerCase()
  const run = recordCandidate({
    repository: 'sample-app',
    ref: 'refs/heads/develop',
    oldSha: mainSha,
    newSha: sha,
    baseSha: mainSha,
    headSha: developSha,
    candidateSha: sha,
    target: 'main',
    status: 'queued',
  })
  return reply.code(201).send({ run })
})

app.post('/pushes', async (request, reply) => {
  const body = request.body as { branch?: unknown } | null
  if (!body || (body.branch !== 'develop' && body.branch !== 'main')) {
    return reply.code(400).send({ error: 'branch must be develop or main' })
  }
  const origin = readOrigin(bareRepo)
  if (!origin) return reply.code(409).send({ error: ORIGIN_HELP })

  if (body.branch === 'develop') {
    const developSha = readDevelopSha(bareRepo)
    if (!developSha || !hasPassedCandidate(developSha)) {
      return reply.code(409).send({ error: 'develop is not a passed merge commit' })
    }
    const pushed = await pushDevelop(bareRepo)
    if ('error' in pushed) return reply.code(502).send({ error: pushed.error })
    clearRepoCache()
    return reply.code(201).send({ sha: developSha, remote: origin })
  }

  const mainSha = readBranchSha(bareRepo, 'main')
  const developSha = readDevelopSha(bareRepo)
  if (!mainSha || !developSha) {
    return reply.code(409).send({ error: 'main or develop is missing. Run ./scripts/setup-ci.sh' })
  }
  const candidate = findPassedMain(mainSha, developSha)
  if (!candidate) return reply.code(409).send({ error: 'develop → main has not passed against the current branches' })
  const pushed = await pushRef(bareRepo, candidate, 'refs/heads/main')
  if ('error' in pushed) return reply.code(502).send({ error: pushed.error })
  if (candidate !== mainSha) {
    try {
      compareAndSwapRef(bareRepo, 'refs/heads/main', candidate, mainSha)
    } catch {
      return reply.code(409).send({ error: 'GitHub main updated, but local main moved during the push' })
    }
  }
  clearRepoCache()
  return reply.code(201).send({ sha: candidate, remote: origin })
})

startWorker()

const port = 3001
await app.listen({ host: '127.0.0.1', port })
