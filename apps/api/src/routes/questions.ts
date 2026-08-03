import type { FastifyPluginAsync } from 'fastify';

import type { QuestionService } from '../services/question-service.js';

export interface QuestionRoutesOptions {
  questionService: QuestionService;
}

export const questionRoutes: FastifyPluginAsync<QuestionRoutesOptions> = async (
  app,
  { questionService },
) => {
  app.post('/api/questions', async (request) =>
    questionService.askQuestion(request.body),
  );
};
