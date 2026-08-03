import { describe, expect, it } from 'vitest';

import { loadEvaluationFixtures } from './fixtures.js';

describe('固定检索评测夹具', () => {
  it('包含 3 份合成知识文档和固定分布的 12 个问题', async () => {
    const fixtures = await loadEvaluationFixtures();

    expect(fixtures.documents.map((document) => document.title)).toEqual([
      '退款政策',
      '配送说明',
      '客服指南',
    ]);
    expect(fixtures.cases).toHaveLength(12);
    expect(new Set(fixtures.cases.map((item) => item.id)).size).toBe(12);
    expect(
      fixtures.cases.filter((item) => item.expectedOutcome === 'answer'),
    ).toHaveLength(6);
    expect(
      fixtures.cases.filter(
        (item) => item.expectedRefusalStage === 'generation',
      ),
    ).toHaveLength(2);
    expect(
      fixtures.cases.filter(
        (item) => item.expectedRefusalStage === 'retrieval',
      ),
    ).toHaveLength(4);
  });

  it('每个可回答用例的预期事实都存在于对应文档', async () => {
    const fixtures = await loadEvaluationFixtures();
    const contentByTitle = new Map(
      fixtures.documents.map((document) => [document.title, document.content]),
    );

    for (const evaluationCase of fixtures.cases.filter(
      (item) => item.expectedOutcome === 'answer',
    )) {
      const expectedContent = evaluationCase.expectedDocumentTitles
        .map((title) => contentByTitle.get(title) ?? '')
        .join('\n');
      expect(evaluationCase.requiredFacts.length).toBeGreaterThan(0);
      for (const fact of evaluationCase.requiredFacts) {
        expect(expectedContent).toContain(fact);
      }
    }
  });
});
