import { describe, expect, it } from 'vitest';

import {
  MAX_GARBLED_RATIO,
  assessExtractionQuality,
} from './quality-gate.js';

describe('提取质量门控', () => {
  it('空文本与纯空白文本判为 empty', () => {
    expect(assessExtractionQuality('')).toEqual({
      ok: false,
      failure: 'empty',
    });
    expect(assessExtractionQuality('  \n\t ')).toEqual({
      ok: false,
      failure: 'empty',
    });
  });

  it('替换字符占比超过 1% 判为 garbled', () => {
    const characterCount = 200;
    const replacementCount = Math.ceil(characterCount * MAX_GARBLED_RATIO) + 1;
    const text = `${'�'.repeat(replacementCount)}${'正'.repeat(characterCount - replacementCount)}`;

    expect(assessExtractionQuality(text)).toEqual({
      ok: false,
      failure: 'garbled',
    });
  });

  it('替换字符占比低于阈值时放行', () => {
    const text = `�${'正常文本'.repeat(50)}`;

    expect(assessExtractionQuality(text)).toEqual({ ok: true });
  });

  it('提供页数时按有效字符密度检测稀疏提取', () => {
    expect(assessExtractionQuality('只有一句话', 10)).toEqual({
      ok: false,
      failure: 'sparse',
    });
    expect(assessExtractionQuality('内容'.repeat(500), 10)).toEqual({
      ok: true,
    });
  });

  it('未提供页数时不检测密度', () => {
    expect(assessExtractionQuality('只有一句话')).toEqual({ ok: true });
  });
});
