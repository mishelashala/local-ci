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

export const db = drizzle(sqlite)

export type PushInput = {
  repository: string
  ref: string
  oldSha: string
  newSha: string
}

export function enqueuePush(input: PushInput) {
  const branch = input.ref.replace(/^refs\/heads\//, '')
  const row = {
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    repository: input.repository,
    ref: input.ref,
    branch,
    oldSha: input.oldSha,
    newSha: input.newSha,
    status: 'queued',
    trigger: 'push',
    workflow: '.github/workflows/ci.yml',
    createdAt: Date.now(),
  }
  db.insert(runs).values(row).run()
  return row
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

export function claimNextRun() {
  const claim = sqlite.transaction(() => {
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
