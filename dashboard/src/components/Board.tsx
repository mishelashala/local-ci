import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { formatAgo, mono } from '../format'
import { Panel, Sha, StatusChip } from '../ui'
import { LiveLog } from './LiveLog'

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
}

const ZERO = '0000000000000000000000000000000000000000'

function normalize(run: Run): Run {
  return {
    ...run,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
  }
}

export function Board() {
  const [runs, setRuns] = useState<Run[]>([])
  const [offline, setOffline] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancel = false
    const tick = async () => {
      try {
        const response = await fetch('/api/runs')
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as { runs: Run[] }
        if (cancel) return
        setRuns(body.runs.map(normalize))
        setOffline(false)
        setNow(Date.now())
      } catch {
        if (!cancel) setOffline(true)
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1000)
    return () => {
      cancel = true
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    if (selectedId && runs.some((run) => run.id === selectedId)) return
    const running = runs.find((run) => run.status === 'running')
    setSelectedId(running?.id ?? runs[0]?.id ?? null)
  }, [runs, selectedId])

  const running = runs.find((run) => run.status === 'running')
  const queued = runs.filter((run) => run.status === 'queued')
  const history = runs.filter((run) => run.status !== 'queued' && run.status !== 'running')
  const selected = runs.find((run) => run.id === selectedId) ?? null

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
          <Typography variant="caption" sx={{ fontFamily: mono }}>
            ~/ci/repos/sample-app.git
          </Typography>
          <Typography variant="caption" color={offline ? 'warning.main' : 'success.main'}>
            {offline ? 'scheduler offline' : 'scheduler online'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            127.0.0.1
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          Queue and logs are from the scheduler. Merge, promote, and GitHub push are not built.
        </Typography>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(360px, 460px) minmax(0, 1fr)', gap: 1.25, p: 1.25 }}>
        <Box sx={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr)', gap: 1.25 }}>
          <Panel title="Runner" action={<Typography variant="caption" color="text.secondary">concurrency 1</Typography>}>
            <Box sx={{ px: 1.5, py: 1.25 }}>
              {offline && (
                <Typography variant="caption" color="warning.main">
                  Scheduler is not answering on 127.0.0.1:3001.
                </Typography>
              )}
              {!offline && running && (
                <RunSummary run={running} now={now} selected={selected?.id === running.id} onSelect={() => setSelectedId(running.id)} />
              )}
              {!offline && !running && (
                <>
                  <Typography sx={{ fontWeight: 600 }}>Runner idle</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {history[0]
                      ? `Last run ${history[0].branch} ${history[0].status}`
                      : 'No runs yet. git push ci feat/branch-name'}
                  </Typography>
                </>
              )}
            </Box>
          </Panel>

          <Panel title="Queue" action={<Typography variant="caption" color="text.secondary">{offline ? 'offline' : queued.length}</Typography>}>
            {!offline && queued.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                Queue empty
              </Typography>
            )}
            {queued.map((run) => (
              <RunSummary key={run.id} run={run} now={now} selected={selected?.id === run.id} onSelect={() => setSelectedId(run.id)} />
            ))}
          </Panel>

          <Panel title="History" fill>
            {!offline && history.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                No finished runs
              </Typography>
            )}
            {history.map((run) => (
              <RunSummary key={run.id} run={run} now={now} selected={selected?.id === run.id} onSelect={() => setSelectedId(run.id)} />
            ))}
          </Panel>
        </Box>

        {selected ? <LiveLog runId={selected.id} /> : (
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

function RunSummary({ run, now, selected, onSelect }: { run: Run; now: number; selected: boolean; onSelect: () => void }) {
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
          {run.branch}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {run.repository} · {run.oldSha === ZERO ? 'new branch' : 'update'} · <Sha value={run.newSha} /> · {formatAgo(now, run.createdAt)}
        {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
      </Typography>
    </Box>
  )
}
