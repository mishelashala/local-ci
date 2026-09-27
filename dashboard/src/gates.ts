export type RepoSnapshot = {
  id: string
  name: string
  barePath: string
  maxBranchDrift: number
  develop: string | null
  branches: { name: string; sha: string; aheadOfDevelop: number | null; behindDevelop: number | null; status: 'ready-to-merge' | 'passed' | 'failed' | 'running' | 'queued' | 'sync-required' | 'idle' | 'ready-to-deploy' }[]
  origin: string | null
  githubDevelop?: { local: string | null; github: string | null; relation: string }
  githubMain?: { local: string | null; github: string | null; relation: string }
  syncError?: string | null
  pendingReset?: { mainSha: string; developSha: string; githubDevelopSha: string | null } | null
}

type MergeCandidate = {
  status: string
  branch: string
  baseSha: string | null
  headSha: string | null
  candidateSha: string | null
  target?: string | null
}

const SHA40 = /^[0-9a-f]{40}$/i

function isSha40(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA40.test(value)
}

export function mergeReady(run: MergeCandidate, repo: RepoSnapshot | null): boolean {
  if (repo === null || run.target === 'main' || run.target === 'reconcile' || run.target === 'post-merge' || repo.githubDevelop?.relation === 'diverged') return false
  const branch = repo.branches.find((item) => item.name === run.branch)
  return (
    run.status === 'passed' &&
    isSha40(run.candidateSha) &&
    repo.develop === run.baseSha &&
    branch?.sha === run.headSha && (branch.behindDevelop ?? 0) <= repo.maxBranchDrift
  )
}

export function pushDevelopSha(runs: readonly MergeCandidate[], repo: RepoSnapshot | null): string | null {
  if (repo === null || !isSha40(repo.develop)) return null
  const develop = repo.develop
  const candidate = runs.some((run) => run.status === 'passed' && (run.target === 'develop' || run.target === 'reconcile' || !run.target) && run.candidateSha === develop)
  const postMerge = runs.some((run) => run.status === 'passed' && run.target === 'post-merge' && run.candidateSha === develop)
  return candidate && postMerge ? develop : null
}

export function mainSha(repo: RepoSnapshot | null): string | null {
  const sha = repo?.branches.find((branch) => branch.name === 'main')?.sha
  return isSha40(sha) ? sha : null
}

export function pushMainSha(runs: readonly MergeCandidate[], repo: RepoSnapshot | null): string | null {
  const main = mainSha(repo)
  const develop = repo?.develop
  if (!main || !isSha40(develop)) return null
  const match = runs.find(
    (run) =>
      run.target === 'main' &&
      run.status === 'passed' &&
      run.baseSha === main &&
      run.headSha === develop &&
      isSha40(run.candidateSha),
  )
  return match?.candidateSha ?? null
}
