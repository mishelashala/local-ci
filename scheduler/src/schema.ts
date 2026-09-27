import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  repository: text('repository').notNull(),
  ref: text('ref').notNull(),
  branch: text('branch').notNull(),
  oldSha: text('old_sha').notNull(),
  newSha: text('new_sha').notNull(),
  status: text('status').notNull(),
  trigger: text('trigger').notNull(),
  workflow: text('workflow').notNull(),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  exitCode: integer('exit_code'),
  baseSha: text('base_sha'),
  headSha: text('head_sha'),
  candidateSha: text('candidate_sha'),
  target: text('target'),
  autoMerge: integer('auto_merge').notNull().default(0),
  integratedAt: integer('integrated_at'),
  taskId: text('task_id'),
})

export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  line: text('line').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  barePath: text('bare_path').notNull(),
  origin: text('origin'),
  createdAt: integer('created_at').notNull(),
})
