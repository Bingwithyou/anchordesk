import { createHash } from 'node:crypto';

import type {
  AnswerProvider,
  DocumentExtractionProvider,
  EmbeddingProvider,
  ExtractedFile,
  RetrievedChunk,
} from '../providers/types.js';

export type FakeAnswerResolver = (
  question: string,
  evidence: RetrievedChunk[],
) => string;

export type FakeExtractionResolver = (file: ExtractedFile) => string;

function validateFakeEmbedding(vector: readonly number[]): void {
  if (
    vector.length !== 1024 ||
    !vector.every((value) => Number.isFinite(value)) ||
    Math.hypot(...vector) <= 1e-12
  ) {
    throw new Error('Fake Embedding 必须是有限、非零的 1024 维向量');
  }
}

function deterministicEmbedding(input: string): number[] {
  const digest = createHash('sha256').update(input).digest();
  const vector = Array.from({ length: 1024 }, () => 0);
  for (const [offset, value] of digest.entries()) {
    const index = (value + offset * 31) % vector.length;
    vector[index] = (vector[index] ?? 0) + (value + 1) / 256;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly #embeddings: ReadonlyMap<string, readonly number[]>;

  constructor(embeddings: Readonly<Record<string, readonly number[]>> = {}) {
    for (const vector of Object.values(embeddings)) {
      validateFakeEmbedding(vector);
    }
    this.#embeddings = new Map(Object.entries(embeddings));
  }

  async embedOne(input: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    const configured = this.#embeddings.get(input);
    return configured === undefined
      ? deterministicEmbedding(input)
      : [...configured];
  }

  async embedMany(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    return Promise.all(inputs.map((input) => this.embedOne(input, signal)));
  }
}

const defaultAnswer: FakeAnswerResolver = () =>
  JSON.stringify({ answer: '', supported: false, citationRanks: [] });

export class FakeAnswerProvider implements AnswerProvider {
  readonly #resolve: FakeAnswerResolver;

  constructor(resolve: FakeAnswerResolver = defaultAnswer) {
    this.#resolve = resolve;
  }

  async generate(
    question: string,
    evidence: RetrievedChunk[],
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    return this.#resolve(question, evidence);
  }
}

const defaultExtraction: FakeExtractionResolver = () =>
  '这是 Fake 提取的文档内容，用于验证上传链路。';

export class FakeExtractionProvider implements DocumentExtractionProvider {
  readonly #resolve: FakeExtractionResolver;

  constructor(resolve: FakeExtractionResolver = defaultExtraction) {
    this.#resolve = resolve;
  }

  async extract(file: ExtractedFile, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return this.#resolve(file);
  }
}
