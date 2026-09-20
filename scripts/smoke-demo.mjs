import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

// docs/demo 冒烟验证：本地静态服务器 + headless Chromium，
// 验证模型加载、真实检索、拒答判定，并打印实际请求的 wasm 文件名
// （用于精简 vendor 目录）。不属于 npm run verify 门禁。

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsDir = join(root, 'docs');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // 目录路径回退到 index.html，与 GitHub Pages 行为一致。
    const filePath = urlPath.endsWith('/')
      ? join(docsDir, urlPath, 'index.html')
      : join(docsDir, urlPath);
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    console.log(`[404] ${request.url}`);
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((resolvePromise) => server.listen(8765, '127.0.0.1', resolvePromise));

const requestedWasm = new Set();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (message) => {
  console.log(`[页面] ${message.text()}`);
});
page.on('requestfailed', (request) => {
  console.log(`[请求失败] ${request.url()} ${request.failure()?.errorText ?? ''}`);
});
page.on('response', (response) => {
  if (response.url().includes('.wasm')) {
    requestedWasm.add(response.url().split('/').pop());
  }
});

try {
  await page.goto('http://127.0.0.1:8765/demo/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#demo-status')?.textContent?.includes('模型已就绪'),
    undefined,
    { timeout: 180_000 },
  );
  console.log('✓ 模型加载完成');

  await page.fill('#demo-input', '退款申请期限是多少？');
  await page.click('#demo-submit');
  await page.waitForSelector('.demo-evidence', { timeout: 60_000 });
  const evidence = await page.textContent('.demo-evidence');
  if (!evidence.includes('退款政策') || !evidence.includes('距离')) {
    throw new Error(`证据卡片内容异常：${evidence}`);
  }
  console.log('✓ 可回答问题检索命中《退款政策》并展示距离');

  await page.fill('#demo-input', '明天上海天气如何？');
  await page.click('#demo-submit');
  await page.waitForSelector('.demo-refusal', { timeout: 60_000 });
  const refusal = await page.textContent('.demo-refusal');
  if (!refusal.includes('知识库中没有足够依据回答这个问题')) {
    throw new Error(`拒答文案异常：${refusal}`);
  }
  console.log('✓ 知识库外问题触发确定性拒答');

  console.log(`实际请求的 wasm：${[...requestedWasm].join('、')}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
