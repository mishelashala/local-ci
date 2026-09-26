import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoSnapshot } from './contract.ts'

const execFileAsync = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/i

function gitArgs(bareRepo: string, args: string[]) {
  return [`--git-dir=${bareRepo}`, ...args]
}

function gitSync(bareRepo: string, args: string[]) {
  return execFileSync('git', gitArgs(bareRepo, args), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function asSha(value: string) {
  const sha = value.trim().toLowerCase()
  return SHA.test(sha) ? sha : null
}

export function readDevelopSha(bareRepo: string): string | null {
  try {
    return asSha(gitSync(bareRepo, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/develop']))
  } catch {
    return null
  }
}

export function readBranchSha(bareRepo: string, branch: string): string | null {
  try {
    return asSha(gitSync(bareRepo, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`]))
  } catch {
    return null
  }
}

export function readOrigin(bareRepo: string): string | null {
  try {
    const url = gitSync(bareRepo, ['remote', 'get-url', 'origin']).trim()
    return url.length > 0 ? url : null
  } catch {
    return null
  }
}

async function gitText(bareRepo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', gitArgs(bareRepo, args), {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

let snapshotInflight: Promise<RepoSnapshot> | null = null
let snapshotCache: { at: number; value: RepoSnapshot } | null = null

export function currentRepoSnapshot(bareRepo: string): Promise<RepoSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.at < 1000) return Promise.resolve(snapshotCache.value)
  if (snapshotInflight) return snapshotInflight
  snapshotInflight = readRepoSnapshotFast(bareRepo)
    .then((value) => {
      snapshotCache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      snapshotInflight = null
    })
  return snapshotInflight
}

async function readRepoSnapshotFast(bareRepo: string): Promise<RepoSnapshot> {
  const [develop, branchText, origin] = await Promise.all([
    gitText(bareRepo, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/develop']).then(asSha).catch(() => null),
    gitText(bareRepo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']).catch(() => ''),
    gitText(bareRepo, ['remote', 'get-url', 'origin']).then((url) => {
      const trimmed = url.trim()
      return trimmed.length > 0 ? trimmed : null
    }).catch(() => null),
  ])
  const branches = branchText.split('\n').flatMap((line) => {
    if (line.length === 0) return []
    const tab = line.indexOf('\t')
    if (tab <= 0) return []
    const name = line.slice(0, tab)
    const sha = asSha(line.slice(tab + 1))
    if (!sha) return []
    return [{ name, sha }]
  })
  return { develop, branches, origin }
}

export function readRepoSnapshot(bareRepo: string): RepoSnapshot {
  let branches: RepoSnapshot['branches'] = []
  try {
    const text = gitSync(bareRepo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'])
    branches = text.split('\n').flatMap((line) => {
      if (line.length === 0) return []
      const tab = line.indexOf('\t')
      if (tab <= 0) return []
      const name = line.slice(0, tab)
      const sha = asSha(line.slice(tab + 1))
      if (!sha) return []
      return [{ name, sha }]
    })
  } catch {
    branches = []
  }
  return {
    develop: readDevelopSha(bareRepo),
    branches,
    origin: readOrigin(bareRepo),
  }
}

export function clearRepoCache() {
  snapshotCache = null
}

export function compareAndSwapRef(bareRepo: string, ref: string, newSha: string, oldSha: string) {
  gitSync(bareRepo, ['update-ref', ref, newSha, oldSha])
}

export function compareAndSwapDevelop(bareRepo: string, newSha: string, oldSha: string) {
  compareAndSwapRef(bareRepo, 'refs/heads/develop', newSha, oldSha)
}

export async function pushRef(bareRepo: string, source: string, destination: string): Promise<{ ok: true } | { error: string }> {
  try {
    await execFileAsync('git', gitArgs(bareRepo, ['push', 'origin', `${source}:${destination}`]), {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true }
  } catch (error) {
    const failed = error as { stderr?: string; message?: string }
    const stderr = typeof failed.stderr === 'string' ? failed.stderr.trim() : ''
    return { error: stderr || failed.message || 'git push failed' }
  }
}

export async function pushDevelop(bareRepo: string): Promise<{ ok: true } | { error: string }> {
  return pushRef(bareRepo, 'refs/heads/develop', 'refs/heads/develop')
}
