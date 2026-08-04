import { describe, expect, it } from 'vitest';

import { buildPreview } from './preview.js';

describe('文本预览', () => {
  it('规范化空白并按 Unicode 字符截断', () => {
    const content = `  第一段\r\n\r\n第二段\t${'🙂'.repeat(200)}  `;
    const preview = buildPreview(content, 120);
    expect(Array.from(preview).length).toBe(120);
    expect(preview.startsWith('第一段 第二段 🙂')).toBe(true);
    expect(preview).not.toMatch(/[\r\n\t]/u);
  });

  it('短内容也只返回不完整预览', () => {
    expect(buildPreview('退款期限为 7 天。', 120)).toBe('退款期限为 7 天');
  });

  it('单字符内容不泄露原文', () => {
    expect(buildPreview('密', 120)).toBe('');
  });
});
