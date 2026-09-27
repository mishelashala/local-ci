import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { appendLog, claimNextRunForRepository, finishRun, getRepository, listRepositories } from './db.ts'
import { readBranchSha, readDevelopSha } from './git-repo.ts'
import { workRoot } from './paths.ts'

type ClaimedRun = NonNullable<ReturnType<typeof claimNextRunForRepository>>

function consume(stream: Readable | null, runId: string) {
  let pending = ''
  const write = (line: string) => {
    if (line.length > 0) appendLog(runId, line)
  }
  if (stream) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string | Buffer) => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const parts = pending.split(/\r\n|\n|\r/)
      pending = parts.pop() ?? ''
      for (const line of parts) write(line)
    })
  }
  return () => {
    if (pending.length > 0) write(pending)
    pending = ''
  }
}

function spawnLogged(runId: string, command: string, args: string[], cwd?: string): Promise<number | null> {
  appendLog(runId, [command, ...args].join(' '))
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const flushOut = consume(child.stdout, runId)
    const flushErr = consume(child.stderr, runId)
    let settled = false
    const done = (code: number | null) => {
      if (settled) return
      settled = true
      flushOut()
      flushErr()
      resolve(code)
    }
    child.on('error', (error) => {
      appendLog(runId, error.message)
      done(null)
    })
    child.on('close', (code) => {
      done(code)
    })
  })
}

async function execute(run: ClaimedRun) {
  const workDir = join(workRoot, run.id)
  const outcome: { status: 'passed' | 'failed'; exitCode: number | null } = {
    status: 'failed',
    exitCode: 1,
  }
  try {
    const repository = getRepository(run.repository)
    if (!repository) {
      appendLog(run.id, `error: unknown repository ${run.repository}`)
      return
    }

    mkdirSync(workRoot, { recursive: true })
    rmSync(workDir, { recursive: true, force: true })
    mkdirSync(workDir, { recursive: true })

    const cloneCode = await spawnLogged(run.id, 'git', ['clone', '--local', repository.barePath, workDir])
    if (cloneCode !== 0) {
      appendLog(run.id, `error: git clone failed (${cloneCode ?? 'spawn error'})`)
      outcome.exitCode = cloneCode
      return
    }

    const checkoutCode = await spawnLogged(run.id, 'git', ['checkout', run.newSha], workDir)
    if (checkoutCode !== 0) {
      appendLog(run.id, `error: git checkout failed (${checkoutCode ?? 'spawn error'})`)
      outcome.exitCode = checkoutCode
      return
    }

    const ciCode = await spawnLogged(run.id, 'npm', ['ci'], workDir)
    if (ciCode !== 0) {
      appendLog(run.id, `error: npm ci failed (${ciCode ?? 'spawn error'})`)
      outcome.exitCode = ciCode
      return
    }

    const testCode = await spawnLogged(run.id, 'npm', ['test'], workDir)
    if (testCode === 0) {
      outcome.status = 'passed'
      outcome.exitCode = 0
      return
    }
    appendLog(run.id, `error: npm test failed (${testCode ?? 'spawn error'})`)
    outcome.exitCode = testCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(run.id, `error: ${message}`)
    outcome.status = 'failed'
    outcome.exitCode = 1
  } finally {
    try {
      finishRun(run.id, outcome.status, outcome.exitCode)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

export function startWorker() {
  let busy = false
  const tick = () => {
    if (busy) return
    const run = listRepositories().map((repository) => claimNextRunForRepository(
      repository.id,
      readDevelopSha(repository.barePath),
      readBranchSha(repository.barePath, 'main'),
    )).find((candidate) => candidate !== undefined)
    if (run === undefined) return
    busy = true
    void execute(run).finally(() => {
      busy = false
    })
  }
  setInterval(tick, 1000)
  tick()
}
