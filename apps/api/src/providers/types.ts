export interface RetrievedChunk {
  rank: number;
  documentId: string;
  chunkId: string;
  documentTitle: string;
  content: string;
  distance: number;
}

export interface EmbeddingProvider {
  embedOne(input: string, signal?: AbortSignal): Promise<number[]>;
  embedMany(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface AnswerProvider {
  generate(
    question: string,
    evidence: RetrievedChunk[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface Providers {
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
}
