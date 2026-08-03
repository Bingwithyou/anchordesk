import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type {
  Citation,
  QuestionResponse,
  RefusalReason,
} from '@anchordesk/shared';

import { inTransaction } from '../db/transaction.js';
import type {
  AnswerProvider,
  EmbeddingProvider,
  RetrievedChunk,
} from '../providers/types.js';
import { validateGeneratedAnswer } from '../rag/answer-contract.js';
import { retrieveChunks } from '../rag/retrieve.js';

export const REFUSAL_ANSWER = '知识库中没有足够依据回答这个问题。';
export const MAX_QUESTION_LENGTH = 2000;
const CITATION_PREVIEW_LENGTH = 160;

export interface QuestionService {
  askQuestion(value: unknown, signal?: AbortSignal): Promise<QuestionResponse>;
}

export interface CreateQuestionServiceOptions {
  database: Pool;
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
  ragTopK: number;
  ragMaxDistance: number;
  embeddingModel: string;
  answerModel: string;
  promptVersion: string;
}

export class QuestionServiceError extends Error {
  readonly code = 'invalid_question';
  readonly statusCode = 400;

  constructor() {
    super('问题输入不合法');
    this.name = 'QuestionServiceError';
  }
}

export function parseQuestionInput(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new QuestionServiceError();
  }

  const input = value as Record<string, unknown>;
  const fields = Object.keys(input);
  if (
    fields.length !== 1 ||
    fields[0] !== 'question' ||
    typeof input.question !== 'string'
  ) {
    throw new QuestionServiceError();
  }

  const question = input.question.trim();
  const length = Array.from(question).length;
  if (length < 1 || length > MAX_QUESTION_LENGTH) {
    throw new QuestionServiceError();
  }
  return question;
}

export function buildCitationPreview(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length === 0) {
    return '';
  }

  const visibleLength = Math.min(
    characters.length - 1,
    CITATION_PREVIEW_LENGTH,
  );
  return characters.slice(0, visibleLength).join('');
}

function toCitation(chunk: RetrievedChunk): Citation {
  return {
    rank: chunk.rank,
    documentTitle: chunk.documentTitle,
    preview: buildCitationPreview(chunk.content),
    distance: chunk.distance,
  };
}

interface QuestionOutcome {
  answer: string;
  refusalReason: RefusalReason | null;
  generationMs: number | null;
  citedRanks: ReadonlySet<number>;
  citations: Citation[];
}

interface QuestionLogSnapshot {
  question: string;
  outcome: QuestionOutcome;
  candidates: RetrievedChunk[];
  passedRanks: ReadonlySet<number>;
  retrievalMs: number;
}

async function saveQuestionLog(
  client: PoolClient,
  options: CreateQuestionServiceOptions,
  snapshot: QuestionLogSnapshot,
): Promise<string> {
  const { question, outcome, candidates, passedRanks, retrievalMs } = snapshot;
  const questionLogId = randomUUID();

  await client.query(
    `INSERT INTO question_logs
       (id, question, answer, refused, refusal_reason, answer_model,
        embedding_model, rag_top_k, rag_max_distance, prompt_version,
        retrieval_ms, generation_ms, created_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
    [
      questionLogId,
      question,
      outcome.answer,
      outcome.refusalReason !== null,
      outcome.refusalReason,
      options.answerModel,
      options.embeddingModel,
      options.ragTopK,
      options.ragMaxDistance,
      options.promptVersion,
      retrievalMs,
      outcome.generationMs,
    ],
  );

  for (const candidate of candidates) {
    const passedThreshold = passedRanks.has(candidate.rank);
    await client.query(
      `INSERT INTO question_log_hits
         (id, question_log_id, source_document_id, source_chunk_id,
          document_title, chunk_content, rank, distance,
          passed_threshold, cited)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        questionLogId,
        candidate.documentId,
        candidate.chunkId,
        candidate.documentTitle,
        candidate.content,
        candidate.rank,
        candidate.distance,
        passedThreshold,
        passedThreshold && outcome.citedRanks.has(candidate.rank),
      ],
    );
  }

  if (outcome.refusalReason !== null) {
    await client.query(
      `INSERT INTO review_queue
         (id, question_log_id, item_type, status, note, created_at, resolved_at)
       VALUES ($1, $2, 'refusal', 'open', NULL, CURRENT_TIMESTAMP, NULL)`,
      [randomUUID(), questionLogId],
    );
  }

  return questionLogId;
}

function refusalOutcome(
  refusalReason: RefusalReason,
  generationMs: number | null,
): QuestionOutcome {
  return {
    answer: REFUSAL_ANSWER,
    refusalReason,
    generationMs,
    citedRanks: new Set(),
    citations: [],
  };
}

export function createQuestionService(
  options: CreateQuestionServiceOptions,
): QuestionService {
  const { database, embeddingProvider, answerProvider, ragTopK, ragMaxDistance } =
    options;

  async function resolveOutcome(
    question: string,
    candidates: RetrievedChunk[],
    evidence: RetrievedChunk[],
    signal?: AbortSignal,
  ): Promise<QuestionOutcome> {
    if (candidates.length === 0) {
      return refusalOutcome('no_chunks', null);
    }
    if (evidence.length === 0) {
      return refusalOutcome('low_similarity', null);
    }

    const generationStart = performance.now();
    const rawOutput = await answerProvider.generate(question, evidence, signal);
    const generationMs = Math.round(performance.now() - generationStart);

    const result = validateGeneratedAnswer(rawOutput, evidence);
    if (result.kind === 'refusal') {
      return refusalOutcome(result.refusalReason, generationMs);
    }

    return {
      answer: result.answer,
      refusalReason: null,
      generationMs,
      citedRanks: new Set(result.citationRanks),
      citations: result.citedEvidence.map(toCitation),
    };
  }

  return {
    async askQuestion(
      value: unknown,
      signal?: AbortSignal,
    ): Promise<QuestionResponse> {
      const question = parseQuestionInput(value);

      const retrievalStart = performance.now();
      const embedding = await embeddingProvider.embedOne(question, signal);
      const { candidates, evidence } = await retrieveChunks({
        database,
        embedding,
        maxDistance: ragMaxDistance,
        topK: ragTopK,
      });
      const retrievalMs = Math.round(performance.now() - retrievalStart);

      const outcome = await resolveOutcome(
        question,
        candidates,
        evidence,
        signal,
      );

      const questionLogId = await inTransaction(database, (client) =>
        saveQuestionLog(client, options, {
          question,
          outcome,
          candidates,
          passedRanks: new Set(evidence.map(({ rank }) => rank)),
          retrievalMs,
        }),
      );

      if (outcome.refusalReason !== null) {
        return {
          questionLogId,
          answer: REFUSAL_ANSWER,
          refused: true,
          refusalReason: outcome.refusalReason,
          citations: [],
        };
      }

      const [firstCitation, ...restCitations] = outcome.citations;
      if (firstCitation === undefined) {
        throw new Error('合法答案必须至少包含一个引用');
      }
      return {
        questionLogId,
        answer: outcome.answer,
        refused: false,
        citations: [firstCitation, ...restCitations],
      };
    },
  };
}
