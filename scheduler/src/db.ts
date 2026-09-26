import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { asc, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { logs, runs } from './schema.ts'

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
mkdirSync(dataDir, { recursive: true })

const sqlite = new Database(join(dataDir, 'ci.sqlite'))
sqlite.pragma('journal_mode = WAL')
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
`)

for (const statement of [
  `ALTER TABLE runs ADD COLUMN started_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN finished_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN exit_code INTEGER`,
  `ALTER TABLE runs ADD COLUMN base_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN head_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN candidate_sha TEXT`,
  `ALTER TABLE runs ADD COLUMN target TEXT`,
]) {
  try {
    sqlite.exec(statement)
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
`)

sqlite.prepare(`UPDATE runs SET status = 'failed', exit_code = 1, finished_at = ? WHERE status = 'running'`).run(Date.now())

export const db = drizzle(sqlite)

export type CandidateInput = {
  repository: string
  ref: string
  oldSha: string
  newSha: string
  baseSha: string | null
  headSha: string | null
  candidateSha: string | null
  target?: 'develop' | 'main'
  status: 'queued' | 'failed'
  logLine?: string
}

function staleCandidates(developSha: string | null, mainSha: string | null) {
  if (developSha === null) {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE trigger = 'candidate'
           AND (target IS NULL OR target = 'develop')
           AND status IN ('queued', 'passed')
           AND base_sha IS NOT NULL`,
      )
      .run()
  } else {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE trigger = 'candidate'
           AND (target IS NULL OR target = 'develop')
           AND status IN ('queued', 'passed')
           AND base_sha IS NOT ?
           AND NOT (status = 'passed' AND candidate_sha IS ?)`,
      )
      .run(developSha, developSha)
  }

  if (mainSha === null || developSha === null) {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE trigger = 'candidate' AND target = 'main' AND status IN ('queued', 'passed')`,
      )
      .run()
    return
  }

  sqlite
    .prepare(
      `UPDATE runs SET status = 'stale'
       WHERE trigger = 'candidate'
         AND target = 'main'
         AND status IN ('queued', 'passed')
         AND (base_sha IS NOT ? OR head_sha IS NOT ?)
         AND NOT (status = 'passed' AND candidate_sha IS ?)`,
    )
    .run(mainSha, developSha, mainSha)
}

export function recordCandidate(input: CandidateInput) {
  const branch = input.ref.replace(/^refs\/heads\//, '')
  const now = Date.now()
  const failed = input.status === 'failed'
  const row = {
    id: `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    repository: input.repository,
    ref: input.ref,
    branch,
    oldSha: input.oldSha,
    newSha: input.newSha,
    status: input.status,
    trigger: 'candidate',
    workflow: '.github/workflows/ci.yml',
    createdAt: now,
    startedAt: null,
    finishedAt: failed ? now : null,
    exitCode: failed ? 1 : null,
    baseSha: input.baseSha,
    headSha: input.headSha,
    candidateSha: input.candidateSha,
    target: input.target ?? 'develop',
  }
  const target = row.target
  const write = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE runs SET status = 'stale'
         WHERE trigger = 'candidate' AND status = 'queued' AND branch = ? AND repository = ?
           AND (target = ? OR (? = 'develop' AND target IS NULL))`,
      )
      .run(branch, input.repository, target, target)
    db.insert(runs).values(row).run()
    if (input.logLine) appendLog(row.id, input.logLine)
  })
  write()
  return getRun(row.id) ?? row
}

export function markRunStale(id: string) {
  sqlite.prepare(`UPDATE runs SET status = 'stale' WHERE id = ? AND status IN ('queued', 'passed')`).run(id)
}

export function hasPassedCandidate(sha: string) {
  const row = sqlite
    .prepare(
      `SELECT id FROM runs
       WHERE status = 'passed' AND trigger = 'candidate' AND candidate_sha = ?
         AND (target IS NULL OR target = 'develop')
       LIMIT 1`,
    )
    .get(sha) as { id: string } | undefined
  return row !== undefined
}

export function findPassedMain(mainSha: string, developSha: string): string | undefined {
  const row = sqlite
    .prepare(
      `SELECT candidate_sha AS sha FROM runs
       WHERE status = 'passed' AND trigger = 'candidate' AND target = 'main'
         AND base_sha = ? AND head_sha = ? AND candidate_sha IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(mainSha, developSha) as { sha: string } | undefined
  return row?.sha
}

export function listRuns() {
  return db.select().from(runs).orderBy(desc(runs.createdAt)).limit(20).all()
}

export function getRun(id: string) {
  return db.select().from(runs).where(eq(runs.id, id)).get()
}

export function listLogLines(runId: string): string[] {
  return db
    .select()
    .from(logs)
    .where(eq(logs.runId, runId))
    .orderBy(asc(logs.seq))
    .all()
    .map((row) => row.line)
}

export function appendLog(runId: string, line: string) {
  const current = sqlite.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM logs WHERE run_id = ?`).get(runId) as { n: number }
  db.insert(logs)
    .values({ runId, seq: current.n + 1, line: line.slice(0, 2000), createdAt: Date.now() })
    .run()
}

export function finishRun(runId: string, status: 'passed' | 'failed' | 'canceled', exitCode: number | null) {
  db.update(runs).set({ status, exitCode, finishedAt: Date.now() }).where(eq(runs.id, runId)).run()
}

export function claimNextRun(developSha: string | null, mainSha: string | null) {
  const claim = sqlite.transaction(() => {
    staleCandidates(developSha, mainSha)
    const running = sqlite.prepare(`SELECT id FROM runs WHERE status = 'running' LIMIT 1`).get()
    if (running) return undefined
    const next = sqlite.prepare(`SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as
      | { id: string }
      | undefined
    if (!next) return undefined
    const updated = sqlite
      .prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
      .run(Date.now(), next.id)
    if (updated.changes !== 1) return undefined
    return getRun(next.id)
  })
  return claim()
}
