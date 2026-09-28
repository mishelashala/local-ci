import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const repositoryRoot = process.env.LOCAL_CI_REPOSITORY_ROOT ?? join(repoRoot, 'ci', 'repos');
export const schedulerRoot = join(repoRoot, 'scheduler');
export const dashboardDistRoot = join(repoRoot, 'dashboard', 'dist');
export const workRoot = join(process.env.LOCAL_CI_DATA_DIR ?? join(schedulerRoot, 'data'), 'work');
export const hookSourceRoot = join(schedulerRoot, 'hooks');

export function bareRepo(repository: string) {
  return join(repositoryRoot, `${repository}.git`);
}
