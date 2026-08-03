import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { DeepSeekAnswerProvider } from './providers/deepseek.js';
import { OllamaEmbeddingProvider } from './providers/ollama.js';
import type { Providers } from './providers/types.js';

const apiHost = '127.0.0.1';

export function createProviders(config: AppConfig): Providers {
  return {
    embeddingProvider: new OllamaEmbeddingProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaEmbedModel,
      timeoutMs: config.ollamaTimeoutMs,
    }),
    answerProvider: new DeepSeekAnswerProvider({
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      promptVersion: config.promptVersion,
      timeoutMs: config.deepseekTimeoutMs,
    }),
  };
}

export async function startServer(
  config: AppConfig,
  providers: Providers,
): Promise<FastifyInstance> {
  const app = buildApp(config, providers);

  try {
    await app.listen({ host: apiHost, port: config.port });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await startServer(config, createProviders(config));
  console.log(`AnchorDesk API 已启动：http://${apiHost}:${config.port}`);
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`API 启动失败：${message}`);
    process.exitCode = 1;
  });
}
