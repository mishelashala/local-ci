import type { FastifyInstance } from 'fastify';
import { sampleUsage } from '../usage.ts';

export function registerUsageRoute(app: FastifyInstance) {
  app.get('/usage', async () => sampleUsage());
}
