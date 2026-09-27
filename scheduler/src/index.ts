import Fastify from 'fastify'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import { createTemporaryMerge } from './git-merge.ts'
import {
  clearRepoCache,
  compareAndSwapDevelop,
  compareAndSwapRef,
  currentRepoSnapshot,
  pushRef,
  readBranchSha,
  readDevelopSha,
  readOrigin,
  retainCandidate,
  setOrigin,
} from './git-repo.ts'
import { bareRepo, dashboardDistRoot, hookSourceRoot, repositoryRoot, workRoot } from './paths.ts'
import {
  getRun,
  findPassedMain,
  hasPassedCandidate,
  listLogLines,
  listWorkflows,
  smokeForCandidate,
  listRuns,
  markRunStale,
  recordCandidate,
  getRepository,
  listRepositories,
  recentRunsForRepository,
  saveRepository,
  listRunsForRepository,
  cancelQueuedRun,
  retryRun,
  savePromotion,
  pendingPromotion,
  finishPromotion,
  integrationControl,
  setIntegrationControl,
  clearIntegrationControl,
} from './db.ts'
import { cancelActiveRun, startWorker } from './worker.ts'
import { withRepositoryLock } from './integration.ts'
import { assertRemoteUnchanged, branchSync, remoteSha, synchronizeBranch, synchronizeDevelop } from './synchronization.ts'

const ORIGIN_HELP = 'Save the GitHub remote on the setup screen.'
const GITHUB_REMOTE = /^(?:git@[\w.-]+:[\w./~-]+|ssh:\/\/git@[\w.-]+\/[\w./~-]+|https:\/\/[\w.-]+\/[\w./~-]+)(?:\.git)?$/
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const configuredDrift = Number(process.env.LOCAL_CI_MAX_BRANCH_DRIFT ?? 10)
const MAX_BRANCH_DRIFT = Number.isInteger(configuredDrift) && configuredDrift >= 0 ? configuredDrift : 10
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

const app = Fastify({
  logger: true,
  rewriteUrl: (request) => {
    const url = request.url ?? '/'
    return url.startsWith('/api/') ? url.slice(4) : url
  },
})

function discoverExistingRepositories() {
  mkdirSync(repositoryRoot, { recursive: true })
  for (const entry of readdirSync(repositoryRoot)) {
    if (!entry.endsWith('.git')) continue
    const id = entry.slice(0, -4)
    const path = join(repositoryRoot, entry)
    try {
      if (!statSync(join(path, 'HEAD')).isFile()) continue
      const origin = readOrigin(path)
      const existing = getRepository(id)
      saveRepository({ id, name: existing?.name ?? id, barePath: path, origin })
    } catch {
      // Ignore folders that are not initialized bare repositories.
    }
  }
}

function repositoryFor(id: unknown) {
  if (typeof id === 'string' && REPOSITORY_ID.test(id)) return getRepository(id)
  return undefined
}

async function snapshotFor(repository: NonNullable<ReturnType<typeof getRepository>>) {
  let syncError: string | null = null
  try {
    if (!integrationControl(repository.id)) await synchronizeDevelop(repository.barePath)
    await synchronizeBranch(repository.barePath, 'main')
  } catch (error) {
    syncError = error instanceof Error ? error.message : String(error)
  }
  const snapshot = await currentRepoSnapshot(repository.barePath, repository.id, repository.name)
  const runs = recentRunsForRepository(repository.id)
  const branches = snapshot.branches.map((branch) => {
    const latest = runs.find((run) => run.branch === branch.name && run.target !== 'main')
    const readyMerge = latest?.status === 'passed' && latest.baseSha === snapshot.develop && latest.headSha === branch.sha
    const mainRun = runs.find((run) => run.target === 'main' && run.status === 'passed' && run.baseSha === snapshot.branches.find((item) => item.name === 'main')?.sha && run.headSha === snapshot.develop)
    let status: typeof branch.status = 'idle'
    if (branch.name === 'develop' && mainRun?.candidateSha) status = 'ready-to-deploy'
    else if (readyMerge && (branch.behindDevelop ?? 0) <= MAX_BRANCH_DRIFT) status = 'ready-to-merge'
    else if ((branch.behindDevelop ?? 0) > MAX_BRANCH_DRIFT) status = 'sync-required'
    else if (latest?.status === 'queued' || latest?.status === 'running' || latest?.status === 'failed') status = latest.status
    else if (latest?.status === 'passed') status = 'passed'
    return { ...branch, status }
  })
  return {
    ...snapshot, barePath: repository.barePath, maxBranchDrift: MAX_BRANCH_DRIFT, branches,
    githubDevelop: branchSync(repository.barePath, 'develop'),
    githubMain: branchSync(repository.barePath, 'main'),
    syncError,
    pendingReset: pendingPromotion(repository.id) ?? null,
    integration: integrationControl(repository.id) ?? null,
  }
}

discoverExistingRepositories()

app.get('/health', async () => ({ ok: true }))

app.get('/repositories', async () => ({ repositories: await Promise.all(listRepositories().map(snapshotFor)) }))

app.get<{ Querystring: { repository?: string } }>('/repo', async (request, reply) => {
  const selected = repositoryFor(request.query.repository) ?? listRepositories()[0]
  if (!selected) return reply.code(404).send({ error: 'no repositories registered' })
  return snapshotFor(selected)
})

app.get<{ Querystring: { repository?: string } }>('/runs', async (request, reply) => {
  if (request.query.repository) {
    if (!repositoryFor(request.query.repository)) return reply.code(404).send({ error: 'repository not found' })
    return { runs: listRunsForRepository(request.query.repository) }
  }
  return { runs: listRuns() }
})

app.post('/repositories', async (request, reply) => {
  const body = request.body as { id?: unknown; name?: unknown; github?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : id
  const github = typeof body?.github === 'string' ? body.github.trim() : ''
  if (!REPOSITORY_ID.test(id)) return reply.code(400).send({ error: 'Use a repository ID with letters, numbers, dots, underscores, or hyphens.' })
  if (name.length < 1 || name.length > 100) return reply.code(400).send({ error: 'Repository name is required.' })
  if (!GITHUB_REMOTE.test(github)) return reply.code(400).send({ error: 'Use a git@, ssh://, or https:// remote.' })
  if (getRepository(id)) return reply.code(409).send({ error: 'repository is already registered' })
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

app.get<{ Params: { id: string }; Querystring: { workflow?: string } }>('/runs/:id/logs', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  const workflow = request.query.workflow
  if (workflow && !listWorkflows(run.id).some((item) => item.path === workflow)) return reply.code(404).send({ error: 'workflow not found in run' })
  return { lines: listLogLines(run.id, workflow) }
})

app.get<{ Params: { id: string } }>('/runs/:id/workflows', async (request, reply) => {
  if (!getRun(request.params.id)) return reply.code(404).send({ error: 'run not found' })
  return { workflows: listWorkflows(request.params.id) }
})

app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  return { run }
})

app.get<{ Params: { id: string } }>('/runs/:id/result', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  const lines = listLogLines(run.id)
  const smoke = run.target === 'develop' && run.candidateSha ? smokeForCandidate(run.repository, run.candidateSha) : undefined
  const control = integrationControl(run.repository)
  const status = run.status === 'failed' ? 'failed' : run.integratedAt
    ? control?.mode === 'blocked' ? 'blocked'
      : (smoke && smoke.status !== 'passed') || (control?.developSha === run.candidateSha && control.reason === 'Post-merge smoke check')
        ? 'verifying' : 'integrated'
    : run.status
  return {
    runId: run.id, repository: run.repository, taskId: run.taskId ?? run.branch, branch: run.branch,
    headSha: run.headSha, candidateSha: run.candidateSha,
    status, smokeRunId: smoke?.id ?? null,
    exitCode: run.exitCode,
    failure: run.status === 'failed' ? lines.filter((line) => /error:|fail|conflict/i.test(line)).slice(-8) : [],
    artifactDirectory: join(workRoot, 'artifacts', run.id),
    logsUrl: `/api/runs/${encodeURIComponent(run.id)}/logs`,
  }
})

app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  if (!cancelQueuedRun(run.id) && !cancelActiveRun(run.id)) return reply.code(409).send({ error: 'run cannot be canceled' })
  return { canceled: run.id }
})

app.post<{ Params: { id: string } }>('/runs/:id/retry', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  const repository = repositoryFor(run.repository)
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  try { await synchronizeDevelop(repository.barePath, true) }
  catch (error) { return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` }) }
  const base = run.target === 'main' ? readBranchSha(repository.barePath, 'main') : run.target === 'reconcile' ? remoteSha(repository.barePath, 'develop') : run.target === 'post-merge' ? run.baseSha : readDevelopSha(repository.barePath)
  const head = run.target === 'main' || run.target === 'reconcile' ? readDevelopSha(repository.barePath) : readBranchSha(repository.barePath, run.branch)
  if (run.target === 'post-merge' && readDevelopSha(repository.barePath) !== run.candidateSha) return reply.code(409).send({ error: 'develop moved since the post-merge run' })
  if (base !== run.baseSha || head !== run.headSha) return reply.code(409).send({ error: 'branch SHAs moved; create a new validation' })
  const next = retryRun(run.id)
  if (!next) return reply.code(409).send({ error: 'run has no reusable candidate' })
  return reply.code(201).send({ run: next })
})

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

app.post('/reconcile', async (request, reply) => {
  const body = request.body as { repository?: unknown } | null
  const repository = repositoryFor(body?.repository)
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  const path = repository.barePath
  try { await synchronizeDevelop(path, true) }
  catch (error) { return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` }) }
  const sync = branchSync(path, 'develop')
  if (sync.relation !== 'diverged' || !sync.local || !sync.github) return reply.code(409).send({ error: 'develop is not diverged' })
  const merged = await createTemporaryMerge({ bareRepo: path, baseSha: sync.github, headSha: sync.local })
  if ('conflict' in merged) return reply.code(409).send({ error: 'reconciliation has merge conflicts; resolve in your working copy' })
  retainCandidate(path, merged.sha)
  const run = recordCandidate({ repository: repository.id, ref: 'refs/heads/develop', oldSha: sync.github,
    newSha: merged.sha, baseSha: sync.github, headSha: sync.local, candidateSha: merged.sha,
    target: 'reconcile', status: 'queued' })
  return reply.code(201).send({ run })
})

app.post('/reconciliations', async (request, reply) => {
  const body = request.body as { runId?: unknown } | null
  const run = typeof body?.runId === 'string' ? getRun(body.runId) : undefined
  if (!run || run.target !== 'reconcile' || run.status !== 'passed' || !run.candidateSha) return reply.code(409).send({ error: 'passed reconciliation is required' })
  const repository = repositoryFor(run.repository)
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  const path = repository.barePath
  try {
    await synchronizeDevelop(path, true)
    assertRemoteUnchanged(path, 'develop', run.baseSha)
    if (readDevelopSha(path) !== run.headSha) return reply.code(409).send({ error: 'local develop moved; revalidate' })
    compareAndSwapDevelop(path, run.candidateSha, run.headSha!)
    clearRepoCache()
    return reply.code(201).send({ develop: run.candidateSha })
  } catch (error) { return reply.code(409).send({ error: String(error) }) }
})

app.post('/reset-develop', async (request, reply) => {
  const body = request.body as { repository?: unknown } | null
  const repository = repositoryFor(body?.repository)
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  return withRepositoryLock(repository.id, async () => {
  const promotion = pendingPromotion(repository.id)
  if (!promotion) return reply.code(409).send({ error: 'no pending promotion' })
  if (!integrationControl(repository.id)) return reply.code(409).send({ error: 'promotion freeze is missing; resolve recovery before reset' })
  const path = repository.barePath
  try {
    await synchronizeDevelop(path, true)
    await synchronizeBranch(path, 'main')
    assertRemoteUnchanged(path, 'main', promotion.mainSha)
    if (readBranchSha(path, 'main') !== promotion.mainSha) {
      return reply.code(409).send({ error: 'local branches moved since promotion' })
    }
    const githubSha = remoteSha(path, 'develop')
    let result = 'Remote develop already reset'
    if (githubSha !== promotion.mainSha) {
      assertRemoteUnchanged(path, 'develop', promotion.githubDevelopSha)
      if (readDevelopSha(path) !== promotion.developSha) return reply.code(409).send({ error: 'local develop moved since promotion' })
      const lease = `--force-with-lease=refs/heads/develop:${promotion.githubDevelopSha ?? ''}`
      result = execFileSync('git', [`--git-dir=${path}`, 'push', lease, 'origin', `${promotion.mainSha}:refs/heads/develop`],
        { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    }
    if (readDevelopSha(path) === promotion.developSha && promotion.mainSha !== promotion.developSha) {
      compareAndSwapDevelop(path, promotion.mainSha, promotion.developSha)
    } else if (readDevelopSha(path) !== promotion.mainSha) {
      setIntegrationControl(repository.id, 'blocked', promotion.developSha, 'Remote reset completed but local develop moved; reconcile manually')
      return reply.code(409).send({ error: 'remote reset completed but local develop moved; recovery required' })
    }
    finishPromotion(repository.id)
    clearIntegrationControl(repository.id)
    clearRepoCache()
    return reply.code(201).send({ develop: promotion.mainSha, result })
  } catch (error) { return reply.code(409).send({ error: `reset blocked: ${String(error)}` }) }
  })
})

app.post('/events', async (request, reply) => {
  const parsed = asPush(request.body as PushBody)
  if (typeof parsed === 'string') return reply.code(400).send({ error: parsed })
  const repository = repositoryFor(parsed.repository)
  if (!repository) return reply.code(404).send({ error: 'repository is not registered' })
  return withRepositoryLock(repository.id, async () => {
  const repoPath = repository.barePath
  if (parsed.ref === 'refs/heads/develop' || parsed.ref === 'refs/heads/main') {
    return reply.code(400).send({ error: 'that branch moves only from the dashboard' })
  }
  if (parsed.newSha === DELETED) return { ignored: 'branch delete' }

  try {
    const sync = integrationControl(repository.id) ? branchSync(repoPath, 'develop') : await synchronizeDevelop(repoPath, true)
    if (sync.relation === 'diverged') return reply.code(409).send({ error: 'develop diverged from GitHub; validate a reconciliation first' })
  } catch (error) {
    return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` })
  }
  if (readBranchSha(repoPath, parsed.ref.slice('refs/heads/'.length)) !== parsed.newSha) {
    return reply.code(409).send({ error: 'branch moved since this push event' })
  }

  const developSha = readDevelopSha(repoPath)
  if (!developSha) {
    const run = recordCandidate({
      ...parsed,
      baseSha: null,
      headSha: parsed.newSha,
      candidateSha: null,
      status: 'failed',
      logLine: 'refs/heads/develop is missing. Connect the repository in the dashboard.',
    })
    return reply.code(201).send({ run })
  }

  const behind = Number(execFileSync('git', [`--git-dir=${repoPath}`, 'rev-list', '--count', `${parsed.newSha}..${developSha}`], { encoding: 'utf8' }).trim())
  if (behind > MAX_BRANCH_DRIFT) {
    const run = recordCandidate({
      ...parsed,
      baseSha: developSha,
      headSha: parsed.newSha,
      candidateSha: null,
      status: 'failed',
      logLine: `branch is ${behind} commits behind develop; sync/rebase is required before validation (limit ${MAX_BRANCH_DRIFT})`,
    })
    return reply.code(201).send({ run })
  }

  const merged = await createTemporaryMerge({
    bareRepo: repoPath,
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

  retainCandidate(repoPath, merged.sha)
  const run = recordCandidate({
    ...parsed,
    newSha: merged.sha.toLowerCase(),
    baseSha: developSha,
    headSha: parsed.newSha,
    candidateSha: merged.sha.toLowerCase(),
    status: 'queued',
    taskId: parsed.ref.slice('refs/heads/'.length),
  })
  return reply.code(201).send({ run })
  })
})

app.post('/runs/manual', async (request, reply) => {
  const body = request.body as { repository?: unknown; branch?: unknown } | null
  const repository = repositoryFor(body?.repository)
  const branch = body?.branch
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  if (typeof branch !== 'string' || !REF.test(`refs/heads/${branch}`) || branch === 'main' || branch === 'develop') {
    return reply.code(400).send({ error: 'choose a feature branch' })
  }
  const sha = readBranchSha(repository.barePath, branch)
  if (!sha) return reply.code(404).send({ error: 'branch not found' })
  const response = await app.inject({ method: 'POST', url: '/events', payload: {
    repository: repository.id, ref: `refs/heads/${branch}`, oldSha: DELETED, newSha: sha,
  } })
  return reply.code(response.statusCode).send(response.json())
})

app.post('/merges', async (_request, reply) => reply.code(409).send({ error: 'Feature candidates integrate automatically after their checks pass.' }))

app.post('/main', async (request, reply) => {
  const body = request.body as { repository?: unknown } | null
  const repository = repositoryFor(body?.repository) ?? listRepositories()[0]
  if (!repository) return reply.code(404).send({ error: 'repository not found' })
  return withRepositoryLock(repository.id, async () => {
  if (integrationControl(repository.id)) return reply.code(409).send({ error: 'promotion or recovery is already active' })
  const frozenSha = readDevelopSha(repository.barePath)
  if (!frozenSha) return reply.code(409).send({ error: 'develop is missing' })
  setIntegrationControl(repository.id, 'frozen', frozenSha, 'Validating develop for promotion')
  const repoPath = repository.barePath
  try {
    const develop = await synchronizeDevelop(repoPath, true)
    const main = await synchronizeBranch(repoPath, 'main')
    if (develop.relation === 'diverged' || main.relation === 'diverged' || readDevelopSha(repoPath) !== frozenSha) {
      clearIntegrationControl(repository.id)
      return reply.code(409).send({ error: 'branches changed during promotion setup; retry' })
    }
  } catch (error) { clearIntegrationControl(repository.id); return reply.code(502).send({ error: `GitHub synchronization failed: ${String(error)}` }) }
  const mainSha = readBranchSha(repoPath, 'main')
  const developSha = readDevelopSha(repoPath)
  if (!mainSha || !developSha) {
    clearIntegrationControl(repository.id)
    return reply.code(409).send({ error: 'main or develop is missing. Connect the repository in the dashboard.' })
  }
  const merged = await createTemporaryMerge({ bareRepo: repoPath, baseSha: mainSha, headSha: developSha })
  if ('conflict' in merged) {
    clearIntegrationControl(repository.id)
    const run = recordCandidate({
      repository: repository.id,
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
  retainCandidate(repoPath, sha)
  const run = recordCandidate({
    repository: repository.id,
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
})

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

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

app.get('/*', async (request, reply) => {
  const requested = request.params as { '*': string }
  const relative = decodeURIComponent(requested['*'] ?? '')
  const candidate = resolve(dashboardDistRoot, relative || 'index.html')
  const safeRoot = resolve(dashboardDistRoot) + '/'
  const file = candidate.startsWith(safeRoot) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(dashboardDistRoot, 'index.html')
  if (!existsSync(file)) return reply.code(503).type('text/plain').send('Dashboard is building. Start Local CI with npm run dev and try again.')
  reply.type(mimeTypes[extname(file)] ?? 'application/octet-stream')
  if (extname(file) === '.html') reply.header('cache-control', 'no-cache')
  return reply.send(createReadStream(file))
})

startWorker()

const port = Number(process.env.LOCAL_CI_PORT ?? 3001)
await app.listen({ host: process.env.LOCAL_CI_HOST ?? '127.0.0.1', port })
