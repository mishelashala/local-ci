import Fastify from 'fastify'
import { enqueuePush, getRun, listLogLines, listRuns } from './db.ts'
import { startWorker } from './worker.ts'

const DELETED = '0000000000000000000000000000000000000000'
const SHA = /^[0-9a-f]{40}$/
const REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/

type PushBody = {
  repository?: unknown
  ref?: unknown
  oldSha?: unknown
  newSha?: unknown
}

function asPush(body: PushBody) {
  if (typeof body.repository !== 'string' || body.repository.length === 0 || body.repository.length > 80) {
    return 'repository is required'
  }
  if (typeof body.ref !== 'string' || !REF.test(body.ref)) return 'ref must be a branch'
  if (typeof body.oldSha !== 'string' || !SHA.test(body.oldSha)) return 'oldSha must be a SHA'
  if (typeof body.newSha !== 'string' || !SHA.test(body.newSha)) return 'newSha must be a SHA'
  return {
    repository: body.repository,
    ref: body.ref,
    oldSha: body.oldSha,
    newSha: body.newSha,
  }
}

const app = Fastify({ logger: true })

app.get('/health', async () => ({ ok: true }))

app.get('/runs', async () => ({ runs: listRuns() }))

app.get<{ Params: { id: string } }>('/runs/:id/logs', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  return { lines: listLogLines(run.id) }
})

app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
  const run = getRun(request.params.id)
  if (!run) return reply.code(404).send({ error: 'run not found' })
  return { run }
})

app.post('/events', async (request, reply) => {
  const parsed = asPush(request.body as PushBody)
  if (typeof parsed === 'string') return reply.code(400).send({ error: parsed })
  if (parsed.newSha === DELETED) return { ignored: 'branch delete' }
  const run = enqueuePush(parsed)
  return reply.code(201).send({ run })
})

startWorker()

const port = 3001
await app.listen({ host: '127.0.0.1', port })
