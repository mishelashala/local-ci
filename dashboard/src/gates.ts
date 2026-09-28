export type RepoSnapshot = {
  id: string;
  name: string;
  barePath: string;
  maxBranchDrift: number;
  develop: string | null;
  branches: {
    name: string;
    sha: string;
    aheadOfDevelop: number | null;
    behindDevelop: number | null;
    status:
      | 'ready-to-merge'
      | 'passed'
      | 'failed'
      | 'running'
      | 'queued'
      | 'sync-required'
      | 'idle'
      | 'ready-to-deploy';
  }[];
  origin: string | null;
  githubDevelop?: { local: string | null; github: string | null; relation: string };
  githubMain?: { local: string | null; github: string | null; relation: string };
  syncError?: string | null;
  pendingReset?: { mainSha: string; developSha: string; githubDevelopSha: string | null } | null;
  integration?: { mode: 'frozen' | 'blocked'; developSha: string | null; reason: string | null } | null;
};

type MergeCandidate = {
  status: string;
  branch: string;
  baseSha: string | null;
  headSha: string | null;
  candidateSha: string | null;
  target?: string | null;
  integratedAt?: number | null;
};

const SHA40 = /^[0-9a-f]{40}$/i;

function isSha40(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

export function mergeReady(run: MergeCandidate, repo: RepoSnapshot | null): boolean {
  void run;
  void repo;
  return false; // Integration is automatic; kept for older UI clients.
}

export function pushDevelopSha(runs: readonly MergeCandidate[], repo: RepoSnapshot | null): string | null {
  if (repo === null || !isSha40(repo.develop)) {
    return null;
  }
  const develop = repo.develop;
  const candidate = runs.some(
    (run) => run.status === 'passed' && run.target === 'develop' && run.integratedAt && run.candidateSha === develop,
  );
  return candidate && !repo.integration ? develop : null;
}

export function developMatchesGitHub(repo: RepoSnapshot | null): boolean {
  const local = repo?.develop;
  const github = repo?.githubDevelop?.github;
  return isSha40(local) && isSha40(github) && local.toLowerCase() === github.toLowerCase();
}

export function mainSha(repo: RepoSnapshot | null): string | null {
  const sha = repo?.branches.find((branch) => branch.name === 'main')?.sha;
  return isSha40(sha) ? sha : null;
}

export function pushMainSha(runs: readonly MergeCandidate[], repo: RepoSnapshot | null): string | null {
  const main = mainSha(repo);
  const develop = repo?.develop;
  if (!main || !isSha40(develop)) {
    return null;
  }
  const match = runs.find(
    (run) =>
      run.target === 'main' &&
      (run.status === 'passed' || run.status === 'ready') &&
      run.baseSha === main &&
      run.headSha === develop &&
      isSha40(run.candidateSha),
  );
  return match?.candidateSha ?? null;
}
