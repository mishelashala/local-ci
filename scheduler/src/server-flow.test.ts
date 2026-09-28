import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('API runs YAML, integrates agents, freezes promotion, pushes and resets exact refs', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-server-'));
  const repos = join(root, 'repos');
  const origin = join(root, 'github.git');
  const work = join(root, 'work');
  const local = join(repos, 'project.git');
  const bin = join(root, 'bin');
  const port = 39000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  mkdirSync(repos);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const ref = (repo: string, branch: string) => git(`--git-dir=${repo}`, 'rev-parse', `refs/heads/${branch}`);
  const post = async (path: string, body: object) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      assert.fail(`${path}: ${response.status} ${await response.text()}`);
    }
    return response.json();
  };
  const wait = async (predicate: () => Promise<boolean>) => {
    for (let n = 0; n < 120; n++) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail('server flow timed out');
  };
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'CI test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'ci@example.test';
  let server: ReturnType<typeof spawn> | undefined;
  try {
    git('init', '--bare', '-b', 'main', origin);
    git('init', '-b', 'main', work);
    git('-C', work, 'config', 'user.name', 'CI test');
    git('-C', work, 'config', 'user.email', 'ci@example.test');
    mkdirSync(join(work, '.local-ci', 'workflows'), { recursive: true });
    writeFileSync(
      join(work, '.local-ci', 'workflows', 'tests.yml'),
      'on:\n  pull_request:\n    branches: [develop, main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    );
    writeFileSync(join(work, 'base.txt'), 'base');
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-m', 'base');
    git('-C', work, 'remote', 'add', 'origin', origin);
    git('-C', work, 'push', 'origin', 'main:main', 'main:develop');
    git('clone', '--bare', origin, local);
    git(`--git-dir=${local}`, 'remote', 'set-url', 'origin', origin);
    git(`--git-dir=${local}`, 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*');
    git('-C', work, 'remote', 'add', 'ci', local);
    writeFileSync(
      join(bin, 'act'),
      '#!/bin/sh\necho "fake act: $1 $*"\nif [ "$1" = push ]; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo \'[]\' ;;\n  "pr create") echo \'https://github.com/example/project/pull/7\' ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o755 },
    );
    server = spawn('node', ['--import', './scheduler/node_modules/tsx/dist/loader.mjs', 'scheduler/src/index.ts'], {
      cwd: join(import.meta.dirname, '..', '..'),
      env: {
        ...process.env,
        LOCAL_CI_REPOSITORY_ROOT: repos,
        LOCAL_CI_DATA_DIR: join(root, 'data'),
        LOCAL_CI_PORT: String(port),
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdio: 'ignore',
    });
    await wait(async () =>
      fetch(`${base}/api/health`)
        .then((r) => r.ok)
        .catch(() => false),
    );
    const createBranch = (branch: string) => {
      git('-C', work, 'checkout', '-b', branch, 'main');
      writeFileSync(join(work, `${branch.slice(5)}.txt`), branch);
      git('-C', work, 'add', '.');
      git('-C', work, 'commit', '-m', branch);
      const head = git('-C', work, 'rev-parse', 'HEAD');
      git('-C', work, 'push', 'ci', branch);
      return head;
    };
    const headA = createBranch('feat/a');
    const pushEvent = (branch: string, head: string) =>
      post('/api/events', { repository: 'project', ref: `refs/heads/${branch}`, oldSha: '0'.repeat(40), newSha: head });
    const { run: first } = await pushEvent('feat/a', headA);
    await wait(async () => (await (await fetch(`${base}/api/runs/${first.id}`)).json()).run.integratedAt !== null);
    const workflows = (await (await fetch(`${base}/api/runs/${first.id}/workflows`)).json()).workflows;
    assert.deepEqual(
      workflows.map((item: { path: string; status: string }) => [item.path, item.status]),
      [['.local-ci/workflows/tests.yml', 'passed']],
    );
    const log = (
      await (await fetch(`${base}/api/runs/${first.id}/logs?workflow=.local-ci%2Fworkflows%2Ftests.yml`)).json()
    ).lines;
    assert.ok(log.some((line: string) => line.includes('fake act')));
    const staged = ref(local, 'develop');
    await post('/api/pushes', { repository: 'project', branch: 'develop' });
    assert.equal(ref(origin, 'develop'), staged);
    git(`--git-dir=${local}`, 'remote', 'set-url', 'origin', 'git@github.com:example/project.git');
    git(`--git-dir=${local}`, 'config', `url.${origin}/.insteadOf`, 'git@github.com:example/project.git');
    const promotion = await post('/api/main', { repository: 'project' });
    assert.equal(promotion.url, 'https://github.com/example/project/pull/7');
    const headB = createBranch('feat/b');
    await pushEvent('feat/b', headB);
    await wait(async () => {
      const runs = (await (await fetch(`${base}/api/runs?repository=project`)).json()).runs;
      return runs.some(
        (item: { branch: string; integratedAt: number | null }) => item.branch === 'feat/b' && item.integratedAt,
      );
    });
    const healthy = ref(local, 'develop');
    git('-C', work, 'checkout', '-b', 'feat/c', 'main');
    writeFileSync(
      join(work, '.local-ci', 'workflows', 'develop-smoke.yml'),
      'on:\n  push:\n    branches: [develop]\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo health\n',
    );
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-m', 'feat/c');
    const headC = git('-C', work, 'rev-parse', 'HEAD');
    git('-C', work, 'push', 'ci', 'feat/c');
    const { run: third } = await pushEvent('feat/c', headC);
    await wait(async () => (await (await fetch(`${base}/api/runs/${third.id}`)).json()).run.status === 'failed');
    assert.equal(ref(local, 'develop'), healthy);
    const result = await (await fetch(`${base}/api/runs/${third.id}/result`)).json();
    assert.equal(result.status, 'failed');
  } finally {
    server?.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
