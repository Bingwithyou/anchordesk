import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadConfig,
  parseAppConfig,
  parseGenerationEvaluationConfig,
  parseRetrievalEvaluationConfig,
} from './config.js';

const validEnvironment = {
  PORT: '4000',
  WEB_ORIGIN: 'http://127.0.0.1:5173',
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
  TEST_DATABASE_URL:
    'postgres://postgres:postgres@127.0.0.1:5433/anchordesk_test',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_EMBED_MODEL: 'bge-m3',
  OLLAMA_TIMEOUT_MS: '30000',
  DEEPSEEK_API_KEY: 'test-only-key',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-v4-pro',
  DEEPSEEK_TIMEOUT_MS: '60000',
  RAG_TOP_K: '5',
  RAG_MAX_DISTANCE: '0.55',
  PROMPT_VERSION: 'v1',
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('应用配置', () => {
  it('将合法环境变量解析为带数值的 AppConfig', () => {
    expect(parseAppConfig(validEnvironment)).toEqual({
      port: 4000,
      webOrigin: 'http://127.0.0.1:5173',
      databaseUrl:
        'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
      testDatabaseUrl:
        'postgres://postgres:postgres@127.0.0.1:5433/anchordesk_test',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaEmbedModel: 'bge-m3',
      ollamaTimeoutMs: 30_000,
      deepseekApiKey: 'test-only-key',
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekModel: 'deepseek-v4-pro',
      deepseekTimeoutMs: 60_000,
      ragTopK: 5,
      ragMaxDistance: 0.55,
      promptVersion: 'v1',
    });
  });

  it.each([
    ['PORT', '70000'],
    ['WEB_ORIGIN', '不是 URL'],
    ['WEB_ORIGIN', 'https://example.com'],
    ['WEB_ORIGIN', 'http://127.0.0.1:5173/app'],
    ['DATABASE_URL', '不是 URL'],
    ['DATABASE_URL', 'file:///tmp/anchordesk'],
    [
      'DATABASE_URL',
      'postgres://postgres:postgres@192.168.1.5:5432/anchordesk',
    ],
    ['TEST_DATABASE_URL', 'https://127.0.0.1/anchordesk_test'],
    ['OLLAMA_BASE_URL', 'file:///tmp/ollama'],
    ['OLLAMA_BASE_URL', 'http://192.168.1.5:11434'],
    ['DEEPSEEK_BASE_URL', 'javascript:alert(1)'],
    ['OLLAMA_TIMEOUT_MS', 'NaN'],
    ['DEEPSEEK_TIMEOUT_MS', '-1'],
    ['RAG_TOP_K', '0'],
    ['RAG_TOP_K', '21'],
    ['RAG_MAX_DISTANCE', '-0.1'],
  ] as const)('拒绝非法的 %s', (name, value) => {
    expect(() =>
      parseAppConfig({ ...validEnvironment, [name]: value }),
    ).toThrow(name);
  });

  it('拒绝空 DeepSeek Key，且错误不回显其他密钥内容', () => {
    expect(() =>
      parseAppConfig({
        ...validEnvironment,
        DEEPSEEK_API_KEY: 'should-never-appear',
        DEEPSEEK_BASE_URL: '不是 URL',
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining('should-never-appear'),
      }),
    );

    expect(() =>
      parseAppConfig({ ...validEnvironment, DEEPSEEK_API_KEY: '   ' }),
    ).toThrow('DEEPSEEK_API_KEY');
  });

  it('从指定 env 文件加载，并让显式环境变量覆盖文件值', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anchordesk-config-'));
    temporaryDirectories.push(directory);
    const environmentFile = join(directory, '.env');
    await writeFile(
      environmentFile,
      Object.entries(validEnvironment)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );

    const config = loadConfig(
      { PORT: '4100', DEEPSEEK_API_KEY: 'environment-key' },
      environmentFile,
    );

    expect(config.port).toBe(4100);
    expect(config.deepseekApiKey).toBe('environment-key');
  });
});

describe('检索评测配置', () => {
  it('只要求数据库、Ollama 和检索参数，不要求 DeepSeek 配置', () => {
    expect(
      parseRetrievalEvaluationConfig({
        DATABASE_URL: validEnvironment.DATABASE_URL,
        TEST_DATABASE_URL: validEnvironment.TEST_DATABASE_URL,
        OLLAMA_BASE_URL: validEnvironment.OLLAMA_BASE_URL,
        OLLAMA_EMBED_MODEL: validEnvironment.OLLAMA_EMBED_MODEL,
        OLLAMA_TIMEOUT_MS: validEnvironment.OLLAMA_TIMEOUT_MS,
        RAG_TOP_K: validEnvironment.RAG_TOP_K,
        RAG_MAX_DISTANCE: validEnvironment.RAG_MAX_DISTANCE,
      }),
    ).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      testDatabaseUrl: validEnvironment.TEST_DATABASE_URL,
      ollamaBaseUrl: validEnvironment.OLLAMA_BASE_URL,
      ollamaEmbedModel: validEnvironment.OLLAMA_EMBED_MODEL,
      ollamaTimeoutMs: 30_000,
      ragTopK: 5,
      ragMaxDistance: 0.55,
    });
  });
});

describe('生成评测配置', () => {
  it('解析真实生成评测所需的数据库、Ollama 与 DeepSeek 配置', () => {
    expect(parseGenerationEvaluationConfig(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      testDatabaseUrl: validEnvironment.TEST_DATABASE_URL,
      ollamaBaseUrl: validEnvironment.OLLAMA_BASE_URL,
      ollamaEmbedModel: validEnvironment.OLLAMA_EMBED_MODEL,
      ollamaTimeoutMs: 30_000,
      ragTopK: 5,
      ragMaxDistance: 0.55,
      deepseekApiKey: 'test-only-key',
      deepseekBaseUrl: 'https://api.deepseek.com',
      deepseekModel: 'deepseek-v4-pro',
      deepseekTimeoutMs: 60_000,
      promptVersion: 'v1',
    });
  });

  it('缺少或空白 DeepSeek Key 时立即失败且错误不回显密钥内容', () => {
    expect(() =>
      parseGenerationEvaluationConfig({
        ...validEnvironment,
        DEEPSEEK_API_KEY: 'should-never-appear',
        DEEPSEEK_BASE_URL: '不是 URL',
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining('should-never-appear'),
      }),
    );

    expect(() =>
      parseGenerationEvaluationConfig({
        ...validEnvironment,
        DEEPSEEK_API_KEY: '   ',
      }),
    ).toThrow('DEEPSEEK_API_KEY');
  });

  it('只提供检索字段时因缺少 DeepSeek Key 直接失败', () => {
    expect(() =>
      parseGenerationEvaluationConfig({
        DATABASE_URL: validEnvironment.DATABASE_URL,
        TEST_DATABASE_URL: validEnvironment.TEST_DATABASE_URL,
        OLLAMA_BASE_URL: validEnvironment.OLLAMA_BASE_URL,
        OLLAMA_EMBED_MODEL: validEnvironment.OLLAMA_EMBED_MODEL,
        OLLAMA_TIMEOUT_MS: validEnvironment.OLLAMA_TIMEOUT_MS,
        RAG_TOP_K: validEnvironment.RAG_TOP_K,
        RAG_MAX_DISTANCE: validEnvironment.RAG_MAX_DISTANCE,
      }),
    ).toThrow('DEEPSEEK_API_KEY');
  });
});
