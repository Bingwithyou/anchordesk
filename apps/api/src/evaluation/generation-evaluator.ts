import type { AnswerContractResult } from '../rag/answer-contract.js';
import type { RetrievalResult } from '../rag/retrieve.js';
import type { EvaluationCase } from './fixtures.js';

export type ActualOutcome = 'answer' | 'refusal';
export type ActualRefusalStage = 'retrieval' | 'generation';

export interface GenerationCaseReport {
  id: string;
  question: string;
  expectedOutcome: EvaluationCase['expectedOutcome'];
  expectedRefusalStage: EvaluationCase['expectedRefusalStage'];
  actualOutcome: ActualOutcome;
  actualRefusalStage: ActualRefusalStage | null;
  refusalReason: string | null;
  hitDocumentTitles: string[];
  citedDocumentTitles: string[];
  missingRequiredFacts: string[];
  citationValid: boolean | null;
  durationMs: number;
  error: string | null;
  passed: boolean;
}

/**
 * 评估单个固定用例。contract 为空表示检索阶段没有门槛内证据，
 * 生成阶段根本没有被调用，因此拒答只能归因于检索。
 */
export function evaluateGenerationCase(
  evaluationCase: EvaluationCase,
  retrieval: RetrievalResult,
  contract: AnswerContractResult | null,
  durationMs: number,
): GenerationCaseReport {
  const hitDocumentTitles = [
    ...new Set(retrieval.evidence.map((chunk) => chunk.documentTitle)),
  ];
  const refusalOccurred = contract === null || contract.kind === 'refusal';
  const actualOutcome: ActualOutcome = refusalOccurred ? 'refusal' : 'answer';
  const actualRefusalStage: ActualRefusalStage | null = refusalOccurred
    ? contract === null
      ? 'retrieval'
      : 'generation'
    : null;

  let citedDocumentTitles: string[] = [];
  let missingRequiredFacts: string[] = [];
  let citationValid: boolean | null = null;
  let passed = false;
  let error: string | null = null;
  let refusalReason: string | null = null;

  if (evaluationCase.expectedOutcome === 'answer') {
    if (contract?.kind === 'answer') {
      citedDocumentTitles = [
        ...new Set(contract.citedEvidence.map((chunk) => chunk.documentTitle)),
      ];
      missingRequiredFacts = evaluationCase.requiredFacts.filter(
        (fact) => !contract.answer.includes(fact),
      );
      citationValid = true;
      const allExpectedCited = evaluationCase.expectedDocumentTitles.every(
        (title) => citedDocumentTitles.includes(title),
      );
      passed = allExpectedCited && missingRequiredFacts.length === 0;
    }
  } else if (evaluationCase.expectedRefusalStage === 'generation') {
    // 生成阶段拒答必须来自模型主动拒答：只接受 model_refused。
    // empty_answer、invalid_model_output、invalid_citation 属于输出异常，
    // 不能当作边界用例通过；同时预期文档必须全部命中，
    // 否则拒答可能只是因为检索失败而不是模型正确识别边界。
    const modelRefused =
      contract?.kind === 'refusal' && contract.refusalReason === 'model_refused';
    const expectedDocumentsHit = evaluationCase.expectedDocumentTitles.every(
      (title) => hitDocumentTitles.includes(title),
    );
    if (contract?.kind === 'refusal') {
      refusalReason = contract.refusalReason;
    }
    passed = modelRefused && expectedDocumentsHit;
  } else if (evaluationCase.expectedRefusalStage === 'retrieval') {
    passed = retrieval.evidence.length === 0;
  }

  return {
    id: evaluationCase.id,
    question: evaluationCase.question,
    expectedOutcome: evaluationCase.expectedOutcome,
    expectedRefusalStage: evaluationCase.expectedRefusalStage,
    actualOutcome,
    actualRefusalStage,
    refusalReason,
    hitDocumentTitles,
    citedDocumentTitles,
    missingRequiredFacts,
    citationValid,
    durationMs,
    error,
    passed,
  };
}
