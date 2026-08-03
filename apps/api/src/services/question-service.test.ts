import { describe, expect, it } from 'vitest';

import {
  buildCitationPreview,
  parseQuestionInput,
  QuestionServiceError,
} from './question-service.js';

describe('问题输入合同', () => {
  it('trim 后返回问题文本', () => {
    expect(parseQuestionInput({ question: '  退款申请期限是多少？  ' })).toBe(
      '退款申请期限是多少？',
    );
  });

  it('接受恰好 2000 个 Unicode 字符', () => {
    const question = '🙂'.repeat(2000);
    expect(parseQuestionInput({ question })).toBe(question);
  });

  it.each([
    ['非对象', '退款期限'],
    ['null', null],
    ['缺少 question', {}],
    ['question 不是字符串', { question: 42 }],
    ['空问题', { question: '   \r\n\t ' }],
    ['超长问题', { question: '🙂'.repeat(2001) }],
    ['额外字段', { question: '退款期限', sessionId: 'abc' }],
  ])('拒绝%s', (_label, input) => {
    expect(() => parseQuestionInput(input)).toThrowError(
      expect.objectContaining({
        code: 'invalid_question',
        statusCode: 400,
      }),
    );
  });

  it('错误是 QuestionServiceError 且不回显问题内容', () => {
    const privateQuestion = '不应出现在错误信息中的问题';
    try {
      parseQuestionInput({ question: privateQuestion, extra: true });
      expect.unreachable('应当抛出错误');
    } catch (error) {
      expect(error).toBeInstanceOf(QuestionServiceError);
      expect((error as Error).message).not.toContain(privateQuestion);
    }
  });
});

describe('Citation preview', () => {
  it('规范化空白并截取前 160 个 Unicode 字符', () => {
    const content = `  第一段\r\n\r\n第二段\t${'🙂'.repeat(200)}  `;
    const preview = buildCitationPreview(content);
    expect(Array.from(preview).length).toBe(160);
    expect(preview.startsWith('第一段 第二段 🙂')).toBe(true);
    expect(preview).not.toMatch(/[\r\n\t]/u);
  });

  it('短内容也只返回不完整预览', () => {
    expect(buildCitationPreview('退款期限为 7 天。')).toBe('退款期限为 7 天');
  });
});
