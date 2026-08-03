import { describe, expectTypeOf, it } from 'vitest';

import type {
  Citation,
  CreateDocumentRequest,
  DocumentCreatedResponse,
  DocumentDetail,
  DocumentSourceType,
  DocumentSummary,
  DocumentUpdatedResponse,
  QuestionResponse,
  RefusalReason,
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
});
