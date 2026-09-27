import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ActWorkflowRunner } from './workflow-runner.ts'

test('feature push uses local PR workflows and the exact merge event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-runner-'))
  const workspace = join(root, 'repo')
  const bin = join(root, 'bin')
  const capture = join(root, 'act.jsonl')
  const priorPath = process.env.PATH
  const priorCapture = process.env.LOCAL_CI_TEST_CAPTURE
  try {
    mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(workspace, '.local-ci', 'workflows'), { recursive: true })
    mkdirSync(bin)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'CI')
    git('config', 'user.email', 'ci@example.test')
    writeFileSync(join(workspace, 'app.ts'), 'first\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const baseSha = git('rev-parse', 'HEAD')
    writeFileSync(join(workspace, 'app.ts'), 'second\n')
    writeFileSync(join(workspace, '.github', 'workflows', 'wrong.yml'), 'on: push\njobs:\n  wrong:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n')
    writeFileSync(join(workspace, '.local-ci', 'workflows', 'architecture.yml'), 'on:\n  pull_request:\n    branches: [develop]\njobs:\n  architecture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n')
    writeFileSync(join(workspace, '.local-ci', 'workflows', 'tests.yaml'), 'on:\n  pull_request:\n    branches: [develop]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n')
    writeFileSync(join(workspace, '.local-ci', 'workflows', 'reset.yml'), 'on:\n  pull_request:\n    types: [closed]\njobs:\n  reset:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n')
    git('add', '.')
    git('commit', '-qm', 'feature')
    const sha = git('rev-parse', 'HEAD')
    writeFileSync(join(bin, 'act'), '#!/usr/bin/env node\nconst fs=require("fs"); fs.appendFileSync(process.env.LOCAL_CI_TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2), event:JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--eventpath")+1],"utf8"))})+"\\n")\n', { mode: 0o755 })
    process.env.PATH = bin + ':' + priorPath
    process.env.LOCAL_CI_TEST_CAPTURE = capture
    const lines: string[] = []
    const code = await new ActWorkflowRunner().run({
      workspace, repository: 'rxrise-marketplaces', ref: 'refs/heads/feat/example',
      sha, headSha: sha, baseSha, target: 'develop', runId: 'run-test',
      signal: new AbortController().signal, log: (line) => lines.push(line),
    })
    assert.equal(code, 0)
    const calls = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; event: { pull_request: { head: { ref: string }; base: { ref: string }; merge_commit_sha: string } } })
    assert.deepEqual(calls.map((call) => call.args[call.args.indexOf('-W') + 1]), [
      '.local-ci/workflows/architecture.yml', '.local-ci/workflows/tests.yaml',
    ])
    assert(calls.every((call) => call.args[0] === 'pull_request'))
    assert.equal(calls[0].event.pull_request.head.ref, 'feat/example')
    assert.equal(calls[0].event.pull_request.base.ref, 'develop')
    assert.equal(calls[0].event.pull_request.merge_commit_sha, sha)
    assert.equal(git('rev-parse', 'refs/remotes/origin/develop'), baseSha)
    assert(lines.some((line) => line.includes('workflows: .local-ci/workflows/architecture.yml')))
  } finally {
    process.env.PATH = priorPath
    if (priorCapture === undefined) delete process.env.LOCAL_CI_TEST_CAPTURE
    else process.env.LOCAL_CI_TEST_CAPTURE = priorCapture
    rmSync(root, { recursive: true, force: true })
  }
})
