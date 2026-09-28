import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { dashboardDistRoot } from '../paths.ts';

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function registerDashboardRoute(app: FastifyInstance) {
  app.get('/*', async (request, reply) => {
    const requested = request.params as { '*': string };
    const relative = decodeURIComponent(requested['*'] ?? '');
    const candidate = resolve(dashboardDistRoot, relative || 'index.html');
    const safeRoot = `${resolve(dashboardDistRoot)}/`;
    const file =
      candidate.startsWith(safeRoot) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(dashboardDistRoot, 'index.html');
    if (!existsSync(file)) {
      return reply
        .code(503)
        .type('text/plain')
        .send('Dashboard is building. Start Local CI with npm run dev and try again.');
    }
    reply.type(mimeTypes[extname(file)] ?? 'application/octet-stream');
    if (extname(file) === '.html') {
      reply.header('cache-control', 'no-cache');
    }
    return reply.send(createReadStream(file));
  });
}
