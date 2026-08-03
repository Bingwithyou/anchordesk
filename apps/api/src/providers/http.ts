import { ProviderError } from './errors.js';
import type { ProviderName } from './errors.js';

export interface FetchProviderJsonOptions {
  fetch: typeof globalThis.fetch;
  init: Omit<RequestInit, 'signal'>;
  provider: ProviderName;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
}

function callerAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('调用方已取消请求', 'AbortError');
}

export async function fetchProviderJson({
  fetch: fetchImplementation,
  init,
  provider,
  signal,
  timeoutMs,
  url,
}: FetchProviderJsonOptions): Promise<unknown> {
  if (signal?.aborted) {
    throw callerAbortError(signal);
  }

  const controller = new AbortController();
  let abortSource: 'caller' | 'timeout' | undefined;
  const handleCallerAbort = (): void => {
    if (abortSource === undefined) {
      abortSource = 'caller';
      controller.abort(signal?.reason);
    }
  };
  signal?.addEventListener('abort', handleCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    if (abortSource === undefined) {
      abortSource = 'timeout';
      controller.abort();
    }
  }, timeoutMs);

  try {
    const response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderError({
        kind: 'http_status',
        provider,
        upstreamStatus: response.status,
      });
    }

    try {
      const body: unknown = await response.json();
      if (abortSource === 'caller' && signal) {
        throw callerAbortError(signal);
      }
      if (abortSource === 'timeout') {
        throw new ProviderError({ kind: 'timeout', provider });
      }
      return body;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (abortSource === 'caller' && signal) {
        throw callerAbortError(signal);
      }
      if (abortSource === 'timeout') {
        throw new ProviderError({ kind: 'timeout', provider });
      }
      throw new ProviderError({ kind: 'invalid_response', provider });
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (abortSource === 'caller' && signal) {
      throw callerAbortError(signal);
    }
    throw new ProviderError({
      kind: abortSource === 'timeout' ? 'timeout' : 'connection',
      provider,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', handleCallerAbort);
  }
}
