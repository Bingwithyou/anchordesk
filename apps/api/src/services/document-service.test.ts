import { describe, expect, it } from 'vitest';

import {
  DocumentServiceError,
  parseCreateDocumentInput,
  parseUpdateDocumentInput,
} from './document-service.js';

describe('文档输入合同', () => {
  it('规范化合法标题并保留正文内容', () => {
    const content = '  第一段\n\n第二段  ';

    expect(
      parseCreateDocumentInput({
        title: '  退款政策  ',
        content,
        sourceType: 'markdown',
      }),
    ).toEqual({
      title: '退款政策',
      content,
      sourceType: 'markdown',
    });
  });

  it('接受 pdf 与 docx 来源类型', () => {
    expect(
      parseCreateDocumentInput({
        title: '论文',
        content: '正文',
        sourceType: 'pdf',
      }).sourceType,
    ).toBe('pdf');
    expect(
      parseCreateDocumentInput({
        title: '手册',
        content: '正文',
        sourceType: 'docx',
      }).sourceType,
    ).toBe('docx');
  });

  it.each([
    ['空标题', { title: '   ', content: '正文', sourceType: 'text' }],
    [
      '超长标题',
      { title: '🙂'.repeat(121), content: '正文', sourceType: 'text' },
    ],
    ['空正文', { title: '标题', content: '\r\n\t ', sourceType: 'text' }],
    ['非法类型', { title: '标题', content: '正文', sourceType: 'html' }],
    [
      '额外字段',
      {
        title: '标题',
        content: '正文',
        sourceType: 'text',
        reindex: true,
      },
    ],
  ])('拒绝%s', (_label, input) => {
    expect(() => parseCreateDocumentInput(input)).toThrowError(
      expect.objectContaining({
        code: 'invalid_document',
        statusCode: 400,
      }),
    );
  });

  it('错误信息不回显文档正文', () => {
    const privateContent = '不应出现在错误信息中的正文';

    try {
      parseCreateDocumentInput({
        title: '',
        content: privateContent,
        sourceType: 'text',
      });
      throw new Error('预期输入校验失败');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentServiceError);
      expect((error as Error).message).not.toContain(privateContent);
    }
  });

  it('按 UTF-8 字节接受 102400 字节并拒绝 102401 字节', () => {
    const exactLimit = `${'中'.repeat(34_133)}a`;
    const overLimit = `${exactLimit}b`;

    expect(Buffer.byteLength(exactLimit, 'utf8')).toBe(102_400);
    expect(
      parseCreateDocumentInput({
        title: '边界文档',
        content: exactLimit,
        sourceType: 'text',
      }).content,
    ).toBe(exactLimit);
    expect(() =>
      parseCreateDocumentInput({
        title: '超限文档',
        content: overLimit,
        sourceType: 'text',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'invalid_document',
        statusCode: 400,
      }),
    );
  });

  it('更新输入要求可解析且带时区的 expectedUpdatedAt', () => {
    const input = {
      title: '配送说明',
      content: '新正文',
      sourceType: 'markdown',
      expectedUpdatedAt: '2026-07-28T09:15:30.123456Z',
    } as const;

    expect(parseUpdateDocumentInput(input)).toEqual(input);
    expect(() =>
      parseUpdateDocumentInput({
        ...input,
        expectedUpdatedAt: '2026-07-28 09:15:30',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'invalid_document',
        statusCode: 400,
      }),
    );
    expect(() =>
      parseUpdateDocumentInput({
        ...input,
        expectedUpdatedAt: '2026-02-30T09:15:30.123456Z',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'invalid_document',
        statusCode: 400,
      }),
    );
  });
});
