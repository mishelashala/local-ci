import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const bareRepo = join(repoRoot, 'ci', 'repos', 'sample-app.git')
export const workRoot = join(repoRoot, 'scheduler', 'data', 'work')
