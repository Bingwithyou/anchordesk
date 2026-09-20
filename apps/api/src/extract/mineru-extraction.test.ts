import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MinerUExtractionProvider,
  parseFileParseResponse,
} from './mineru-extraction.js';

interface MockMineru {
  url: string;
  close: () => Promise<void>;
}

async function startMockMineru(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<MockMineru> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const openMocks: MockMineru[] = [];

afterEach(async () => {
  await Promise.all(openMocks.splice(0).map((mock) => mock.close()));
});

const pdfFile = {
  filename: '测试文档.PDF',
  data: Buffer.from('标志性 PDF 字节', 'utf8'),
};

describe('MinerUExtractionProvider', () => {
  it('成功解析 /file_parse 响应并携带页数，扩展名发送前小写化', async () => {
    const mock = await startMockMineru((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const includes = (text: string): boolean =>
          body.includes(Buffer.from(text, 'utf8'));
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/file_parse');
        expect(includes('return_md')).toBe(true);
        expect(includes('response_format_zip')).toBe(true);
        expect(includes('测试文档.pdf')).toBe(true);
        expect(includes('测试文档.PDF')).toBe(false);
        expect(includes('标志性 PDF 字节')).toBe(true);
        respondJson(response, 200, {
          status: 'completed',
          backend: 'pipeline',
          version: '3.4.4',
          results: {
            '测试文档': { md_content: '## 标题\n\n正文内容', pages: 3 },
          },
        });
      });
    });
    openMocks.push(mock);
    const provider = new MinerUExtractionProvider({
      baseUrl: mock.url,
      timeoutMs: 5_000,
    });

    const result = await provider.extract(pdfFile);

    expect(result).toEqual({ text: '## 标题\n\n正文内容', pageCount: 3 });
  });

  it('服务未启动时报 502 连接失败', async () => {
    const mock = await startMockMineru(() => undefined);
    await mock.close();
    const provider = new MinerUExtractionProvider({
      baseUrl: mock.url,
      timeoutMs: 1_000,
    });

    await expect(provider.extract(pdfFile)).rejects.toThrowError(
      expect.objectContaining({
        provider: 'mineru',
        kind: 'connection',
        statusCode: 502,
      }),
    );
  });

  it('超过超时时间未响应时报 504', async () => {
    const mock = await startMockMineru(() => undefined);
    openMocks.push(mock);
    const provider = new MinerUExtractionProvider({
      baseUrl: mock.url,
      timeoutMs: 100,
    });

    await expect(provider.extract(pdfFile)).rejects.toThrowError(
      expect.objectContaining({
        provider: 'mineru',
        kind: 'timeout',
        statusCode: 504,
      }),
    );
  });

  it('上游解析失败（409）与服务器异常（500）都映射为 502', async () => {
    const mock = await startMockMineru((_request, response) => {
      respondJson(response, 409, { detail: 'failed' });
    });
    openMocks.push(mock);
    const provider = new MinerUExtractionProvider({
      baseUrl: mock.url,
      timeoutMs: 5_000,
    });

    await expect(provider.extract(pdfFile)).rejects.toThrowError(
      expect.objectContaining({
        provider: 'mineru',
        kind: 'http_status',
        statusCode: 502,
        upstreamStatus: 409,
      }),
    );
  });

  it('响应不是合法 JSON 时报 502 invalid_response', async () => {
    const mock = await startMockMineru((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('不是 JSON');
    });
    openMocks.push(mock);
    const provider = new MinerUExtractionProvider({
      baseUrl: mock.url,
      timeoutMs: 5_000,
    });

    await expect(provider.extract(pdfFile)).rejects.toThrowError(
      expect.objectContaining({
        provider: 'mineru',
        kind: 'invalid_response',
        statusCode: 502,
      }),
    );
  });

  it('用户取消时原样抛出 AbortError', async () => {
    const provider = new MinerUExtractionProvider({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 5_000,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.extract(pdfFile, controller.signal)).rejects.toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});

describe('parseFileParseResponse', () => {
  const validPayload = {
    status: 'completed',
    results: { 文档: { md_content: '正文' } },
  };

  it('提取 md_content，无页数字段时省略 pageCount', () => {
    expect(parseFileParseResponse(validPayload)).toEqual({ text: '正文' });
  });

  it('兼容 pages 与 page_count 两种页数字段', () => {
    expect(
      parseFileParseResponse({
        status: 'completed',
        results: { 文档: { md_content: '正文', page_count: 2 } },
      }),
    ).toEqual({ text: '正文', pageCount: 2 });
  });

  it.each([
    ['非对象', '文本'],
    ['status 非 completed', { status: 'failed', results: {} }],
    ['results 缺失', { status: 'completed' }],
    ['results 无 md_content', { status: 'completed', results: { 文档: {} } }],
  ])('%s时报 invalid_response', (_label, payload) => {
    expect(() => parseFileParseResponse(payload)).toThrowError(
      expect.objectContaining({
        provider: 'mineru',
        kind: 'invalid_response',
        statusCode: 502,
      }),
    );
  });
});
