export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'canceled'
export type RunKind = 'push' | 'merge-validation' | 'promote-main' | 'manual'
export type PrStatus = 'queued' | 'validating' | 'ready' | 'stale' | 'failed' | 'merged'
export type BranchCi = 'queued' | 'running' | 'passed' | 'failed'
export type GateStatus = 'ready' | 'stale' | 'running' | 'failed' | 'idle'

export type RefState = {
  name: 'develop' | 'main'
  sha: string
  updatedAt: number
}

export type Run = {
  id: string
  kind: RunKind
  branch: string
  sha: string
  targetSha?: string
  integrationSha?: string
  prNumber?: number
  status: RunStatus
  result: 'passed' | 'failed'
  suite: 'full'
  workflow: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number | null
  containerId?: string
  log: string[]
  script: string[]
  cursor: number
  nextLineAt: number
}

export type PullRequest = {
  number: number
  position: number
  title: string
  author: string
  branch: string
  sourceSha: string
  behind: number
  validatedAgainst: string | null
  integrationSha: string | null
  status: PrStatus
  branchStatus: BranchCi
}

export type MainGate = {
  developSha: string
  status: GateStatus
  runId?: string
}
