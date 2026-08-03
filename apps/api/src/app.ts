import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig } from './config.js';
import { createDatabasePool } from './db/pool.js';
import { ProviderError } from './providers/errors.js';
import type { Providers } from './providers/types.js';
import { documentRoutes } from './routes/documents.js';
import { healthRoutes } from './routes/health.js';
import { questionRoutes } from './routes/questions.js';
import {
  createDocumentService,
  DocumentServiceError,
} from './services/document-service.js';
import {
  createQuestionService,
  QuestionServiceError,
} from './services/question-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    providers: Providers;
  }
}

function getClientErrorStatus(error: unknown): number | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('statusCode' in error) ||
    typeof error.statusCode !== 'number'
  ) {
    return undefined;
  }
  return error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : undefined;
}

export function buildApp(
  config: AppConfig,
  providers: Providers,
  database: Pool = createDatabasePool(config.databaseUrl),
): FastifyInstance {
  const app = Fastify();
  const documentService = createDocumentService({
    database,
    embeddingProvider: providers.embeddingProvider,
  });
  const questionService = createQuestionService({
    database,
    embeddingProvider: providers.embeddingProvider,
    answerProvider: providers.answerProvider,
    ragTopK: config.ragTopK,
    ragMaxDistance: config.ragMaxDistance,
    embeddingModel: config.ollamaEmbedModel,
    answerModel: config.deepseekModel,
    promptVersion: config.promptVersion,
  });

  app.decorate('appConfig', config);
  app.decorate('providers', providers);
  app.addHook('onClose', async () => {
    await database.end();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DocumentServiceError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof QuestionServiceError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof ProviderError) {
      request.log.error(
        { provider: error.provider, kind: error.kind },
        error.message,
      );
      return reply.code(error.statusCode).send({
        code: error.kind === 'timeout' ? 'provider_timeout' : 'provider_error',
        message: error.message,
      });
    }
    const clientErrorStatus = getClientErrorStatus(error);
    if (clientErrorStatus !== undefined) {
      return reply.code(clientErrorStatus).send({
        code: 'invalid_request',
        message: '请求数据不合法',
      });
    }

    request.log.error(error);
    return reply.code(500).send({
      code: 'internal_error',
      message: '服务器内部错误',
    });
  });
  app.register(cors, {
    origin(origin, callback) {
      callback(null, origin === undefined || origin === config.webOrigin);
    },
  });
  app.register(healthRoutes);
  app.register(documentRoutes, { documentService });
  app.register(questionRoutes, { questionService });

  return app;
}
