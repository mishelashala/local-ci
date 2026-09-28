import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('serial candidates retest against the moved base and a freeze defers integration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-integration-'));
  process.env.LOCAL_CI_DATA_DIR = join(root, 'data');
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'CI test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'ci@example.test';
  const bare = join(root, 'repo.git');
  const work = join(root, 'work');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sha = (ref: string) => git(`--git-dir=${bare}`, 'rev-parse', ref);
  try {
    git('init', '--bare', '-b', 'develop', bare);
    git('init', '-b', 'develop', work);
    git('-C', work, 'config', 'user.name', 'CI test');
    git('-C', work, 'config', 'user.email', 'ci@example.test');
    writeFileSync(join(work, 'base.txt'), 'base');
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-m', 'base');
    const base = git('-C', work, 'rev-parse', 'HEAD');
    git('-C', work, 'remote', 'add', 'ci', bare);
    git('-C', work, 'push', 'ci', 'develop');
    for (const branch of ['feat/a', 'feat/b']) {
      git('-C', work, 'checkout', '-b', branch, 'develop');
      writeFileSync(join(work, `${branch.slice(5)}.txt`), branch);
      git('-C', work, 'add', '.');
      git('-C', work, 'commit', '-m', branch);
      git('-C', work, 'push', 'ci', branch);
    }
    const db = await import('./db.ts');
    const { createTemporaryMerge, mergeBranchMessage } = await import('./git-merge.ts');
    const { integrate, maintainIntegrationQueue, completeSmoke } = await import('./integration.ts');
    db.saveRepository({ id: 'test', name: 'test', barePath: bare, origin: null });
    const records = [];
    for (const branch of ['feat/a', 'feat/b']) {
      const head = sha(`refs/heads/${branch}`);
      const merge = await createTemporaryMerge({
        bareRepo: bare,
        baseSha: base,
        headSha: head,
        message: mergeBranchMessage(branch, 'develop'),
      });
      assert.ok('sha' in merge);
      assert.equal(
        git(`--git-dir=${bare}`, 'log', '-1', '--format=%s', merge.sha),
        `Merge branch '${branch}' into develop`,
      );
      const { retainCandidate } = await import('./git-repo.ts');
      retainCandidate(bare, merge.sha);
      records.push(
        db.recordCandidate({
          repository: 'test',
          ref: `refs/heads/${branch}`,
          oldSha: base,
          newSha: merge.sha,
          baseSha: base,
          headSha: head,
          candidateSha: merge.sha,
          status: 'queued',
        }),
      );
    }
    const first = records[0];
    db.finishRun(first.id, 'passed', 0);
    db.setIntegrationControl('test', 'frozen', base, 'promotion');
    await integrate(first.id);
    assert.equal(sha('refs/heads/develop'), base);
    db.clearIntegrationControl('test');
    await maintainIntegrationQueue();
    assert.equal(sha('refs/heads/develop'), first.candidateSha);
    await maintainIntegrationQueue();
    const latest = db.listRunsForRepository('test').find((run) => run.branch === 'feat/b' && run.status === 'queued');
    assert.ok(latest);
    assert.equal(latest.baseSha, first.candidateSha);
    assert.notEqual(latest.candidateSha, records[1].candidateSha);
    assert.equal(
      git(`--git-dir=${bare}`, 'log', '-1', '--format=%s', latest.candidateSha!),
      `Merge branch 'feat/b' into develop`,
    );
    db.finishRun(latest.id, 'passed', 0);
    await integrate(latest.id);
    assert.equal(sha('refs/heads/develop'), latest.candidateSha);
    assert.equal(db.getRun(latest.id)?.integratedAt !== null, true);
    assert.throws(() => sha('refs/heads/feat/a'));
    assert.throws(() => sha('refs/heads/feat/b'));
    db.setIntegrationControl('test', 'frozen', latest.candidateSha, 'Post-merge smoke check');
    const smoke = db.recordCandidate({
      repository: 'test',
      ref: 'refs/heads/develop',
      oldSha: first.candidateSha!,
      newSha: latest.candidateSha!,
      baseSha: first.candidateSha,
      headSha: latest.candidateSha,
      candidateSha: latest.candidateSha,
      target: 'smoke',
      status: 'queued',
    });
    db.finishRun(smoke.id, 'failed', 1);
    await completeSmoke(smoke.id, 'failed');
    assert.equal(sha('refs/heads/develop'), first.candidateSha);
    assert.equal(db.getRun(latest.id)?.status, 'failed');
    assert.equal(db.integrationControl('test'), undefined);

    git('-C', work, 'checkout', '-b', 'feat/smoke', 'develop');
    mkdirSync(join(work, '.local-ci', 'workflows'), { recursive: true });
    writeFileSync(
      join(work, '.local-ci', 'workflows', 'develop-smoke.yml'),
      'on:\n  push:\n    branches: [develop]\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    );
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-m', 'feat/smoke');
    git('-C', work, 'push', 'ci', 'feat/smoke');
    const smokeHead = sha('refs/heads/feat/smoke');
    const smokeBase = sha('refs/heads/develop');
    const smokeMerge = await createTemporaryMerge({
      bareRepo: bare,
      baseSha: smokeBase,
      headSha: smokeHead,
      message: mergeBranchMessage('feat/smoke', 'develop'),
    });
    assert.ok('sha' in smokeMerge);
    const { retainCandidate } = await import('./git-repo.ts');
    retainCandidate(bare, smokeMerge.sha);
    const smokeCandidate = db.recordCandidate({
      repository: 'test',
      ref: 'refs/heads/feat/smoke',
      oldSha: smokeBase,
      newSha: smokeMerge.sha,
      baseSha: smokeBase,
      headSha: smokeHead,
      candidateSha: smokeMerge.sha,
      status: 'queued',
      taskId: 'feat/smoke',
    });
    db.finishRun(smokeCandidate.id, 'passed', 0);
    await integrate(smokeCandidate.id);
    assert.equal(sha('refs/heads/feat/smoke'), smokeHead);
    const smokeRun = db
      .listRunsForRepository('test')
      .find((run) => run.target === 'smoke' && run.candidateSha === smokeMerge.sha);
    assert.ok(smokeRun);
    db.finishRun(smokeRun.id, 'passed', 0);
    await completeSmoke(smokeRun.id, 'passed');
    assert.throws(() => sha('refs/heads/feat/smoke'));
    assert.equal(sha('refs/heads/develop'), smokeMerge.sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
