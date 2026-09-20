import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LocalExtractionProvider } from './local-extraction.js';

const sampleDocxPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/data/sample.docx',
);

describe('内置本地提取', () => {
  const provider = new LocalExtractionProvider();

  it('md/txt 按 UTF-8 解码原文且扩展名不区分大小写', async () => {
    const content = '第一行\n第二行';

    expect(
      await provider.extract({
        filename: '笔记.TXT',
        data: Buffer.from(content, 'utf8'),
      }),
    ).toEqual({ text: content });
  });

  it('docx 用 mammoth 提取段落文本', async () => {
    const result = await provider.extract({
      filename: '样例.docx',
      data: readFileSync(sampleDocxPath),
    });

    expect(result.text).toContain('这是用于测试的 Word 文档内容。');
    expect(result.text).toContain('AnchorDesk 文档解析测试');
  });

  it('损坏的 docx 报 unparseable_document', async () => {
    await expect(
      provider.extract({
        filename: '坏文件.docx',
        data: Buffer.from('这不是 zip 文件', 'utf8'),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'unparseable_document' }),
    );
  });

  it('pdf 在解析未启用时明确报错', async () => {
    await expect(
      provider.extract({
        filename: '论文.pdf',
        data: Buffer.from('%PDF-1.4', 'utf8'),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'pdf_extraction_disabled' }),
    );
  });

  it('未知扩展名报 unsupported_file_type', async () => {
    await expect(
      provider.extract({
        filename: '表格.xlsx',
        data: Buffer.from('x', 'utf8'),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'unsupported_file_type' }),
    );
  });
});
