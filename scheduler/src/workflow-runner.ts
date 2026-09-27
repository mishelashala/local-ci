import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { minimatch } from 'minimatch'
import YAML from 'yaml'
import type { ChildProcess } from 'node:child_process'

export interface WorkflowRunner {
  run(input: {
    workspace: string
    repository: string
    ref: string
    sha: string
    headSha: string
    baseSha: string
    target: 'develop' | 'main' | 'reconcile' | 'post-merge' | 'smoke'
    runId: string
    signal: AbortSignal
    log: (line: string, workflowPath?: string) => void
    onWorkflows?: (paths: string[]) => void
    onWorkflowStart?: (path: string) => void
    onWorkflowFinish?: (path: string, exitCode: number) => void
  }): Promise<number>
}

const timeoutMinutes = Number(process.env.LOCAL_CI_RUN_TIMEOUT_MINUTES ?? 45)
export const runTimeoutMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
  ? timeoutMinutes * 60_000 : 45 * 60_000

function streamLines(stream: NodeJS.ReadableStream | null, log: (line: string) => void) {
  let pending = ''
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r\n|\r|\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) log(line)
  })
  return () => { if (pending) log(pending) }
}

function stopProcess(child: ChildProcess) {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); return } catch { /* already stopped */ }
  }
  child.kill('SIGTERM')
}

type PullRequestTrigger = {
  branches?: string[]
  'branches-ignore'?: string[]
  paths?: string[]
  'paths-ignore'?: string[]
  types?: string[]
}

function matches(patterns: string[] | undefined, value: string) {
  return patterns?.some((pattern) => minimatch(value, pattern)) ?? false
}

function selectedWorkflows(input: Parameters<WorkflowRunner['run']>[0]) {
  if (input.target === 'smoke') {
    const file = '.local-ci/workflows/develop-smoke.yml'
    if (!existsSync(join(input.workspace, file))) throw new Error('post-merge smoke workflow disappeared from the tested commit')
    const workflow = YAML.parse(readFileSync(join(input.workspace, file), 'utf8')) as { on?: { push?: { branches?: string[] } } }
    if (!workflow?.on?.push || (workflow.on.push.branches && !matches(workflow.on.push.branches, 'develop'))) {
      throw new Error('develop-smoke.yml must declare on: push for develop')
    }
    return [file]
  }
  const relative = existsSync(join(input.workspace, '.local-ci', 'workflows')) ? '.local-ci/workflows' : '.github/workflows'
  const directory = join(input.workspace, relative)
  if (!existsSync(directory)) throw new Error('no .local-ci/workflows or .github/workflows directory at the candidate SHA')
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort()
  if (files.length === 0) throw new Error('no workflow YAML files at the candidate SHA')
  const base = input.target === 'main' ? 'main' : 'develop'
  const changes = execFileSync('git', ['diff', '--name-only', input.baseSha + '...' + input.headSha], {
    cwd: input.workspace, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim().split('\n').filter(Boolean)
  let prWorkflows = 0
  const selected = files.filter((name) => {
    const workflow = YAML.parse(readFileSync(join(directory, name), 'utf8')) as { on?: { pull_request?: PullRequestTrigger | null } } | null
    const trigger = workflow?.on?.pull_request
    if (trigger === undefined) return false
    const rules = trigger ?? {}
    if (rules.types && !rules.types.some((type) => type === 'opened' || type === 'synchronize')) return false
    prWorkflows++
    if (rules.branches && !matches(rules.branches, base)) return false
    if (matches(rules['branches-ignore'], base)) return false
    if (rules.paths && !changes.some((path) => matches(rules.paths, path))) return false
    if (rules['paths-ignore'] && changes.length > 0 && changes.every((path) => matches(rules['paths-ignore'], path))) return false
    return true
  })
  if (prWorkflows === 0) throw new Error('no pull_request test workflow found (closed/reset workflows do not validate a push)')
  return selected.map((name) => relative + '/' + name)
}

export class ActWorkflowRunner implements WorkflowRunner {
  async run(input: Parameters<WorkflowRunner['run']>[0]): Promise<number> {
    let selected: string[]
    try {
      selected = selectedWorkflows(input)
    } catch (error) {
      input.log('error: ' + (error instanceof Error ? error.message : String(error)))
      return 1
    }
    if (selected.length === 0) {
      input.log('All pull_request workflows are excluded by branch/path filters; GitHub would run no checks.')
      return 0
    }
    input.onWorkflows?.(selected)
    const base = input.target === 'main' ? 'main' : 'develop'
    const head = input.ref.replace(/^refs\/heads\//, '')
    // act copies this disposable checkout into the job container. Its origin URL is a
    // host path, so prepare the ratchet ref here instead of fetching inside the job.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/develop',
      input.target === 'smoke' ? input.sha : input.target === 'main' ? input.headSha : input.baseSha], { cwd: input.workspace })
    const eventPath = join(input.workspace, '.local-ci-event.json')
    writeFileSync(eventPath, JSON.stringify(input.target === 'smoke' ? {
      ref: 'refs/heads/develop', before: input.baseSha, after: input.sha,
      repository: { full_name: input.repository },
    } : {
      action: 'synchronize',
      number: 1,
      ref: 'refs/pull/1/merge',
      repository: { full_name: input.repository },
      pull_request: {
        number: 1, merged: false, merge_commit_sha: input.sha,
        head: { ref: head, sha: input.headSha, repo: { full_name: input.repository } },
        base: { ref: base, sha: input.baseSha, repo: { full_name: input.repository } },
      },
    }))
    const artifacts = join(dirname(input.workspace), 'artifacts', input.runId)
    mkdirSync(artifacts, { recursive: true })
    input.log('Pull request ' + head + ' -> ' + base + '; candidate ' + input.sha + '; workflows: ' + selected.join(', '))
    let result = 0
    for (const file of selected) {
      if (input.signal.aborted) return 1
      input.onWorkflowStart?.(file)
      const args = [
        input.target === 'smoke' ? 'push' : 'pull_request', '-C', input.workspace, '-W', file, '--eventpath', eventPath,
        '--artifact-server-path', artifacts, '--pull=false',
        '--container-architecture', process.env.LOCAL_CI_CONTAINER_ARCH ?? 'linux/amd64',
        '-P', process.env.LOCAL_CI_ACT_PLATFORM ?? 'ubuntu-latest=catthehacker/ubuntu:act-latest',
      ]
      input.log('act ' + args.join(' '))
      const code = await new Promise<number>((resolve) => {
        const child = spawn('act', args, {
          cwd: input.workspace,
          detached: process.platform !== 'win32',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const workflowLog = (line: string) => input.log(line, file)
        const flushOut = streamLines(child.stdout, workflowLog)
        const flushErr = streamLines(child.stderr, workflowLog)
        const abort = () => stopProcess(child)
        input.signal.addEventListener('abort', abort, { once: true })
        if (input.signal.aborted) abort()
        let settled = false
        const done = (exit: number) => {
          if (settled) return
          settled = true
          input.signal.removeEventListener('abort', abort)
          flushOut()
          flushErr()
          resolve(exit)
        }
        child.on('error', (error: NodeJS.ErrnoException) => {
          workflowLog(error.code === 'ENOENT' ? 'error: act is not installed or is not on PATH' : 'error: ' + error.message)
          done(1)
        })
        child.on('close', (exit) => done(exit ?? 1))
      })
      input.onWorkflowFinish?.(file, code)
      if (code !== 0) result = code
    }
    input.log('Artifacts (if any): ' + artifacts)
    return result
  }
}
