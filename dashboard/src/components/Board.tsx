import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Box, Button, Chip, MenuItem, Select, Skeleton, Typography } from '@mui/material'
import { useColorMode } from '../color-mode'
import { formatAgo, mono, shortSha } from '../format'
import { mainSha, pushDevelopSha, pushMainSha, type RepoSnapshot } from '../gates'
import { useToast } from '../toast'
import { LogSkeleton, Panel, RunSkeleton, Sha, StatusChip } from '../ui'
import { ConnectDialog } from './Connect'
import { LiveLog } from './LiveLog'
import { Onboarding } from './Onboarding'
import { Repositories } from './Repositories'

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
  integratedAt: number | null
  taskId: string | null
}

type RunInput = Omit<Run, 'startedAt' | 'finishedAt' | 'exitCode' | 'baseSha' | 'headSha' | 'candidateSha' | 'target' | 'integratedAt' | 'taskId'> & {
  target?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  exitCode?: number | null
  baseSha?: string | null
  headSha?: string | null
  candidateSha?: string | null
  integratedAt?: number | null
  taskId?: string | null
}

const ZERO = '0000000000000000000000000000000000000000'

function repositoryQuery(): string {
  return new URLSearchParams(window.location.search).get('repository') ?? ''
}

function setRepositoryQuery(id: string) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('repository', id)
  else url.searchParams.delete('repository')
  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== current) window.history.replaceState(null, '', next)
}

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
    integratedAt: run.integratedAt ?? null,
    taskId: run.taskId ?? null,
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
    integration: body.integration ?? null,
  }
}

async function postJson(path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  return { ok: response.ok, status: response.status, body }
}

function apiError(body: Record<string, unknown>, status: number, label: string): string {
  return typeof body.error === 'string' && body.error.length > 0 ? body.error : `${label} (${status})`
}

function keepGitHub(current: RepoSnapshot | undefined, next: RepoSnapshot): RepoSnapshot {
  if (!current || current.id !== next.id) return next
  return {
    ...next,
    githubDevelop: next.githubDevelop ?? current.githubDevelop,
    githubMain: next.githubMain ?? current.githubMain,
  }
}

function ActionButton({
  busyKey,
  busy,
  children,
  disabled,
  variant = 'outlined',
  ...props
}: ComponentProps<typeof Button> & { busyKey: string; busy: string | null }) {
  const loading = busy === busyKey
  return (
    <Button
      {...props}
      type="button"
      size={props.size ?? 'small'}
      variant={variant}
      loading={loading}
      loadingPosition="center"
      disabled={Boolean(disabled) || (busy !== null && !loading)}
      sx={{ minWidth: 96, flexShrink: 0 }}
    >
      {children}
    </Button>
  )
}

export function Board() {
  const { mode, toggle } = useColorMode()
  const notify = useToast()
  const [runs, setRuns] = useState<Run[]>([])
  const [runsReady, setRunsReady] = useState(false)
  const [repo, setRepo] = useState<RepoSnapshot | null>(null)
  const [repositories, setRepositories] = useState<RepoSnapshot[]>([])
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(repositoryQuery)
  const [showSetup, setShowSetup] = useState(false)
  const [showRepositories, setShowRepositories] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [repoReady, setRepoReady] = useState(false)
  const [offline, setOffline] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const busyLock = useRef<string | null>(null)
  const activeIdRef = useRef(selectedRepositoryId)

  async function refreshRuns(repositoryId: string) {
    const response = await fetch(`/api/runs?repository=${encodeURIComponent(repositoryId)}`)
    if (!response.ok || activeIdRef.current !== repositoryId) return
    const body = (await response.json()) as { runs?: RunInput[] }
    if (!Array.isArray(body.runs) || activeIdRef.current !== repositoryId) return
    setRuns(body.runs.map(normalize))
    setRunsReady(true)
    setOffline(false)
    setNow(Date.now())
  }

  async function refreshBoard(repositoryId: string) {
    const reposResponse = await fetch('/api/repositories')
    if (reposResponse.ok && activeIdRef.current === repositoryId) {
      const body = (await reposResponse.json()) as { repositories?: RepoSnapshot[] }
      if (Array.isArray(body.repositories)) {
        const snapshots = body.repositories.map(normalizeRepo)
        setRepositories((current) => snapshots.map((item) => keepGitHub(current.find((entry) => entry.id === item.id), item)))
        setRepo((current) => {
          const next = snapshots.find((item) => item.id === repositoryId)
          return next ? keepGitHub(current ?? undefined, next) : current
        })
      }
    }
    await refreshRuns(repositoryId)
  }

  async function runAction(key: string, path: string, payload: unknown, label: string, success: string | ((body: Record<string, unknown>) => string)) {
    if (busyLock.current) return
    busyLock.current = key
    setBusy(key)
    const repositoryId = activeIdRef.current
    try {
      const result = await postJson(path, payload)
      if (result.ok && path === '/api/sync' && typeof result.body.id === 'string') {
        const saved = normalizeRepo(result.body as RepoSnapshot)
        setRepositories((items) => items.map((item) => item.id === saved.id ? saved : item))
        if (activeIdRef.current === saved.id) setRepo(saved)
      }
      await refreshBoard(repositoryId)
      if (result.ok) notify('success', typeof success === 'function' ? success(result.body) : success)
      else notify('error', apiError(result.body, result.status, label))
    } catch {
      notify('error', `${label} request failed`)
    } finally {
      busyLock.current = null
      setBusy(null)
    }
  }

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const response = await fetch('/api/repositories')
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as { repositories?: RepoSnapshot[] }
        if (cancel) return
        const snapshots = Array.isArray(body.repositories) ? body.repositories.map(normalizeRepo) : []
        setRepositories(snapshots)
        const active = snapshots.find((item) => item.id === selectedRepositoryId) ?? snapshots[0]
        if (!active) {
          setRepo(null)
          setRepoReady(true)
          setRuns([])
          setRunsReady(true)
          setOffline(false)
          return
        }
        setRepo(active)
        setRepoReady(true)
        const runsResponse = await fetch(`/api/runs?repository=${encodeURIComponent(active.id)}`)
        if (!runsResponse.ok) throw new Error(String(runsResponse.status))
        const runsBody = (await runsResponse.json()) as { runs?: RunInput[] }
        if (cancel) return
        if (!Array.isArray(runsBody.runs)) throw new Error('runs')
        setRuns(runsBody.runs.map(normalize))
        setOffline(false)
        setRunsReady(true)
        setNow(Date.now())
        const synced = await fetch('/api/repositories?sync=1')
        if (!synced.ok || cancel) return
        const syncedBody = (await synced.json()) as { repositories?: RepoSnapshot[] }
        if (cancel || !Array.isArray(syncedBody.repositories)) return
        const refreshed = syncedBody.repositories.map(normalizeRepo)
        setRepositories(refreshed)
        setRepo(refreshed.find((item) => item.id === active.id) ?? refreshed[0] ?? null)
      } catch {
        if (!cancel) {
          setOffline(true)
          setRunsReady(true)
        }
      }
    })()
    return () => {
      cancel = true
    }
  }, [selectedRepositoryId])

  useEffect(() => {
    const onPop = () => setSelectedRepositoryId(repositoryQuery())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function selectRepository(id: string) {
    setSelectedRepositoryId(id)
    setRepositoryQuery(id)
  }

  useEffect(() => {
    if (selectedId && runs.some((run) => run.id === selectedId)) return
    const running = runs.find((run) => run.status === 'running')
    setSelectedId(running?.id ?? runs[0]?.id ?? null)
  }, [runs, selectedId])

  const activeRepositoryId = repositories.find((item) => item.id === selectedRepositoryId)?.id ?? repositories[0]?.id ?? ''
  activeIdRef.current = activeRepositoryId

  useEffect(() => {
    if (!repoReady) return
    setRepositoryQuery(activeRepositoryId)
  }, [repoReady, activeRepositoryId])

  const live = runs.some((run) => run.status === 'queued' || run.status === 'running')
  const wasLive = useRef(false)
  useEffect(() => {
    if (!runsReady || !activeRepositoryId) return
    const stopped = wasLive.current && !live
    wasLive.current = live
    if (stopped) void refreshBoard(activeRepositoryId)
    if (!live) return
    const id = window.setInterval(() => { void refreshRuns(activeRepositoryId) }, 2000)
    return () => window.clearInterval(id)
  }, [live, runsReady, activeRepositoryId])

  const running = runs.find((run) => run.status === 'running')
  const queued = runs.filter((run) => run.status === 'queued')
  const history = runs.filter((run) => run.status !== 'queued' && run.status !== 'running')
  const selected = runs.find((run) => run.id === selectedId) ?? null
  const developSha = pushDevelopSha(runs, repo)
  const githubMainSha = pushMainSha(runs, repo)
  const canOpenMain = mainSha(repo) !== null && repo?.develop != null && !repo?.integration
  const mainBusy = runs.some((run) => run.target === 'main' && (run.status === 'queued' || run.status === 'running'))

  const summary = (run: Run) => (
    <RunSummary
      key={run.id}
      run={run}
      now={now}
      selected={selected?.id === run.id}
      onSelect={() => setSelectedId(run.id)}
      showMerge={false}
      busy={busy}
      onMerge={() => void runAction(`merge:${run.id}`, '/api/merges', { runId: run.id }, 'Merge', 'Merge finished')}
      onCancel={() => void runAction(`cancel:${run.id}`, `/api/runs/${encodeURIComponent(run.id)}/cancel`, {}, 'Cancel', 'Run canceled')}
      onRetry={() => void runAction(`retry:${run.id}`, `/api/runs/${encodeURIComponent(run.id)}/retry`, {}, 'Retry', 'Retry queued')}
      onReconcile={() => void runAction(`reconcile:${run.id}`, '/api/reconciliations', { runId: run.id }, 'Reconcile', 'Develop reconciled')}
    />
  )

  if (showRepositories) {
    return (
      <Repositories
        repositories={repositories}
        activeId={activeRepositoryId}
        onOpen={(id) => {
          selectRepository(id)
          setRuns([])
          setSelectedId(null)
          setShowRepositories(false)
        }}
        onAdd={() => { setShowRepositories(false); setShowSetup(true) }}
        onRemoved={(id) => {
          const remaining = repositories.filter((item) => item.id !== id)
          setRepositories(remaining)
          if (activeRepositoryId === id) {
            const next = remaining[0]
            selectRepository(next?.id ?? '')
            setRepo(next ?? null)
            setRuns([])
            setSelectedId(null)
            setRunsReady(!next)
          }
        }}
        onClose={() => setShowRepositories(false)}
      />
    )
  }

  if (showSetup || (repoReady && !offline && repositories.length === 0)) {
    return <Onboarding onCancel={repositories.length ? () => setShowSetup(false) : undefined} onSaved={(snapshot) => {
      const saved = normalizeRepo(snapshot)
      setRepo(saved)
      setRepositories((items) => [...items.filter((item) => item.id !== saved.id), saved])
      selectRepository(saved.id)
      setShowSetup(false)
      notify('success', `Connected ${saved.name}`)
    }} />
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
          {repoReady && repositories.length > 0 && (
            <Select size="small" value={activeRepositoryId} onChange={(event) => {
              selectRepository(event.target.value)
              setRuns([])
              setSelectedId(null)
            }} sx={{ minWidth: 190, height: 32, fontSize: 13 }}>
              {repositories.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
            </Select>
          )}
          {repo && <Button type="button" size="small" variant="outlined" onClick={() => setShowConnect(true)}>Connect</Button>}
          {!runsReady ? (
            <Skeleton variant="text" width={118} height={16} />
          ) : (
            <Typography variant="caption" color={offline ? 'warning.main' : 'success.main'}>
              {offline ? 'scheduler offline' : 'scheduler online'}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {repoReady && repositories.length > 0 && <Button type="button" size="small" onClick={() => setShowRepositories(true)}>All repositories</Button>}
          {repoReady && repositories.length > 0 && <Button type="button" size="small" onClick={() => setShowSetup(true)}>Add repository</Button>}
          {repo && <ActionButton busyKey="sync" busy={busy} onClick={() => void runAction('sync', '/api/sync', { repository: repo.id }, 'Sync', 'GitHub sync finished')}>Sync GitHub</ActionButton>}
          {repo?.githubDevelop?.relation === 'diverged' && <ActionButton busyKey="reconcile" busy={busy} color="warning" onClick={() => void runAction('reconcile', '/api/reconcile', { repository: repo.id }, 'Validate reconciliation', 'Reconciliation queued')}>Validate reconciliation</ActionButton>}
          {repo?.pendingReset && <ActionButton busyKey="reset" busy={busy} color="warning" onClick={() => void runAction('reset', '/api/reset-develop', { repository: repo.id }, 'Reset develop', 'Develop reset to main')}>Reset develop to main</ActionButton>}
          {repo?.integration?.mode === 'frozen' && <ActionButton busyKey="promotion" busy={busy} onClick={() => void runAction('promotion', '/api/promotion/cancel', { repository: repo.id }, 'Release promotion', 'Promotion released')}>Release promotion</ActionButton>}
          {!repoReady && (
            <>
              <Skeleton variant="rounded" width={150} height={30} />
              <Skeleton variant="rounded" width={168} height={30} />
            </>
          )}
          {repoReady && canOpenMain && (
            <ActionButton busyKey="main" busy={busy} disabled={mainBusy} onClick={() => void runAction('main', '/api/main', { repository: activeRepositoryId }, 'Validation', 'Validation queued')}>
              Validate develop → main
            </ActionButton>
          )}
          {repoReady && githubMainSha && (
            <ActionButton busyKey="push-main" busy={busy} variant="contained" onClick={() => void runAction('push-main', '/api/pushes', { repository: activeRepositoryId, branch: 'main' }, 'Push', (body) => typeof body.remote === 'string' ? body.remote : 'Pushed main to GitHub')}>
              Push main to GitHub {shortSha(githubMainSha)}
            </ActionButton>
          )}
          {repoReady && developSha && (
            <ActionButton busyKey="push-develop" busy={busy} variant="contained" onClick={() => void runAction('push-develop', '/api/pushes', { repository: activeRepositoryId, branch: 'develop' }, 'Push', (body) => typeof body.remote === 'string' ? body.remote : 'Pushed develop to GitHub')}>
              Push to develop {shortSha(developSha)}
            </ActionButton>
          )}
          <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
            {mode === 'dark' ? 'Light' : 'Dark'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            127.0.0.1
          </Typography>
        </Box>
        {repo?.syncError && <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>GitHub sync: {repo.syncError}</Typography>}
        {repo?.githubDevelop && <Typography variant="caption" color={repo.githubDevelop.relation === 'diverged' ? 'error.main' : 'text.secondary'} sx={{ display: 'block' }}>
          GitHub develop: {repo.githubDevelop.relation} · local {shortSha(repo.githubDevelop.local ?? '')} · GitHub {shortSha(repo.githubDevelop.github ?? '')}
        </Typography>}
        {repo?.integration && <Typography variant="caption" color={repo.integration.mode === 'blocked' ? 'error.main' : 'warning.main'} sx={{ display: 'block' }}>
          Integration {repo.integration.mode}: {repo.integration.reason}. Agent candidates wait for this repository.
        </Typography>}
      </Box>
      <ConnectDialog repo={repo} open={showConnect} onClose={() => setShowConnect(false)} />

      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(360px, 460px) minmax(0, 1fr)', gap: 1.25, p: 1.25 }}>
        <Box sx={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto auto minmax(120px, auto) minmax(0, 1fr)', gap: 1.25 }}>
          <Panel title="Runner" action={<Typography variant="caption" color="text.secondary">concurrency 1</Typography>}>
            {!runsReady && <RunSkeleton />}
            {runsReady && (
            <Box sx={{ px: 1.5, py: 1.25 }}>
              {offline && (
                <Typography variant="caption" color="warning.main">
                  Scheduler is not answering on 127.0.0.1:6001.
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
                {branch.name !== 'main' && branch.name !== 'develop' && branch.status !== 'sync-required' && <ActionButton busyKey={`run:${branch.name}`} busy={busy} onClick={() => void runAction(`run:${branch.name}`, '/api/runs/manual', { repository: repo.id, branch: branch.name }, 'Enqueue', 'Run queued')}>Run</ActionButton>}
                {branch.status === 'sync-required' && <Button size="small" variant="outlined" disabled={busy !== null} onClick={() => notify('warning', `Sync ${branch.name} in your working copy: git fetch ci develop && git rebase ci/develop && git push --force-with-lease ci ${branch.name}`)}>Sync/Rebase</Button>}
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
  busy,
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
  busy: string | null
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
          {run.target === 'main' ? 'develop → main' : run.target === 'post-merge' ? 'develop verification' : run.branch}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {run.repository} · {run.taskId ?? run.branch} · {run.oldSha === ZERO ? 'new branch' : 'update'} · <Sha value={run.newSha} /> · {formatAgo(now, run.createdAt)}
        {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
        {run.integratedAt ? ' · integrated locally' : ''}
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
              built against {run.target === 'main' ? 'main' : 'develop'} <Sha value={run.baseSha} />
            </>
          ) : null}
        </Typography>
      )}
      {showMerge && (
        <Box sx={{ mt: 0.75 }} onClick={(event) => event.stopPropagation()}>
          <ActionButton busyKey={`merge:${run.id}`} busy={busy} variant="contained" color="success" onClick={() => { onSelect(); onMerge() }}>
            Merge to develop
          </ActionButton>
        </Box>
      )}
      {(run.status === 'queued' || run.status === 'running' || run.status === 'failed' || run.status === 'canceled' || run.status === 'stale' || (run.target === 'reconcile' && run.status === 'passed')) && (
        <Box sx={{ mt: 0.5 }} onClick={(event) => event.stopPropagation()}>
          {(run.status === 'queued' || run.status === 'running') && <ActionButton busyKey={`cancel:${run.id}`} busy={busy} color="warning" onClick={onCancel}>Cancel</ActionButton>}
          {(run.status === 'failed' || run.status === 'canceled' || run.status === 'stale') && run.candidateSha && <ActionButton busyKey={`retry:${run.id}`} busy={busy} onClick={onRetry}>Retry</ActionButton>}
          {run.target === 'reconcile' && run.status === 'passed' && <ActionButton busyKey={`reconcile:${run.id}`} busy={busy} color="success" onClick={onReconcile}>Reconcile develop</ActionButton>}
        </Box>
      )}
    </Box>
  )
}
