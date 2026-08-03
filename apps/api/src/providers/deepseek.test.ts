import { describe, expect, it } from 'vitest';

import { DeepSeekAnswerProvider } from './deepseek.js';
import { ProviderError } from './errors.js';
import type { RetrievedChunk } from './types.js';

const evidence: RetrievedChunk[] = [
  {
    rank: 1,
    documentId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    documentTitle: '退款政策',
    content: '订单支付后 7 天内可以提交退款申请。',
    distance: 0.21,
  },
];

describe('DeepSeek Answer Provider', () => {
  it('发送非思考 JSON 请求并返回模型原始文本', async () => {
    let capturedHeaders: Headers | undefined;
    let capturedRequest: Record<string, unknown> | undefined;
    let capturedUrl = '';
    const rawOutput = JSON.stringify({
      answer: '退款申请需在 7 天内提交。[1]',
      supported: true,
      citationRanks: [1],
    });
    const provider = new DeepSeekAnswerProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://api.deepseek.com',
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedRequest = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            choices: [
              { finish_reason: 'stop', message: { content: rawOutput } },
            ],
          }),
          { status: 200 },
        );
      },
      model: 'deepseek-v4-pro',
      promptVersion: 'v1',
      timeoutMs: 60_000,
    });

    await expect(
      provider.generate('退款申请期限是多少？', evidence),
    ).resolves.toBe(rawOutput);
    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(capturedHeaders?.get('authorization')).toBe('Bearer test-only-key');
    expect(capturedHeaders?.get('content-type')).toBe('application/json');
    expect(capturedRequest).toMatchObject({
      max_tokens: 1024,
      model: 'deepseek-v4-pro',
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0.2,
      thinking: { type: 'disabled' },
    });
    expect(capturedRequest?.messages).toEqual([
      {
        role: 'system',
        content: expect.stringMatching(/中文.*JSON/su),
      },
      {
        role: 'user',
        content: expect.stringMatching(
          /<evidence>[\s\S]*退款政策[\s\S]*7 天[\s\S]*<question>退款申请期限是多少？<\/question>/u,
        ),
      },
    ]);
  });

  it('保留 stop 响应中的空文本，交由答案合同分类', async () => {
    const provider = new DeepSeekAnswerProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://api.deepseek.com',
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '' } }],
          }),
          { status: 200 },
        ),
      model: 'deepseek-v4-pro',
      promptVersion: 'v1',
      timeoutMs: 60_000,
    });

    await expect(provider.generate('问题', evidence)).resolves.toBe('');
  });

  it.each([
    ['choices 缺失', {}],
    ['content 为 null', { choices: [{ finish_reason: 'stop', message: { content: null } }] }],
    ['生成被截断', { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }],
    [
      '内容过滤',
      {
        choices: [
          { finish_reason: 'content_filter', message: { content: '{}' } },
        ],
      },
    ],
  ])('把%s归为无效上游响应', async (_label, responseBody) => {
    const provider = new DeepSeekAnswerProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://api.deepseek.com',
      fetch: async () =>
        new Response(JSON.stringify(responseBody), { status: 200 }),
      model: 'deepseek-v4-pro',
      promptVersion: 'v1',
      timeoutMs: 60_000,
    });

    await expect(provider.generate('问题', evidence)).rejects.toMatchObject({
      kind: 'invalid_response',
      provider: 'deepseek',
      statusCode: 502,
    });
  });

  it('非成功 HTTP 状态归为 502，且错误不泄漏 Key 或上游正文', async () => {
    const provider = new DeepSeekAnswerProvider({
      apiKey: 'should-never-appear',
      baseUrl: 'https://api.deepseek.com',
      fetch: async () => new Response('上游敏感正文', { status: 401 }),
      model: 'deepseek-v4-pro',
      promptVersion: 'v1',
      timeoutMs: 60_000,
    });

    const error = await provider
      .generate('不应泄漏的问题', evidence)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'http_status',
      provider: 'deepseek',
      statusCode: 502,
      upstreamStatus: 401,
    });
    expect((error as Error).message).not.toMatch(
      /should-never-appear|上游敏感正文|不应泄漏的问题/u,
    );
  });

  it('内部超时中止请求并归为 504', async () => {
    const provider = new DeepSeekAnswerProvider({
      apiKey: 'test-only-key',
      baseUrl: 'https://api.deepseek.com',
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('已中止', 'AbortError')),
            { once: true },
          );
        }),
      model: 'deepseek-v4-pro',
      promptVersion: 'v1',
      timeoutMs: 5,
    });

    await expect(provider.generate('问题', evidence)).rejects.toMatchObject({
      kind: 'timeout',
      provider: 'deepseek',
      statusCode: 504,
    });
  });
});
