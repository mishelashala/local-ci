import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readBranchSha } from './git-repo.ts';
import { logs, repositories, runs } from './schema.ts';

const dataDir = process.env.LOCAL_CI_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, 'ci.sqlite'));
sqlite.pragma('journal_mode = WAL');
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bare_path TEXT NOT NULL,
    origin TEXT,
    created_at INTEGER NOT NULL
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    ref TEXT NOT NULL,
    branch TEXT NOT NULL,
    old_sha TEXT NOT NULL,
    new_sha TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    workflow TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

for (const statement of [
  `ALTER TABLE runs ADD COLUMN started_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN finished_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN exit_code INTEGER`,
  `ALTER TABLE runs ADD COLUMN base_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN head_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN candidate_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN target TEXT`,
  `ALTER TABLE runs ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN integrated_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN task_id TEXT`,
]) {
  try {
    sqlite.exec(statement);
  } catch {
    // Column already exists.
  }
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    line TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
try {
  sqlite.exec(`ALTER TABLE logs ADD COLUMN workflow_path TEXT`);
} catch {
  /* already present */
}

sqlite.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  PRIMARY KEY (run_id, path)
)`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    repository TEXT PRIMARY KEY,
    main_sha TEXT NOT NULL,
    develop_sha TEXT NOT NULL,
    github_develop_sha TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

sqlite.exec(`CREATE TABLE IF NOT EXISTS integration_control (
  repository TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  develop_sha TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
)`);

sqlite
  .prepare(`UPDATE runs SET status = 'failed', exit_code = 1, finished_at = ? WHERE status = 'running'`)
  .run(Date.now());

export const db = drizzle(sqlite);

export type CandidateInput = {
  repository: string;
  ref: string;
  oldSha: string;
  newSha: string;
  baseSha: string | null;
  headSha: string | null;
  candidateSha: string | null;
  target?: 'develop' | 'main' | 'reconcile' | 'post-merge' | 'smoke';
  status: 'queued' | 'failed';
  logLine?: string;
  taskId?: string | null;
};

function staleCandidates(repository: string, developSha: string | null, mainSha: string | null) {
  if (developSha === null) {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE repository = ? AND trigger = 'candidate'
           AND (target IS NULL OR target = 'develop')
           AND status IN ('queued', 'passed') AND integrated_at IS NULL
           AND base_sha IS NOT NULL`,
      )
      .run(repository);
  } else {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE repository = ? AND trigger = 'candidate'
           AND (target IS NULL OR target = 'develop')
           AND status IN ('queued', 'passed') AND integrated_at IS NULL
           AND base_sha IS NOT ?
           AND NOT (status = 'passed' AND candidate_sha IS ?)`,
      )
      .run(repository, developSha, developSha);
  }

  if (mainSha === null || developSha === null) {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE repository = ? AND trigger = 'candidate' AND target = 'main' AND status IN ('queued', 'passed')`,
      )
      .run(repository);
    return;
  }

  sqlite
    .prepare(
      `UPDATE runs SET status = 'stale'
       WHERE repository = ? AND trigger = 'candidate'
         AND target = 'main'
         AND status IN ('queued', 'passed')
         AND (base_sha IS NOT ? OR head_sha IS NOT ?)
         AND NOT (status = 'passed' AND candidate_sha IS ?)`,
    )
    .run(repository, mainSha, developSha, mainSha);
}

export function recordCandidate(input: CandidateInput) {
  const branch = input.ref.replace(/^refs\/heads\//, '');
  const now = Date.now();
  const failed = input.status === 'failed';
  const row = {
    id: `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    repository: input.repository,
    ref: input.ref,
    branch,
    oldSha: input.oldSha,
    newSha: input.newSha,
    status: input.status,
    trigger: 'candidate',
    workflow: '.github/workflows/* (pull_request)',
    createdAt: now,
    startedAt: null,
    finishedAt: failed ? now : null,
    exitCode: failed ? 1 : null,
    baseSha: input.baseSha,
    headSha: input.headSha,
    candidateSha: input.candidateSha,
    target: input.target ?? 'develop',
    autoMerge: input.target === undefined || input.target === 'develop' ? 1 : 0,
    integratedAt: null,
    taskId: input.taskId ?? null,
  };
  const target = row.target;
  const write = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE trigger = 'candidate' AND status IN ('queued', 'passed') AND integrated_at IS NULL AND branch = ? AND repository = ?
           AND (target = ? OR (? = 'develop' AND target IS NULL))`,
      )
      .run(branch, input.repository, target, target);
    db.insert(runs).values(row).run();
    if (input.logLine) appendLog(row.id, input.logLine);
  });
  write();
  return getRun(row.id) ?? row;
}

export function markRunStale(id: string) {
  sqlite.prepare(`UPDATE runs SET status = 'stale' WHERE id = ? AND status IN ('queued', 'passed')`).run(id);
}

export function retireCandidate(id: string, line: string) {
  sqlite.prepare(`UPDATE runs SET status = 'stale', auto_merge = 0 WHERE id = ?`).run(id);
  appendLog(id, line);
}

export function integrationControl(repository: string) {
  return sqlite
    .prepare(`SELECT mode, develop_sha AS developSha, reason FROM integration_control WHERE repository = ?`)
    .get(repository) as { mode: 'frozen' | 'blocked'; developSha: string | null; reason: string | null } | undefined;
}

export function setIntegrationControl(
  repository: string,
  mode: 'frozen' | 'blocked',
  developSha: string | null,
  reason: string,
) {
  sqlite
    .prepare(`INSERT INTO integration_control (repository, mode, develop_sha, reason, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository) DO UPDATE SET mode=excluded.mode, develop_sha=excluded.develop_sha, reason=excluded.reason, created_at=excluded.created_at`)
    .run(repository, mode, developSha, reason, Date.now());
}

export function clearIntegrationControl(repository: string) {
  sqlite.prepare(`DELETE FROM integration_control WHERE repository = ?`).run(repository);
}

export function markIntegrated(id: string) {
  sqlite.prepare(`UPDATE runs SET integrated_at = ? WHERE id = ? AND status = 'passed'`).run(Date.now(), id);
}

export function markDefective(repository: string, sha: string) {
  sqlite
    .prepare(`UPDATE runs SET status = 'failed', integrated_at = NULL, auto_merge = 0
    WHERE repository = ? AND target = 'develop' AND candidate_sha = ? AND integrated_at IS NOT NULL`)
    .run(repository, sha);
}

export function pendingIntegration() {
  return sqlite
    .prepare(`SELECT r.id FROM runs r LEFT JOIN integration_control c ON c.repository = r.repository
    WHERE r.status = 'passed' AND r.auto_merge = 1 AND r.integrated_at IS NULL AND c.mode IS NULL
    ORDER BY r.created_at ASC, r.id ASC LIMIT 1`)
    .get() as { id: string } | undefined;
}

export function interruptedSmoke() {
  return sqlite
    .prepare(`SELECT r.id, r.status FROM runs r JOIN integration_control c ON c.repository = r.repository
    WHERE r.target = 'smoke' AND r.status IN ('passed', 'failed') AND c.mode = 'frozen'
      AND c.develop_sha = r.candidate_sha ORDER BY r.created_at DESC LIMIT 1`)
    .get() as { id: string; status: 'passed' | 'failed' } | undefined;
}

export function interruptedPromotionValidation() {
  return sqlite
    .prepare(`SELECT c.repository FROM integration_control c JOIN runs r ON r.repository = c.repository
    WHERE c.mode = 'frozen' AND c.reason = 'Validating develop for promotion'
      AND r.target = 'main' AND r.status = 'failed'
      AND r.head_sha = c.develop_sha
      AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.repository = r.repository AND newer.target = 'main'
        AND newer.created_at > r.created_at AND newer.status IN ('queued', 'running', 'passed'))
      ORDER BY r.created_at DESC LIMIT 1`)
    .get() as { repository: string } | undefined;
}

export function staleOrQueuedCandidates() {
  return sqlite
    .prepare(`SELECT r.id FROM runs r LEFT JOIN integration_control c ON c.repository = r.repository
    WHERE r.auto_merge = 1 AND r.target = 'develop' AND r.status IN ('queued', 'stale') AND c.mode IS NULL
    AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.repository = r.repository AND newer.branch = r.branch
      AND newer.auto_merge = 1 AND newer.created_at > r.created_at AND newer.status != 'stale')
    ORDER BY r.created_at ASC, r.id ASC`)
    .all() as { id: string }[];
}

export function hasPassedCandidate(repository: string, sha: string) {
  const row = sqlite
    .prepare(
      `SELECT id FROM runs
       WHERE repository = ? AND status = 'passed' AND trigger = 'candidate' AND candidate_sha = ?
         AND ((target = 'develop' AND integrated_at IS NOT NULL) OR target = 'reconcile')
       LIMIT 1`,
    )
    .get(repository, sha) as { id: string } | undefined;
  return row !== undefined;
}

export function hasPassedPostMerge(repository: string, sha: string) {
  return Boolean(
    sqlite
      .prepare(`SELECT id FROM runs
    WHERE repository = ? AND status = 'passed' AND trigger = 'candidate'
      AND target = 'post-merge' AND candidate_sha = ? LIMIT 1`)
      .get(repository, sha),
  );
}

export function findPassedMain(repository: string, mainSha: string, developSha: string): string | undefined {
  const row = sqlite
    .prepare(
      `SELECT candidate_sha AS sha FROM runs
       WHERE repository = ? AND status = 'passed' AND trigger = 'candidate' AND target = 'main'
         AND base_sha = ? AND head_sha = ? AND candidate_sha IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repository, mainSha, developSha) as { sha: string } | undefined;
  return row?.sha;
}

export function listRuns() {
  return db.select().from(runs).orderBy(desc(runs.createdAt)).limit(20).all();
}

export function listRunsForRepository(repository: string) {
  return db.select().from(runs).where(eq(runs.repository, repository)).orderBy(desc(runs.createdAt)).limit(100).all();
}

export function recentRunsForRepository(repository: string) {
  return db.select().from(runs).where(eq(runs.repository, repository)).orderBy(desc(runs.createdAt)).limit(100).all();
}

export function listRepositories() {
  return db.select().from(repositories).orderBy(asc(repositories.name)).all();
}

export function getRepository(id: string) {
  return db.select().from(repositories).where(eq(repositories.id, id)).get();
}

export function saveRepository(input: { id: string; name: string; barePath: string; origin: string | null }) {
  const existing = getRepository(input.id);
  const row = { ...input, createdAt: existing?.createdAt ?? Date.now() };
  if (existing) {
    db.update(repositories)
      .set({ name: row.name, barePath: row.barePath, origin: row.origin })
      .where(eq(repositories.id, row.id))
      .run();
  } else {
    db.insert(repositories).values(row).run();
  }
  return getRepository(input.id);
}

export function activeRunIds(repository: string) {
  return sqlite
    .prepare(`SELECT id FROM runs WHERE repository = ? AND status IN ('queued', 'running')`)
    .all(repository) as { id: string }[];
}

export function deleteRepository(id: string) {
  const existing = getRepository(id);
  if (!existing) return false;
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM logs WHERE run_id IN (SELECT id FROM runs WHERE repository = ?)`).run(id);
    sqlite.prepare(`DELETE FROM workflow_runs WHERE run_id IN (SELECT id FROM runs WHERE repository = ?)`).run(id);
    sqlite.prepare(`DELETE FROM runs WHERE repository = ?`).run(id);
    sqlite.prepare(`DELETE FROM promotions WHERE repository = ?`).run(id);
    sqlite.prepare(`DELETE FROM integration_control WHERE repository = ?`).run(id);
    sqlite.prepare(`DELETE FROM repositories WHERE id = ?`).run(id);
  })();
  return true;
}

export function savePromotion(
  repository: string,
  mainSha: string,
  developSha: string,
  githubDevelopSha: string | null,
) {
  sqlite
    .prepare(`INSERT INTO promotions (repository, main_sha, develop_sha, github_develop_sha, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(repository) DO UPDATE SET main_sha=excluded.main_sha, develop_sha=excluded.develop_sha,
      github_develop_sha=excluded.github_develop_sha, status='pending', created_at=excluded.created_at`)
    .run(repository, mainSha, developSha, githubDevelopSha, Date.now());
}

export function pendingPromotion(repository: string) {
  return sqlite
    .prepare(`SELECT main_sha AS mainSha, develop_sha AS developSha, github_develop_sha AS githubDevelopSha
    FROM promotions WHERE repository = ? AND status = 'pending'`)
    .get(repository) as { mainSha: string; developSha: string; githubDevelopSha: string | null } | undefined;
}

export function finishPromotion(repository: string) {
  sqlite
    .prepare(`UPDATE promotions SET status = 'completed' WHERE repository = ? AND status = 'pending'`)
    .run(repository);
}

export function getRun(id: string) {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function listWorkflows(runId: string) {
  return sqlite
    .prepare(`SELECT path, status, started_at AS startedAt, finished_at AS finishedAt,
    exit_code AS exitCode FROM workflow_runs WHERE run_id = ? ORDER BY path`)
    .all(runId) as {
    path: string;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    exitCode: number | null;
  }[];
}

export function smokeForCandidate(repository: string, sha: string) {
  return sqlite
    .prepare(`SELECT id, status FROM runs WHERE repository = ? AND target = 'smoke' AND candidate_sha = ?
    ORDER BY created_at DESC LIMIT 1`)
    .get(repository, sha) as { id: string; status: string } | undefined;
}

export function registerWorkflows(runId: string, paths: string[]) {
  const register = sqlite.prepare(`INSERT OR IGNORE INTO workflow_runs (run_id, path, status) VALUES (?, ?, 'queued')`);
  sqlite.transaction(() => {
    for (const path of paths) register.run(runId, path);
  })();
}

export function startWorkflow(runId: string, path: string) {
  sqlite
    .prepare(`UPDATE workflow_runs SET status = 'running', started_at = ? WHERE run_id = ? AND path = ?`)
    .run(Date.now(), runId, path);
}

export function finishWorkflow(runId: string, path: string, exitCode: number) {
  sqlite
    .prepare(`UPDATE workflow_runs SET status = ?, finished_at = ?, exit_code = ? WHERE run_id = ? AND path = ?`)
    .run(exitCode === 0 ? 'passed' : 'failed', Date.now(), exitCode, runId, path);
}

export function listLogLines(runId: string, workflowPath?: string): string[] {
  if (workflowPath)
    return (
      sqlite
        .prepare(`SELECT line FROM logs WHERE run_id = ? AND workflow_path = ? ORDER BY seq`)
        .all(runId, workflowPath) as { line: string }[]
    ).map((row) => row.line);
  return db
    .select()
    .from(logs)
    .where(eq(logs.runId, runId))
    .orderBy(asc(logs.seq))
    .all()
    .map((row) => row.line);
}

export function appendLog(runId: string, line: string, workflowPath?: string) {
  const current = sqlite.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM logs WHERE run_id = ?`).get(runId) as {
    n: number;
  };
  sqlite
    .prepare(`INSERT INTO logs (run_id, seq, line, created_at, workflow_path) VALUES (?, ?, ?, ?, ?)`)
    .run(runId, current.n + 1, line.slice(0, 2000), Date.now(), workflowPath ?? null);
}

export function finishRun(runId: string, status: 'passed' | 'failed' | 'canceled', exitCode: number | null) {
  db.update(runs).set({ status, exitCode, finishedAt: Date.now() }).where(eq(runs.id, runId)).run();
  sqlite
    .prepare(
      `UPDATE workflow_runs SET status = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')`,
    )
    .run(status === 'canceled' ? 'canceled' : 'failed', Date.now(), runId);
}

export function cancelQueuedRun(runId: string) {
  return (
    sqlite
      .prepare(
        `UPDATE runs SET status = 'canceled', finished_at = ?, exit_code = NULL WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), runId).changes === 1
  );
}

export function retryRun(runId: string) {
  const prior = getRun(runId);
  if (!prior || !['failed', 'canceled', 'stale'].includes(prior.status)) return undefined;
  if (!prior.candidateSha || !prior.baseSha || !prior.headSha) return undefined;
  return recordCandidate({
    repository: prior.repository,
    ref: prior.ref,
    oldSha: prior.oldSha,
    newSha: prior.candidateSha,
    baseSha: prior.baseSha,
    headSha: prior.headSha,
    candidateSha: prior.candidateSha,
    target: (prior.target ?? 'develop') as CandidateInput['target'],
    status: 'queued',
    taskId: prior.taskId,
  });
}

export function claimNextRunGlobal() {
  const claim = sqlite.transaction(() => {
    if (sqlite.prepare(`SELECT id FROM runs WHERE status = 'running' LIMIT 1`).get()) return undefined;
    for (const repository of listRepositories()) {
      // Current refs are checked by the worker before this transaction as well.
      staleCandidates(
        repository.id,
        readBranchSha(repository.barePath, 'develop'),
        readBranchSha(repository.barePath, 'main'),
      );
    }
    const next = sqlite
      .prepare(`SELECT r.id FROM runs r LEFT JOIN integration_control c ON c.repository = r.repository
      WHERE r.status = 'queued' AND (r.target != 'develop' OR c.mode IS NULL)
      ORDER BY CASE WHEN r.target = 'smoke' THEN 0 ELSE 1 END, r.created_at ASC, r.id ASC LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!next) return undefined;
    const changed = sqlite
      .prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(Date.now(), next.id);
    return changed.changes === 1 ? getRun(next.id) : undefined;
  });
  return claim();
}

export function claimNextRun(developSha: string | null, mainSha: string | null) {
  const claim = sqlite.transaction(() => {
    const firstQueued = sqlite
      .prepare(`SELECT id, repository FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as { id: string; repository: string } | undefined;
    if (!firstQueued) return undefined;
    staleCandidates(firstQueued.repository, developSha, mainSha);
    const running = sqlite.prepare(`SELECT id FROM runs WHERE status = 'running' LIMIT 1`).get();
    if (running) return undefined;
    const next = sqlite.prepare(`SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    if (!next) return undefined;
    const updated = sqlite
      .prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(Date.now(), next.id);
    if (updated.changes !== 1) return undefined;
    return getRun(next.id);
  });
  return claim();
}

export function claimNextRunForRepository(repository: string, developSha: string | null, mainSha: string | null) {
  const claim = sqlite.transaction(() => {
    staleCandidates(repository, developSha, mainSha);
    const running = sqlite.prepare(`SELECT id FROM runs WHERE status = 'running' LIMIT 1`).get();
    if (running) return undefined;
    const next = sqlite
      .prepare(`SELECT id FROM runs WHERE status = 'queued' AND repository = ? ORDER BY created_at ASC LIMIT 1`)
      .get(repository) as { id: string } | undefined;
    if (!next) return undefined;
    const updated = sqlite
      .prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(Date.now(), next.id);
    if (updated.changes !== 1) return undefined;
    return getRun(next.id);
  });
  return claim();
}
