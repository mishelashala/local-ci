import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { laneFor } from './lane.ts';
import { usageFromSamples } from './usage.ts';

function developSha(root: string, name: string) {
  const bare = join(root, `${name}.git`);
  const work = join(root, name);
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  git('init', '--bare', '-b', 'develop', bare);
  git('init', '-b', 'develop', work);
  git('-C', work, 'config', 'user.name', 'CI test');
  git('-C', work, 'config', 'user.email', 'ci@example.test');
  writeFileSync(join(work, 'a.txt'), name);
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-m', 'base');
  const sha = git('-C', work, 'rev-parse', 'HEAD');
  git('-C', work, 'remote', 'add', 'ci', bare);
  git('-C', work, 'push', 'ci', 'develop');
  return { bare, sha };
}

test('server and marketplaces are different lanes', () => {
  assert.equal(laneFor('RxRise Server', 'server-id'), 'backend');
  assert.equal(laneFor('RxRise Marketplaces', 'market-id'), 'frontend');
  assert.equal(laneFor('RxRise Server', 'server-id'), laneFor('backend-extra', 'other'));
  assert.notEqual(laneFor('notes', 'notes-id'), 'frontend');
});

test('usage turns cpu deltas and bytes into percents and gigabytes', () => {
  const sample = usageFromSamples(
    { idle: 100, total: 200 },
    { idle: 150, total: 300 },
    { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  );
  assert.equal(sample.cpu, 50);
  assert.equal(sample.ramUsedGb, 8);
  assert.equal(sample.ramTotalGb, 16);
  assert.equal(usageFromSamples(null, { idle: 1, total: 2 }, { total: 1024 ** 3, free: 0 }).cpu, null);
});

test('a running frontend does not claim another frontend while a server run is queued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-lanes-'));
  process.env.LOCAL_CI_DATA_DIR = join(root, 'data');
  try {
    const db = await import('./db.ts');
    const market = developSha(root, 'market');
    const server = developSha(root, 'server');
    db.saveRepository({ id: 'market', name: 'RxRise Marketplaces', barePath: market.bare, origin: null });
    db.saveRepository({ id: 'server', name: 'RxRise Server', barePath: server.bare, origin: null });
    const queued = (repository: string, ref: string, sha: string) => {
      const run = db.recordCandidate({
        repository,
        ref,
        oldSha: sha,
        newSha: sha,
        baseSha: sha,
        headSha: sha,
        candidateSha: sha,
        status: 'queued',
      });
      return run.id;
    };
    const firstFrontend = queued('market', 'refs/heads/feat/one', market.sha);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const serverRun = queued('server', 'refs/heads/feat/api', server.sha);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondFrontend = queued('market', 'refs/heads/feat/two', market.sha);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondServer = queued('server', 'refs/heads/feat/api-two', server.sha);

    const claimedFirst = db.claimNextRunGlobal();
    const claimedSecond = db.claimNextRunGlobal();
    const claimedThird = db.claimNextRunGlobal();
    assert.equal(claimedFirst?.id, firstFrontend);
    assert.equal(claimedSecond?.id, serverRun);
    assert.equal(claimedThird, undefined);

    db.finishRun(serverRun, 'passed', 0);
    const claimedWhileFrontendRuns = db.claimNextRunGlobal();
    assert.equal(claimedWhileFrontendRuns?.id, secondServer);
    assert.equal(db.claimNextRunGlobal(), undefined);

    db.finishRun(firstFrontend, 'passed', 0);
    const claimedAfterFrontend = db.claimNextRunGlobal();
    assert.equal(claimedAfterFrontend?.id, secondFrontend);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
