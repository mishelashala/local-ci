import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

export interface WorkflowRunner {
  run(input: {
    workspace: string
    repository: string
    ref: string
    sha: string
    runId: string
    signal: AbortSignal
    log: (line: string) => void
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

export class ActWorkflowRunner implements WorkflowRunner {
  async run(input: Parameters<WorkflowRunner['run']>[0]): Promise<number> {
    const workflows = join(input.workspace, '.github', 'workflows')
    if (!existsSync(workflows) || !readdirSync(workflows).some((name) => /\.ya?ml$/.test(name))) {
      input.log('error: no .github/workflows/*.yml files found at the candidate SHA')
      return 1
    }
    const eventPath = join(input.workspace, '.local-ci-event.json')
    writeFileSync(eventPath, JSON.stringify({
      act: true,
      ref: input.ref,
      after: input.sha,
      repository: { full_name: input.repository },
      pull_request: { head: { ref: input.ref.replace(/^refs\/heads\//, '') }, base: { ref: 'develop' } },
    }))
    const args = [
      'push', '-C', input.workspace, '-W', '.github/workflows', '--eventpath', eventPath,
      '--pull=false', '--container-architecture', process.env.LOCAL_CI_CONTAINER_ARCH ?? 'linux/amd64',
      '-P', process.env.LOCAL_CI_ACT_PLATFORM ?? 'ubuntu-latest=catthehacker/ubuntu:act-latest',
    ]
    input.log(`act ${args.join(' ')}`)
    return new Promise((resolve) => {
      const child = spawn('act', args, {
        cwd: input.workspace,
        detached: process.platform !== 'win32',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const flushOut = streamLines(child.stdout, input.log)
      const flushErr = streamLines(child.stderr, input.log)
      const abort = () => stopProcess(child)
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
      let settled = false
      const done = (code: number) => {
        if (settled) return
        settled = true
        input.signal.removeEventListener('abort', abort)
        flushOut()
        flushErr()
        resolve(code)
      }
      child.on('error', (error: NodeJS.ErrnoException) => {
        input.log(error.code === 'ENOENT' ? 'error: act is not installed or is not on PATH' : `error: ${error.message}`)
        done(1)
      })
      child.on('close', (code) => done(code ?? 1))
    })
  }
}
