import { currentRepoSnapshot } from '../git-repo.ts'
import { getRepository, integrationControl, pendingPromotion, recentRunsForRepository } from '../db.ts'
import { branchSync, synchronizeBranch, synchronizeDevelop } from '../synchronization.ts'

export const ORIGIN_HELP = 'Save the GitHub remote on the setup screen.'
export const GITHUB_REMOTE = /^(?:git@[\w.-]+:[\w./~-]+|ssh:\/\/git@[\w.-]+\/[\w./~-]+|https:\/\/[\w.-]+\/[\w./~-]+)(?:\.git)?$/
export const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const configuredDrift = Number(process.env.LOCAL_CI_MAX_BRANCH_DRIFT ?? 10)
export const MAX_BRANCH_DRIFT = Number.isInteger(configuredDrift) && configuredDrift >= 0 ? configuredDrift : 10
export const DELETED = '0000000000000000000000000000000000000000'
const SHA = /^[0-9a-f]{40}$/
export const REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/

export type PushBody = {
  repository?: unknown
  ref?: unknown
  oldSha?: unknown
  newSha?: unknown
}

export function asPush(body: PushBody) {
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

export function repositoryFor(id: unknown) {
  if (typeof id === 'string' && REPOSITORY_ID.test(id)) return getRepository(id)
  return undefined
}

export async function snapshotFor(repository: NonNullable<ReturnType<typeof getRepository>>, sync = true) {
  let syncError: string | null = null
  if (sync) {
    try {
      if (!integrationControl(repository.id)) await synchronizeDevelop(repository.barePath)
      await synchronizeBranch(repository.barePath, 'main')
    } catch (error) {
      syncError = error instanceof Error ? error.message : String(error)
    }
  }
  const snapshot = await currentRepoSnapshot(repository.barePath, repository.id, repository.name, sync)
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
    githubDevelop: sync ? branchSync(repository.barePath, 'develop') : null,
    githubMain: sync ? branchSync(repository.barePath, 'main') : null,
    syncError,
    pendingReset: pendingPromotion(repository.id) ?? null,
    integration: integrationControl(repository.id) ?? null,
  }
}
