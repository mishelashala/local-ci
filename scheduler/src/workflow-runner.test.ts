import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ActWorkflowRunner,
  actContainerPath,
  actEnvContents,
  containerArchitecture,
  ghContainerOption,
  remapHostPorts,
} from './workflow-runner.ts';

test('container architecture matches GitHub ubuntu-latest unless configured', () => {
  assert.equal(containerArchitecture(''), 'linux/amd64');
  assert.equal(containerArchitecture('   '), 'linux/amd64');
  assert.equal(containerArchitecture(undefined), 'linux/amd64');
  assert.equal(containerArchitecture('linux/arm64'), 'linux/arm64');
});

test('job env mounts gh and keeps the token out of the command line', () => {
  const contents = actEnvContents('/usr/bin', 'secret-token', 'PATH=/old\nGH_TOKEN=old\nFEATURE=1\n');
  assert.match(
    contents,
    /^FEATURE=1\nPATH=\/usr\/bin\nGH_TOKEN=secret-token\nGITHUB_TOKEN=secret-token\nnpm_config_store_dir=\/pnpm\/store\n$/,
  );
  assert.match(
    actEnvContents(
      '/usr/bin',
      null,
      'LOCAL_CI_CHANGED_FILES=old\nnpm_config_store_dir=/tmp/other\n',
      'src/a.ts,src/b.ts',
    ),
    /LOCAL_CI_CHANGED_FILES=src\/a.ts,src\/b.ts\nnpm_config_store_dir=\/pnpm\/store\n$/,
  );
  assert.doesNotMatch(actEnvContents('/usr/bin', null, 'LOCAL_CI_CHANGED_FILES=old\n', 'src/a.ts'), /old/);
  assert.doesNotMatch(contents, /\/old/);
  assert.doesNotMatch(actEnvContents('/usr/bin', null, 'npm_config_store_dir=/tmp/other\n'), /\/tmp\/other/);
  const option = ghContainerOption('/opt/ci/gh');
  assert.equal(option, '--volume /opt/ci/gh:/usr/local/bin/gh:ro');
  assert.doesNotMatch(option, /secret-token/);
});

test('act PATH keeps both node architectures', () => {
  const path = actContainerPath('/opt/acttoolcache/node/24.19.0/arm64/bin:/usr/bin');
  assert.match(path, /^\/opt\/acttoolcache\/node\/24\.19\.0\/x64\/bin:/);
  assert.match(path, /\/opt\/acttoolcache\/node\/24\.19\.0\/arm64\/bin/);
  assert.match(path, /\/usr\/bin:/);
});

test('busy workflow host ports move to a free port', () => {
  const source = [
    'jobs:',
    '  tests:',
    '    services:',
    '      postgres:',
    '        ports:',
    '          - 5432:5432',
    '    steps:',
    '      - run: echo ok',
    '        env:',
    '          DATABASE_URL: postgres://root:root@localhost:5432/test_db',
  ].join('\n');
  const remapped = remapHostPorts(
    source,
    (port) => port === 5432,
    () => 55123,
  );
  assert.equal(remapped.changes.length, 1);
  assert.deepEqual(remapped.changes[0], { from: 5432, to: 55123 });
  assert.match(remapped.text, /55123:5432/);
  assert.doesNotMatch(remapped.text, /55123:55123/);
  assert.match(remapped.text, /localhost:55123/);
  const free = remapHostPorts(
    source,
    () => false,
    () => 55123,
  );
  assert.equal(free.text, source);
  assert.deepEqual(free.changes, []);
});

test('jobs that publish the same host port each get their own', () => {
  const source = [
    'jobs:',
    '  first:',
    '    services:',
    '      postgres:',
    '        ports:',
    '          - 5432:5432',
    '    steps:',
    '      - run: echo ok',
    '        env:',
    '          DATABASE_URL: postgres://root:root@localhost:5432/test_db',
    '  second:',
    '    services:',
    '      postgres:',
    '        ports:',
    '          - 5432:5432',
    '    steps:',
    '      - run: echo ok',
    '        env:',
    '          DATABASE_URL: postgres://root:root@127.0.0.1:5432/test_db',
  ].join('\n');
  let next = 55123;
  const remapped = remapHostPorts(
    source,
    (port) => port === 5432,
    () => next++,
  );
  assert.deepEqual(remapped.changes, [
    { from: 5432, to: 55123 },
    { from: 5432, to: 55124 },
  ]);
  assert.match(remapped.text, /55123:5432/);
  assert.match(remapped.text, /55124:5432/);
  assert.match(remapped.text, /localhost:55123/);
  assert.match(remapped.text, /127\.0\.0\.1:55124/);
  assert.doesNotMatch(remapped.text, /5432:5432/);
  next = 55123;
  const shared = remapHostPorts(
    source,
    () => false,
    () => next++,
  );
  assert.match(shared.text, /5432:5432/);
  assert.match(shared.text, /55123:5432/);
  assert.match(shared.text, /localhost:5432/);
  assert.match(shared.text, /127\.0\.0\.1:55123/);
});

test('feature push uses local PR workflows and the exact merge event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-runner-'));
  const workspace = join(root, 'repo');
  const bin = join(root, 'bin');
  const capture = join(root, 'act.jsonl');
  const priorPath = process.env.PATH;
  const priorCapture = process.env.LOCAL_CI_TEST_CAPTURE;
  try {
    mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(workspace, '.local-ci', 'workflows'), { recursive: true });
    mkdirSync(bin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'CI');
    git('config', 'user.email', 'ci@example.test');
    writeFileSync(join(workspace, 'app.ts'), 'first\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(workspace, 'app.ts'), 'second\n');
    writeFileSync(
      join(workspace, '.github', 'workflows', 'wrong.yml'),
      'on: push\njobs:\n  wrong:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n',
    );
    writeFileSync(
      join(workspace, '.local-ci', 'workflows', 'architecture.yml'),
      'on:\n  pull_request:\n    branches: [develop]\njobs:\n  architecture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    );
    writeFileSync(
      join(workspace, '.local-ci', 'workflows', 'tests.yaml'),
      'on:\n  pull_request:\n    branches: [develop]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    );
    writeFileSync(
      join(workspace, '.local-ci', 'workflows', 'reset.yml'),
      'on:\n  pull_request:\n    types: [closed]\njobs:\n  reset:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n',
    );
    git('add', '.');
    git('commit', '-qm', 'feature');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(
      join(bin, 'act'),
      '#!/usr/bin/env node\nconst fs=require("fs"); fs.appendFileSync(process.env.LOCAL_CI_TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2), event:JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--eventpath")+1],"utf8"))})+"\\n")\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${priorPath}`;
    process.env.LOCAL_CI_TEST_CAPTURE = capture;
    const lines: string[] = [];
    const selected: string[] = [];
    const states: string[] = [];
    const code = await new ActWorkflowRunner().run({
      workspace,
      repository: 'rxrise-marketplaces',
      ref: 'refs/heads/feat/example',
      sha,
      headSha: sha,
      baseSha,
      target: 'develop',
      runId: 'run-test',
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
      onWorkflows: (paths) => selected.push(...paths),
      onWorkflowStart: (path) => states.push(`running ${path}`),
      onWorkflowFinish: (path, exitCode) => states.push(`finished ${path} ${exitCode}`),
    });
    assert.equal(code, 0);
    const calls = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            event: { pull_request: { head: { ref: string }; base: { ref: string }; merge_commit_sha: string } };
          },
      );
    assert.deepEqual(
      calls.map((call) => call.args[call.args.indexOf('-W') + 1]),
      ['.local-ci/workflows/architecture.yml', '.local-ci/workflows/tests.yaml'],
    );
    assert.deepEqual(
      selected,
      calls.map((call) => call.args[call.args.indexOf('-W') + 1]),
    );
    assert.deepEqual(
      states,
      selected.flatMap((path) => [`running ${path}`, `finished ${path} 0`]),
    );
    assert(calls.every((call) => call.args[0] === 'pull_request'));
    assert(
      calls.every((call) => call.args[call.args.indexOf('--container-architecture') + 1] === containerArchitecture()),
    );
    assert.equal(calls[0].event.pull_request.head.ref, 'feat/example');
    assert.equal(calls[0].event.pull_request.base.ref, 'develop');
    assert.equal(calls[0].event.pull_request.merge_commit_sha, sha);
    assert.equal(git('rev-parse', 'refs/remotes/origin/develop'), baseSha);
    assert(lines.some((line) => line.includes('workflows: .local-ci/workflows/architecture.yml')));
  } finally {
    process.env.PATH = priorPath;
    if (priorCapture === undefined) {
      delete process.env.LOCAL_CI_TEST_CAPTURE;
    } else {
      process.env.LOCAL_CI_TEST_CAPTURE = priorCapture;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
