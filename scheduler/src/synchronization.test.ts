import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDevelopSha } from './git-repo.ts';
import { matchLocalDevelop } from './synchronization.ts';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('matching diverged develop uses the GitHub commit and creates none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-sync-'));
  const work = join(root, 'work');
  const origin = join(root, 'origin.git');
  const local = join(root, 'local.git');
  try {
    execFileSync('git', ['init', '-q', '-b', 'develop', work]);
    git(work, ['config', 'user.email', 'ci@example.test']);
    git(work, ['config', 'user.name', 'CI']);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const base = git(work, ['rev-parse', 'HEAD']);
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git(work, ['remote', 'add', 'origin', origin]);
    git(work, ['push', '-q', 'origin', 'develop']);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'github']);
    const github = git(work, ['rev-parse', 'HEAD']);
    git(work, ['push', '-q', 'origin', 'develop']);
    execFileSync('git', ['clone', '--bare', '-q', origin, local]);
    git(work, ['update-ref', 'refs/heads/develop', base]);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'local-only']);
    const localOnly = git(work, ['rev-parse', 'HEAD']);
    execFileSync('git', [`--git-dir=${local}`, 'fetch', '-q', work, '+refs/heads/develop:refs/heads/develop']);
    assert.notEqual(github, localOnly);
    const after = await matchLocalDevelop(local);
    assert.equal(after.relation, 'same');
    assert.equal(readDevelopSha(local), github);
    assert.equal(
      execFileSync('git', [`--git-dir=${local}`, 'rev-parse', 'refs/heads/develop'], { encoding: 'utf8' }).trim(),
      github,
    );
    assert.equal(
      execFileSync('git', [`--git-dir=${local}`, 'rev-list', '--parents', '-n', '1', 'refs/heads/develop'], {
        encoding: 'utf8',
      }).trim(),
      `${github} ${base}`,
    );
    assert.throws(() =>
      execFileSync('git', [`--git-dir=${local}`, 'merge-base', '--is-ancestor', localOnly, 'refs/heads/develop'], {
        stdio: 'ignore',
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
