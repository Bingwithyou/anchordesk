import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from '../providers/types.js';
import type { EvaluationCase } from './fixtures.js';
import { evaluateRetrievalCase } from './retrieval-evaluator.js';

function candidate(
  documentTitle: string,
  rank: number,
  distance: number,
): RetrievedChunk {
  return {
    rank,
    documentId: `document-${rank}`,
    chunkId: `chunk-${rank}`,
    documentTitle,
    content: '不会进入评测报告的 chunk 全文',
    distance,
  };
}

const answerCase = {
  id: 'answer-case',
  question: '退款期限是多少？',
  expectedOutcome: 'answer',
  expectedRefusalStage: null,
  expectedDocumentTitles: ['退款政策'],
  requiredFacts: ['7 个自然日'],
} satisfies EvaluationCase;

describe('检索评测判定', () => {
  it('答案用例只在预期文档通过门槛时通过', () => {
    const report = evaluateRetrievalCase(
      answerCase,
      {
        candidates: [
          candidate('退款政策', 1, 0.3),
          candidate('配送说明', 2, 0.7),
        ],
        evidence: [candidate('退款政策', 1, 0.3)],
      },
      0.55,
    );

    expect(report.passed).toBe(true);
    expect(report.expectedDocumentsAvailable).toBe(true);
    expect(report.candidates).toEqual([
      {
        documentTitle: '退款政策',
        rank: 1,
        distance: 0.3,
        passedThreshold: true,
      },
      {
        documentTitle: '配送说明',
        rank: 2,
        distance: 0.7,
        passedThreshold: false,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('chunk 全文');
  });

  it('检索拒答用例只在没有候选通过门槛时通过', () => {
    const retrievalRefusalCase = {
      ...answerCase,
      id: 'retrieval-refusal',
      expectedOutcome: 'refusal',
      expectedRefusalStage: 'retrieval',
      expectedDocumentTitles: [],
      requiredFacts: [],
    } satisfies EvaluationCase;

    expect(
      evaluateRetrievalCase(
        retrievalRefusalCase,
        {
          candidates: [candidate('客服指南', 1, 0.8)],
          evidence: [],
        },
        0.55,
      ).passed,
    ).toBe(true);
    expect(
      evaluateRetrievalCase(
        retrievalRefusalCase,
        {
          candidates: [candidate('客服指南', 1, 0.4)],
          evidence: [candidate('客服指南', 1, 0.4)],
        },
        0.55,
      ).passed,
    ).toBe(false);
  });

  it('生成拒答用例要求预期相关文档通过检索门槛', () => {
    const generationRefusalCase = {
      ...answerCase,
      id: 'generation-refusal',
      expectedOutcome: 'refusal',
      expectedRefusalStage: 'generation',
      requiredFacts: [],
    } satisfies EvaluationCase;

    expect(
      evaluateRetrievalCase(
        generationRefusalCase,
        {
          candidates: [candidate('退款政策', 1, 0.4)],
          evidence: [candidate('退款政策', 1, 0.4)],
        },
        0.55,
      ).passed,
    ).toBe(true);
    expect(
      evaluateRetrievalCase(
        generationRefusalCase,
        {
          candidates: [candidate('退款政策', 1, 0.6)],
          evidence: [],
        },
        0.55,
      ).passed,
    ).toBe(false);
  });
});
