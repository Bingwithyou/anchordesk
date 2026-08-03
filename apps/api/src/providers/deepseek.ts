import { createPromptMessages } from '../rag/prompt.js';
import { ProviderError } from './errors.js';
import { fetchProviderJson } from './http.js';
import type { AnswerProvider, RetrievedChunk } from './types.js';

export interface DeepSeekAnswerProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  promptVersion: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export class DeepSeekAnswerProvider implements AnswerProvider {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #model: string;
  readonly #promptVersion: string;
  readonly #timeoutMs: number;

  constructor({
    apiKey,
    baseUrl,
    fetch: fetchImplementation = globalThis.fetch,
    model,
    promptVersion,
    timeoutMs,
  }: DeepSeekAnswerProviderOptions) {
    this.#apiKey = apiKey;
    this.#endpoint = `${baseUrl.replace(/\/+$/gu, '')}/chat/completions`;
    this.#fetch = fetchImplementation;
    this.#model = model;
    this.#promptVersion = promptVersion;
    this.#timeoutMs = timeoutMs;
  }

  async generate(
    question: string,
    evidence: RetrievedChunk[],
    signal?: AbortSignal,
  ): Promise<string> {
    const body = await fetchProviderJson({
      fetch: this.#fetch,
      init: {
        body: JSON.stringify({
          max_tokens: 1024,
          messages: createPromptMessages(
            question,
            evidence,
            this.#promptVersion,
          ),
          model: this.#model,
          response_format: { type: 'json_object' },
          stream: false,
          temperature: 0.2,
          thinking: { type: 'disabled' },
        }),
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      provider: 'deepseek',
      signal,
      timeoutMs: this.#timeoutMs,
      url: this.#endpoint,
    });

    if (
      typeof body !== 'object' ||
      body === null ||
      !('choices' in body) ||
      !Array.isArray(body.choices) ||
      body.choices.length === 0
    ) {
      throw new ProviderError({
        kind: 'invalid_response',
        provider: 'deepseek',
      });
    }

    const choice: unknown = body.choices[0];
    if (
      typeof choice !== 'object' ||
      choice === null ||
      !('finish_reason' in choice) ||
      choice.finish_reason !== 'stop' ||
      !('message' in choice) ||
      typeof choice.message !== 'object' ||
      choice.message === null ||
      !('content' in choice.message) ||
      typeof choice.message.content !== 'string'
    ) {
      throw new ProviderError({
        kind: 'invalid_response',
        provider: 'deepseek',
      });
    }

    return choice.message.content;
  }
}
