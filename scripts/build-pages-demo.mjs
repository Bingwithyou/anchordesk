import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@huggingface/transformers';

// chunkDocument 是 TypeScript，经 tsx 运行本脚本即可解析 .js → .ts。
import { chunkDocument } from '../apps/api/src/rag/chunk.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = resolve(root, 'docs/demo/models');
const knowledgeDir = resolve(root, 'fixtures/knowledge');
const casesPath = resolve(root, 'fixtures/evaluation/cases.json');
const outputPath = resolve(root, 'docs/demo/vectors.json');
const vendorDir = resolve(root, 'docs/demo/vendor');

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const REFUSAL_TEXT = '知识库中没有足够依据回答这个问题。';

// 与浏览器演示页共用同一套本地模型文件，构建期不访问网络。
env.localModelPath = modelsDir;
env.allowLocalModels = true;

function cosineDistance(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  // 向量已归一化（pooling normalize），余弦距离 = 1 - 点积。
  return 1 - dot;
}

function documentTitle(content, fallback) {
  const match = /^#\s+(.+)$/mu.exec(content);
  return match?.[1]?.trim() || fallback;
}

async function main() {
  // 显式本地目录路径 + q8：与浏览器演示页口径一致，构建期不访问网络。
  const extractor = await pipeline(
    'feature-extraction',
    resolve(modelsDir, MODEL_ID),
    { dtype: 'q8' },
  );

  const embed = async (texts) => {
    const output = await extractor(texts, {
      pooling: 'mean',
      normalize: true,
    });
    return output.tolist();
  };

  // 1. 组装语料：三篇 fixtures 知识文档按与生产一致的规则切块。
  const chunks = [];
  for (const filename of readdirSync(knowledgeDir)) {
    if (!filename.endsWith('.md')) {
      continue;
    }
    const content = readFileSync(resolve(knowledgeDir, filename), 'utf8');
    const title = documentTitle(content, filename.replace(/\.md$/u, ''));
    for (const chunkContent of chunkDocument(content)) {
      chunks.push({ title, content: chunkContent, vector: null });
    }
  }
  console.log(`语料：${chunks.length} 个分块`);

  // 2. 嵌入全部 chunk 与全部评测问题（同一模型、同一归一化口径）。
  const chunkVectors = await embed(chunks.map((chunk) => chunk.content));
  chunks.forEach((chunk, index) => {
    chunk.vector = chunkVectors[index];
  });

  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  const questions = cases.map((entry) => ({
    text: entry.question,
    outcome: entry.expectedOutcome,
    refusalStage: entry.expectedRefusalStage,
    documentTitles: entry.expectedDocumentTitles ?? [],
  }));
  const questionVectors = await embed(questions.map((entry) => entry.text));

  // 3. 校验：可回答问题的最佳命中必须落在其标注文档上；
  //    并以「可回答组最大距离」与「检索拒答组最小距离」的中点校准演示门槛。
  const answerableDistances = [];
  const refusalDistances = [];
  const results = [];
  for (const [questionIndex, question] of questions.entries()) {
    let best = { distance: Number.POSITIVE_INFINITY, title: '' };
    for (const chunk of chunks) {
      const distance = cosineDistance(questionVectors[questionIndex], chunk.vector);
      if (distance < best.distance) {
        best = { distance, title: chunk.title };
      }
    }
    const isAnswerable = question.outcome === 'answer';
    if (isAnswerable) {
      answerableDistances.push(best.distance);
    } else if (question.refusalStage === 'retrieval') {
      refusalDistances.push(best.distance);
    }
    // 仅对有标注文档的用例做命中校验；检索拒答用例本就不应命中任何文档。
    const expectsHit = question.documentTitles.length > 0;
    const hit = expectsHit && question.documentTitles.includes(best.title);
    results.push({
      question: question.text,
      documentTitles: question.documentTitles,
      bestTitle: best.title,
      bestDistance: Number(best.distance.toFixed(4)),
      hit,
    });
  }

  const maxAnswerable = Math.max(...answerableDistances);
  const minRefusal = Math.min(...refusalDistances);
  const separated = maxAnswerable < minRefusal;
  const demoMaxDistance = Number(((maxAnswerable + minRefusal) / 2).toFixed(4));
  console.log(`可回答组最大距离：${maxAnswerable.toFixed(4)}`);
  console.log(`检索拒答组最小距离：${minRefusal.toFixed(4)}`);
  console.log(`校准门槛（演示模型）：${demoMaxDistance}`);
  console.log(`两组可分离：${separated ? '是' : '否（门槛不可靠，请检查模型与用例）'}`);

  for (const result of results) {
    if (result.hit) {
      console.log(`✓ ${result.question} → ${result.bestTitle}（${result.bestDistance}）`);
    } else if (result.documentTitles.length > 0) {
      throw new Error(
        `✗ 命中校验失败：${result.question} 最佳命中是 ${result.bestTitle}，预期 ${result.documentTitles}`,
      );
    } else {
      console.log(`∘ ${result.question} → 最近 ${result.bestTitle}（${result.bestDistance}，应超门槛）`);
    }
  }

  // 4. 输出向量与元数据；拷贝浏览器运行时资源（库 + wasm）。
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        model: MODEL_ID,
        demoMaxDistance,
        refusalText: REFUSAL_TEXT,
        chunks: chunks.map(({ title, content, vector }) => ({
          title,
          content,
          vector,
        })),
        questions,
      },
      undefined,
      2,
    ),
  );
  console.log(`已写入 ${outputPath}`);

  mkdirSync(vendorDir, { recursive: true });
  copyFileSync(
    resolve(root, 'node_modules/@huggingface/transformers/dist/transformers.min.js'),
    resolve(vendorDir, 'transformers.min.js'),
  );
  // 页面固定 numThreads=1 且 GitHub Pages 无 COOP/COEP，ORT 走 asyncify
  // 单线程路径（冒烟脚本验证过实际只请求这一对文件），其余 wasm 不拷贝。
  for (const filename of [
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.asyncify.mjs',
  ]) {
    copyFileSync(
      resolve(root, 'node_modules/onnxruntime-web/dist', filename),
      resolve(vendorDir, filename),
    );
  }
  console.log('已拷贝浏览器运行时资源到 docs/demo/vendor/');
}

main().catch((error) => {
  let current = error;
  while (current !== undefined && current !== null) {
    console.error(
      `演示构建失败：${current instanceof Error ? current.message : '未知错误'}`,
    );
    current = current.cause;
  }
  process.exitCode = 1;
});
