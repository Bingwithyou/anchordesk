import { describe, expect, it } from 'vitest';

import { fetchProviderJson } from './http.js';

function responseWithPendingJson(signal: AbortSignal | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('已中止', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('已中止', 'AbortError')),
          { once: true },
        );
      }),
  } as unknown as Response;
}

describe('Provider HTTP 边界', () => {
  it('响应正文读取阶段超时仍归为 504', async () => {
    await expect(
      fetchProviderJson({
        fetch: async (_input, init) => responseWithPendingJson(init?.signal),
        init: { method: 'POST' },
        provider: 'ollama',
        timeoutMs: 5,
        url: 'http://127.0.0.1:11434/api/embed',
      }),
    ).rejects.toMatchObject({
      kind: 'timeout',
      provider: 'ollama',
      statusCode: 504,
    });
  });

  it('响应正文读取阶段由调用方取消时保留原始取消原因', async () => {
    const controller = new AbortController();
    const reason = new DOMException('用户取消', 'AbortError');
    const request = fetchProviderJson({
      fetch: async (_input, init) => responseWithPendingJson(init?.signal),
      init: { method: 'POST' },
      provider: 'deepseek',
      signal: controller.signal,
      timeoutMs: 30_000,
      url: 'https://api.deepseek.com/chat/completions',
    });

    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });
});
