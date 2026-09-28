import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('delete removes a repository from the list and disk', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-remove-'));
  const repos = join(root, 'repos');
  const bare = join(repos, 'demo.git');
  const port = 41000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  mkdirSync(repos);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const server = spawn('node', ['--import', './scheduler/node_modules/tsx/dist/loader.mjs', 'scheduler/src/index.ts'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      LOCAL_CI_REPOSITORY_ROOT: repos,
      LOCAL_CI_DATA_DIR: join(root, 'data'),
      LOCAL_CI_PORT: String(port),
    },
    stdio: 'ignore',
  });
  try {
    for (let n = 0; n < 50; n++) {
      if (
        await fetch(`${base}/api/health`)
          .then((response) => response.ok)
          .catch(() => false)
      )
        break;
      if (n === 49) assert.fail('server did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const listed = (await (await fetch(`${base}/api/repositories`)).json()) as { repositories: { id: string }[] };
    assert.deepEqual(
      listed.repositories.map((repository) => repository.id),
      ['demo'],
    );
    const removed = await fetch(`${base}/api/repositories/demo`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: 'demo' });
    assert.equal(existsSync(bare), false);
    const after = (await (await fetch(`${base}/api/repositories`)).json()) as { repositories: unknown[] };
    assert.deepEqual(after.repositories, []);
    assert.equal((await fetch(`${base}/api/repositories/demo`, { method: 'DELETE' })).status, 404);
  } finally {
    server.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
