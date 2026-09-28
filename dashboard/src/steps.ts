export type StepState = 'running' | 'passed' | 'failed'

export type ActStep = {
  id: string
  job: string
  name: string
  status: StepState
  duration: string | null
  lines: string[]
}

const LINE = /^\[([^\]]+)\]\s*(.*)$/
const START = /^⭐\s+Run\s+(.+)$/
const END = /^(✅|❌)\s+(?:Success|Failure)\s+-\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/
const JOB_END = /^🏁\s+Job\s+(succeeded|failed)/

export function jobLabel(raw: string): string {
  const trimmed = raw.trim()
  const slash = trimmed.lastIndexOf('/')
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim()
}

export function parseActSteps(lines: string[]): ActStep[] {
  const steps: ActStep[] = []
  let current: ActStep | null = null
  const open = (job: string, name: string): ActStep => {
    if (current?.name === 'Prepare' && current.status === 'running') current.status = 'passed'
    const step: ActStep = {
      id: `${job}#${steps.length}`,
      job,
      name,
      status: 'running',
      duration: null,
      lines: [],
    }
    steps.push(step)
    current = step
    return step
  }
  for (const line of lines) {
    const parsed = LINE.exec(line)
    if (!parsed) {
      if (current) current.lines.push(line)
      continue
    }
    const job = jobLabel(parsed[1])
    const rest = parsed[2].trim()
    const started = START.exec(rest)
    if (started) {
      open(job, started[1].trim())
      continue
    }
    const ended = END.exec(rest)
    if (ended) {
      const name = ended[2].trim()
      const step = [...steps].reverse().find((item) => item.job === job && item.name === name) ?? open(job, name)
      step.status = ended[1] === '✅' ? 'passed' : 'failed'
      step.duration = ended[3] ?? null
      current = step
      continue
    }
    const jobEnded = JOB_END.exec(rest)
    if (jobEnded) {
      if (jobEnded[1] === 'failed') {
        for (const step of steps) if (step.job === job && step.status === 'running') step.status = 'failed'
      }
      continue
    }
    if (!current || current.job !== job) open(job, 'Prepare')
    current?.lines.push(line)
  }
  return steps
}

export function groupSteps(steps: ActStep[]): { job: string; status: StepState; steps: ActStep[] }[] {
  const groups: { job: string; status: StepState; steps: ActStep[] }[] = []
  for (const step of steps) {
    let group = groups.find((item) => item.job === step.job)
    if (!group) {
      group = { job: step.job, status: 'passed', steps: [] }
      groups.push(group)
    }
    group.steps.push(step)
    if (step.status === 'failed' || (step.status === 'running' && group.status !== 'failed')) group.status = step.status
  }
  return groups
}
