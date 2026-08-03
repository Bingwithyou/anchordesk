import { describe, expect, it } from 'vitest';

import { chunkDocument } from './chunk.js';

describe('确定性文档切块', () => {
  it('保持段落边界，并在总长度超限时分成多个 chunk', () => {
    expect(chunkDocument('第一段。\n\n第二段。', 8)).toEqual([
      '第一段。',
      '第二段。',
    ]);
  });

  it('先把 CRLF 统一为 LF', () => {
    expect(chunkDocument('第一段。\r\n\r\n第二段。', 8)).toEqual([
      '第一段。',
      '第二段。',
    ]);
  });

  it('超长单段按 Unicode 字符窗口切分且不重叠', () => {
    expect(chunkDocument('甲😀乙😀丙', 2)).toEqual(['甲😀', '乙😀', '丙']);
  });

  it('合并未超限的相邻短段，并把分隔空行计入长度', () => {
    expect(chunkDocument('甲。\n\n乙。', 6)).toEqual(['甲。\n\n乙。']);
  });

  it('把连续空行和只含空格或 Tab 的行都视为段落分隔', () => {
    expect(chunkDocument('甲。\n \n\t\n\n乙。', 4)).toEqual(['甲。', '乙。']);
  });

  it('保留段内单换行与中文标点', () => {
    expect(chunkDocument('退款期限为 7 天。\n逾期不受理！')).toEqual([
      '退款期限为 7 天。\n逾期不受理！',
    ]);
  });

  it('空白输入返回空数组', () => {
    expect(chunkDocument(' \r\n\t\n ')).toEqual([]);
  });

  it('默认按 900 个 Unicode 字符切分', () => {
    expect(chunkDocument('文'.repeat(901)).map((chunk) => chunk.length)).toEqual([
      900, 1,
    ]);
  });
});
