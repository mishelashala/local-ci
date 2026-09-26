export type RepoSnapshot = {
  develop: string | null
  branches: { name: string; sha: string }[]
  origin: string | null
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
  if (repo === null || run.target === 'main') return false
  return (
    run.status === 'passed' &&
    isSha40(run.candidateSha) &&
    repo.develop === run.baseSha &&
    repo.branches.some((branch) => branch.name === run.branch && branch.sha === run.headSha)
  )
}

export function pushDevelopSha(runs: readonly MergeCandidate[], repo: RepoSnapshot | null): string | null {
  if (repo === null || !isSha40(repo.develop)) return null
  const develop = repo.develop
  const matched = runs.some((run) => run.status === 'passed' && run.target !== 'main' && run.candidateSha === develop)
  return matched ? develop : null
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
