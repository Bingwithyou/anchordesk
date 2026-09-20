import { ProviderError } from '../providers/errors.js';
import type {
  DocumentExtractionProvider,
  ExtractedFile,
  ExtractionResult,
} from '../providers/types.js';

export interface MinerUExtractionProviderOptions {
  baseUrl: string;
  timeoutMs: number;
}

/**
 * 通过 HTTP 调用本机 mineru-api 的 /file_parse 同步解析接口。
 * 服务本身由用户手动启动（同 Ollama），本类只负责协议与错误映射：
 * 连接失败/非 2xx → 502，超时 → 504，响应结构非法 → 502 invalid_response。
 */
export class MinerUExtractionProvider implements DocumentExtractionProvider {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor({ baseUrl, timeoutMs }: MinerUExtractionProviderOptions) {
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  async extract(
    file: ExtractedFile,
    signal?: AbortSignal,
  ): Promise<ExtractionResult> {
    signal?.throwIfAborted();
    const form = new FormData();
    form.append('files', new Blob([file.data]), lowercaseExtension(file.filename));
    form.append('return_md', 'true');
    form.append('response_format_zip', 'false');

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combinedSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/file_parse`, {
        method: 'POST',
        body: form,
        signal: combinedSignal,
      });
    } catch (error) {
      // 用户主动取消（如浏览器断开）原样抛出，不映射为上游错误。
      if (signal?.aborted === true) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ProviderError({ kind: 'timeout', provider: 'mineru' });
      }
      throw new ProviderError({ kind: 'connection', provider: 'mineru' });
    }

    if (!response.ok) {
      // mineru-api 对解析失败返回 409、任务管理器不可用返回 503。
      throw new ProviderError({
        kind: 'http_status',
        provider: 'mineru',
        upstreamStatus: response.status,
      });
    }

    const payload: unknown = await response.json().catch(() => undefined);
    return parseFileParseResponse(payload);
  }
}

/**
 * 解析 /file_parse 的响应：markdown 位于 results 下以文件名主体为键的
 * 子对象中，字段名为 md_content。页数字段（pages/page_count）按上游
 * 实现差异做防御性读取，缺失时质量门控跳过密度检测。
 */
export function parseFileParseResponse(payload: unknown): ExtractionResult {
  const invalidResponse = (): ProviderError =>
    new ProviderError({ kind: 'invalid_response', provider: 'mineru' });

  if (typeof payload !== 'object' || payload === null) {
    throw invalidResponse();
  }
  const root = payload as Record<string, unknown>;
  if (root.status !== 'completed') {
    throw invalidResponse();
  }

  const results = root.results;
  if (typeof results !== 'object' || results === null) {
    throw invalidResponse();
  }

  let markdown: string | undefined;
  let pageCount: number | undefined;
  for (const entry of Object.values(results)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const fileResult = entry as Record<string, unknown>;
    if (typeof fileResult.md_content === 'string' && markdown === undefined) {
      markdown = fileResult.md_content;
    }
    if (pageCount === undefined) {
      const pages = fileResult.pages ?? fileResult.page_count;
      if (typeof pages === 'number' && Number.isInteger(pages) && pages > 0) {
        pageCount = pages;
      }
    }
  }

  if (markdown === undefined) {
    throw invalidResponse();
  }
  return { text: markdown, ...(pageCount === undefined ? {} : { pageCount }) };
}

/** mineru-api 只接受小写扩展名，发送前统一小写化 */
function lowercaseExtension(filename: string): string {
  const separatorIndex = filename.lastIndexOf('.');
  if (separatorIndex < 0) {
    return filename;
  }
  return `${filename.slice(0, separatorIndex)}${filename.slice(separatorIndex).toLowerCase()}`;
}
