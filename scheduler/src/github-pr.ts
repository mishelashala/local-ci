import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function githubSlug(origin: string): string | null {
  const match = origin.match(/github\.com[:/]([^/]+\/[^/#]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

export async function openDevelopPullRequest(slug: string): Promise<{ url: string } | { error: string }> {
  try {
    const listed = await execFileAsync(
      'gh',
      ['pr', 'list', '--repo', slug, '--base', 'main', '--head', 'develop', '--state', 'open', '--json', 'url'],
      { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    const existing = JSON.parse(listed.stdout) as { url?: string }[];
    const url = existing.find((item) => typeof item.url === 'string')?.url;
    if (url) {
      return { url };
    }
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    const stderr = typeof failed.stderr === 'string' ? failed.stderr.trim() : '';
    return { error: stderr || failed.message || 'could not list pull requests' };
  }
  try {
    const created = await execFileAsync(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        slug,
        '--base',
        'main',
        '--head',
        'develop',
        '--title',
        'develop → main',
        '--body',
        'Opened by local CI. GitHub runs the tests.',
      ],
      { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    const url = created.stdout.trim();
    if (!url) {
      return { error: 'gh did not return a pull request URL' };
    }
    return { url };
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    const stderr = typeof failed.stderr === 'string' ? failed.stderr.trim() : '';
    return { error: stderr || failed.message || 'could not open the pull request' };
  }
}
