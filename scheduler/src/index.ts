import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { getRepository, saveRepository } from './db.ts';
import { readOrigin } from './git-repo.ts';
import { repositoryRoot } from './paths.ts';
import { registerRoutes } from './routes/register.ts';
import { startWorker } from './worker.ts';

function discoverExistingRepositories() {
  mkdirSync(repositoryRoot, { recursive: true });
  for (const entry of readdirSync(repositoryRoot)) {
    if (!entry.endsWith('.git')) {
      continue;
    }
    const id = entry.slice(0, -4);
    const path = join(repositoryRoot, entry);
    try {
      if (!statSync(join(path, 'HEAD')).isFile()) {
        continue;
      }
      const origin = readOrigin(path);
      const existing = getRepository(id);
      saveRepository({ id, name: existing?.name ?? id, barePath: path, origin });
    } catch {
      // Ignore folders that are not initialized bare repositories.
    }
  }
}

const app = Fastify({
  logger: true,
  rewriteUrl: (request) => {
    const url = request.url ?? '/';
    return url.startsWith('/api/') ? url.slice(4) : url;
  },
});

discoverExistingRepositories();
registerRoutes(app);
startWorker();

const port = Number(process.env.LOCAL_CI_PORT ?? 6001);
await app.listen({ host: process.env.LOCAL_CI_HOST ?? '127.0.0.1', port });
