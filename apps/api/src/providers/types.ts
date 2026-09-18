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

export interface ExtractedFile {
  filename: string;
  data: Buffer;
}

export interface DocumentExtractionProvider {
  /** 把上传的二进制文件解析为 UTF-8 纯文本；提取失败或质量不达标必须抛错 */
  extract(file: ExtractedFile, signal?: AbortSignal): Promise<string>;
}

export interface Providers {
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
  extractionProvider: DocumentExtractionProvider;
}
