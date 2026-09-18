export type ExtractionQualityFailure = 'empty' | 'garbled' | 'sparse';

export interface ExtractionQuality {
  ok: boolean;
  failure?: ExtractionQualityFailure;
}

/** U+FFFD 替换字符占比超过该值视为编码损坏/提取乱码 */
export const MAX_GARBLED_RATIO = 0.01;

/** 每页有效字符数低于该值视为漏识别（仅当上游能提供页数时启用） */
export const MIN_MEANINGFUL_CHARS_PER_PAGE = 20;

/**
 * 对解析出的文本做廉价质量检测：空文本、乱码率、字符密度。
 * 纯函数，不依赖任何外部服务，本地提取与 MinerU 提取共用。
 */
export function assessExtractionQuality(
  text: string,
  pageCount?: number,
): ExtractionQuality {
  if (text.trim() === '') {
    return { ok: false, failure: 'empty' };
  }

  const characters = Array.from(text);
  let replacementCount = 0;
  for (const character of characters) {
    if (character === '�') {
      replacementCount += 1;
    }
  }
  if (replacementCount / characters.length > MAX_GARBLED_RATIO) {
    return { ok: false, failure: 'garbled' };
  }

  if (pageCount !== undefined && pageCount > 0) {
    const meaningfulCount = text.replace(/\s/gu, '').length;
    if (meaningfulCount / pageCount < MIN_MEANINGFUL_CHARS_PER_PAGE) {
      return { ok: false, failure: 'sparse' };
    }
  }

  return { ok: true };
}
