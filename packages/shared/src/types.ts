export type RefusalReason =
  | 'no_chunks'
  | 'low_similarity'
  | 'model_refused'
  | 'empty_answer'
  | 'invalid_model_output'
  | 'invalid_citation';

export type Citation = {
  rank: number;
  documentTitle: string;
  preview: string;
  distance: number;
};

export type DocumentSourceType = 'markdown' | 'text';

export type DocumentSummary = {
  id: string;
  title: string;
  sourceType: DocumentSourceType;
  createdAt: string;
  updatedAt: string;
  indexedAt: string;
  chunkCount: number;
};

export type DocumentDetail = DocumentSummary & {
  content: string;
};

export type CreateDocumentRequest = {
  title: string;
  content: string;
  sourceType: DocumentSourceType;
};

export type UpdateDocumentRequest = CreateDocumentRequest & {
  expectedUpdatedAt: string;
};

export type DocumentCreatedResponse = {
  id: string;
  chunkCount: number;
};

export type DocumentUpdatedResponse = DocumentCreatedResponse & {
  updatedAt: string;
};

export type QuestionResponse =
  | {
      questionLogId: string;
      answer: string;
      refused: false;
      citations: [Citation, ...Citation[]];
    }
  | {
      questionLogId: string;
      answer: '知识库中没有足够依据回答这个问题。';
      refused: true;
      refusalReason: RefusalReason;
      citations: [];
    };
