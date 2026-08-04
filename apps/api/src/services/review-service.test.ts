import { describe, expect, it } from 'vitest';

import {
  parseFeedbackInput,
  parseResolveInput,
  ReviewServiceError,
} from './review-service.js';

const validUuid = '5f0c8f8a-1234-4abc-9def-0123456789ab';

describe('反馈输入合同', () => {
  it('接受合法的 helpful 反馈', () => {
    expect(
      parseFeedbackInput({ questionLogId: validUuid, rating: 'helpful' }),
    ).toEqual({ questionLogId: validUuid, rating: 'helpful' });
  });

  it('接受合法的 not_helpful 反馈', () => {
    expect(
      parseFeedbackInput({ questionLogId: validUuid, rating: 'not_helpful' }),
    ).toEqual({ questionLogId: validUuid, rating: 'not_helpful' });
  });

  it.each([
    ['非对象', 'not_helpful'],
    ['null', null],
    ['缺少 rating', { questionLogId: validUuid }],
    ['缺少 questionLogId', { rating: 'helpful' }],
    ['非法 rating', { questionLogId: validUuid, rating: 'great' }],
    ['非法 UUID', { questionLogId: 'not-a-uuid', rating: 'helpful' }],
    [
      '额外字段',
      { questionLogId: validUuid, rating: 'helpful', note: '多余' },
    ],
  ])('拒绝%s', (_label, input) => {
    expect(() => parseFeedbackInput(input)).toThrowError(
      expect.objectContaining({
        code: 'invalid_review_request',
        statusCode: 400,
      }),
    );
  });
});

describe('解决输入合同', () => {
  it('trim 后返回 note', () => {
    expect(parseResolveInput({ note: '  已补充说明。  ' })).toEqual({
      note: '已补充说明。',
    });
  });

  it('接受恰好 1000 个 Unicode 字符', () => {
    const note = '🙂'.repeat(1000);
    expect(parseResolveInput({ note })).toEqual({ note });
  });

  it.each([
    ['非对象', '直接字符串'],
    ['缺少 note', {}],
    ['note 不是字符串', { note: 42 }],
    ['空 note', { note: ' \r\n\t ' }],
    ['超长 note', { note: '🙂'.repeat(1001) }],
    ['额外字段', { note: '备注', status: 'resolved' }],
  ])('拒绝%s', (_label, input) => {
    expect(() => parseResolveInput(input)).toThrowError(
      expect.objectContaining({
        code: 'invalid_review_request',
        statusCode: 400,
      }),
    );
  });

  it('错误不回显 note 内容', () => {
    const privateNote = '不应出现在错误信息中的备注';
    try {
      parseResolveInput({ note: privateNote, extra: true });
      expect.unreachable('应当抛出错误');
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewServiceError);
      expect((error as Error).message).not.toContain(privateNote);
    }
  });
});

describe('ReviewServiceError', () => {
  it.each([
    ['invalid_review_request', 400],
    ['log_not_found', 404],
    ['feedback_conflict', 409],
    ['review_item_not_found', 404],
    ['review_item_conflict', 409],
  ] as const)('%s 映射到 %i', (code, statusCode) => {
    const error = new ReviewServiceError(code);
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(error.message).not.toBe('');
  });
});
