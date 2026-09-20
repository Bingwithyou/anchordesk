export type ProviderName = 'ollama' | 'deepseek' | 'mineru';
export type ProviderErrorKind =
  | 'connection'
  | 'timeout'
  | 'http_status'
  | 'invalid_response';

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  provider: ProviderName;
  upstreamStatus?: number;
}

const providerLabels: Record<ProviderName, string> = {
  ollama: 'Ollama',
  deepseek: 'DeepSeek',
  mineru: 'MinerU',
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderName;
  readonly statusCode: 502 | 504;
  readonly upstreamStatus: number | undefined;

  constructor({ kind, provider, upstreamStatus }: ProviderErrorOptions) {
    const label = providerLabels[provider];
    const message =
      kind === 'timeout'
        ? `${label} 请求超时`
        : `${label} 上游服务响应异常`;
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.statusCode = kind === 'timeout' ? 504 : 502;
    this.upstreamStatus = upstreamStatus;
  }
}
