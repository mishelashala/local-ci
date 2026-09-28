import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { AnsiText } from '../ansi';
import { formatAgo, formatDuration, mono } from '../format';
import { groupSteps, parseActSteps } from '../steps';
import { LogSkeleton, Panel, Sha, StatusChip } from '../ui';

type LiveRun = {
  id: string;
  branch: string;
  newSha: string;
  status: string;
  workflow: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
};
type Workflow = {
  path: string;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
};

function elapsed(run: LiveRun, now: number): string {
  if (run.startedAt === null) {
    return formatAgo(now, run.createdAt);
  }
  return formatDuration((run.finishedAt ?? now) - run.startedAt);
}

export function LiveLog({ runId }: { runId: string }) {
  const [run, setRun] = useState<LiveRun | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const [openSteps, setOpenSteps] = useState<string[]>([]);
  const [openJobs, setOpenJobs] = useState<string[]>([]);
  const pinnedSteps = useRef(new Set<string>());
  const closedSteps = useRef(new Set<string>());
  const seenRunningSteps = useRef(new Set<string>());
  const pinnedJobs = useRef(new Set<string>());
  const closedJobs = useRef(new Set<string>());
  const seenRunningJobs = useRef(new Set<string>());

  useEffect(() => {
    setSelectedWorkflow(null);
    setOpenSteps([]);
    setOpenJobs([]);
    pinnedSteps.current.clear();
    closedSteps.current.clear();
    seenRunningSteps.current.clear();
    pinnedJobs.current.clear();
    closedJobs.current.clear();
    seenRunningJobs.current.clear();
  }, [runId]);

  useEffect(() => {
    let cancel = false;
    setRun(null);
    setLines([]);
    setReady(false);
    setError(false);
    seen.current = 0;

    const tick = async () => {
      try {
        const [runResponse, logResponse, workflowsResponse] = await Promise.all([
          fetch(`/api/runs/${runId}`),
          fetch(
            `/api/runs/${runId}/logs${selectedWorkflow ? `?workflow=${encodeURIComponent(selectedWorkflow)}` : ''}`,
          ),
          fetch(`/api/runs/${runId}/workflows`),
        ]);
        if (!runResponse.ok || !logResponse.ok || !workflowsResponse.ok) {
          throw new Error(String(runResponse.status));
        }
        const runBody = (await runResponse.json()) as { run: LiveRun };
        const logBody = (await logResponse.json()) as { lines: string[] };
        const workflowBody = (await workflowsResponse.json()) as { workflows: Workflow[] };
        if (cancel) {
          return;
        }
        setRun({
          ...runBody.run,
          startedAt: runBody.run.startedAt ?? null,
          finishedAt: runBody.run.finishedAt ?? null,
          exitCode: runBody.run.exitCode ?? null,
        });
        setLines(logBody.lines);
        setWorkflows(workflowBody.workflows);
        setNow(Date.now());
        setReady(true);
        setError(false);
      } catch {
        if (!cancel) {
          setError(true);
          setReady(true);
        }
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [runId, selectedWorkflow]);

  const steps = parseActSteps(lines);
  const jobs = groupSteps(steps);

  useEffect(() => {
    for (const step of steps) {
      if (step.status === 'running') {
        seenRunningSteps.current.add(step.id);
      } else if (seenRunningSteps.current.has(step.id)) {
        seenRunningSteps.current.delete(step.id);
        pinnedSteps.current.delete(step.id);
        closedSteps.current.delete(step.id);
      }
    }
    const nextSteps = new Set(pinnedSteps.current);
    for (const step of steps) {
      if (step.status === 'running' && !closedSteps.current.has(step.id)) {
        nextSteps.add(step.id);
      }
    }
    setOpenSteps([...nextSteps]);

    for (const job of jobs) {
      if (job.status === 'running') {
        seenRunningJobs.current.add(job.job);
      } else if (seenRunningJobs.current.has(job.job)) {
        seenRunningJobs.current.delete(job.job);
        pinnedJobs.current.delete(job.job);
        closedJobs.current.delete(job.job);
      }
    }
    const nextJobs = new Set(pinnedJobs.current);
    for (const job of jobs) {
      if (job.status === 'running' && !closedJobs.current.has(job.job)) {
        nextJobs.add(job.job);
      }
    }
    setOpenJobs([...nextJobs]);
  }, [lines]);

  useEffect(() => {
    if (lines.length === seen.current) {
      return;
    }
    seen.current = lines.length;
    const el = scroller.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [lines, openSteps]);

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
                  {error ? 'Scheduler is not answering on 127.0.0.1:6001.' : 'Loading run'}
                </Typography>
              )}
              {run && (
                <>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <StatusChip status={run.status} />
                    <Typography sx={{ fontWeight: 600, fontSize: 14 }} noWrap>
                      {run.branch}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ ml: 'auto', fontFamily: mono, fontVariantNumeric: 'tabular-nums' }}
                    >
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
            {workflows.length > 0 && (
              <Box
                sx={{
                  px: 1,
                  py: 0.5,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  maxHeight: 145,
                  overflow: 'auto',
                }}
              >
                <Button
                  size="small"
                  variant={selectedWorkflow === null ? 'contained' : 'text'}
                  onClick={() => setSelectedWorkflow(null)}
                >
                  All logs
                </Button>
                {workflows.map((workflow) => (
                  <Box key={workflow.path} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <StatusChip status={workflow.status} />
                    <Button
                      size="small"
                      sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
                      variant={selectedWorkflow === workflow.path ? 'contained' : 'text'}
                      onClick={() => setSelectedWorkflow(workflow.path)}
                    >
                      {workflow.path}
                    </Button>
                    {workflow.exitCode !== null && <Typography variant="caption">exit {workflow.exitCode}</Typography>}
                  </Box>
                ))}
              </Box>
            )}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {error && (
                <Typography variant="caption" color="warning.main" display="block" sx={{ px: 1.5, py: 1 }}>
                  Scheduler is not answering on 127.0.0.1:6001.
                </Typography>
              )}
              {!error && lines.length === 0 && (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 1.5, py: 1 }}>
                  {run?.status === 'queued' ? 'Queued. Steps appear when the runner starts.' : 'No log lines.'}
                </Typography>
              )}
              {!error && lines.length > 0 && steps.length === 0 && (
                <Box ref={scroller} sx={{ px: 1.5, py: 1, fontFamily: mono, fontSize: 12.5, lineHeight: 1.55 }}>
                  {lines.map((line, index) => (
                    <Box key={`${runId}-${index}`} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                      <AnsiText text={line} />
                    </Box>
                  ))}
                </Box>
              )}
              {jobs.map((job) => (
                <Accordion
                  key={job.job}
                  disableGutters
                  elevation={0}
                  expanded={openJobs.includes(job.job)}
                  onChange={(_event, expanded) => {
                    if (expanded) {
                      pinnedJobs.current.add(job.job);
                      closedJobs.current.delete(job.job);
                      setOpenJobs((names) => (names.includes(job.job) ? names : [...names, job.job]));
                    } else {
                      pinnedJobs.current.delete(job.job);
                      closedJobs.current.add(job.job);
                      setOpenJobs((names) => names.filter((name) => name !== job.job));
                    }
                  }}
                  sx={{
                    '&:before': { display: 'none' },
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'transparent',
                  }}
                >
                  <AccordionSummary
                    sx={{
                      minHeight: 36,
                      px: 1.5,
                      bgcolor: 'action.hover',
                      '& .MuiAccordionSummary-content': { my: 0.5, alignItems: 'center', gap: 1 },
                    }}
                  >
                    <StatusChip status={job.status} />
                    <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }} noWrap>
                      {job.job}
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ p: 0 }}>
                    {job.steps.map((step) => (
                      <Accordion
                        key={step.id}
                        disableGutters
                        elevation={0}
                        onClick={(event) => event.stopPropagation()}
                        expanded={openSteps.includes(step.id)}
                        onChange={(_event, expanded) => {
                          if (expanded) {
                            pinnedSteps.current.add(step.id);
                            closedSteps.current.delete(step.id);
                            setOpenSteps((ids) => (ids.includes(step.id) ? ids : [...ids, step.id]));
                          } else {
                            pinnedSteps.current.delete(step.id);
                            closedSteps.current.add(step.id);
                            setOpenSteps((ids) => ids.filter((id) => id !== step.id));
                          }
                        }}
                        sx={{
                          '&:before': { display: 'none' },
                          borderBottom: '1px solid',
                          borderColor: 'divider',
                          bgcolor: 'transparent',
                          ml: 2,
                        }}
                      >
                        <AccordionSummary
                          sx={{
                            minHeight: 36,
                            px: 1.5,
                            '& .MuiAccordionSummary-content': { my: 0.5, alignItems: 'center', gap: 1 },
                          }}
                        >
                          <StatusChip status={step.status} />
                          <Typography sx={{ fontSize: 13, flex: 1 }} noWrap>
                            {step.name}
                          </Typography>
                          {step.duration && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                              {step.duration}
                            </Typography>
                          )}
                        </AccordionSummary>
                        <AccordionDetails
                          ref={step.status === 'running' ? scroller : undefined}
                          sx={{
                            px: 1.5,
                            py: 1,
                            fontFamily: mono,
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            maxHeight: 360,
                            overflow: 'auto',
                          }}
                        >
                          {step.lines.length === 0 && (
                            <Typography variant="caption" color="text.secondary">
                              No output yet.
                            </Typography>
                          )}
                          {step.lines.map((line, index) => (
                            <Box key={`${step.id}-${index}`} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                              <AnsiText text={line.replace(/^\[[^\]]+\]\s?/, '')} />
                            </Box>
                          ))}
                        </AccordionDetails>
                      </Accordion>
                    ))}
                  </AccordionDetails>
                </Accordion>
              ))}
            </Box>
          </>
        )}
      </Box>
    </Panel>
  );
}
