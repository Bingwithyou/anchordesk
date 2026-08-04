import type { FastifyPluginAsync } from 'fastify';

import type { ReviewService } from '../services/review-service.js';

export interface ReviewQueueRoutesOptions {
  reviewService: ReviewService;
}

export const reviewQueueRoutes: FastifyPluginAsync<
  ReviewQueueRoutesOptions
> = async (app, { reviewService }) => {
  app.get('/api/review-queue', async () => reviewService.listReviewQueue());

  app.put<{ Params: { id: string } }>(
    '/api/review-queue/:id/resolve',
    async (request) =>
      reviewService.resolveReviewItem(request.params.id, request.body),
  );
};
