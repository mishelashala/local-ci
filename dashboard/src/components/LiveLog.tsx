import { useEffect, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { AnsiText } from '../ansi'
import { formatAgo, formatDuration, mono } from '../format'
import { LogSkeleton, Panel, Sha, StatusChip } from '../ui'

type LiveRun = {
  id: string
  branch: string
  newSha: string
  status: string
  workflow: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
}
type Workflow = { path: string; status: string; startedAt: number | null; finishedAt: number | null; exitCode: number | null }

function elapsed(run: LiveRun, now: number): string {
  if (run.startedAt === null) return formatAgo(now, run.createdAt)
  return formatDuration((run.finishedAt ?? now) - run.startedAt)
}

export function LiveLog({ runId }: { runId: string }) {
  const [run, setRun] = useState<LiveRun | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const seen = useRef(0)

  useEffect(() => { setSelectedWorkflow(null) }, [runId])

  useEffect(() => {
    let cancel = false
    setRun(null)
    setLines([])
    setReady(false)
    setError(false)
    seen.current = 0

    const tick = async () => {
      try {
        const [runResponse, logResponse, workflowsResponse] = await Promise.all([
          fetch(`/api/runs/${runId}`),
          fetch(`/api/runs/${runId}/logs${selectedWorkflow ? `?workflow=${encodeURIComponent(selectedWorkflow)}` : ''}`),
          fetch(`/api/runs/${runId}/workflows`),
        ])
        if (!runResponse.ok || !logResponse.ok || !workflowsResponse.ok) throw new Error(String(runResponse.status))
        const runBody = (await runResponse.json()) as { run: LiveRun }
        const logBody = (await logResponse.json()) as { lines: string[] }
        const workflowBody = (await workflowsResponse.json()) as { workflows: Workflow[] }
        if (cancel) return
        setRun({
          ...runBody.run,
          startedAt: runBody.run.startedAt ?? null,
          finishedAt: runBody.run.finishedAt ?? null,
          exitCode: runBody.run.exitCode ?? null,
        })
        setLines(logBody.lines)
        setWorkflows(workflowBody.workflows)
        setNow(Date.now())
        setReady(true)
        setError(false)
      } catch {
        if (!cancel) {
          setError(true)
          setReady(true)
        }
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), 1000)
    return () => {
      cancel = true
      window.clearInterval(id)
    }
  }, [runId, selectedWorkflow])

  useEffect(() => {
    if (lines.length === seen.current) return
    seen.current = lines.length
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <Panel
      title="Logs"
      fill
      scroll={false}
      action={
        <Typography variant="caption" color="text.secondary">
          live
        </Typography>
      }
    >
      <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!ready ? (
          <LogSkeleton />
        ) : (
        <>
        <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
          {!run && (
            <Typography variant="caption" color="text.secondary">
              {error ? 'Scheduler is not answering on 127.0.0.1:3001.' : 'Loading run'}
            </Typography>
          )}
          {run && (
            <>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <StatusChip status={run.status} />
                <Typography sx={{ fontWeight: 600, fontSize: 14 }} noWrap>
                  {run.branch}
                </Typography>
                <Typography variant="caption" sx={{ ml: 'auto', fontFamily: mono, fontVariantNumeric: 'tabular-nums' }}>
                  {elapsed(run, now)}
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {run.id} · <Sha value={run.newSha} /> · {run.workflow}
                {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
              </Typography>
            </>
          )}
        </Box>
        {workflows.length > 0 && <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'divider', maxHeight: 145, overflow: 'auto' }}>
          <Button size="small" variant={selectedWorkflow === null ? 'contained' : 'text'} onClick={() => setSelectedWorkflow(null)}>All logs</Button>
          {workflows.map((workflow) => <Box key={workflow.path} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <StatusChip status={workflow.status} />
            <Button size="small" sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
              variant={selectedWorkflow === workflow.path ? 'contained' : 'text'}
              onClick={() => setSelectedWorkflow(workflow.path)}>{workflow.path}</Button>
            {workflow.exitCode !== null && <Typography variant="caption">exit {workflow.exitCode}</Typography>}
          </Box>)}
        </Box>}
        <Box
          ref={scroller}
          sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, py: 1, fontFamily: mono, fontSize: 12.5, lineHeight: 1.55 }}
        >
          {error && (
            <Typography variant="caption" color="warning.main" display="block">
              Scheduler is not answering on 127.0.0.1:3001.
            </Typography>
          )}
          {!error && lines.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              {run?.status === 'queued' ? 'Queued. Logs appear when the runner starts.' : 'No log lines.'}
            </Typography>
          )}
          {lines.map((line, index) => (
            <Box key={`${runId}-${index}`} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              <AnsiText text={line} />
            </Box>
          ))}
        </Box>
        </>
        )}
      </Box>
    </Panel>
  )
}
