import { env, pipeline } from './vendor/transformers.min.js';

// 全部资源随仓库自托管（模型、wasm、运行时），不依赖任何 CDN。
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', location.href).toString();
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', location.href).toString();
// GitHub Pages 不提供 COOP/COEP，线程版 wasm 不可用，固定单线程。
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const EMBEDDING_OPTIONS = { pooling: 'mean', normalize: true };

const input = document.querySelector('#demo-input');
const submit = document.querySelector('#demo-submit');
const statusLine = document.querySelector('#demo-status');
const resultsBox = document.querySelector('#demo-results');
const chipsBox = document.querySelector('#demo-chips');
const thresholdLabel = document.querySelector('#demo-threshold');

let data = null;
let extractorPromise = null;
let busy = false;

function cosineDistance(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  // 向量已归一化（mean pooling + normalize），余弦距离 = 1 - 点积。
  return 1 - dot;
}

async function loadExtractor() {
  if (extractorPromise === null) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    });
  }
  return extractorPromise;
}

async function embedOne(text) {
  const extractor = await loadExtractor();
  const output = await extractor([text], EMBEDDING_OPTIONS);
  return Array.from(output.data);
}

function distanceLabel(distance, threshold) {
  if (distance > threshold) {
    return `<span class="distance blocked">距离：${distance.toFixed(4)}（未过门槛）</span>`;
  }
  return `<span class="distance passed">距离：${distance.toFixed(4)}（过门槛）</span>`;
}

function renderEvidence(hits, threshold) {
  resultsBox.innerHTML = hits
    .map(
      (hit) => `
    <article class="demo-evidence">
      <header>
        <span class="title">《${hit.title}》</span>
        ${distanceLabel(hit.distance, threshold)}
      </header>
      <p>${escapeHtml(hit.content)}</p>
    </article>`,
    )
    .join('');
}

function renderRefusal(bestDistance, threshold) {
  resultsBox.innerHTML = `
    <div class="demo-refusal">
      <strong>${data.refusalText}</strong>
      <p class="reason">
        检索级拒答（low_similarity）：最近距离 ${bestDistance.toFixed(4)}
        超过演示门槛 ${threshold.toFixed(4)}，系统不会编造答案。
      </p>
    </div>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

async function runQuery(text) {
  if (busy) {
    return;
  }
  const query = text.trim();
  if (query === '') {
    return;
  }
  busy = true;
  submit.disabled = true;
  statusLine.textContent = `正在嵌入并检索：${query}`;
  try {
    const vector = await embedOne(query);
    const scored = data.chunks.map((chunk) => ({
      title: chunk.title,
      content: chunk.content,
      distance: cosineDistance(vector, chunk.vector),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    const best = scored[0];
    if (best === undefined) {
      renderRefusal(Number.POSITIVE_INFINITY, data.demoMaxDistance);
    } else if (best.distance > data.demoMaxDistance) {
      renderRefusal(best.distance, data.demoMaxDistance);
    } else {
      renderEvidence(scored.slice(0, 5), data.demoMaxDistance);
    }
    statusLine.textContent = `检索完成：${query}`;
  } catch (error) {
    statusLine.textContent = `演示运行失败：${
      error instanceof Error ? error.message : '未知错误'
    }`;
  } finally {
    busy = false;
    submit.disabled = false;
  }
}

function buildChips() {
  for (const question of data.questions) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'demo-chip';
    const stage =
      question.outcome === 'answer'
        ? '可回答'
        : question.refusalStage === 'retrieval'
          ? '检索拒答'
          : '生成拒答';
    chip.textContent = `${stage} · ${question.text}`;
    chip.addEventListener('click', () => {
      input.value = question.text;
      void runQuery(question.text);
    });
    chipsBox.append(chip);
  }
}

async function main() {
  const response = await fetch('./vectors.json');
  data = await response.json();
  thresholdLabel.textContent = data.demoMaxDistance.toFixed(4);
  buildChips();
  submit.addEventListener('click', () => void runQuery(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void runQuery(input.value);
    }
  });
  await loadExtractor();
  submit.disabled = false;
  statusLine.textContent =
    '模型已就绪。输入任意问题开始检索，或点击下方预置问题。';
}

main().catch((error) => {
  statusLine.textContent = `初始化失败：${
    error instanceof Error ? error.message : '未知错误'
  }`;
});
