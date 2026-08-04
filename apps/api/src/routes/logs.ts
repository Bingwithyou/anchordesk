import type { FastifyPluginAsync } from 'fastify';

import {
  ReviewServiceError,
  type ReviewService,
} from '../services/review-service.js';

export interface LogRoutesOptions {
  reviewService: ReviewService;
}

export const logRoutes: FastifyPluginAsync<LogRoutesOptions> = async (
  app,
  { reviewService },
) => {
  app.get('/api/logs', async () => reviewService.listLogs());

  app.get<{ Params: { id: string } }>('/api/logs/:id', async (request) => {
    const log = await reviewService.getLog(request.params.id);
    if (!log) {
      throw new ReviewServiceError('log_not_found');
    }
    return log;
  });
};
