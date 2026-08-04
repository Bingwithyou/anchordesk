import { describe, expectTypeOf, it } from 'vitest';

import type {
  Citation,
  CreateDocumentRequest,
  DocumentCreatedResponse,
  DocumentDetail,
  DocumentSourceType,
  DocumentSummary,
  DocumentUpdatedResponse,
  FeedbackRating,
  FeedbackRequest,
  FeedbackResponse,
  LogDetail,
  LogHit,
  LogSummary,
  QuestionResponse,
  RefusalReason,
  ResolvedReviewItem,
  ResolveReviewRequest,
  ReviewItemType,
  ReviewQueueItem,
  ReviewStatus,
  UpdateDocumentRequest,
} from '@anchordesk/shared';

describe('共享问答合同', () => {
  it('导出完整且封闭的拒答原因集合', () => {
    expectTypeOf<RefusalReason>().toEqualTypeOf<
      | 'no_chunks'
      | 'low_similarity'
      | 'model_refused'
      | 'empty_answer'
      | 'invalid_model_output'
      | 'invalid_citation'
    >();
  });

  it('导出 Citation 与成功、拒答两种响应', () => {
    type ExpectedCitation = {
      rank: number;
      documentTitle: string;
      preview: string;
      distance: number;
    };
    type ExpectedQuestionResponse =
      | {
          questionLogId: string;
          answer: string;
          refused: false;
          citations: [ExpectedCitation, ...ExpectedCitation[]];
        }
      | {
          questionLogId: string;
          answer: '知识库中没有足够依据回答这个问题。';
          refused: true;
          refusalReason: RefusalReason;
          citations: [];
        };

    expectTypeOf<Citation>().toEqualTypeOf<ExpectedCitation>();
    expectTypeOf<QuestionResponse>().toEqualTypeOf<ExpectedQuestionResponse>();
  });

  it('导出文档 CRUD 请求与响应合同', () => {
    type ExpectedSummary = {
      id: string;
      title: string;
      sourceType: 'markdown' | 'text';
      createdAt: string;
      updatedAt: string;
      indexedAt: string;
      chunkCount: number;
    };

    expectTypeOf<DocumentSourceType>().toEqualTypeOf<'markdown' | 'text'>();
    expectTypeOf<DocumentSummary>().toEqualTypeOf<ExpectedSummary>();
    expectTypeOf<DocumentDetail>().toEqualTypeOf<
      ExpectedSummary & { content: string }
    >();
    expectTypeOf<CreateDocumentRequest>().toEqualTypeOf<{
      title: string;
      content: string;
      sourceType: DocumentSourceType;
    }>();
    expectTypeOf<UpdateDocumentRequest>().toEqualTypeOf<
      CreateDocumentRequest & { expectedUpdatedAt: string }
    >();
    expectTypeOf<DocumentCreatedResponse>().toEqualTypeOf<{
      id: string;
      chunkCount: number;
    }>();
    expectTypeOf<DocumentUpdatedResponse>().toEqualTypeOf<
      DocumentCreatedResponse & { updatedAt: string }
    >();
  });

  it('导出反馈与审查队列的枚举合同', () => {
    expectTypeOf<FeedbackRating>().toEqualTypeOf<'helpful' | 'not_helpful'>();
    expectTypeOf<ReviewItemType>().toEqualTypeOf<'refusal' | 'not_helpful'>();
    expectTypeOf<ReviewStatus>().toEqualTypeOf<'open' | 'resolved'>();
  });

  it('导出日志摘要、详情与 hits 快照合同', () => {
    expectTypeOf<LogSummary>().toEqualTypeOf<{
      id: string;
      questionPreview: string;
      answerPreview: string;
      refused: boolean;
      refusalReason: RefusalReason | null;
      createdAt: string;
      feedbackRating: FeedbackRating | null;
    }>();

    expectTypeOf<LogHit>().toEqualTypeOf<{
      rank: number;
      sourceDocumentId: string;
      sourceChunkId: string;
      documentTitle: string;
      chunkContent: string;
      distance: number;
      passedThreshold: boolean;
      cited: boolean;
    }>();

    expectTypeOf<LogDetail>().toEqualTypeOf<{
      id: string;
      question: string;
      answer: string;
      refused: boolean;
      refusalReason: RefusalReason | null;
      answerModel: string;
      embeddingModel: string;
      ragTopK: number;
      ragMaxDistance: number;
      promptVersion: string;
      retrievalMs: number;
      generationMs: number | null;
      createdAt: string;
      feedback: {
        rating: FeedbackRating;
        createdAt: string;
      } | null;
      hits: LogHit[];
    }>();
  });

  it('导出反馈请求与响应合同', () => {
    expectTypeOf<FeedbackRequest>().toEqualTypeOf<{
      questionLogId: string;
      rating: FeedbackRating;
    }>();
    expectTypeOf<FeedbackResponse>().toEqualTypeOf<{
      id: string;
      questionLogId: string;
      rating: FeedbackRating;
      createdAt: string;
    }>();
  });

  it('导出审查队列项与解决合同', () => {
    expectTypeOf<ReviewQueueItem>().toEqualTypeOf<{
      id: string;
      questionLogId: string;
      itemType: ReviewItemType;
      status: ReviewStatus;
      question: string;
      answer: string;
      refusalReason: RefusalReason | null;
      feedbackRating: FeedbackRating | null;
      note: string | null;
      createdAt: string;
      resolvedAt: string | null;
    }>();

    expectTypeOf<ResolveReviewRequest>().toEqualTypeOf<{ note: string }>();
    expectTypeOf<ResolvedReviewItem>().toEqualTypeOf<{
      id: string;
      status: 'resolved';
      note: string;
      resolvedAt: string;
    }>();
  });
});
