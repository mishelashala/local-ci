import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { clearRepoCache, compareAndSwapDevelop, readBranchSha, retainCandidate } from './git-repo.ts'

const execFileAsync = promisify(execFile)
const fetches = new Map<string, Promise<void>>()
const lastFetch = new Map<string, number>()

export type Relation = 'same' | 'github-ahead' | 'local-ahead' | 'diverged' | 'github-missing' | 'local-missing'
export type BranchSync = { local: string | null; github: string | null; relation: Relation }

function git(path: string, args: string[]) {
  return execFileSync('git', [`--git-dir=${path}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function trackingSha(path: string, branch: string): string | null {
  try { return git(path, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]) } catch { return null }
}

function ancestor(path: string, older: string, newer: string): boolean {
  try {
    execFileSync('git', [`--git-dir=${path}`, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' })
    return true
  } catch { return false }
}

export function branchSync(path: string, branch: 'main' | 'develop'): BranchSync {
  const local = readBranchSha(path, branch)
  const github = trackingSha(path, branch)
  if (!github) return { local, github, relation: 'github-missing' }
  if (!local) return { local, github, relation: 'local-missing' }
  if (local === github) return { local, github, relation: 'same' }
  if (ancestor(path, local, github)) return { local, github, relation: 'github-ahead' }
  if (ancestor(path, github, local)) return { local, github, relation: 'local-ahead' }
  return { local, github, relation: 'diverged' }
}

export async function fetchGitHub(path: string, force = false): Promise<void> {
  const pending = fetches.get(path)
  if (pending) return pending
  if (!force && Date.now() - (lastFetch.get(path) ?? 0) < 30000) return
  const task = (async () => {
    try {
      await execFileAsync('git', [
        `--git-dir=${path}`, 'fetch', '--no-tags', '--prune', 'origin',
        '+refs/heads/*:refs/remotes/origin/*',
      ], {
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      clearRepoCache()
    } finally {
      lastFetch.set(path, Date.now())
    }
  })().finally(() => fetches.delete(path))
  fetches.set(path, task)
  return task
}

export async function synchronizeBranch(path: string, branch: 'main' | 'develop', force = false): Promise<BranchSync> {
  await fetchGitHub(path, force)
  const state = branchSync(path, branch)
  if (state.relation === 'github-ahead' && state.local && state.github) {
    // The expected old SHA makes this a fast-forward-only compare-and-swap.
    git(path, ['update-ref', `refs/heads/${branch}`, state.github, state.local])
    clearRepoCache()
    return branchSync(path, branch)
  }
  return state
}

export async function synchronizeDevelop(path: string, force = false) {
  return synchronizeBranch(path, 'develop', force)
}

/** Point local develop at GitHub's existing develop commit. Never creates a commit. */
export async function matchLocalDevelop(path: string): Promise<BranchSync> {
  await fetchGitHub(path, true)
  const state = branchSync(path, 'develop')
  if (!state.github || !state.local || state.local === state.github) return state
  if (state.relation !== 'diverged' && state.relation !== 'github-ahead') return state
  retainCandidate(path, state.local)
  compareAndSwapDevelop(path, state.github, state.local)
  clearRepoCache()
  return branchSync(path, 'develop')
}

export function assertRemoteUnchanged(path: string, branch: 'main' | 'develop', expected: string | null) {
  const current = branchSync(path, branch).github
  if (current !== expected) throw new Error(`GitHub ${branch} changed; synchronize and revalidate`)
}

export function remoteSha(path: string, branch: 'main' | 'develop') {
  return trackingSha(path, branch)
}
