import type { RetrievalResult } from '../rag/retrieve.js';
import type { EvaluationCase } from './fixtures.js';

export interface RetrievalCandidateReport {
  documentTitle: string;
  rank: number;
  distance: number;
  passedThreshold: boolean;
}

export interface RetrievalCaseReport {
  id: string;
  question: string;
  expectedOutcome: EvaluationCase['expectedOutcome'];
  expectedRefusalStage: EvaluationCase['expectedRefusalStage'];
  expectedDocumentTitles: string[];
  candidates: RetrievalCandidateReport[];
  expectedDocumentsAvailable: boolean | null;
  passed: boolean;
}

export function evaluateRetrievalCase(
  evaluationCase: EvaluationCase,
  retrieval: RetrievalResult,
  maxDistance: number,
): RetrievalCaseReport {
  const availableTitles = new Set(
    retrieval.evidence.map((candidate) => candidate.documentTitle),
  );
  const expectedDocumentsAvailable =
    evaluationCase.expectedDocumentTitles.length === 0
      ? null
      : evaluationCase.expectedDocumentTitles.every((title) =>
          availableTitles.has(title),
        );
  const passed =
    evaluationCase.expectedRefusalStage === 'retrieval'
      ? retrieval.evidence.length === 0
      : expectedDocumentsAvailable === true;

  return {
    id: evaluationCase.id,
    question: evaluationCase.question,
    expectedOutcome: evaluationCase.expectedOutcome,
    expectedRefusalStage: evaluationCase.expectedRefusalStage,
    expectedDocumentTitles: [...evaluationCase.expectedDocumentTitles],
    candidates: retrieval.candidates.map((candidate) => ({
      documentTitle: candidate.documentTitle,
      rank: candidate.rank,
      distance: candidate.distance,
      passedThreshold: candidate.distance <= maxDistance,
    })),
    expectedDocumentsAvailable,
    passed,
  };
}
