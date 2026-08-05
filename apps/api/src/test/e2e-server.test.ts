import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from '../providers/types.js';
import {
  buildE2EAnswerResolver,
  createE2EApp,
  E2E_DOCUMENT_CONTENT,
  E2E_DOCUMENT_TITLE,
  E2E_SERVER_PORT,
} from './e2e-server.js';

// 单元测试不读取仓库 .env，直接注入安全的回环测试 URL。
const safeDatabaseUrls = {
  databaseUrl: 'postgres://postgres:postgres@127.0.0.1:5434/anchordesk',
  testDatabaseUrl: 'postgres://postgres:postgres@127.0.0.1:5433/anchordesk_test',
};

function makeEvidence(): RetrievedChunk[] {
  return [
    {
      rank: 1,
      documentId: 'document-1',
      chunkId: 'chunk-1',
      documentTitle: E2E_DOCUMENT_TITLE,
      content: E2E_DOCUMENT_CONTENT,
      distance: 0,
    },
  ];
}

describe('E2E 测试服务器', () => {
  it('使用测试数据库配置，且不读取真实 DeepSeek Key', async () => {
    const app = createE2EApp(safeDatabaseUrls);
    expect(app.appConfig.databaseUrl).toMatch(/_test$/u);
    expect(app.appConfig.testDatabaseUrl).toMatch(/_test$/u);
    expect(app.appConfig.deepseekApiKey).toBe('');
    expect(app.appConfig.port).toBe(E2E_SERVER_PORT);
    await app.close();
  });

  it('提供可供 Playwright 等待的健康检查', async () => {
    const app = createE2EApp(safeDatabaseUrls);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('Fake 回答是带合法引用的中文 JSON', () => {
    const resolve = buildE2EAnswerResolver();
    const parsed = JSON.parse(
      resolve(E2E_DOCUMENT_CONTENT, makeEvidence()),
    ) as {
      answer: string;
      supported: boolean;
      citationRanks: number[];
    };
    expect(parsed.supported).toBe(true);
    expect(parsed.answer).toContain('退款申请期限为 7 个自然日');
    expect(parsed.answer).toContain('[1]');
    expect(parsed.citationRanks).toEqual([1]);
  });

  it('Fake 回答对含“手续费”的问题产生生成阶段拒答', () => {
    const resolve = buildE2EAnswerResolver();
    const parsed = JSON.parse(
      resolve('申请退款会收取手续费吗？', makeEvidence()),
    ) as { answer: string; supported: boolean; citationRanks: number[] };
    expect(parsed).toEqual({ answer: '', supported: false, citationRanks: [] });
  });

  it('Fake 回答在无证据时拒绝生成，检索拒答由服务层先行处理', () => {
    const resolve = buildE2EAnswerResolver();
    expect(() => resolve('明天上海天气如何？', [])).toThrow(
      /只在存在门槛内证据时被调用/u,
    );
  });
});
