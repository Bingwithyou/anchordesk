import type { FastifyPluginCallback } from 'fastify';

export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/api/health', () => ({ status: 'ok' }));
  done();
};
