import { execFileSync } from 'node:child_process';
import {
  appendLog,
  clearIntegrationControl,
  getRepository,
  getRun,
  integrationControl,
  interruptedPromotionValidation,
  interruptedSmoke,
  listRunsForRepository,
  markDefective,
  markIntegrated,
  markRunStale,
  pendingIntegration,
  recordCandidate,
  retireCandidate,
  setIntegrationControl,
  staleOrQueuedCandidates,
} from './db.ts';
import { createTemporaryMerge, mergeBranchMessage } from './git-merge.ts';
import {
  clearRepoCache,
  compareAndSwapDevelop,
  deleteBranchIfMatches,
  readBranchSha,
  readDevelopSha,
  retainCandidate,
} from './git-repo.ts';

// Serializes the short ref transition with promotion state changes in this process.
// The durable control row preserves a freeze over a scheduler restart.
const tails = new Map<string, Promise<void>>();
export async function withRepositoryLock<T>(repository: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(repository) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(repository, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(repository) === tail) tails.delete(repository);
  }
}

function dropMergedBranch(bareRepo: string, branch: string, expectedSha: string, logId: string) {
  const result = deleteBranchIfMatches(bareRepo, branch, expectedSha);
  if (result === 'deleted') appendLog(logId, `Deleted branch ${branch} after it landed on develop.`);
  if (result === 'moved') appendLog(logId, `Branch ${branch} moved after the merge; left it in place.`);
}

function isAncestor(repo: string, head: string, base: string) {
  try {
    execFileSync('git', [`--git-dir=${repo}`, 'merge-base', '--is-ancestor', head, base], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function rebuild(id: string): Promise<void> {
  const run = getRun(id);
  if (run?.target !== 'develop' || !['queued', 'stale', 'passed'].includes(run.status) || run.integratedAt) return;
  const repository = getRepository(run.repository);
  if (!repository || integrationControl(run.repository)) return;
  const base = readDevelopSha(repository.barePath);
  const head = readBranchSha(repository.barePath, run.branch);
  if (!base || !head) {
    retireCandidate(id, 'Branch or develop disappeared; resubmit the branch.');
    return;
  }
  if (head !== run.headSha) {
    retireCandidate(id, 'A newer branch tip superseded this run.');
    return;
  }
  if (run.baseSha === base) {
    if (run.status === 'stale') retireCandidate(id, 'Stale run cannot be reused; push or enqueue the branch again.');
    return;
  }
  markRunStale(id);
  if (isAncestor(repository.barePath, head, base)) {
    retireCandidate(id, 'Branch tip is already in develop.');
    return;
  }
  const merged = await createTemporaryMerge({
    bareRepo: repository.barePath,
    baseSha: base,
    headSha: head,
    message: mergeBranchMessage(run.branch, 'develop'),
  });
  if ('conflict' in merged) {
    recordCandidate({
      repository: run.repository,
      ref: run.ref,
      oldSha: run.oldSha,
      newSha: head,
      baseSha: base,
      headSha: head,
      candidateSha: null,
      target: 'develop',
      status: 'failed',
      taskId: run.taskId,
      logLine: 'merge conflict against current develop; the owning agent must update this branch',
    });
    return;
  }
  retainCandidate(repository.barePath, merged.sha);
  recordCandidate({
    repository: run.repository,
    ref: run.ref,
    oldSha: run.oldSha,
    newSha: merged.sha,
    baseSha: base,
    headSha: head,
    candidateSha: merged.sha,
    target: 'develop',
    status: 'queued',
    taskId: run.taskId,
    logLine: `Rebuilt after develop moved from ${run.baseSha} to ${base}`,
  });
}

export async function integrate(id: string): Promise<void> {
  const initial = getRun(id);
  if (initial?.target !== 'develop') return;
  await withRepositoryLock(initial.repository, async () => {
    const run = getRun(id);
    const repository = getRepository(initial.repository);
    if (!run || !repository || run.status !== 'passed' || run.integratedAt || integrationControl(run.repository))
      return;
    const base = readDevelopSha(repository.barePath);
    const head = readBranchSha(repository.barePath, run.branch);
    if (!base || !head || head !== run.headSha || !run.candidateSha || !run.baseSha) {
      markRunStale(id);
      appendLog(id, 'Source branch changed before integration; a newer push must pass.');
      return;
    }
    if (base !== run.baseSha) {
      await rebuild(id);
      return;
    }
    const smokeConfigured = (() => {
      try {
        execFileSync(
          'git',
          [
            `--git-dir=${repository.barePath}`,
            'cat-file',
            '-e',
            `${run.candidateSha}:.local-ci/workflows/develop-smoke.yml`,
          ],
          { stdio: 'ignore' },
        );
        return true;
      } catch {
        return false;
      }
    })();
    try {
      compareAndSwapDevelop(repository.barePath, run.candidateSha, base);
    } catch {
      await rebuild(id);
      return;
    }
    if (smokeConfigured) setIntegrationControl(run.repository, 'frozen', run.candidateSha, 'Post-merge smoke check');
    markIntegrated(id);
    appendLog(id, `Automatically integrated ${run.candidateSha} into local develop.`);
    if (!smokeConfigured && run.headSha) dropMergedBranch(repository.barePath, run.branch, run.headSha, id);
    clearRepoCache();
    if (smokeConfigured)
      try {
        recordCandidate({
          repository: run.repository,
          ref: 'refs/heads/develop',
          oldSha: base,
          newSha: run.candidateSha,
          baseSha: base,
          headSha: run.candidateSha,
          candidateSha: run.candidateSha,
          target: 'smoke',
          status: 'queued',
          taskId: run.taskId,
        });
      } catch (error) {
        setIntegrationControl(
          run.repository,
          'blocked',
          run.candidateSha,
          `Could not enqueue smoke check: ${String(error)}`,
        );
      }
  });
}

export async function completeSmoke(id: string, status: 'passed' | 'failed' | 'canceled') {
  const run = getRun(id);
  if (run?.target !== 'smoke') return;
  await withRepositoryLock(run.repository, () => {
    const control = integrationControl(run.repository);
    const repository = getRepository(run.repository);
    if (!repository || control?.developSha !== run.candidateSha || control.mode !== 'frozen') return;
    if (status === 'passed') {
      appendLog(id, `Healthy develop ${run.candidateSha}; integration resumes.`);
      const source = listRunsForRepository(run.repository).find(
        (item) =>
          item.target === 'develop' &&
          item.candidateSha === run.candidateSha &&
          item.integratedAt &&
          item.headSha &&
          item.branch !== 'develop' &&
          item.branch !== 'main',
      );
      if (source?.headSha) dropMergedBranch(repository.barePath, source.branch, source.headSha, id);
      clearRepoCache();
      clearIntegrationControl(run.repository);
      return;
    }
    if (!run.baseSha || !run.candidateSha) return;
    try {
      compareAndSwapDevelop(repository.barePath, run.baseSha, run.candidateSha);
      markDefective(run.repository, run.candidateSha);
      appendLog(
        id,
        `Smoke failed; rolled back local develop to ${run.baseSha}. Candidate ${run.candidateSha} is defective.`,
      );
      clearRepoCache();
      clearIntegrationControl(run.repository);
    } catch {
      markDefective(run.repository, run.candidateSha);
      setIntegrationControl(
        run.repository,
        'blocked',
        run.candidateSha,
        'Smoke failed and develop moved; manual recovery required',
      );
      appendLog(id, 'Smoke failed; develop moved, so automatic rollback was blocked.');
    }
  });
}

export async function maintainIntegrationQueue(): Promise<void> {
  const smoke = interruptedSmoke();
  if (smoke) {
    await completeSmoke(smoke.id, smoke.status);
    return;
  }
  const promotion = interruptedPromotionValidation();
  if (promotion) {
    await withRepositoryLock(promotion.repository, () => clearIntegrationControl(promotion.repository));
    return;
  }
  const pending = pendingIntegration();
  if (pending) {
    await integrate(pending.id);
    return;
  }
  for (const { id } of staleOrQueuedCandidates()) {
    const run = getRun(id);
    const repository = run && getRepository(run.repository);
    if (!run || !repository) continue;
    if (run.status === 'stale' || readDevelopSha(repository.barePath) !== run.baseSha) {
      await withRepositoryLock(run.repository, () => rebuild(id));
      return;
    }
  }
}
