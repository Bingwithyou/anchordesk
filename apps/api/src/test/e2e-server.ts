import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import {
  assertSafeTestDatabaseUrls,
  loadDatabaseUrls,
  type DatabaseUrls,
} from '../db/database-config.js';
import {
  FakeAnswerProvider,
  FakeEmbeddingProvider,
  type FakeAnswerResolver,
} from './fixtures.js';

export const E2E_SERVER_HOST = '127.0.0.1';
export const E2E_SERVER_PORT = 4100;

/**
 * E2E 知识文档内容。FakeEmbeddingProvider 对相同文本返回相同向量，
 * 因此提问文本等于文档全文时检索距离为 0，必被命中；
 * 知识库外问题（如“明天上海天气如何？”）的哈希向量距离远大于 0.45 门槛，
 * 必然触发 low_similarity 拒答。
 */
export const E2E_DOCUMENT_TITLE = '退款政策';
export const E2E_DOCUMENT_CONTENT =
  '退款政策：退款申请期限为 7 个自然日。退款审核通过后，金额将在 3 个工作日内退回原支付方式。人工支持服务时间为周一至周五 09:00—18:00。';

export function buildE2EAnswerResolver(): FakeAnswerResolver {
  return (question, evidence) => {
    if (evidence.length === 0) {
      throw new Error('E2E Fake 回答只在存在门槛内证据时被调用');
    }
    if (question.includes('手续费')) {
      return JSON.stringify({ answer: '', supported: false, citationRanks: [] });
    }
    const first = evidence[0];
    if (first === undefined) {
      throw new Error('E2E Fake 回答缺少首条证据');
    }
    return JSON.stringify({
      answer: `根据《${first.documentTitle}》，退款申请期限为 7 个自然日。[${first.rank}]`,
      supported: true,
      citationRanks: [first.rank],
    });
  };
}

export function createE2EApp(
  databaseUrls: DatabaseUrls = loadDatabaseUrls(),
): ReturnType<typeof buildApp> {
  assertSafeTestDatabaseUrls(databaseUrls);

  const config = {
    port: E2E_SERVER_PORT,
    webOrigin: 'http://127.0.0.1:5173',
    databaseUrl: databaseUrls.testDatabaseUrl,
    testDatabaseUrl: databaseUrls.testDatabaseUrl,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaEmbedModel: 'bge-m3',
    ollamaTimeoutMs: 30_000,
    // E2E 只使用 Fake Providers，不读取或校验真实 DeepSeek Key。
    deepseekApiKey: '',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-v4-pro',
    deepseekTimeoutMs: 60_000,
    ragTopK: 5,
    ragMaxDistance: 0.45,
    promptVersion: 'v1',
  } satisfies AppConfig;

  const providers = {
    embeddingProvider: new FakeEmbeddingProvider(),
    answerProvider: new FakeAnswerProvider(buildE2EAnswerResolver()),
  };

  return buildApp(config, providers);
}

async function main(): Promise<void> {
  const app: FastifyInstance = createE2EApp();
  await app.listen({ host: E2E_SERVER_HOST, port: E2E_SERVER_PORT });
  console.log(
    `E2E 测试 API 已启动：http://${E2E_SERVER_HOST}:${E2E_SERVER_PORT}/api/health`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`启动 E2E 测试 API 失败：${message}`);
    process.exitCode = 1;
  });
}
