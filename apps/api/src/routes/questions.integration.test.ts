import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LightMyRequestResponse } from 'fastify';

import { loadDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { resetTestDatabase } from '../db/reset-test-db.js';
import { ProviderError } from '../providers/errors.js';
import type {
  AnswerProvider,
  RetrievedChunk,
} from '../providers/types.js';
import { FakeAnswerProvider } from '../test/fixtures.js';
import { createTestApp, testAppConfig } from '../test/test-app.js';

const REFUSAL_ANSWER = '知识库中没有足够依据回答这个问题。';
const databaseUrls = loadDatabaseUrls();
const apps: ReturnType<typeof createTestApp>[] = [];
let database: ReturnType<typeof createDatabasePool>;

interface QuestionLogRow {
  question: string;
  answer: string;
  refused: boolean;
  refusalReason: string | null;
  answerModel: string;
  embeddingModel: string;
  ragTopK: number;
  ragMaxDistance: number;
  promptVersion: string;
  retrievalMs: number;
  generationMs: number | null;
}

interface HitRow {
  sourceDocumentId: string;
  sourceChunkId: string;
  documentTitle: string;
  chunkContent: string;
  rank: number;
  distance: number;
  passedThreshold: boolean;
  cited: boolean;
}

beforeAll(async () => {
  await resetTestDatabase(databaseUrls);
});

beforeEach(() => {
  database = createDatabasePool(testAppConfig.databaseUrl);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await database.query(
    'DROP TRIGGER IF EXISTS task6_fail_review_queue_trigger ON review_queue',
  );
  await database.query('DROP FUNCTION IF EXISTS task6_fail_review_queue()');
  await database.end();
  await resetTestDatabase(databaseUrls);
});

function buildApp(answerProvider?: AnswerProvider): ReturnType<typeof createTestApp> {
  // Fake Embedding 是哈希向量，问题与文档天然距离较大；放宽门槛让证据通过。
  const app = createTestApp({
    ...(answerProvider ? { answerProvider } : {}),
    config: { ragMaxDistance: 2 },
  });
  apps.push(app);
  return app;
}

async function createDocument(
  app: ReturnType<typeof createTestApp>,
  title: string,
  content: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents',
    payload: { title, content, sourceType: 'text' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function ask(
  app: ReturnType<typeof createTestApp>,
  payload: object,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/questions', payload });
}

async function loadLog(questionLogId: string): Promise<QuestionLogRow> {
  const result = await database.query<QuestionLogRow>(
    `SELECT
       question,
       answer,
       refused,
       refusal_reason AS "refusalReason",
       answer_model AS "answerModel",
       embedding_model AS "embeddingModel",
       rag_top_k AS "ragTopK",
       rag_max_distance AS "ragMaxDistance",
       prompt_version AS "promptVersion",
       retrieval_ms AS "retrievalMs",
       generation_ms AS "generationMs"
     FROM question_logs WHERE id = $1`,
    [questionLogId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0] as QuestionLogRow;
}

async function loadHits(questionLogId: string): Promise<HitRow[]> {
  const result = await database.query<HitRow>(
    `SELECT
       source_document_id AS "sourceDocumentId",
       source_chunk_id AS "sourceChunkId",
       document_title AS "documentTitle",
       chunk_content AS "chunkContent",
       rank,
       distance,
       passed_threshold AS "passedThreshold",
       cited
     FROM question_log_hits WHERE question_log_id = $1 ORDER BY rank`,
    [questionLogId],
  );
  return result.rows;
}

async function countReviewQueue(questionLogId: string): Promise<number> {
  const result = await database.query(
    `SELECT id FROM review_queue
     WHERE question_log_id = $1 AND item_type = 'refusal' AND status = 'open'`,
    [questionLogId],
  );
  return result.rowCount ?? 0;
}

function answerWithCitations(
  resolve: (question: string, evidence: RetrievedChunk[]) => unknown,
): AnswerProvider {
  return new FakeAnswerProvider((question, evidence) => {
    const value = resolve(question, evidence);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

const validAnswerProvider = answerWithCitations((_question, evidence) => ({
  answer: `退款期限为 7 天。[${evidence[0]?.rank}]`,
  supported: true,
  citationRanks: [evidence[0]?.rank],
}));

describe('POST /api/questions 输入校验', () => {
  it.each([
    ['空问题', { question: '   ' }],
    ['超长问题', { question: '问'.repeat(2001) }],
    ['额外字段', { question: '退款期限', sessionId: 's1' }],
    ['缺少 question', {}],
  ])('拒绝%s并返回 400', async (_label, payload) => {
    const app = buildApp();
    const response = await ask(app, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'invalid_question',
      message: expect.stringContaining('问题'),
    });
    const logs = await database.query('SELECT id FROM question_logs');
    expect(logs.rowCount).toBe(0);
  });
});

describe('检索级拒答', () => {
  it('知识库为空时返回 no_chunks 并创建队列，无 hits', async () => {
    const app = buildApp(validAnswerProvider);
    const response = await ask(app, { question: '退款期限是多少？' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      questionLogId: string;
      answer: string;
      refused: boolean;
      refusalReason: string;
      citations: unknown[];
    };
    expect(body.refused).toBe(true);
    expect(body.answer).toBe(REFUSAL_ANSWER);
    expect(body.refusalReason).toBe('no_chunks');
    expect(body.citations).toEqual([]);

    const log = await loadLog(body.questionLogId);
    expect(log.refusalReason).toBe('no_chunks');
    expect(log.generationMs).toBeNull();
    expect(await loadHits(body.questionLogId)).toEqual([]);
    expect(await countReviewQueue(body.questionLogId)).toBe(1);
  });

  it('全部候选超过距离门槛时返回 low_similarity 并保存全部 candidates', async () => {
    const app = createTestApp({
      answerProvider: validAnswerProvider,
      config: { ragMaxDistance: 0 },
    });
    apps.push(app);
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    await createDocument(app, '发票政策', '电子发票在发货后 24 小时内开具。');

    const response = await ask(app, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      questionLogId: string;
      refused: boolean;
      refusalReason: string;
      citations: unknown[];
    };
    expect(body.refused).toBe(true);
    expect(body.refusalReason).toBe('low_similarity');
    expect(body.citations).toEqual([]);

    const log = await loadLog(body.questionLogId);
    expect(log.generationMs).toBeNull();
    const hits = await loadHits(body.questionLogId);
    expect(hits.length).toBe(2);
    expect(hits.every((hit) => !hit.passedThreshold && !hit.cited)).toBe(true);
    expect(await countReviewQueue(body.questionLogId)).toBe(1);
  });
});

describe('生成级拒答', () => {
  it.each([
    [
      'supported: false',
      { answer: '', supported: false, citationRanks: [] },
      'model_refused',
    ],
    [
      '空答案',
      { answer: '   ', supported: true, citationRanks: [1] },
      'empty_answer',
    ],
    ['非 JSON 输出', '这不是 JSON', 'invalid_model_output'],
    [
      '无行内引用',
      { answer: '退款期限为 7 天。', supported: true, citationRanks: [1] },
      'invalid_citation',
    ],
    [
      '越界引用',
      { answer: '退款期限为 7 天。[99]', supported: true, citationRanks: [99] },
      'invalid_citation',
    ],
    [
      'citationRanks 与正文引用不一致',
      { answer: '退款期限为 7 天。[1]', supported: true, citationRanks: [2] },
      'invalid_citation',
    ],
  ])('%s → 拒答且创建队列', async (_label, output, expectedReason) => {
    const app = buildApp(answerWithCitations(() => output));
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');

    const response = await ask(app, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      questionLogId: string;
      answer: string;
      refused: boolean;
      refusalReason: string;
      citations: unknown[];
    };
    expect(body.refused).toBe(true);
    expect(body.answer).toBe(REFUSAL_ANSWER);
    expect(body.refusalReason).toBe(expectedReason);
    expect(body.citations).toEqual([]);

    const log = await loadLog(body.questionLogId);
    expect(log.refusalReason).toBe(expectedReason);
    expect(log.generationMs).toBeGreaterThanOrEqual(0);
    const hits = await loadHits(body.questionLogId);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => !hit.cited)).toBe(true);
    expect(await countReviewQueue(body.questionLogId)).toBe(1);
  });
});

describe('合法答案', () => {
  it.each(['退款期限为 7 天。', '退款规则…', '…'])(
    '短 chunk“%s”只作为预览返回而不泄露完整内容',
    async (content) => {
      const app = buildApp(validAnswerProvider);
      await createDocument(app, '退款政策', content);

      const response = await ask(app, { question: '退款期限是多少？' });
      const body = response.json() as {
        refused: boolean;
        citations: Array<{ preview: string }>;
      };

      expect(response.statusCode).toBe(200);
      expect(body.refused).toBe(false);
      expect(body.citations).toHaveLength(1);
      expect(body.citations[0]?.preview).not.toContain(content);
    },
  );

  it('返回答案、引用与日志快照，且不创建队列', async () => {
    const content = '订单支付后 7 个自然日内可以提交退款申请。'.repeat(10);
    const app = buildApp(
      answerWithCitations((_question, evidence) => ({
        answer: evidence.map((chunk) => `依据 [${chunk.rank}]。`).join(''),
        supported: true,
        citationRanks: evidence.map((chunk) => chunk.rank),
      })),
    );
    const documentId = await createDocument(app, '退款政策', content);
    await createDocument(app, '发票政策', '电子发票在发货后 24 小时内开具。');

    const response = await ask(app, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      questionLogId: string;
      answer: string;
      refused: boolean;
      citations: {
        rank: number;
        documentTitle: string;
        preview: string;
        distance: number;
      }[];
    };
    expect(body.refused).toBe(false);
    expect(body.answer).toContain('[1]');
    expect(body.citations.length).toBeGreaterThanOrEqual(1);
    for (const citation of body.citations) {
      expect(Object.keys(citation).sort()).toEqual([
        'distance',
        'documentTitle',
        'preview',
        'rank',
      ]);
      expect(Array.from(citation.preview).length).toBeLessThanOrEqual(160);
    }
    // 普通响应不包含完整 chunk 内容
    expect(JSON.stringify(body)).not.toContain(content);

    const log = await loadLog(body.questionLogId);
    expect(log.refused).toBe(false);
    expect(log.refusalReason).toBeNull();
    expect(log.generationMs).toBeGreaterThanOrEqual(0);
    expect(log.answerModel).toBe(testAppConfig.deepseekModel);
    expect(log.embeddingModel).toBe(testAppConfig.ollamaEmbedModel);
    expect(log.promptVersion).toBe(testAppConfig.promptVersion);

    const hits = await loadHits(body.questionLogId);
    const citedRanks = new Set(body.citations.map((citation) => citation.rank));
    expect(
      hits.every((hit) => hit.cited === (citedRanks.has(hit.rank) && hit.passedThreshold)),
    ).toBe(true);
    expect(hits.some((hit) => hit.cited)).toBe(true);
    expect(hits.some((hit) => hit.sourceDocumentId === documentId)).toBe(true);
    expect(await countReviewQueue(body.questionLogId)).toBe(0);
  });

  it('只有实际引用的 hit 标记 cited=true', async () => {
    const app = buildApp(
      answerWithCitations(() => ({
        answer: '退款期限为 7 天。[1]',
        supported: true,
        citationRanks: [1],
      })),
    );
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    await createDocument(app, '发票政策', '电子发票在发货后 24 小时内开具。');

    const response = await ask(app, { question: '如何申请退款？' });
    const body = response.json() as { questionLogId: string };
    const hits = await loadHits(body.questionLogId);
    expect(hits.length).toBe(2);
    expect(hits.filter((hit) => hit.cited).map((hit) => hit.rank)).toEqual([1]);
  });

  it('文档更新和删除后历史快照内容不变', async () => {
    const originalContent = '订单支付后 7 个自然日内可以提交退款申请。';
    const app = buildApp(validAnswerProvider);
    const documentId = await createDocument(app, '退款政策', originalContent);

    const response = await ask(app, { question: '如何申请退款？' });
    const body = response.json() as { questionLogId: string };

    const detail = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    const { updatedAt } = detail.json() as { updatedAt: string };
    const update = await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '新退款政策',
        content: '退款期限调整为 14 天。',
        sourceType: 'text',
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(update.statusCode).toBe(200);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
    });
    expect(remove.statusCode).toBe(204);

    const hits = await loadHits(body.questionLogId);
    expect(hits.length).toBe(1);
    expect(hits[0]?.documentTitle).toBe('退款政策');
    expect(hits[0]?.chunkContent).toContain(originalContent);
  });
});

describe('系统错误', () => {
  it('Embedding 连接失败返回 502 且不写日志不入队列', async () => {
    const app = buildApp(validAnswerProvider);
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const embeddingProvider = {
      async embedOne(): Promise<number[]> {
        throw new ProviderError({ kind: 'connection', provider: 'ollama' });
      },
      async embedMany(): Promise<number[][]> {
        throw new ProviderError({ kind: 'connection', provider: 'ollama' });
      },
    };
    const failing = createTestApp({
      embeddingProvider,
      answerProvider: validAnswerProvider,
    });
    apps.push(failing);

    const response = await ask(failing, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(502);
    const logs = await database.query('SELECT id FROM question_logs');
    expect(logs.rowCount).toBe(0);
    const queue = await database.query('SELECT id FROM review_queue');
    expect(queue.rowCount).toBe(0);
  });

  it.each([
    ['DeepSeek 连接失败', 'connection', 502],
    ['DeepSeek 超时', 'timeout', 504],
  ] as const)('%s返回 %i 且不写日志不入队列', async (_label, kind, statusCode) => {
    const failingAnswerProvider: AnswerProvider = {
      async generate(): Promise<string> {
        throw new ProviderError({ kind, provider: 'deepseek' });
      },
    };
    const app = buildApp(failingAnswerProvider);
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');

    const response = await ask(app, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(statusCode);
    const logs = await database.query('SELECT id FROM question_logs');
    expect(logs.rowCount).toBe(0);
    const queue = await database.query('SELECT id FROM review_queue');
    expect(queue.rowCount).toBe(0);
  });

  it('队列写入失败时日志与 hits 整体回滚并返回 500', async () => {
    const app = buildApp(answerWithCitations(() => '不是 JSON'));
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');

    await database.query(`
      CREATE OR REPLACE FUNCTION task6_fail_review_queue()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Task 6 故障注入';
      END;
      $$
    `);
    await database.query(`
      CREATE TRIGGER task6_fail_review_queue_trigger
      BEFORE INSERT ON review_queue
      FOR EACH ROW
      EXECUTE FUNCTION task6_fail_review_queue()
    `);

    const response = await ask(app, { question: '如何申请退款？' });
    expect(response.statusCode).toBe(500);
    const logs = await database.query('SELECT id FROM question_logs');
    expect(logs.rowCount).toBe(0);
    const hits = await database.query('SELECT id FROM question_log_hits');
    expect(hits.rowCount).toBe(0);
    const queue = await database.query('SELECT id FROM review_queue');
    expect(queue.rowCount).toBe(0);
  });
});
