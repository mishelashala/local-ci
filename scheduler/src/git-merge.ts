import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SHA = /^[0-9a-fA-F]{40}$/
const CONFLICT_INFO = /^[0-7]+ [0-9a-fA-F]{40} [123]\s/

function requireSha(value: string, name: string) {
  if (!SHA.test(value)) {
    throw new Error(`${name} must be 40 hex characters`)
  }
}

function printsConflict(text: string) {
  if (text.includes('CONFLICT')) return true
  return text.split('\n').some((line) => CONFLICT_INFO.test(line))
}

function git(args: string[]) {
  return execFileAsync('git', args, { encoding: 'utf8' })
}

const BRANCH = /^[A-Za-z0-9._/-]+$/

export function mergeBranchMessage(branch: string, into: 'develop' | 'main'): string {
  if (!BRANCH.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('invalid branch name')
  }
  return `Merge branch '${branch}' into ${into}`
}

export async function createTemporaryMerge(input: {
  bareRepo: string
  baseSha: string
  headSha: string
  message: string
}): Promise<{ sha: string } | { conflict: true }> {
  requireSha(input.baseSha, 'baseSha')
  requireSha(input.headSha, 'headSha')

  if (input.baseSha === input.headSha) {
    return { sha: input.baseSha }
  }

  const gitDir = `--git-dir=${input.bareRepo}`
  let mergeStdout = ''
  try {
    const merged = await git([
      gitDir,
      'merge-tree',
      '--write-tree',
      input.baseSha,
      input.headSha,
    ])
    mergeStdout = merged.stdout
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string }
    const text = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
    if (typeof failed.code === 'number' || printsConflict(text)) {
      return { conflict: true }
    }
    throw error
  }

  if (printsConflict(mergeStdout)) return { conflict: true }

  const treeSha = mergeStdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!SHA.test(treeSha)) {
    throw new Error('merge-tree did not return a tree SHA')
  }

  const message = input.message.replace(/[\r\n]/g, ' ').trim()
  if (!message) throw new Error('merge message is empty')

  const commit = await git([
    gitDir,
    'commit-tree',
    treeSha,
    '-p',
    input.baseSha,
    '-p',
    input.headSha,
    '-m',
    message,
  ])
  const sha = commit.stdout.trim()
  if (!SHA.test(sha)) {
    throw new Error('commit-tree did not return a commit SHA')
  }
  return { sha }
}
