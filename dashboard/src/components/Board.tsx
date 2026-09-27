import { useEffect, useRef, useState } from 'react'
import { Box, Button, Chip, MenuItem, Select, Skeleton, Typography } from '@mui/material'
import { useColorMode } from '../color-mode'
import { formatAgo, mono, shortSha } from '../format'
import { mainSha, mergeReady, pushDevelopSha, pushMainSha, type RepoSnapshot } from '../gates'
import { LogSkeleton, Panel, RunSkeleton, Sha, StatusChip } from '../ui'
import { LiveLog } from './LiveLog'
import { Onboarding } from './Onboarding'

type Run = {
  id: string
  repository: string
  branch: string
  oldSha: string
  newSha: string
  status: string
  workflow: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  baseSha: string | null
  headSha: string | null
  candidateSha: string | null
  target: string | null
}

type RunInput = Omit<Run, 'startedAt' | 'finishedAt' | 'exitCode' | 'baseSha' | 'headSha' | 'candidateSha' | 'target'> & {
  target?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  exitCode?: number | null
  baseSha?: string | null
  headSha?: string | null
  candidateSha?: string | null
}

type ApiBody = {
  error?: unknown
  remote?: unknown
}

type PushNotice = { ok: true; remote: string } | { ok: false; error: string }

type RepositoryOption = { id: string; name: string }

const ZERO = '0000000000000000000000000000000000000000'

function normalize(run: RunInput): Run {
  return {
    ...run,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
    baseSha: run.baseSha ?? null,
    headSha: run.headSha ?? null,
    candidateSha: run.candidateSha ?? null,
    target: run.target ?? null,
  }
}

function normalizeRepo(body: RepoSnapshot): RepoSnapshot {
  const raw = Array.isArray(body.branches) ? body.branches : []
  return {
    id: typeof body.id === 'string' ? body.id : '',
    name: typeof body.name === 'string' ? body.name : 'Repository',
    barePath: typeof body.barePath === 'string' ? body.barePath : '',
    maxBranchDrift: Number.isInteger(body.maxBranchDrift) ? body.maxBranchDrift : 10,
    develop: body.develop ?? null,
    branches: raw.flatMap((branch) => {
      if (!branch || typeof branch.name !== 'string' || typeof branch.sha !== 'string') return []
      return [{
        name: branch.name,
        sha: branch.sha,
        aheadOfDevelop: Number.isFinite(branch.aheadOfDevelop) ? branch.aheadOfDevelop : null,
        behindDevelop: Number.isFinite(branch.behindDevelop) ? branch.behindDevelop : null,
        status: branch.status ?? 'idle',
      }]
    }),
    origin: body.origin ?? null,
    githubDevelop: body.githubDevelop,
    githubMain: body.githubMain,
    syncError: body.syncError ?? null,
    pendingReset: body.pendingReset ?? null,
  }
}

async function postJson(path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: ApiBody }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: ApiBody = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed !== null && typeof parsed === 'object') body = parsed as ApiBody
  } catch {
    body = {}
  }
  return { ok: response.ok, status: response.status, body }
}

function apiError(body: ApiBody, status: number, label: string): string {
  return typeof body.error === 'string' && body.error.length > 0 ? body.error : `${label} (${status})`
}

export function Board() {
  const { mode, toggle } = useColorMode()
  const [runs, setRuns] = useState<Run[]>([])
  const [runsReady, setRunsReady] = useState(false)
  const [repo, setRepo] = useState<RepoSnapshot | null>(null)
  const [repositories, setRepositories] = useState<RepositoryOption[]>([])
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('')
  const [showSetup, setShowSetup] = useState(false)
  const [repoReady, setRepoReady] = useState(false)
  const [offline, setOffline] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [pushing, setPushing] = useState(false)
  const [openingMain, setOpeningMain] = useState(false)
  const [pushNotice, setPushNotice] = useState<PushNotice | null>(null)
  const mergeLock = useRef<string | null>(null)
  const pushLock = useRef(false)

  async function action(path: string, payload: unknown, label: string) {
    if (pushLock.current) return
    pushLock.current = true
    setPushing(true)
    setPushNotice(null)
    try {
      const result = await postJson(path, payload)
      setPushNotice(result.ok ? { ok: true, remote: `${label} complete` } : { ok: false, error: apiError(result.body, result.status, label) })
    } catch { setPushNotice({ ok: false, error: `${label} request failed` }) }
    finally { pushLock.current = false; setPushing(false) }
  }

  useEffect(() => {
    let cancel = false
    let ticket = 0
    const tick = () => {
      const mine = ++ticket
      void (async () => {
        try {
          const response = await fetch('/api/repositories')
          if (!response.ok) throw new Error(String(response.status))
          const body = (await response.json()) as { repositories?: RepoSnapshot[] }
          if (cancel || mine !== ticket) return
          const snapshots = Array.isArray(body.repositories) ? body.repositories.map(normalizeRepo) : []
          setRepositories(snapshots.map(({ id, name }) => ({ id, name })))
          const active = snapshots.find((item) => item.id === selectedRepositoryId) ?? snapshots[0]
          if (!active) {
            setRepo(null)
            setRepoReady(true)
            setRuns([])
            setRunsReady(true)
            setOffline(false)
            return
          }
          if (!selectedRepositoryId) setSelectedRepositoryId(active.id)
          setRepo(active)
          setRepoReady(true)
          const runsResponse = await fetch(`/api/runs?repository=${encodeURIComponent(active.id)}`)
          if (!runsResponse.ok) throw new Error(String(runsResponse.status))
          const runsBody = (await runsResponse.json()) as { runs?: RunInput[] }
          if (cancel || mine !== ticket) return
          if (!Array.isArray(runsBody.runs)) throw new Error('runs')
          setRuns(runsBody.runs.map(normalize))
          setOffline(false)
          setRunsReady(true)
          setNow(Date.now())
        } catch {
          if (!cancel && mine === ticket) {
            setOffline(true)
            setRunsReady(true)
          }
        }
      })()
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1000)
    return () => {
      cancel = true
      window.clearInterval(id)
    }
  }, [selectedRepositoryId])

  useEffect(() => {
    if (selectedId && runs.some((run) => run.id === selectedId)) return
    const running = runs.find((run) => run.status === 'running')
    setSelectedId(running?.id ?? runs[0]?.id ?? null)
  }, [runs, selectedId])

  async function mergeRun(runId: string) {
    if (mergeLock.current) return
    mergeLock.current = runId
    setMergingId(runId)
    setMergeErrors((current) => {
      const next = { ...current }
      delete next[runId]
      return next
    })
    try {
      const result = await postJson('/api/merges', { runId })
      if (!result.ok) {
        setMergeErrors((current) => ({ ...current, [runId]: apiError(result.body, result.status, 'Merge failed') }))
        return
      }
      setMergeErrors((current) => {
        const next = { ...current }
        delete next[runId]
        return next
      })
    } catch {
      setMergeErrors((current) => ({ ...current, [runId]: 'Merge request failed' }))
    } finally {
      mergeLock.current = null
      setMergingId(null)
    }
  }

  async function pushDevelop() {
    if (pushLock.current) return
    pushLock.current = true
    setPushing(true)
    setPushNotice(null)
    try {
      const result = await postJson('/api/pushes', { repository: selectedRepositoryId, branch: 'develop' })
      if (!result.ok) {
        setPushNotice({ ok: false, error: apiError(result.body, result.status, 'Push failed') })
        return
      }
      setPushNotice(typeof result.body.remote === 'string' ? { ok: true, remote: result.body.remote } : null)
    } catch {
      setPushNotice({ ok: false, error: 'Push request failed' })
    } finally {
      pushLock.current = false
      setPushing(false)
    }
  }

  const running = runs.find((run) => run.status === 'running')
  const queued = runs.filter((run) => run.status === 'queued')
  const history = runs.filter((run) => run.status !== 'queued' && run.status !== 'running')
  const selected = runs.find((run) => run.id === selectedId) ?? null
  const developSha = pushDevelopSha(runs, repo)
  const githubMainSha = pushMainSha(runs, repo)
  const canOpenMain = mainSha(repo) !== null && repo?.develop != null
  const mainBusy = runs.some((run) => run.target === 'main' && (run.status === 'queued' || run.status === 'running'))

  async function openMain() {
    if (pushLock.current) return
    pushLock.current = true
    setOpeningMain(true)
    setPushNotice(null)
    try {
      const result = await postJson('/api/main', { repository: selectedRepositoryId })
      if (!result.ok) setPushNotice({ ok: false, error: apiError(result.body, result.status, 'PR failed') })
    } catch {
      setPushNotice({ ok: false, error: 'PR request failed' })
    } finally {
      pushLock.current = false
      setOpeningMain(false)
    }
  }

  async function pushMain() {
    if (pushLock.current) return
    pushLock.current = true
    setPushing(true)
    setPushNotice(null)
    try {
      const result = await postJson('/api/pushes', { repository: selectedRepositoryId, branch: 'main' })
      if (!result.ok) {
        setPushNotice({ ok: false, error: apiError(result.body, result.status, 'Push failed') })
        return
      }
      setPushNotice(typeof result.body.remote === 'string' ? { ok: true, remote: result.body.remote } : null)
    } catch {
      setPushNotice({ ok: false, error: 'Push request failed' })
    } finally {
      pushLock.current = false
      setPushing(false)
    }
  }

  const summary = (run: Run) => (
    <RunSummary
      key={run.id}
      run={run}
      now={now}
      selected={selected?.id === run.id}
      onSelect={() => setSelectedId(run.id)}
      showMerge={mergeReady(run, repo)}
      merging={mergingId === run.id}
      mergeError={mergeErrors[run.id] ?? null}
      onMerge={() => void mergeRun(run.id)}
      onCancel={() => void action(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {}, 'Cancel')}
      onRetry={() => void action(`/api/runs/${encodeURIComponent(run.id)}/retry`, {}, 'Retry')}
      onReconcile={() => void action('/api/reconciliations', { runId: run.id }, 'Reconcile develop')}
    />
  )

  if (showSetup || (repoReady && !offline && repositories.length === 0)) {
    return <Onboarding onCancel={repositories.length ? () => setShowSetup(false) : undefined} onSaved={(snapshot) => {
      const saved = normalizeRepo(snapshot)
      setRepo(saved)
      setRepositories((items) => [...items.filter((item) => item.id !== saved.id), { id: saved.id, name: saved.name }])
      setSelectedRepositoryId(saved.id)
      setShowSetup(false)
    }} />
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
          {repoReady && repositories.length > 0 && (
            <Select size="small" value={selectedRepositoryId} onChange={(event) => {
              setSelectedRepositoryId(event.target.value)
              setRuns([])
              setSelectedId(null)
              setPushNotice(null)
            }} sx={{ minWidth: 190, height: 32, fontSize: 13 }}>
              {repositories.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
            </Select>
          )}
          {repo && <Typography variant="caption" sx={{ fontFamily: mono }}>{repo.id} · {repo.barePath}</Typography>}
          {!runsReady ? (
            <Skeleton variant="text" width={118} height={16} />
          ) : (
            <Typography variant="caption" color={offline ? 'warning.main' : 'success.main'}>
              {offline ? 'scheduler offline' : 'scheduler online'}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {repoReady && repositories.length > 0 && <Button type="button" size="small" onClick={() => setShowSetup(true)}>Add repository</Button>}
          {repo && <Button type="button" size="small" disabled={pushing} onClick={() => void action('/api/sync', { repository: repo.id }, 'Sync')}>Sync GitHub</Button>}
          {repo?.githubDevelop?.relation === 'diverged' && <Button type="button" size="small" color="warning" disabled={pushing} onClick={() => void action('/api/reconcile', { repository: repo.id }, 'Validate reconciliation')}>Validate reconciliation</Button>}
          {repo?.pendingReset && <Button type="button" size="small" color="warning" variant="outlined" disabled={pushing} onClick={() => void action('/api/reset-develop', { repository: repo.id }, 'Reset develop')}>Reset develop to main</Button>}
          {!repoReady && (
            <>
              <Skeleton variant="rounded" width={150} height={30} />
              <Skeleton variant="rounded" width={168} height={30} />
            </>
          )}
          {repoReady && canOpenMain && (
            <Button type="button" size="small" variant="outlined" disabled={openingMain || pushing || mainBusy} onClick={() => void openMain()} sx={{ flexShrink: 0 }}>
              PR develop → main
            </Button>
          )}
          {repoReady && githubMainSha && (
            <Button type="button" size="small" variant="contained" disabled={pushing || openingMain} onClick={() => void pushMain()} sx={{ flexShrink: 0 }}>
              Push main to GitHub {shortSha(githubMainSha)}
            </Button>
          )}
          {repoReady && developSha && (
            <Button type="button" size="small" variant="contained" disabled={pushing || openingMain} onClick={() => void pushDevelop()} sx={{ flexShrink: 0 }}>
              Push to develop {shortSha(developSha)}
            </Button>
          )}
          <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
            {mode === 'dark' ? 'Light' : 'Dark'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            127.0.0.1
          </Typography>
        </Box>
        {pushNotice && (
          <Typography variant="caption" color={pushNotice.ok ? 'success.main' : 'error.main'} sx={{ display: 'block', mt: 0.5 }}>
            {pushNotice.ok ? pushNotice.remote : pushNotice.error}
          </Typography>
        )}
        {repo?.syncError && <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>GitHub sync: {repo.syncError}</Typography>}
        {repo?.githubDevelop && <Typography variant="caption" color={repo.githubDevelop.relation === 'diverged' ? 'error.main' : 'text.secondary'} sx={{ display: 'block' }}>
          GitHub develop: {repo.githubDevelop.relation} · local {shortSha(repo.githubDevelop.local ?? '')} · GitHub {shortSha(repo.githubDevelop.github ?? '')}
        </Typography>}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Merge moves local develop. Push to develop sends it to GitHub. PR develop → main runs tests, then Push main sends that commit to GitHub main.
        </Typography>
        {repo && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, fontFamily: mono }}>
          git remote add ci {repo.barePath}
        </Typography>}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(360px, 460px) minmax(0, 1fr)', gap: 1.25, p: 1.25 }}>
        <Box sx={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto auto minmax(120px, auto) minmax(0, 1fr)', gap: 1.25 }}>
          <Panel title="Runner" action={<Typography variant="caption" color="text.secondary">concurrency 1</Typography>}>
            {!runsReady && <RunSkeleton />}
            {runsReady && (
            <Box sx={{ px: 1.5, py: 1.25 }}>
              {offline && (
                <Typography variant="caption" color="warning.main">
                  Scheduler is not answering on 127.0.0.1:3001.
                </Typography>
              )}
              {!offline && running && summary(running)}
              {!offline && !running && (
                <>
                  <Typography sx={{ fontWeight: 600 }}>Runner idle</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {history[0]
                      ? `Last run ${history[0].branch} ${history[0].status}`
                      : 'No runs yet. git push ci feat/branch-name'}
                  </Typography>
                </>
              )}
            </Box>
            )}
          </Panel>

          <Panel
            title="Queue"
            action={
              !runsReady ? (
                <Skeleton variant="text" width={16} height={14} />
              ) : (
                <Typography variant="caption" color="text.secondary">{offline ? 'offline' : queued.length}</Typography>
              )
            }
          >
            {!runsReady && (
              <>
                <RunSkeleton />
                <RunSkeleton />
              </>
            )}
            {runsReady && !offline && queued.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                Queue empty
              </Typography>
            )}
            {queued.map(summary)}
          </Panel>

          <Panel title="Branches" action={<Typography variant="caption" color="text.secondary">{repo?.maxBranchDrift ?? 10} commit drift limit</Typography>}>
            {!repo?.branches.length && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>No branches in this CI repository yet.</Typography>}
            {repo?.branches.map((branch) => (
              <Box key={branch.name} sx={{ px: 1.5, py: 0.8, display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }} noWrap>{branch.name}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: mono }}><Sha value={branch.sha} /></Typography>
                {branch.behindDevelop !== null && branch.name !== 'develop' && <Typography variant="caption" color={branch.behindDevelop > (repo?.maxBranchDrift ?? 10) ? 'error.main' : 'text.secondary'}>{branch.behindDevelop} behind</Typography>}
                <Chip size="small" label={branch.status.replaceAll('-', ' ')} color={branch.status === 'ready-to-merge' || branch.status === 'ready-to-deploy' ? 'success' : branch.status === 'failed' || branch.status === 'sync-required' ? 'error' : 'default'} />
                {branch.name !== 'main' && branch.name !== 'develop' && branch.status !== 'sync-required' && <Button size="small" onClick={() => void action('/api/runs/manual', { repository: repo.id, branch: branch.name }, 'Enqueue')}>Run</Button>}
                {branch.status === 'sync-required' && <Button size="small" onClick={() => setPushNotice({ ok: false, error: `Sync ${branch.name} in your working copy: git fetch ci develop && git rebase ci/develop && git push --force-with-lease ci ${branch.name}` })}>Sync/Rebase</Button>}
              </Box>
            ))}
          </Panel>

          <Panel title="History" fill>
            {!runsReady && (
              <>
                <RunSkeleton />
                <RunSkeleton />
                <RunSkeleton />
                <RunSkeleton />
              </>
            )}
            {runsReady && !offline && history.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                No finished runs
              </Typography>
            )}
            {history.map(summary)}
          </Panel>
        </Box>

        {!runsReady ? (
          <Panel title="Logs" fill scroll={false}>
            <LogSkeleton />
          </Panel>
        ) : selected ? <LiveLog runId={selected.id} /> : (
          <Panel title="Logs" fill>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
              No run selected
            </Typography>
          </Panel>
        )}
      </Box>
    </Box>
  )
}

function RunSummary({
  run,
  now,
  selected,
  onSelect,
  showMerge,
  merging,
  mergeError,
  onMerge,
  onCancel,
  onRetry,
  onReconcile,
}: {
  run: Run
  now: number
  selected: boolean
  onSelect: () => void
  showMerge: boolean
  merging: boolean
  mergeError: string | null
  onMerge: () => void
  onCancel: () => void
  onRetry: () => void
  onReconcile: () => void
}) {
  return (
    <Box
      onClick={onSelect}
      sx={{
        px: 1.5,
        py: 0.9,
        cursor: 'pointer',
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: selected ? 'rgba(88, 166, 255, 0.08)' : 'transparent',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <StatusChip status={run.status} />
        <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
          {run.target === 'main' ? 'develop → main' : run.branch}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {run.repository} · {run.oldSha === ZERO ? 'new branch' : 'update'} · <Sha value={run.newSha} /> · {formatAgo(now, run.createdAt)}
        {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
      </Typography>
      {(run.candidateSha || run.baseSha) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {run.candidateSha ? (
            <>
              candidate <Sha value={run.candidateSha} />
            </>
          ) : null}
          {run.candidateSha && run.baseSha ? ' · ' : null}
          {run.baseSha ? (
            <>
              built against develop <Sha value={run.baseSha} />
            </>
          ) : null}
        </Typography>
      )}
      {showMerge && (
        <Box sx={{ mt: 0.75 }}>
          <Button
            type="button"
            size="small"
            variant="contained"
            color="success"
            disabled={merging}
            onClick={(event) => {
              event.stopPropagation()
              onSelect()
              onMerge()
            }}
          >
            Merge to develop
          </Button>
          {mergeError ? (
            <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
              {mergeError}
            </Typography>
          ) : null}
        </Box>
      )}
      {(run.status === 'queued' || run.status === 'running' || run.status === 'failed' || run.status === 'canceled' || run.status === 'stale' || (run.target === 'reconcile' && run.status === 'passed')) && (
        <Box sx={{ mt: 0.5 }}>
          {(run.status === 'queued' || run.status === 'running') && <Button size="small" onClick={(event) => { event.stopPropagation(); onCancel() }}>Cancel</Button>}
          {(run.status === 'failed' || run.status === 'canceled' || run.status === 'stale') && run.candidateSha && <Button size="small" onClick={(event) => { event.stopPropagation(); onRetry() }}>Retry</Button>}
          {run.target === 'reconcile' && run.status === 'passed' && <Button size="small" color="success" onClick={(event) => { event.stopPropagation(); onReconcile() }}>Reconcile develop</Button>}
        </Box>
      )}
    </Box>
  )
}
