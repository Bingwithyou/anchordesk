import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import type { Providers } from './providers/types.js';

const config = {
  port: 4000,
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

const providers = {
  embeddingProvider: {
    embedOne: async () => {
      throw new Error('health 不应调用 Embedding Provider');
    },
    embedMany: async () => {
      throw new Error('health 不应调用 Embedding Provider');
    },
  },
  answerProvider: {
    generate: async () => {
      throw new Error('health 不应调用 Answer Provider');
    },
  },
  extractionProvider: {
    extract: async () => {
      throw new Error('health 不应调用 Extraction Provider');
    },
  },
} satisfies Providers;

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createTestApp(): ReturnType<typeof buildApp> {
  const app = buildApp(config, providers);
  apps.push(app);
  return app;
}

describe('API 应用壳', () => {
  it('无需监听端口或真实密钥即可 inject 健康检查', async () => {
    const response = await createTestApp().inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('只为配置的 Web Origin 返回 CORS 许可', async () => {
    const app = createTestApp();
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: config.webOrigin },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:9999' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe(
      config.webOrigin,
    );
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect(allowed.headers['access-control-allow-origin']).not.toBe('*');
  });
});
