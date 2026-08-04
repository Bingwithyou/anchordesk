import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type {
  FeedbackRequest,
  FeedbackResponse,
  LogDetail,
  LogHit,
  LogSummary,
  ResolvedReviewItem,
  ResolveReviewRequest,
  ReviewQueueItem,
} from '@anchordesk/shared';

import { inTransaction } from '../db/transaction.js';
import { buildPreview } from '../text/preview.js';

export const QUESTION_PREVIEW_LENGTH = 120;
export const ANSWER_PREVIEW_LENGTH = 160;
const LOG_LIST_LIMIT = 100;

const utcMicroseconds = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ReviewService {
  listLogs(): Promise<LogSummary[]>;
  getLog(id: string): Promise<LogDetail | null>;
  submitFeedback(value: unknown): Promise<FeedbackResponse>;
  listReviewQueue(): Promise<ReviewQueueItem[]>;
  resolveReviewItem(id: string, value: unknown): Promise<ResolvedReviewItem>;
}

export interface CreateReviewServiceOptions {
  database: Pool;
}

export type ReviewServiceErrorCode =
  | 'invalid_review_request'
  | 'log_not_found'
  | 'feedback_conflict'
  | 'review_item_not_found'
  | 'review_item_conflict';

const reviewErrorDetails: Record<
  ReviewServiceErrorCode,
  { message: string; statusCode: 400 | 404 | 409 }
> = {
  invalid_review_request: { message: '审查请求不合法', statusCode: 400 },
  log_not_found: { message: '问答日志不存在', statusCode: 404 },
  feedback_conflict: {
    message: '该日志已有反馈或不允许提交反馈',
    statusCode: 409,
  },
  review_item_not_found: { message: '待处理项不存在', statusCode: 404 },
  review_item_conflict: { message: '待处理项已被解决', statusCode: 409 },
};

export class ReviewServiceError extends Error {
  readonly code: ReviewServiceErrorCode;
  readonly statusCode: 400 | 404 | 409;

  constructor(code: ReviewServiceErrorCode = 'invalid_review_request') {
    const details = reviewErrorDetails[code];
    super(details.message);
    this.name = 'ReviewServiceError';
    this.code = code;
    this.statusCode = details.statusCode;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseReviewUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new ReviewServiceError();
  }
  return value;
}

export function parseFeedbackInput(value: unknown): FeedbackRequest {
  if (typeof value !== 'object' || value === null) {
    throw new ReviewServiceError();
  }

  const input = value as Record<string, unknown>;
  const allowedFields = new Set(['questionLogId', 'rating']);
  if (
    Object.keys(input).length !== allowedFields.size ||
    Object.keys(input).some((field) => !allowedFields.has(field)) ||
    typeof input.questionLogId !== 'string' ||
    !uuidPattern.test(input.questionLogId) ||
    (input.rating !== 'helpful' && input.rating !== 'not_helpful')
  ) {
    throw new ReviewServiceError();
  }

  return {
    questionLogId: input.questionLogId,
    rating: input.rating,
  };
}

export function parseResolveInput(value: unknown): ResolveReviewRequest {
  if (typeof value !== 'object' || value === null) {
    throw new ReviewServiceError();
  }

  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    !('note' in input) ||
    typeof input.note !== 'string'
  ) {
    throw new ReviewServiceError();
  }

  const note = input.note.trim();
  const length = Array.from(note).length;
  if (length < 1 || length > 1000) {
    throw new ReviewServiceError();
  }
  return { note };
}

interface LogListRow {
  id: string;
  question: string;
  answer: string;
  refused: boolean;
  refusalReason: LogSummary['refusalReason'];
  createdAt: string;
  feedbackRating: LogSummary['feedbackRating'];
}

interface LogDetailRow {
  id: string;
  question: string;
  answer: string;
  refused: boolean;
  refusalReason: LogDetail['refusalReason'];
  answerModel: string;
  embeddingModel: string;
  ragTopK: number;
  ragMaxDistance: number;
  promptVersion: string;
  retrievalMs: number;
  generationMs: number | null;
  createdAt: string;
  feedbackRating: NonNullable<LogDetail['feedback']>['rating'] | null;
  feedbackCreatedAt: string | null;
}

export function createReviewService({
  database,
}: CreateReviewServiceOptions): ReviewService {
  return {
    async listLogs(): Promise<LogSummary[]> {
      const result = await database.query<LogListRow>(
        `SELECT
           l.id,
           l.question,
           l.answer,
           l.refused,
           l.refusal_reason AS "refusalReason",
           ${utcMicroseconds('l.created_at')} AS "createdAt",
           f.rating AS "feedbackRating"
         FROM question_logs l
         LEFT JOIN feedback f ON f.question_log_id = l.id
         ORDER BY l.created_at DESC, l.id ASC
         LIMIT ${LOG_LIST_LIMIT}`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        questionPreview: buildPreview(row.question, QUESTION_PREVIEW_LENGTH),
        answerPreview: buildPreview(row.answer, ANSWER_PREVIEW_LENGTH),
        refused: row.refused,
        refusalReason: row.refusalReason,
        createdAt: row.createdAt,
        feedbackRating: row.feedbackRating,
      }));
    },

    async getLog(id: string): Promise<LogDetail | null> {
      parseReviewUuid(id);
      const logResult = await database.query<LogDetailRow>(
        `SELECT
           l.id,
           l.question,
           l.answer,
           l.refused,
           l.refusal_reason AS "refusalReason",
           l.answer_model AS "answerModel",
           l.embedding_model AS "embeddingModel",
           l.rag_top_k AS "ragTopK",
           l.rag_max_distance AS "ragMaxDistance",
           l.prompt_version AS "promptVersion",
           l.retrieval_ms AS "retrievalMs",
           l.generation_ms AS "generationMs",
           ${utcMicroseconds('l.created_at')} AS "createdAt",
           f.rating AS "feedbackRating",
           ${utcMicroseconds('f.created_at')} AS "feedbackCreatedAt"
         FROM question_logs l
         LEFT JOIN feedback f ON f.question_log_id = l.id
         WHERE l.id = $1`,
        [id],
      );
      const log = logResult.rows[0];
      if (!log) {
        return null;
      }

      const hitsResult = await database.query<LogHit>(
        `SELECT
           rank,
           source_document_id AS "sourceDocumentId",
           source_chunk_id AS "sourceChunkId",
           document_title AS "documentTitle",
           chunk_content AS "chunkContent",
           distance,
           passed_threshold AS "passedThreshold",
           cited
         FROM question_log_hits
         WHERE question_log_id = $1
         ORDER BY rank ASC`,
        [id],
      );

      return {
        id: log.id,
        question: log.question,
        answer: log.answer,
        refused: log.refused,
        refusalReason: log.refusalReason,
        answerModel: log.answerModel,
        embeddingModel: log.embeddingModel,
        ragTopK: log.ragTopK,
        ragMaxDistance: log.ragMaxDistance,
        promptVersion: log.promptVersion,
        retrievalMs: log.retrievalMs,
        generationMs: log.generationMs,
        createdAt: log.createdAt,
        feedback:
          log.feedbackRating !== null && log.feedbackCreatedAt !== null
            ? {
                rating: log.feedbackRating,
                createdAt: log.feedbackCreatedAt,
              }
            : null,
        hits: hitsResult.rows,
      };
    },

    async submitFeedback(value: unknown): Promise<FeedbackResponse> {
      const input = parseFeedbackInput(value);

      return inTransaction(database, async (client) => {
        const log = await client.query<{ refused: boolean }>(
          'SELECT refused FROM question_logs WHERE id = $1',
          [input.questionLogId],
        );
        const refused = log.rows[0]?.refused;
        if (refused === undefined) {
          throw new ReviewServiceError('log_not_found');
        }
        if (refused) {
          throw new ReviewServiceError('feedback_conflict');
        }

        const inserted = await client.query<{
          id: string;
          createdAt: string;
        }>(
          `INSERT INTO feedback (id, question_log_id, rating, created_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (question_log_id) DO NOTHING
           RETURNING id, ${utcMicroseconds('created_at')} AS "createdAt"`,
          [randomUUID(), input.questionLogId, input.rating],
        );
        const feedback = inserted.rows[0];
        if (!feedback) {
          throw new ReviewServiceError('feedback_conflict');
        }

        if (input.rating === 'not_helpful') {
          await client.query(
            `INSERT INTO review_queue
               (id, question_log_id, item_type, status, note,
                created_at, resolved_at)
             VALUES
               ($1, $2, 'not_helpful', 'open', NULL,
                CURRENT_TIMESTAMP, NULL)`,
            [randomUUID(), input.questionLogId],
          );
        }

        return {
          id: feedback.id,
          questionLogId: input.questionLogId,
          rating: input.rating,
          createdAt: feedback.createdAt,
        };
      });
    },

    async listReviewQueue(): Promise<ReviewQueueItem[]> {
      const result = await database.query<ReviewQueueItem>(
        `SELECT
           q.id,
           q.question_log_id AS "questionLogId",
           q.item_type AS "itemType",
           q.status,
           l.question,
           l.answer,
           l.refusal_reason AS "refusalReason",
           f.rating AS "feedbackRating",
           q.note,
           ${utcMicroseconds('q.created_at')} AS "createdAt",
           ${utcMicroseconds('q.resolved_at')} AS "resolvedAt"
         FROM review_queue q
         INNER JOIN question_logs l ON l.id = q.question_log_id
         LEFT JOIN feedback f ON f.question_log_id = q.question_log_id
         ORDER BY
           CASE WHEN q.status = 'open' THEN 0 ELSE 1 END,
           q.created_at DESC,
           q.id ASC`,
      );
      return result.rows;
    },

    async resolveReviewItem(
      id: string,
      value: unknown,
    ): Promise<ResolvedReviewItem> {
      parseReviewUuid(id);
      const input = parseResolveInput(value);

      return inTransaction(database, async (client) => {
        const existing = await client.query<{ status: 'open' | 'resolved' }>(
          'SELECT status FROM review_queue WHERE id = $1 FOR UPDATE',
          [id],
        );
        const status = existing.rows[0]?.status;
        if (status === undefined) {
          throw new ReviewServiceError('review_item_not_found');
        }
        if (status === 'resolved') {
          throw new ReviewServiceError('review_item_conflict');
        }

        const updated = await client.query<{
          id: string;
          note: string;
          resolvedAt: string;
        }>(
          `UPDATE review_queue
           SET status = 'resolved', note = $2, resolved_at = clock_timestamp()
           WHERE id = $1
           RETURNING
             id,
             note,
             ${utcMicroseconds('resolved_at')} AS "resolvedAt"`,
          [id, input.note],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new ReviewServiceError('review_item_not_found');
        }

        return {
          id: row.id,
          status: 'resolved',
          note: row.note,
          resolvedAt: row.resolvedAt,
        };
      });
    },
  };
}
