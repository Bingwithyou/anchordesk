import { describe, expect, it } from 'vitest';

import { ProviderError } from './errors.js';
import { OllamaEmbeddingProvider } from './ollama.js';

function unitVector(): number[] {
  return Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
}

function secondUnitVector(): number[] {
  return Array.from({ length: 1024 }, (_, index) => (index === 1 ? 1 : 0));
}

describe('Ollama Embedding Provider', () => {
  it('通过 /api/embed 生成单条 1024 维向量并关闭静默截断', async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as unknown,
        url: String(input),
      });
      return new Response(JSON.stringify({ embeddings: [unitVector()] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    };
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: fetchImpl,
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedOne('退款期限')).resolves.toEqual(unitVector());
    expect(requests).toEqual([
      {
        body: {
          input: '退款期限',
          model: 'bge-m3',
          truncate: false,
        },
        url: 'http://127.0.0.1:11434/api/embed',
      },
    ]);
  });

  it('单条请求兼容旧响应中的 embedding 字段', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () =>
        new Response(JSON.stringify({ embedding: unitVector() }), {
          status: 200,
        }),
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedOne('配送时效')).resolves.toEqual(unitVector());
  });

  it('批量响应数量必须与输入数量一致，且错误不包含输入全文', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () =>
        new Response(JSON.stringify({ embeddings: [unitVector()] }), {
          status: 200,
        }),
      model: 'bge-m3',
      timeoutMs: 30_000,
    });
    const privateContent = '不应出现在错误中的完整文档';

    const error = await provider
      .embedMany([privateContent, '第二段'])
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'invalid_response',
      provider: 'ollama',
      statusCode: 502,
    });
    expect((error as Error).message).not.toContain(privateContent);
  });

  it('把非成功 HTTP 状态归为 502 上游错误且不读取响应正文', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () => new Response('包含敏感上游内容', { status: 500 }),
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    const error = await provider
      .embedOne('不应泄漏的输入')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'http_status',
      provider: 'ollama',
      statusCode: 502,
      upstreamStatus: 500,
    });
    expect((error as Error).message).not.toContain('敏感上游内容');
    expect((error as Error).message).not.toContain('不应泄漏的输入');
  });

  it('把连接失败归为 502 上游错误', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () => {
        throw new TypeError('底层连接细节');
      },
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    const error = await provider
      .embedOne('退款期限')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'connection',
      provider: 'ollama',
      statusCode: 502,
    });
    expect((error as Error).message).not.toContain('底层连接细节');
  });

  it('内部超时中止请求并归为 504', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error('缺少超时 signal'));
            return;
          }
          init.signal.addEventListener(
            'abort',
            () => reject(new DOMException('已中止', 'AbortError')),
            { once: true },
          );
        }),
      model: 'bge-m3',
      timeoutMs: 5,
    });

    const error = await provider
      .embedOne('退款期限')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'timeout',
      provider: 'ollama',
      statusCode: 504,
    });
  });

  it('单次批量请求按输入顺序返回等长向量数组', async () => {
    let requestBody: unknown;
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(
          JSON.stringify({ embeddings: [unitVector(), secondUnitVector()] }),
          { status: 200 },
        );
      },
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedMany(['第一段', '第二段'])).resolves.toEqual([
      unitVector(),
      secondUnitVector(),
    ]);
    expect(requestBody).toEqual({
      input: ['第一段', '第二段'],
      model: 'bge-m3',
      truncate: false,
    });
  });

  it.each([
    ['空数组', JSON.stringify({ embeddings: [] })],
    [
      '错误维度',
      JSON.stringify({ embeddings: [unitVector().slice(0, 1023)] }),
    ],
    [
      '非数字元素',
      JSON.stringify({ embeddings: [[null, ...unitVector().slice(1)]] }),
    ],
    [
      '非有限数',
      `{"embeddings":[[1e400,${unitVector().slice(1).join(',')}]]}`,
    ],
    [
      '零范数',
      JSON.stringify({ embeddings: [Array.from({ length: 1024 }, () => 0)] }),
    ],
  ])('拒绝%s向量', async (_label, responseBody) => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () => new Response(responseBody, { status: 200 }),
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedOne('测试输入')).rejects.toMatchObject({
      kind: 'invalid_response',
      provider: 'ollama',
      statusCode: 502,
    });
  });

  it('空批次直接返回空数组且不调用上游', async () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () => {
        throw new Error('不应调用');
      },
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedMany([])).resolves.toEqual([]);
  });

  it('调用方主动取消时保留取消语义而不是伪装成超时', async () => {
    const controller = new AbortController();
    const reason = new DOMException('用户取消', 'AbortError');
    controller.abort(reason);
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async () => {
        throw new Error('不应调用');
      },
      model: 'bge-m3',
      timeoutMs: 30_000,
    });

    await expect(provider.embedOne('测试输入', controller.signal)).rejects.toBe(
      reason,
    );
  });
});
