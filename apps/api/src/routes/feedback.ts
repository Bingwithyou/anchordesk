import type { FastifyPluginAsync } from 'fastify';

import type { ReviewService } from '../services/review-service.js';

export interface FeedbackRoutesOptions {
  reviewService: ReviewService;
}

export const feedbackRoutes: FastifyPluginAsync<FeedbackRoutesOptions> = async (
  app,
  { reviewService },
) => {
  app.post('/api/feedback', async (request, reply) => {
    const feedback = await reviewService.submitFeedback(request.body);
    return reply.code(201).send(feedback);
  });
};
