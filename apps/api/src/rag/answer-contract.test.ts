import { describe, expect, it } from 'vitest';

import { validateGeneratedAnswer } from './answer-contract.js';
import type { RetrievedChunk } from '../providers/types.js';

const evidence: RetrievedChunk[] = [
  {
    rank: 1,
    documentId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    documentTitle: '退款政策',
    content: '订单支付后 7 天内可以提交退款申请。',
    distance: 0.2,
  },
  {
    rank: 2,
    documentId: '33333333-3333-4333-8333-333333333333',
    chunkId: '44444444-4444-4444-8444-444444444444',
    documentTitle: '到账说明',
    content: '审核通过后，款项将在 3 个工作日内原路退回。',
    distance: 0.3,
  },
];

describe('DeepSeek 答案合同', () => {
  it('接受有依据的答案，并只返回实际引用的证据', () => {
    const result = validateGeneratedAnswer(
      JSON.stringify({
        answer: '退款款项会在审核通过后的 3 个工作日内原路退回。[2]',
        supported: true,
        citationRanks: [2],
      }),
      evidence,
    );

    expect(result).toEqual({
      kind: 'answer',
      answer: '退款款项会在审核通过后的 3 个工作日内原路退回。[2]',
      citationRanks: [2],
      citedEvidence: [evidence[1]],
    });
  });

  it.each([
    ['非 JSON', '这不是 JSON'],
    [
      'Markdown 代码块',
      '```json\n{"answer":"答案[1]","supported":true,"citationRanks":[1]}\n```',
    ],
    [
      'JSON 后附加说明',
      '{"answer":"答案[1]","supported":true,"citationRanks":[1]} 说明',
    ],
    ['根值为 null', 'null'],
    ['根值为数组', '[]'],
    ['缺少 answer', JSON.stringify({ supported: true, citationRanks: [1] })],
    [
      'answer 类型错误',
      JSON.stringify({ answer: 1, supported: true, citationRanks: [1] }),
    ],
    [
      'supported 类型错误',
      JSON.stringify({ answer: '答案[1]', supported: 'true', citationRanks: [1] }),
    ],
    [
      'citationRanks 类型错误',
      JSON.stringify({ answer: '答案[1]', supported: true, citationRanks: ['1'] }),
    ],
    [
      '包含额外字段',
      JSON.stringify({
        answer: '答案[1]',
        supported: true,
        citationRanks: [1],
        explanation: '额外说明',
      }),
    ],
  ])('把%s归为 invalid_model_output', (_label, rawOutput) => {
    expect(validateGeneratedAnswer(rawOutput, evidence)).toEqual({
      kind: 'refusal',
      refusalReason: 'invalid_model_output',
    });
  });

  it('合法结构中的 supported false 归为 model_refused', () => {
    expect(
      validateGeneratedAnswer(
        JSON.stringify({
          answer: '',
          supported: false,
          citationRanks: [],
        }),
        evidence,
      ),
    ).toEqual({ kind: 'refusal', refusalReason: 'model_refused' });
  });

  it.each(['', ' \n\t '])('把空白 answer 归为 empty_answer', (answer) => {
    expect(
      validateGeneratedAnswer(
        JSON.stringify({ answer, supported: true, citationRanks: [] }),
        evidence,
      ),
    ).toEqual({ kind: 'refusal', refusalReason: 'empty_answer' });
  });

  it.each([
    [
      'answer 没有行内引用',
      { answer: '退款期限为 7 天。', supported: true, citationRanks: [1] },
      evidence,
    ],
    [
      'citationRanks 为空',
      { answer: '退款期限为 7 天。[1]', supported: true, citationRanks: [] },
      evidence,
    ],
    [
      'rank 为 0',
      { answer: '无效引用。[0]', supported: true, citationRanks: [0] },
      evidence,
    ],
    [
      'rank 为负数',
      { answer: '无效引用。[-1]', supported: true, citationRanks: [-1] },
      evidence,
    ],
    [
      'rank 不是整数',
      { answer: '无效引用。[1.5]', supported: true, citationRanks: [1.5] },
      evidence,
    ],
    [
      'rank 有前导零',
      { answer: '无效引用。[01]', supported: true, citationRanks: [1] },
      evidence,
    ],
    [
      'citationRanks 重复',
      { answer: '退款期限为 7 天。[1]', supported: true, citationRanks: [1, 1] },
      evidence,
    ],
    [
      'answer 引用了未声明的 rank',
      { answer: '退款 7 天。[1]到账 3 天。[2]', supported: true, citationRanks: [1] },
      evidence,
    ],
    [
      'citationRanks 声明了 answer 未引用的 rank',
      { answer: '退款期限为 7 天。[1]', supported: true, citationRanks: [1, 2] },
      evidence,
    ],
    [
      '引用不存在的 evidence rank',
      { answer: '不存在的证据。[3]', supported: true, citationRanks: [3] },
      evidence,
    ],
    [
      '引用未进入可用 evidence 的候选',
      { answer: '第二条未通过门槛。[2]', supported: true, citationRanks: [2] },
      evidence.slice(0, 1),
    ],
  ] as const)('把%s归为 invalid_citation', (_label, output, availableEvidence) => {
    expect(
      validateGeneratedAnswer(JSON.stringify(output), [...availableEvidence]),
    ).toEqual({ kind: 'refusal', refusalReason: 'invalid_citation' });
  });

  it('允许重复行内引用和多证据，并按检索 rank 返回证据', () => {
    expect(
      validateGeneratedAnswer(
        JSON.stringify({
          answer: '退款期限为 7 天。[1]到账需 3 个工作日。[2]再次确认期限。[1]',
          supported: true,
          citationRanks: [2, 1],
        }),
        evidence,
      ),
    ).toEqual({
      kind: 'answer',
      answer: '退款期限为 7 天。[1]到账需 3 个工作日。[2]再次确认期限。[1]',
      citationRanks: [1, 2],
      citedEvidence: evidence,
    });
  });
});
