import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import {
  assertSafeTestDatabaseUrls,
  loadDatabaseUrls,
} from '../db/database-config.js';
import type {
  AnswerProvider,
  DocumentExtractionProvider,
  EmbeddingProvider,
  Providers,
} from '../providers/types.js';
import {
  FakeAnswerProvider,
  FakeEmbeddingProvider,
  FakeExtractionProvider,
} from './fixtures.js';

const databaseUrls = loadDatabaseUrls();
assertSafeTestDatabaseUrls(databaseUrls);

export const testAppConfig = {
  port: 0,
  webOrigin: 'http://127.0.0.1:5173',
  databaseUrl: databaseUrls.testDatabaseUrl,
  testDatabaseUrl: databaseUrls.testDatabaseUrl,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaEmbedModel: 'bge-m3',
  ollamaTimeoutMs: 30_000,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-v4-pro',
  deepseekTimeoutMs: 60_000,
  mineruApiUrl: null,
  mineruTimeoutMs: 300_000,
  ragTopK: 5,
  ragMaxDistance: 0.45,
  promptVersion: 'v1',
} satisfies AppConfig;

export interface TestAppOptions {
  embeddingProvider?: EmbeddingProvider;
  answerProvider?: AnswerProvider;
  extractionProvider?: DocumentExtractionProvider;
  config?: Partial<Pick<AppConfig, 'ragMaxDistance'>>;
}

export function createTestApp({
  embeddingProvider = new FakeEmbeddingProvider(),
  answerProvider = new FakeAnswerProvider(),
  extractionProvider = new FakeExtractionProvider(),
  config = {},
}: TestAppOptions = {}): ReturnType<typeof buildApp> {
  if ('databaseUrl' in config || 'testDatabaseUrl' in config) {
    throw new Error('测试 App 不允许覆盖数据库地址');
  }

  const providers = {
    embeddingProvider,
    answerProvider,
    extractionProvider,
  } satisfies Providers;
  return buildApp({ ...testAppConfig, ...config }, providers);
}
