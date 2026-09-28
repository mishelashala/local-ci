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

export function setOrigin(bareRepo: string, url: string) {
  if (readOrigin(bareRepo)) {
    gitSync(bareRepo, ['remote', 'set-url', 'origin', url])
  } else {
    gitSync(bareRepo, ['remote', 'add', 'origin', url])
  }
  clearRepoCache()
}

async function gitText(bareRepo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', gitArgs(bareRepo, args), {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

const snapshotInflight = new Map<string, Promise<RepoSnapshot>>()
const snapshotCache = new Map<string, { at: number; value: RepoSnapshot }>()

export function currentRepoSnapshot(bareRepo: string, id: string, name = id, counts = true): Promise<RepoSnapshot> {
  if (!counts) return readRepoSnapshotFast(bareRepo, id, name, false)
  const cached = snapshotCache.get(bareRepo)
  if (cached && Date.now() - cached.at < 1000) return Promise.resolve(cached.value)
  const inflight = snapshotInflight.get(bareRepo)
  if (inflight) return inflight
  const next = readRepoSnapshotFast(bareRepo, id, name, true)
    .then((value) => {
      snapshotCache.set(bareRepo, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      snapshotInflight.delete(bareRepo)
    })
  snapshotInflight.set(bareRepo, next)
  return next
}

async function readRepoSnapshotFast(bareRepo: string, id: string, name: string, counts: boolean): Promise<RepoSnapshot> {
  const [develop, branchText, origin] = await Promise.all([
    gitText(bareRepo, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/develop']).then(asSha).catch(() => null),
    gitText(bareRepo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']).catch(() => ''),
    gitText(bareRepo, ['remote', 'get-url', 'origin']).then((url) => {
      const trimmed = url.trim()
      return trimmed.length > 0 ? trimmed : null
    }).catch(() => null),
  ])
  const refs = branchText.split('\n').flatMap((line) => {
    if (line.length === 0) return []
    const tab = line.indexOf('\t')
    if (tab <= 0) return []
    const name = line.slice(0, tab)
    const sha = asSha(line.slice(tab + 1))
    if (!sha) return []
    return [{ name, sha }]
  })
  const branches = counts ? await Promise.all(refs.map(async ({ name, sha }) => {
    const [ahead, behind] = await Promise.all([
      develop ? gitText(bareRepo, ['rev-list', '--count', `${develop}..${sha}`]).then((n) => Number(n.trim())).catch(() => null) : Promise.resolve(null),
      develop ? gitText(bareRepo, ['rev-list', '--count', `${sha}..${develop}`]).then((n) => Number(n.trim())).catch(() => null) : Promise.resolve(null),
    ])
    return { name, sha, aheadOfDevelop: ahead, behindDevelop: behind, status: 'idle' as const }
  })) : refs.map(({ name, sha }) => ({ name, sha, aheadOfDevelop: null, behindDevelop: null, status: 'idle' as const }))
  return { id, name, barePath: bareRepo, maxBranchDrift: 10, develop, branches, origin }
}

export function clearRepoCache() {
  snapshotCache.clear()
}

export function compareAndSwapRef(bareRepo: string, ref: string, newSha: string, oldSha: string) {
  gitSync(bareRepo, ['update-ref', ref, newSha, oldSha])
}

export function compareAndSwapDevelop(bareRepo: string, newSha: string, oldSha: string) {
  compareAndSwapRef(bareRepo, 'refs/heads/develop', newSha, oldSha)
}

const PROTECTED_BRANCHES = new Set(['develop', 'main'])
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/

/** Delete a feature branch only when it still points at the merged tip. */
export function deleteBranchIfMatches(bareRepo: string, branch: string, expectedSha: string): 'deleted' | 'moved' | 'skipped' {
  if (PROTECTED_BRANCHES.has(branch) || !BRANCH_NAME.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return 'skipped'
  if (!SHA.test(expectedSha)) return 'skipped'
  const current = readBranchSha(bareRepo, branch)
  if (!current) return 'skipped'
  if (current !== expectedSha.toLowerCase()) return 'moved'
  try {
    gitSync(bareRepo, ['update-ref', '-d', `refs/heads/${branch}`, expectedSha])
    return 'deleted'
  } catch {
    return 'moved'
  }
}

export function retainCandidate(bareRepo: string, sha: string) {
  if (!SHA.test(sha)) throw new Error('invalid candidate SHA')
  gitSync(bareRepo, ['update-ref', `refs/local-ci/candidates/${sha}`, sha])
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
