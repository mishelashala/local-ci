import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendLog, claimNextRunGlobal, finishRun, getRepository } from './db.ts'
import { workRoot } from './paths.ts'
import { ActWorkflowRunner, runTimeoutMs } from './workflow-runner.ts'

type ClaimedRun = NonNullable<ReturnType<typeof claimNextRunGlobal>>
const runner = new ActWorkflowRunner()
const active = new Map<string, AbortController>()

function gitLogged(runId: string, args: string[], cwd?: string): Promise<number> {
  appendLog(runId, `git ${args.join(' ')}`)
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let tail = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        tail += chunk
        const lines = tail.split(/\r\n|\r|\n/)
        tail = lines.pop() ?? ''
        for (const line of lines) if (line) appendLog(runId, line)
      })
    }
    child.on('error', (error) => { appendLog(runId, `error: ${error.message}`); resolve(1) })
    child.on('close', (code) => { if (tail) appendLog(runId, tail); resolve(code ?? 1) })
  })
}

export function cancelActiveRun(id: string) {
  const controller = active.get(id)
  if (!controller) return false
  appendLog(id, 'cancel requested')
  controller.abort('canceled')
  return true
}

async function execute(run: ClaimedRun) {
  const workDir = join(workRoot, run.id)
  const controller = new AbortController()
  active.set(run.id, controller)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    appendLog(run.id, `error: workflow exceeded ${Math.round(runTimeoutMs / 60000)} minute limit`)
    controller.abort('timeout')
  }, runTimeoutMs)
  let status: 'passed' | 'failed' | 'canceled' = 'failed'
  let exitCode: number | null = 1
  try {
    const repository = getRepository(run.repository)
    if (!repository) throw new Error(`unknown repository ${run.repository}`)
    if (!run.candidateSha || run.newSha !== run.candidateSha) throw new Error('run has no immutable candidate SHA')
    mkdirSync(workRoot, { recursive: true })
    rmSync(workDir, { recursive: true, force: true })
    if (await gitLogged(run.id, ['clone', '--local', '--no-checkout', repository.barePath, workDir]) !== 0) throw new Error('git clone failed')
    if (await gitLogged(run.id, ['fetch', 'origin', `refs/local-ci/candidates/${run.candidateSha}`], workDir) !== 0) throw new Error('candidate fetch failed')
    if (await gitLogged(run.id, ['checkout', '--detach', run.candidateSha], workDir) !== 0) throw new Error('candidate checkout failed')
    if (controller.signal.aborted) return
    exitCode = await runner.run({
      workspace: workDir,
      repository: run.repository,
      ref: run.ref,
      sha: run.candidateSha,
      headSha: run.headSha!,
      baseSha: run.baseSha!,
      target: (run.target ?? 'develop') as 'develop' | 'main' | 'reconcile' | 'post-merge',
      runId: run.id,
      signal: controller.signal,
      log: (line) => appendLog(run.id, line),
    })
    status = exitCode === 0 ? 'passed' : 'failed'
  } catch (error) {
    appendLog(run.id, `error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timeout)
    if (controller.signal.aborted && !timedOut) { status = 'canceled'; exitCode = null }
    finishRun(run.id, status, exitCode)
    active.delete(run.id)
    rmSync(workDir, { recursive: true, force: true })
  }
}

export function startWorker() {
  let busy = false
  const tick = () => {
    if (busy) return
    const run = claimNextRunGlobal()
    if (!run) return
    busy = true
    void execute(run).finally(() => { busy = false })
  }
  setInterval(tick, 1000)
  tick()
}
