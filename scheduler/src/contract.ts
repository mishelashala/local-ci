/**
 * Frozen shapes for the develop merge and GitHub push.
 * Dashboard calls these through the Vite proxy: /api/repo, /api/merges, /api/pushes.
 */

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'canceled' | 'stale'

export type RepoSnapshot = {
  develop: string | null
  branches: { name: string; sha: string }[]
  origin: string | null
}

export type MergeBody = {
  runId: string
}

export type MergeResult = {
  develop: string
}

export type PushBody = {
  branch: 'develop'
}

export type PushResult = {
  sha: string
  remote: string
}
