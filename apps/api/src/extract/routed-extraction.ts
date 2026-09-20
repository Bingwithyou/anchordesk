import { DocumentServiceError } from '../services/document-service.js';
import type {
  DocumentExtractionProvider,
  ExtractedFile,
  ExtractionResult,
} from '../providers/types.js';

export interface RoutedExtractionProviderOptions {
  /** 处理 pdf 的解析器；为 null 表示未配置 MinerU，pdf 上传直接拒绝 */
  pdf: DocumentExtractionProvider | null;
  /** 处理 md/txt/docx 的本地解析器 */
  local: DocumentExtractionProvider;
}

/**
 * 按文件扩展名路由解析器：结构自带的格式（md/txt/docx）走本地原生提取，
 * 结构需恢复的格式（pdf，含扫描件 OCR）走 MinerU 侧车。
 */
export class RoutedExtractionProvider implements DocumentExtractionProvider {
  readonly #pdf: DocumentExtractionProvider | null;
  readonly #local: DocumentExtractionProvider;

  constructor({ pdf, local }: RoutedExtractionProviderOptions) {
    this.#pdf = pdf;
    this.#local = local;
  }

  async extract(
    file: ExtractedFile,
    signal?: AbortSignal,
  ): Promise<ExtractionResult> {
    const extension = fileExtension(file.filename);
    if (extension === 'pdf') {
      if (this.#pdf === null) {
        throw new DocumentServiceError('pdf_extraction_disabled');
      }
      return this.#pdf.extract(file, signal);
    }
    return this.#local.extract(file, signal);
  }
}

function fileExtension(filename: string): string {
  const separatorIndex = filename.lastIndexOf('.');
  if (separatorIndex < 0) {
    return '';
  }
  return filename.slice(separatorIndex + 1).toLowerCase();
}
