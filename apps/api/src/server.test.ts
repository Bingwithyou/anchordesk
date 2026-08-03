import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from './config.js';
import { DeepSeekAnswerProvider } from './providers/deepseek.js';
import { OllamaEmbeddingProvider } from './providers/ollama.js';
import type { Providers } from './providers/types.js';
import { createProviders, startServer } from './server.js';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const servers: Awaited<ReturnType<typeof startServer>>[] = [];

const providers = {
  embeddingProvider: {
    embedOne: async () => [],
    embedMany: async () => [],
  },
  answerProvider: {
    generate: async () => '',
  },
} satisfies Providers;

const config = {
  port: 0,
  webOrigin: 'http://127.0.0.1:5173',
  databaseUrl: 'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
  testDatabaseUrl:
    'postgres://postgres:postgres@127.0.0.1:5433/anchordesk_test',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaEmbedModel: 'bge-m3',
  ollamaTimeoutMs: 30_000,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-v4-pro',
  deepseekTimeoutMs: 60_000,
  ragTopK: 5,
  ragMaxDistance: 0.55,
  promptVersion: 'v1',
} satisfies AppConfig;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('API 真实启动边界', () => {
  it('按应用配置装配真实 Provider', () => {
    const configuredProviders = createProviders(config);

    expect(configuredProviders.embeddingProvider).toBeInstanceOf(
      OllamaEmbeddingProvider,
    );
    expect(configuredProviders.answerProvider).toBeInstanceOf(
      DeepSeekAnswerProvider,
    );
  });

  it('只在 127.0.0.1 上监听', async () => {
    const server = await startServer(config, providers);
    servers.push(server);

    expect(server.addresses()).toEqual([
      expect.objectContaining({ address: '127.0.0.1' }),
    ]);
  });

  it('缺失 DeepSeek Key 时进程在监听前明确失败', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        cwd: apiRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PORT: '4000',
          WEB_ORIGIN: config.webOrigin,
          DATABASE_URL: config.databaseUrl,
          TEST_DATABASE_URL: config.testDatabaseUrl,
          OLLAMA_BASE_URL: config.ollamaBaseUrl,
          OLLAMA_EMBED_MODEL: config.ollamaEmbedModel,
          OLLAMA_TIMEOUT_MS: String(config.ollamaTimeoutMs),
          DEEPSEEK_API_KEY: '',
          DEEPSEEK_BASE_URL: config.deepseekBaseUrl,
          DEEPSEEK_MODEL: config.deepseekModel,
          DEEPSEEK_TIMEOUT_MS: String(config.deepseekTimeoutMs),
          RAG_TOP_K: String(config.ragTopK),
          RAG_MAX_DISTANCE: String(config.ragMaxDistance),
          PROMPT_VERSION: config.promptVersion,
        },
        timeout: 10_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEEPSEEK_API_KEY');
    expect(result.stderr).not.toContain('PORT');
  });
});
