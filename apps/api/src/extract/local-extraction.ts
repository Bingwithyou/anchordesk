import mammoth from 'mammoth';

import { DocumentServiceError } from '../services/document-service.js';
import type {
  DocumentExtractionProvider,
  ExtractedFile,
} from '../providers/types.js';

/**
 * 内置本地提取：md/txt 直接按 UTF-8 解码，docx 用 mammoth 读取 XML 结构。
 * 无网络调用、无 Python 依赖；非 UTF-8 内容解码产生的 U+FFFD 由质量门控兜底。
 */
export class LocalExtractionProvider implements DocumentExtractionProvider {
  async extract(file: ExtractedFile, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const extension = fileExtension(file.filename);

    if (extension === 'md' || extension === 'txt') {
      return file.data.toString('utf8');
    }

    if (extension === 'docx') {
      try {
        const result = await mammoth.extractRawText({ buffer: file.data });
        return result.value;
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        throw new DocumentServiceError('unparseable_document');
      }
    }

    if (extension === 'pdf') {
      throw new DocumentServiceError('pdf_extraction_disabled');
    }

    throw new DocumentServiceError('unsupported_file_type');
  }
}

function fileExtension(filename: string): string {
  const separatorIndex = filename.lastIndexOf('.');
  if (separatorIndex < 0) {
    return '';
  }
  return filename.slice(separatorIndex + 1).toLowerCase();
}
