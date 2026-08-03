import { ProviderError } from './errors.js';
import { fetchProviderJson } from './http.js';
import type { EmbeddingProvider } from './types.js';

export interface OllamaEmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

function validateEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 1024 ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new ProviderError({ kind: 'invalid_response', provider: 'ollama' });
  }

  if (Math.hypot(...value) <= 1e-12) {
    throw new ProviderError({ kind: 'invalid_response', provider: 'ollama' });
  }

  return value;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor({
    baseUrl,
    fetch: fetchImplementation = globalThis.fetch,
    model,
    timeoutMs,
  }: OllamaEmbeddingProviderOptions) {
    this.#endpoint = `${baseUrl.replace(/\/+$/gu, '')}/api/embed`;
    this.#fetch = fetchImplementation;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
  }

  async embedOne(input: string, signal?: AbortSignal): Promise<number[]> {
    const vectors = await this.#request(input, signal);
    return validateEmbedding(vectors[0]);
  }

  async embedMany(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const vectors = await this.#request(inputs, signal);
    if (vectors.length !== inputs.length) {
      throw new ProviderError({ kind: 'invalid_response', provider: 'ollama' });
    }
    return vectors.map(validateEmbedding);
  }

  async #request(
    input: string | string[],
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const body = await fetchProviderJson({
      fetch: this.#fetch,
      init: {
        body: JSON.stringify({ input, model: this.#model, truncate: false }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      provider: 'ollama',
      signal,
      timeoutMs: this.#timeoutMs,
      url: this.#endpoint,
    });
    if (typeof body !== 'object' || body === null) {
      throw new ProviderError({ kind: 'invalid_response', provider: 'ollama' });
    }

    if ('embeddings' in body && Array.isArray(body.embeddings)) {
      return body.embeddings;
    }
    if (
      typeof input === 'string' &&
      'embedding' in body &&
      Array.isArray(body.embedding)
    ) {
      return [body.embedding];
    }

    throw new ProviderError({ kind: 'invalid_response', provider: 'ollama' });
  }
}
