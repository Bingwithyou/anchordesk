import { describe, expect, it } from 'vitest';

import { FakeAnswerProvider, FakeEmbeddingProvider } from './fixtures.js';

describe('确定性 Fake Providers', () => {
  it('为相同文本返回相同的有限、非零 1024 维向量', async () => {
    const provider = new FakeEmbeddingProvider();

    const first = await provider.embedOne('退款期限');
    const repeated = await provider.embedOne('退款期限');
    const different = await provider.embedOne('配送时效');

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(different);
    expect(first).toHaveLength(1024);
    expect(first.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...first)).toBeGreaterThan(1e-12);
    await expect(
      provider.embedMany(['退款期限', '配送时效']),
    ).resolves.toEqual([first, different]);
  });

  it('按注入的确定性规则返回模型原始文本', async () => {
    const provider = new FakeAnswerProvider((question, evidence) =>
      JSON.stringify({
        answer: `${question}：[${evidence[0]?.rank ?? 0}]`,
        supported: evidence.length > 0,
        citationRanks: evidence.map((item) => item.rank),
      }),
    );

    await expect(
      provider.generate('退款期限', [
        {
          rank: 1,
          documentId: 'document-id',
          chunkId: 'chunk-id',
          documentTitle: '退款政策',
          content: '7 天内可以申请退款。',
          distance: 0.2,
        },
      ]),
    ).resolves.toBe(
      JSON.stringify({
        answer: '退款期限：[1]',
        supported: true,
        citationRanks: [1],
      }),
    );
  });
});
