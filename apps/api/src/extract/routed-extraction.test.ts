import { describe, expect, it, vi } from 'vitest';

import type { DocumentExtractionProvider } from '../providers/types.js';
import { RoutedExtractionProvider } from './routed-extraction.js';

function fakeProvider(label: string): DocumentExtractionProvider {
  return {
    extract: vi.fn(async () => ({ text: `${label} 提取结果` })),
  };
}

describe('提取路由', () => {
  const pdfFile = { filename: '文档.pdf', data: Buffer.from('x') };

  it('未配置 MinerU 时 pdf 直接拒绝', async () => {
    const routed = new RoutedExtractionProvider({
      local: fakeProvider('local'),
      pdf: null,
    });

    await expect(routed.extract(pdfFile)).rejects.toThrowError(
      expect.objectContaining({
        code: 'pdf_extraction_disabled',
        statusCode: 400,
      }),
    );
  });

  it('pdf 路由到 MinerU 解析器', async () => {
    const pdf = fakeProvider('pdf');
    const routed = new RoutedExtractionProvider({
      local: fakeProvider('local'),
      pdf,
    });

    await expect(routed.extract(pdfFile)).resolves.toEqual({
      text: 'pdf 提取结果',
    });
    expect(pdf.extract).toHaveBeenCalledTimes(1);
  });

  it.each(['笔记.md', '说明.TXT', '手册.docx'])(
    '%s 路由到本地解析器',
    async (filename) => {
      const local = fakeProvider('local');
      const routed = new RoutedExtractionProvider({
        local,
        pdf: fakeProvider('pdf'),
      });

      await expect(
        routed.extract({ filename, data: Buffer.from('x') }),
      ).resolves.toEqual({ text: 'local 提取结果' });
      expect(local.extract).toHaveBeenCalledTimes(1);
    },
  );
});
