import { Box, Button, Chip, Skeleton, Typography } from '@mui/material';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { useColorMode } from '../color-mode';
import { formatAgo, mono, shortSha } from '../format';
import { developMatchesGitHub, mainSha, pushDevelopSha, type RepoSnapshot } from '../gates';
import { useToast } from '../toast';
import { LogSkeleton, Panel, RunSkeleton, Sha, StatusChip } from '../ui';
import { ConnectDialog } from './Connect';
import { LiveLog } from './LiveLog';
import { Onboarding } from './Onboarding';
import { Repositories } from './Repositories';

type Run = {
  id: string;
  repository: string;
  branch: string;
  oldSha: string;
  newSha: string;
  status: string;
  workflow: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  baseSha: string | null;
  headSha: string | null;
  candidateSha: string | null;
  target: string | null;
  integratedAt: number | null;
  taskId: string | null;
};

type RunInput = Omit<
  Run,
  | 'startedAt'
  | 'finishedAt'
  | 'exitCode'
  | 'baseSha'
  | 'headSha'
  | 'candidateSha'
  | 'target'
  | 'integratedAt'
  | 'taskId'
> & {
  target?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  exitCode?: number | null;
  baseSha?: string | null;
  headSha?: string | null;
  candidateSha?: string | null;
  integratedAt?: number | null;
  taskId?: string | null;
};

const ZERO = '0000000000000000000000000000000000000000';

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
  };
}

function normalizeRepo(body: RepoSnapshot): RepoSnapshot {
  const raw = Array.isArray(body.branches) ? body.branches : [];
  return {
    id: typeof body.id === 'string' ? body.id : '',
    name: typeof body.name === 'string' ? body.name : 'Repository',
    barePath: typeof body.barePath === 'string' ? body.barePath : '',
    maxBranchDrift: Number.isInteger(body.maxBranchDrift) ? body.maxBranchDrift : 10,
    develop: body.develop ?? null,
    branches: raw.flatMap((branch) => {
      if (!branch || typeof branch.name !== 'string' || typeof branch.sha !== 'string') {
        return [];
      }
      return [
        {
          name: branch.name,
          sha: branch.sha,
          aheadOfDevelop: Number.isFinite(branch.aheadOfDevelop) ? branch.aheadOfDevelop : null,
          behindDevelop: Number.isFinite(branch.behindDevelop) ? branch.behindDevelop : null,
          status: branch.status ?? 'idle',
        },
      ];
    }),
    origin: body.origin ?? null,
    githubDevelop: body.githubDevelop,
    githubMain: body.githubMain,
    syncError: body.syncError ?? null,
    pendingReset: body.pendingReset ?? null,
    integration: body.integration ?? null,
  };
}

async function postJson(
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object') {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

function apiError(body: Record<string, unknown>, status: number, label: string): string {
  return typeof body.error === 'string' && body.error.length > 0 ? body.error : `${label} (${status})`;
}

function keepGitHub(current: RepoSnapshot | undefined, next: RepoSnapshot): RepoSnapshot {
  if (!current || current.id !== next.id) {
    return next;
  }
  return {
    ...next,
    githubDevelop: next.githubDevelop ?? current.githubDevelop,
    githubMain: next.githubMain ?? current.githubMain,
  };
}

function ActionButton({
  busyKey,
  busy,
  children,
  disabled,
  variant = 'outlined',
  ...props
}: ComponentProps<typeof Button> & { busyKey: string; busy: string | null }) {
  const loading = busy === busyKey;
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
  );
}

export function Board() {
  const { mode, toggle } = useColorMode();
  const notify = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsReady, setRunsReady] = useState(false);
  const [repositories, setRepositories] = useState<RepoSnapshot[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [showRepositories, setShowRepositories] = useState(false);
  const [connectRepo, setConnectRepo] = useState<RepoSnapshot | null>(null);
  const [repoReady, setRepoReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [usage, setUsage] = useState<{ cpu: number | null; ramUsedGb: number; ramTotalGb: number } | null>(null);
  const queueTouched = useRef(false);
  const busyLock = useRef<string | null>(null);
  const repositoryIdsRef = useRef<string[]>([]);

  async function refreshRuns(repositoryIds: string[]) {
    if (repositoryIds.length === 0) {
      return;
    }
    const batches = await Promise.all(
      repositoryIds.map(async (id) => {
        const response = await fetch(`/api/runs?repository=${encodeURIComponent(id)}`);
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const body = (await response.json()) as { runs?: RunInput[] };
        if (!Array.isArray(body.runs)) {
          throw new Error('runs');
        }
        return body.runs.map(normalize);
      }),
    );
    setRuns(batches.flat().sort((a, b) => b.createdAt - a.createdAt));
    setRunsReady(true);
    setOffline(false);
    setNow(Date.now());
  }

  async function refreshBoard() {
    const reposResponse = await fetch('/api/repositories');
    if (reposResponse.ok) {
      const body = (await reposResponse.json()) as { repositories?: RepoSnapshot[] };
      if (Array.isArray(body.repositories)) {
        const snapshots = body.repositories.map(normalizeRepo);
        setRepositories((current) =>
          snapshots.map((item) =>
            keepGitHub(
              current.find((entry) => entry.id === item.id),
              item,
            ),
          ),
        );
      }
    }
    await refreshRuns(repositoryIdsRef.current);
  }

  async function runAction(
    key: string,
    path: string,
    payload: unknown,
    label: string,
    success: string | ((body: Record<string, unknown>) => string),
  ) {
    if (busyLock.current) {
      return;
    }
    busyLock.current = key;
    setBusy(key);
    const sent =
      payload !== null && typeof payload === 'object' ? (payload as { repository?: string; branch?: string }) : {};
    const repositoryId = typeof sent.repository === 'string' ? sent.repository : '';
    try {
      const result = await postJson(path, payload);
      if (result.ok && path === '/api/sync' && typeof result.body.id === 'string') {
        const saved = normalizeRepo(result.body as RepoSnapshot);
        setRepositories((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      }
      if (result.ok && path === '/api/pushes' && typeof result.body.sha === 'string' && sent.branch === 'develop') {
        const sha = result.body.sha;
        setRepositories((items) =>
          items.map((item) =>
            item.id === repositoryId
              ? { ...item, develop: sha, githubDevelop: { local: sha, github: sha, relation: 'same' } }
              : item,
          ),
        );
      }
      await refreshBoard();
      if (result.ok) {
        notify('success', typeof success === 'function' ? success(result.body) : success);
      } else {
        notify('error', apiError(result.body, result.status, label));
      }
    } catch {
      notify('error', `${label} request failed`);
    } finally {
      busyLock.current = null;
      setBusy(null);
    }
  }

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const response = await fetch('/api/repositories');
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const body = (await response.json()) as { repositories?: RepoSnapshot[] };
        if (cancel) {
          return;
        }
        const snapshots = Array.isArray(body.repositories) ? body.repositories.map(normalizeRepo) : [];
        setRepositories(snapshots);
        if (snapshots.length === 0) {
          setRepoReady(true);
          setRuns([]);
          setRunsReady(true);
          setOffline(false);
          return;
        }
        setRepoReady(true);
        const batches = await Promise.all(
          snapshots.map(async (item) => {
            const runsResponse = await fetch(`/api/runs?repository=${encodeURIComponent(item.id)}`);
            if (!runsResponse.ok) {
              throw new Error(String(runsResponse.status));
            }
            const runsBody = (await runsResponse.json()) as { runs?: RunInput[] };
            if (!Array.isArray(runsBody.runs)) {
              throw new Error('runs');
            }
            return runsBody.runs.map(normalize);
          }),
        );
        if (cancel) {
          return;
        }
        setRuns(batches.flat().sort((a, b) => b.createdAt - a.createdAt));
        setOffline(false);
        setRunsReady(true);
        setNow(Date.now());
        const synced = await fetch('/api/repositories?sync=1');
        if (!synced.ok || cancel) {
          return;
        }
        const syncedBody = (await synced.json()) as { repositories?: RepoSnapshot[] };
        if (cancel || !Array.isArray(syncedBody.repositories)) {
          return;
        }
        const refreshed = syncedBody.repositories.map(normalizeRepo);
        setRepositories(refreshed);
      } catch {
        if (!cancel) {
          setOffline(true);
          setRunsReady(true);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (selectedId && runs.some((run) => run.id === selectedId)) {
      return;
    }
    const running = runs.find((run) => run.status === 'running');
    setSelectedId(running?.id ?? runs[0]?.id ?? null);
  }, [runs, selectedId]);

  repositoryIdsRef.current = repositories.map((item) => item.id);

  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const response = await fetch('/api/usage');
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as { cpu?: number | null; ramUsedGb?: number; ramTotalGb?: number };
        if (cancel || typeof body.ramUsedGb !== 'number' || typeof body.ramTotalGb !== 'number') {
          return;
        }
        setUsage({
          cpu: typeof body.cpu === 'number' ? body.cpu : null,
          ramUsedGb: body.ramUsedGb,
          ramTotalGb: body.ramTotalGb,
        });
      } catch {
        if (!cancel) {
          setUsage(null);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  const live = runs.some((run) => run.status === 'queued' || run.status === 'running');
  const wasLive = useRef(false);
  useEffect(() => {
    if (!runsReady || repositories.length === 0) {
      return;
    }
    const stopped = wasLive.current && !live;
    wasLive.current = live;
    if (stopped) {
      void refreshBoard();
    }
    if (!live) {
      return;
    }
    const id = window.setInterval(() => {
      void refreshRuns(repositoryIdsRef.current);
    }, 2000);
    return () => window.clearInterval(id);
  }, [live, runsReady, repositories.length]);

  const runningRuns = runs.filter((run) => run.status === 'running');
  const queued = runs.filter((run) => run.status === 'queued');
  const history = runs.filter((run) => run.status !== 'queued' && run.status !== 'running');

  useEffect(() => {
    if (!queueTouched.current) {
      setQueueOpen(queued.length > 0);
    }
  }, [queued.length]);
  const selected = runs.find((run) => run.id === selectedId) ?? null;

  const summary = (run: Run) => (
    <RunSummary
      key={run.id}
      run={run}
      now={now}
      selected={selected?.id === run.id}
      onSelect={() => setSelectedId(run.id)}
      repositoryName={repositories.find((item) => item.id === run.repository)?.name ?? 'repository'}
      showMerge={false}
      busy={busy}
      onMerge={() => void runAction(`merge:${run.id}`, '/api/merges', { runId: run.id }, 'Merge', 'Merge finished')}
      onCancel={() =>
        void runAction(
          `cancel:${run.id}`,
          `/api/runs/${encodeURIComponent(run.id)}/cancel`,
          {},
          'Cancel',
          'Run canceled',
        )
      }
      onRetry={() =>
        void runAction(`retry:${run.id}`, `/api/runs/${encodeURIComponent(run.id)}/retry`, {}, 'Retry', 'Retry queued')
      }
      onReconcile={() =>
        void runAction(
          `reconcile:${run.id}`,
          '/api/reconciliations',
          { runId: run.id },
          'Reconcile',
          'Develop reconciled',
        )
      }
    />
  );

  if (showRepositories) {
    return (
      <Repositories
        repositories={repositories}
        onAdd={() => {
          setShowRepositories(false);
          setShowSetup(true);
        }}
        onRemoved={(id) => {
          setRepositories((items) => items.filter((item) => item.id !== id));
          setRuns((items) => items.filter((run) => run.repository !== id));
        }}
        onClose={() => setShowRepositories(false)}
      />
    );
  }

  if (showSetup || (repoReady && !offline && repositories.length === 0)) {
    return (
      <Onboarding
        onCancel={repositories.length ? () => setShowSetup(false) : undefined}
        onSaved={(snapshot) => {
          const saved = normalizeRepo(snapshot);
          setRepositories((items) => [...items.filter((item) => item.id !== saved.id), saved]);
          setShowSetup(false);
          notify('success', `Connected ${saved.name}`);
        }}
      />
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
          {!runsReady ? (
            <Skeleton variant="text" width={118} height={16} />
          ) : (
            <Typography variant="caption" color={offline ? 'warning.main' : 'success.main'}>
              {offline ? 'scheduler offline' : 'scheduler online'}
            </Typography>
          )}
          {usage && (
            <Typography variant="caption" color="text.secondary">
              {usage.cpu === null ? 'CPU …' : `CPU ${usage.cpu}%`} · RAM {usage.ramUsedGb}/{usage.ramTotalGb} GB
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {repoReady && repositories.length > 0 && (
            <Button type="button" size="small" onClick={() => setShowRepositories(true)}>
              All repositories
            </Button>
          )}
          {repoReady && repositories.length > 0 && (
            <Button type="button" size="small" onClick={() => setShowSetup(true)}>
              Add repository
            </Button>
          )}
          <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
            {mode === 'dark' ? 'Light' : 'Dark'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            127.0.0.1
          </Typography>
        </Box>
      </Box>
      <ConnectDialog repo={connectRepo} open={connectRepo !== null} onClose={() => setConnectRepo(null)} />

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(360px, 460px) minmax(0, 1fr)',
          gap: 1.25,
          p: 1.25,
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.25,
          }}
        >
          <Panel
            title="Runner"
            action={
              <Typography variant="caption" color="text.secondary">
                frontend + server
              </Typography>
            }
          >
            {!runsReady && <RunSkeleton />}
            {runsReady && (
              <Box sx={{ px: 1.5, py: 1.25 }}>
                {offline && (
                  <Typography variant="caption" color="warning.main">
                    Scheduler is not answering on 127.0.0.1:6001.
                  </Typography>
                )}
                {!offline && runningRuns.map(summary)}
                {!offline && runningRuns.length === 0 && (
                  <>
                    <Typography sx={{ fontWeight: 600 }}>Runner idle</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {history[0]
                        ? `Last run ${repositories.find((item) => item.id === history[0].repository)?.name ?? 'repository'} ${history[0].branch} ${history[0].status}`
                        : 'No runs yet. git push ci feat/branch-name'}
                    </Typography>
                  </>
                )}
              </Box>
            )}
          </Panel>

          <Panel
            title="Queue"
            open={queueOpen}
            onToggle={() => {
              queueTouched.current = true;
              setQueueOpen((open) => !open);
            }}
            action={
              !runsReady ? (
                <Skeleton variant="text" width={16} height={14} />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  {offline ? 'offline' : queued.length}
                </Typography>
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

          <Panel title="Projects" open={branchesOpen} onToggle={() => setBranchesOpen((open) => !open)} maxHeight={480}>
            {repositories.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                No branches in this CI repository yet.
              </Typography>
            )}
            {repositories.map((item) => {
              const itemRuns = runs.filter((run) => run.repository === item.id);
              const developSha = pushDevelopSha(itemRuns, item);
              const canOpenMain = mainSha(item) !== null && item.develop != null && !item.integration;
              const itemMainBusy = itemRuns.some(
                (run) => run.target === 'main' && (run.status === 'queued' || run.status === 'running'),
              );
              return (
                <Box key={item.id}>
                  <Box sx={{ px: 1.5, py: 0.75, bgcolor: 'action.hover' }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 700 }} noWrap>
                      {item.name}
                    </Typography>
                    {item.syncError && (
                      <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>
                        GitHub sync: {item.syncError}
                      </Typography>
                    )}
                    {item.githubDevelop && (
                      <Typography
                        variant="caption"
                        color={item.githubDevelop.relation === 'diverged' ? 'error.main' : 'text.secondary'}
                        sx={{ display: 'block' }}
                      >
                        GitHub develop: {item.githubDevelop.relation} · local {shortSha(item.githubDevelop.local ?? '')}{' '}
                        · GitHub {shortSha(item.githubDevelop.github ?? '')}
                      </Typography>
                    )}
                    {item.integration && (
                      <Typography
                        variant="caption"
                        color={item.integration.mode === 'blocked' ? 'error.main' : 'warning.main'}
                        sx={{ display: 'block' }}
                      >
                        Integration {item.integration.mode}: {item.integration.reason}
                      </Typography>
                    )}
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75 }}>
                      <Button type="button" size="small" variant="outlined" onClick={() => setConnectRepo(item)}>
                        Connect
                      </Button>
                      <ActionButton
                        busyKey={`sync:${item.id}`}
                        busy={busy}
                        onClick={() =>
                          void runAction(
                            `sync:${item.id}`,
                            '/api/sync',
                            { repository: item.id },
                            'Sync',
                            'GitHub sync finished',
                          )
                        }
                      >
                        Sync GitHub
                      </ActionButton>
                      {item.githubDevelop?.relation === 'diverged' && (
                        <ActionButton
                          busyKey={`match-develop:${item.id}`}
                          busy={busy}
                          color="warning"
                          onClick={() =>
                            void runAction(
                              `match-develop:${item.id}`,
                              '/api/develop/match',
                              { repository: item.id },
                              'Match GitHub develop',
                              'Local develop now matches GitHub. No new commit was created.',
                            )
                          }
                        >
                          Match GitHub develop
                        </ActionButton>
                      )}
                      {item.githubDevelop?.relation === 'diverged' && (
                        <ActionButton
                          busyKey={`reconcile:${item.id}`}
                          busy={busy}
                          color="warning"
                          onClick={() =>
                            void runAction(
                              `reconcile:${item.id}`,
                              '/api/reconcile',
                              { repository: item.id },
                              'Validate reconciliation',
                              'Reconciliation queued',
                            )
                          }
                        >
                          Validate reconciliation
                        </ActionButton>
                      )}
                      {item.pendingReset && (
                        <ActionButton
                          busyKey={`reset:${item.id}`}
                          busy={busy}
                          color="warning"
                          onClick={() =>
                            void runAction(
                              `reset:${item.id}`,
                              '/api/reset-develop',
                              { repository: item.id },
                              'Reset develop',
                              'Develop reset to main',
                            )
                          }
                        >
                          Reset develop to main
                        </ActionButton>
                      )}
                      {item.integration?.mode === 'frozen' && (
                        <ActionButton
                          busyKey={`promotion:${item.id}`}
                          busy={busy}
                          onClick={() =>
                            void runAction(
                              `promotion:${item.id}`,
                              '/api/promotion/cancel',
                              { repository: item.id },
                              'Release promotion',
                              'Promotion released',
                            )
                          }
                        >
                          Release promotion
                        </ActionButton>
                      )}
                      {canOpenMain && (
                        <ActionButton
                          busyKey={`main:${item.id}`}
                          busy={busy}
                          disabled={itemMainBusy}
                          onClick={() =>
                            void runAction(
                              `main:${item.id}`,
                              '/api/main',
                              { repository: item.id },
                              'Prepare',
                              (body) => (typeof body.url === 'string' ? body.url : 'Opened the GitHub pull request'),
                            )
                          }
                        >
                          Prepare develop → main
                        </ActionButton>
                      )}
                      {developSha && (
                        <ActionButton
                          busyKey={`push-develop:${item.id}`}
                          busy={busy}
                          variant="contained"
                          disabled={developMatchesGitHub(item)}
                          title={developMatchesGitHub(item) ? 'GitHub develop is already this commit' : undefined}
                          onClick={() =>
                            void runAction(
                              `push-develop:${item.id}`,
                              '/api/pushes',
                              { repository: item.id, branch: 'develop' },
                              'Push',
                              (body) => (typeof body.remote === 'string' ? body.remote : 'Pushed develop to GitHub'),
                            )
                          }
                        >
                          Push to develop {shortSha(developSha)}
                        </ActionButton>
                      )}
                    </Box>
                  </Box>
                  {item.branches.length === 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
                      No branches in this CI repository yet.
                    </Typography>
                  )}
                  {item.branches.map((branch) => {
                    const liveRun = runs.find(
                      (run) =>
                        run.repository === item.id &&
                        run.branch === branch.name &&
                        (run.status === 'running' || run.status === 'queued'),
                    );
                    const shown = liveRun?.status ?? branch.status;
                    return (
                      <Box
                        key={`${item.id}:${branch.name}`}
                        sx={{
                          px: 1.5,
                          py: 0.8,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          borderBottom: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }} noWrap>
                          {branch.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: mono }}>
                          <Sha value={branch.sha} />
                        </Typography>
                        {branch.behindDevelop !== null && branch.name !== 'develop' && (
                          <Typography variant="caption" color="text.secondary">
                            {branch.behindDevelop} behind
                          </Typography>
                        )}
                        <Chip
                          size="small"
                          label={shown.replaceAll('-', ' ')}
                          color={
                            shown === 'running'
                              ? 'info'
                              : shown === 'ready-to-merge' || shown === 'ready-to-deploy' || shown === 'passed'
                                ? 'success'
                                : shown === 'failed'
                                  ? 'error'
                                  : 'default'
                          }
                        />
                        {!liveRun && branch.name !== 'main' && branch.name !== 'develop' && (
                          <ActionButton
                            busyKey={`run:${item.id}:${branch.name}`}
                            busy={busy}
                            onClick={() =>
                              void runAction(
                                `run:${item.id}:${branch.name}`,
                                '/api/runs/manual',
                                { repository: item.id, branch: branch.name },
                                'Enqueue',
                                'Run queued',
                              )
                            }
                          >
                            Run
                          </ActionButton>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
          </Panel>

          <Panel title="History" grow open={historyOpen} onToggle={() => setHistoryOpen((open) => !open)}>
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
        ) : selected ? (
          <LiveLog runId={selected.id} />
        ) : (
          <Panel title="Logs" fill>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.25 }}>
              No run selected
            </Typography>
          </Panel>
        )}
      </Box>
    </Box>
  );
}

function RunSummary({
  run,
  now,
  selected,
  onSelect,
  repositoryName,
  showMerge,
  busy,
  onMerge,
  onCancel,
  onRetry,
  onReconcile,
}: {
  run: Run;
  now: number;
  selected: boolean;
  onSelect: () => void;
  repositoryName: string;
  showMerge: boolean;
  busy: string | null;
  onMerge: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onReconcile: () => void;
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
          {repositoryName} ·{' '}
          {run.target === 'main'
            ? 'develop → main'
            : run.target === 'post-merge'
              ? 'develop verification'
              : run.target === 'develop-gate'
                ? `full develop suite · ${run.branch}`
                : run.branch}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {run.taskId ?? run.branch} · {run.oldSha === ZERO ? 'new branch' : 'update'} · <Sha value={run.newSha} /> ·{' '}
        {formatAgo(now, run.createdAt)}
        {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
        {run.integratedAt ? ' · integrated locally' : ''}
        {run.target === 'main' && run.status === 'ready' ? ' · GitHub runs the tests' : ''}
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
          <ActionButton
            busyKey={`merge:${run.id}`}
            busy={busy}
            variant="contained"
            color="success"
            onClick={() => {
              onSelect();
              onMerge();
            }}
          >
            Merge to develop
          </ActionButton>
        </Box>
      )}
      {(run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'failed' ||
        run.status === 'canceled' ||
        run.status === 'stale' ||
        (run.target === 'reconcile' && run.status === 'passed')) && (
        <Box sx={{ mt: 0.5 }} onClick={(event) => event.stopPropagation()}>
          {(run.status === 'queued' || run.status === 'running') && (
            <ActionButton busyKey={`cancel:${run.id}`} busy={busy} color="warning" onClick={onCancel}>
              Cancel
            </ActionButton>
          )}
          {(run.status === 'failed' || run.status === 'canceled' || run.status === 'stale') &&
            run.candidateSha &&
            run.target !== 'main' && (
              <ActionButton busyKey={`retry:${run.id}`} busy={busy} onClick={onRetry}>
                Retry
              </ActionButton>
            )}
          {run.target === 'reconcile' && run.status === 'passed' && (
            <ActionButton busyKey={`reconcile:${run.id}`} busy={busy} color="success" onClick={onReconcile}>
              Reconcile develop
            </ActionButton>
          )}
        </Box>
      )}
    </Box>
  );
}
