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

export type FeedbackRating = 'helpful' | 'not_helpful';

export type ReviewItemType = 'refusal' | 'not_helpful';

export type ReviewStatus = 'open' | 'resolved';

export type LogSummary = {
  id: string;
  questionPreview: string;
  answerPreview: string;
  refused: boolean;
  refusalReason: RefusalReason | null;
  createdAt: string;
  feedbackRating: FeedbackRating | null;
};

export type LogHit = {
  rank: number;
  sourceDocumentId: string;
  sourceChunkId: string;
  documentTitle: string;
  chunkContent: string;
  distance: number;
  passedThreshold: boolean;
  cited: boolean;
};

export type LogDetail = {
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
};

export type FeedbackRequest = {
  questionLogId: string;
  rating: FeedbackRating;
};

export type FeedbackResponse = {
  id: string;
  questionLogId: string;
  rating: FeedbackRating;
  createdAt: string;
};

export type ReviewQueueItem = {
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
};

export type ResolveReviewRequest = {
  note: string;
};

export type ResolvedReviewItem = {
  id: string;
  status: 'resolved';
  note: string;
  resolvedAt: string;
};
