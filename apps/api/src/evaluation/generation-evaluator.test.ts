import { describe, expect, it } from 'vitest';

import type { AnswerContractResult } from '../rag/answer-contract.js';
import type { RetrievalResult } from '../rag/retrieve.js';
import type { RetrievedChunk } from '../providers/types.js';
import type { EvaluationCase } from './fixtures.js';
import { evaluateGenerationCase } from './generation-evaluator.js';

function makeChunk(rank: number, documentTitle = '退款政策'): RetrievedChunk {
  return {
    rank,
    documentId: `doc-${rank}`,
    chunkId: `chunk-${rank}`,
    documentTitle,
    content: '退款申请期限为 7 个自然日。',
    distance: 0.2,
  };
}

function makeRetrieval(evidence: RetrievedChunk[]): RetrievalResult {
  return { candidates: evidence, evidence };
}

function answerCase(): EvaluationCase {
  return {
    id: 'answer-1',
    question: '退款申请期限是多少？',
    expectedOutcome: 'answer',
    expectedRefusalStage: null,
    expectedDocumentTitles: ['退款政策'],
    requiredFacts: ['7 个自然日'],
  };
}

function generationRefusalCase(): EvaluationCase {
  return {
    id: 'generation-refusal-1',
    question: '申请退款会收取手续费吗？',
    expectedOutcome: 'refusal',
    expectedRefusalStage: 'generation',
    expectedDocumentTitles: ['退款政策'],
    requiredFacts: [],
  };
}

function retrievalRefusalCase(): EvaluationCase {
  return {
    id: 'retrieval-refusal-1',
    question: '明天上海天气如何？',
    expectedOutcome: 'refusal',
    expectedRefusalStage: 'retrieval',
    expectedDocumentTitles: [],
    requiredFacts: [],
  };
}

function answerContract(
  chunk: RetrievedChunk = makeChunk(1),
): AnswerContractResult {
  return {
    kind: 'answer',
    answer: '退款申请期限为 7 个自然日。[1]',
    citationRanks: [chunk.rank],
    citedEvidence: [chunk],
  };
}

function refusalContract(): AnswerContractResult {
  return { kind: 'refusal', refusalReason: 'model_refused' };
}

describe('生成评测用例评估', () => {
  it('答案用例在引用覆盖预期文档且事实齐全时通过', () => {
    const report = evaluateGenerationCase(
      answerCase(),
      makeRetrieval([makeChunk(1)]),
      answerContract(),
      123,
    );
    expect(report.passed).toBe(true);
    expect(report.actualOutcome).toBe('answer');
    expect(report.actualRefusalStage).toBeNull();
    expect(report.citedDocumentTitles).toEqual(['退款政策']);
    expect(report.missingRequiredFacts).toEqual([]);
    expect(report.citationValid).toBe(true);
    expect(report.durationMs).toBe(123);
  });

  it('答案用例缺失预期事实时列出 missingRequiredFacts 并失败', () => {
    const contract = answerContract();
    const report = evaluateGenerationCase(
      answerCase(),
      makeRetrieval([makeChunk(1)]),
      contract,
      10,
    );
    const missingCase = {
      ...answerCase(),
      requiredFacts: ['7 个自然日', '3 个工作日'],
    };
    const reportWithMissing = evaluateGenerationCase(
      missingCase,
      makeRetrieval([makeChunk(1)]),
      contract,
      10,
    );
    expect(report.passed).toBe(true);
    expect(reportWithMissing.passed).toBe(false);
    expect(reportWithMissing.missingRequiredFacts).toEqual(['3 个工作日']);
  });

  it('答案用例在模型拒答时失败且 citationValid 保持空', () => {
    const report = evaluateGenerationCase(
      answerCase(),
      makeRetrieval([makeChunk(1)]),
      refusalContract(),
      5,
    );
    expect(report.passed).toBe(false);
    expect(report.actualOutcome).toBe('refusal');
    expect(report.actualRefusalStage).toBe('generation');
    expect(report.citationValid).toBeNull();
  });

  it('答案用例在引用未覆盖预期文档时失败', () => {
    const contract = answerContract(makeChunk(2, '配送说明'));
    const report = evaluateGenerationCase(
      answerCase(),
      makeRetrieval([makeChunk(2, '配送说明')]),
      contract,
      5,
    );
    expect(report.passed).toBe(false);
    expect(report.citedDocumentTitles).toEqual(['配送说明']);
  });

  it('生成拒答用例在模型主动拒答且预期文档命中时通过并记录原因', () => {
    const report = evaluateGenerationCase(
      generationRefusalCase(),
      makeRetrieval([makeChunk(1)]),
      refusalContract(),
      40,
    );
    expect(report.passed).toBe(true);
    expect(report.actualOutcome).toBe('refusal');
    expect(report.actualRefusalStage).toBe('generation');
    expect(report.refusalReason).toBe('model_refused');
  });

  it('生成拒答用例在检索无证据时失败，且不误判成检索拒答', () => {
    const report = evaluateGenerationCase(
      generationRefusalCase(),
      makeRetrieval([]),
      null,
      0,
    );
    expect(report.passed).toBe(false);
    expect(report.actualOutcome).toBe('refusal');
    expect(report.actualRefusalStage).toBe('retrieval');
    expect(report.refusalReason).toBeNull();
  });

  it('生成拒答用例在模型反而回答时失败', () => {
    const report = evaluateGenerationCase(
      generationRefusalCase(),
      makeRetrieval([makeChunk(1)]),
      answerContract(),
      20,
    );
    expect(report.passed).toBe(false);
    expect(report.actualOutcome).toBe('answer');
    expect(report.refusalReason).toBeNull();
  });

  it('生成拒答用例在预期文档未命中时失败，即使模型拒答', () => {
    // 要求命中“退款政策”但实际只命中“配送说明”：当前检索没有为边界判断提供依据。
    const report = evaluateGenerationCase(
      generationRefusalCase(),
      makeRetrieval([makeChunk(1, '配送说明')]),
      refusalContract(),
      20,
    );
    expect(report.passed).toBe(false);
    expect(report.refusalReason).toBe('model_refused');
    expect(report.hitDocumentTitles).toEqual(['配送说明']);
  });

  it.each(['empty_answer', 'invalid_model_output', 'invalid_citation'] as const)(
    '生成拒答用例在拒答原因是 %s 时视为输出异常而非模型拒答',
    (refusalReason) => {
      const report = evaluateGenerationCase(
        generationRefusalCase(),
        makeRetrieval([makeChunk(1)]),
        { kind: 'refusal', refusalReason },
        10,
      );
      expect(report.passed).toBe(false);
      expect(report.refusalReason).toBe(refusalReason);
    },
  );

  it('检索拒答用例在证据为空时通过', () => {
    const report = evaluateGenerationCase(
      retrievalRefusalCase(),
      makeRetrieval([]),
      null,
      0,
    );
    expect(report.passed).toBe(true);
    expect(report.actualOutcome).toBe('refusal');
    expect(report.actualRefusalStage).toBe('retrieval');
  });

  it('检索拒答用例在检索到证据时失败', () => {
    const report = evaluateGenerationCase(
      retrievalRefusalCase(),
      makeRetrieval([makeChunk(1)]),
      refusalContract(),
      10,
    );
    expect(report.passed).toBe(false);
  });

  it('错误用例由调用方标记为失败并保留脱敏错误分类', () => {
    const report = {
      ...evaluateGenerationCase(
        retrievalRefusalCase(),
        { candidates: [], evidence: [] },
        null,
        0,
      ),
      error: 'deepseek:http_status',
      passed: false,
    };
    expect(report.passed).toBe(false);
    expect(report.error).toBe('deepseek:http_status');
  });
});
