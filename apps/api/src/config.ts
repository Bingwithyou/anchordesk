import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';
import { z } from 'zod';

export interface AppConfig {
  port: number;
  webOrigin: string;
  databaseUrl: string;
  testDatabaseUrl: string;
  ollamaBaseUrl: string;
  ollamaEmbedModel: string;
  ollamaTimeoutMs: number;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekTimeoutMs: number;
  ragTopK: number;
  ragMaxDistance: number;
  promptVersion: string;
}

export interface RetrievalEvaluationConfig {
  databaseUrl: string;
  testDatabaseUrl: string;
  ollamaBaseUrl: string;
  ollamaEmbedModel: string;
  ollamaTimeoutMs: number;
  ragTopK: number;
  ragMaxDistance: number;
}

export type AppEnvironment = Readonly<Record<string, string | undefined>>;

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export const rootEnvironmentFile = resolve(repositoryRoot, '.env');

const requiredText = z.string().trim().min(1, '不能为空');
const absoluteUrl = z
  .string()
  .trim()
  .min(1, '不能为空')
  .url('必须是有效 URL');
const loopbackHostnames = new Set(['127.0.0.1', '::1', 'localhost']);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(value: string): boolean {
  const hostname = parseUrl(value)?.hostname
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
  return hostname !== undefined && loopbackHostnames.has(hostname);
}

function usesProtocol(value: string, protocols: Set<string>): boolean {
  const protocol = parseUrl(value)?.protocol;
  return protocol !== undefined && protocols.has(protocol);
}

const httpProtocols = new Set(['http:', 'https:']);
const postgresProtocols = new Set(['postgres:', 'postgresql:']);
const httpUrl = absoluteUrl.refine(
  (value) => usesProtocol(value, httpProtocols),
  '协议必须是 http 或 https',
);
const localHttpUrl = httpUrl.refine(
  isLoopbackUrl,
  '主机必须是回环地址',
);
const databaseUrl = absoluteUrl
  .refine(
    (value) => usesProtocol(value, postgresProtocols),
    '协议必须是 postgres 或 postgresql',
  )
  .refine(isLoopbackUrl, '主机必须是回环地址');
const webOrigin = localHttpUrl
  .refine((value) => {
    const parsed = parseUrl(value);
    return (
      parsed !== undefined &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  }, '必须是不含凭据、路径、查询或片段的 Origin')
  .transform((value) => parseUrl(value)?.origin ?? value);
const numberFromText = requiredText.transform((value) => Number(value));
const positiveIntegerNumber = z
  .number({ error: '必须是有效数字' })
  .int('必须是整数')
  .positive('必须大于 0');
const positiveInteger = numberFromText.pipe(positiveIntegerNumber);

const environmentSchema = z.object({
  PORT: numberFromText.pipe(
    positiveIntegerNumber.max(65_535, '不能大于 65535'),
  ),
  WEB_ORIGIN: webOrigin,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  OLLAMA_BASE_URL: localHttpUrl,
  OLLAMA_EMBED_MODEL: requiredText,
  OLLAMA_TIMEOUT_MS: positiveInteger,
  DEEPSEEK_API_KEY: requiredText,
  DEEPSEEK_BASE_URL: httpUrl,
  DEEPSEEK_MODEL: requiredText,
  DEEPSEEK_TIMEOUT_MS: positiveInteger,
  RAG_TOP_K: numberFromText.pipe(
    positiveIntegerNumber.max(20, '不能大于 20'),
  ),
  RAG_MAX_DISTANCE: numberFromText.pipe(
    z
      .number({ error: '必须是有效数字' })
      .finite('必须是有限数字')
      .nonnegative('不能为负数'),
  ),
  PROMPT_VERSION: requiredText,
});

const retrievalEvaluationEnvironmentSchema = environmentSchema.pick({
  DATABASE_URL: true,
  TEST_DATABASE_URL: true,
  OLLAMA_BASE_URL: true,
  OLLAMA_EMBED_MODEL: true,
  OLLAMA_TIMEOUT_MS: true,
  RAG_TOP_K: true,
  RAG_MAX_DISTANCE: true,
});

export class ConfigurationError extends Error {
  constructor(details: string[]) {
    super(`配置无效：${details.join('；')}`);
    this.name = 'ConfigurationError';
  }
}

function configurationError(error: z.ZodError): ConfigurationError {
  const details = error.issues.map((issue) => {
    const variable = issue.path[0];
    const name = typeof variable === 'string' ? variable : '未知配置';
    return `${name} ${issue.message}`;
  });
  return new ConfigurationError([...new Set(details)]);
}

function mergeEnvironment(
  environment: AppEnvironment,
  environmentFile: string,
): AppEnvironment {
  const fileEnvironment = existsSync(environmentFile)
    ? parse(readFileSync(environmentFile))
    : {};
  const definedEnvironment = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] =>
      entry[1] !== undefined,
    ),
  );

  return { ...fileEnvironment, ...definedEnvironment };
}

export function parseAppConfig(environment: AppEnvironment): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw configurationError(parsed.error);
  }

  return {
    port: parsed.data.PORT,
    webOrigin: parsed.data.WEB_ORIGIN,
    databaseUrl: parsed.data.DATABASE_URL,
    testDatabaseUrl: parsed.data.TEST_DATABASE_URL,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaEmbedModel: parsed.data.OLLAMA_EMBED_MODEL,
    ollamaTimeoutMs: parsed.data.OLLAMA_TIMEOUT_MS,
    deepseekApiKey: parsed.data.DEEPSEEK_API_KEY,
    deepseekBaseUrl: parsed.data.DEEPSEEK_BASE_URL,
    deepseekModel: parsed.data.DEEPSEEK_MODEL,
    deepseekTimeoutMs: parsed.data.DEEPSEEK_TIMEOUT_MS,
    ragTopK: parsed.data.RAG_TOP_K,
    ragMaxDistance: parsed.data.RAG_MAX_DISTANCE,
    promptVersion: parsed.data.PROMPT_VERSION,
  };
}

export function parseRetrievalEvaluationConfig(
  environment: AppEnvironment,
): RetrievalEvaluationConfig {
  const parsed = retrievalEvaluationEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw configurationError(parsed.error);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    testDatabaseUrl: parsed.data.TEST_DATABASE_URL,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaEmbedModel: parsed.data.OLLAMA_EMBED_MODEL,
    ollamaTimeoutMs: parsed.data.OLLAMA_TIMEOUT_MS,
    ragTopK: parsed.data.RAG_TOP_K,
    ragMaxDistance: parsed.data.RAG_MAX_DISTANCE,
  };
}

export function loadConfig(
  environment: AppEnvironment = process.env,
  environmentFile = rootEnvironmentFile,
): AppConfig {
  return parseAppConfig(mergeEnvironment(environment, environmentFile));
}

export function loadRetrievalEvaluationConfig(
  environment: AppEnvironment = process.env,
  environmentFile = rootEnvironmentFile,
): RetrievalEvaluationConfig {
  return parseRetrievalEvaluationConfig(
    mergeEnvironment(environment, environmentFile),
  );
}
