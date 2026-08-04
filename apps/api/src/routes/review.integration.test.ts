import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LightMyRequestResponse } from 'fastify';

import { loadDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { resetTestDatabase } from '../db/reset-test-db.js';
import type { AnswerProvider } from '../providers/types.js';
import { FakeAnswerProvider } from '../test/fixtures.js';
import { createTestApp } from '../test/test-app.js';

const ISO_MICROSECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const databaseUrls = loadDatabaseUrls();
const apps: ReturnType<typeof createTestApp>[] = [];
let database: ReturnType<typeof createDatabasePool>;

beforeEach(async () => {
  await resetTestDatabase(databaseUrls);
  database = createDatabasePool(databaseUrls.testDatabaseUrl);
});

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await database.query(
      'DROP TRIGGER IF EXISTS task7_fail_not_helpful_trigger ON review_queue',
    );
    await database.query('DROP FUNCTION IF EXISTS task7_fail_not_helpful()');
  } finally {
    await database.end();
    await resetTestDatabase(databaseUrls);
  }
});

const validAnswerProvider = new FakeAnswerProvider((_question, evidence) =>
  JSON.stringify({
    answer: `退款期限为 7 天。[${evidence[0]?.rank}]`,
    supported: true,
    citationRanks: [evidence[0]?.rank],
  }),
);

function buildApp(answerProvider: AnswerProvider = validAnswerProvider) {
  // Fake Embedding 是哈希向量，问题与文档天然距离较大；放宽门槛让证据通过。
  const app = createTestApp({ answerProvider, config: { ragMaxDistance: 2 } });
  apps.push(app);
  return app;
}

async function createDocument(
  app: ReturnType<typeof createTestApp>,
  title: string,
  content: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents',
    payload: { title, content, sourceType: 'text' },
  });
  expect(response.statusCode).toBe(201);
}

async function askQuestion(
  app: ReturnType<typeof createTestApp>,
  question: string,
): Promise<{ questionLogId: string; refused: boolean }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/questions',
    payload: { question },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { questionLogId: string; refused: boolean };
}

async function submitFeedback(
  app: ReturnType<typeof createTestApp>,
  payload: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/feedback',
    payload: payload as object,
  });
}

async function listLogs(
  app: ReturnType<typeof createTestApp>,
): Promise<Record<string, unknown>[]> {
  const response = await app.inject({ method: 'GET', url: '/api/logs' });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>[];
}

async function listQueue(
  app: ReturnType<typeof createTestApp>,
): Promise<Record<string, unknown>[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/review-queue',
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>[];
}

describe('日志列表', () => {
  it('无日志时返回空数组', async () => {
    const app = buildApp();
    expect(await listLogs(app)).toEqual([]);
  });

  it('返回预览摘要而不是完整问题、回答和 hits', async () => {
    const app = buildApp(
      new FakeAnswerProvider((_question, evidence) =>
        JSON.stringify({
          answer: `${'答'.repeat(200)}[${evidence[0]?.rank}]`,
          supported: true,
          citationRanks: [evidence[0]?.rank],
        }),
      ),
    );
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const longQuestion = '问'.repeat(130);
    const first = await askQuestion(app, longQuestion);
    const second = await askQuestion(app, '发票如何开具？');

    const logs = await listLogs(app);
    expect(logs.length).toBe(2);
    // created_at DESC：后提问的在前
    expect(logs[0]?.id).toBe(second.questionLogId);
    expect(logs[1]?.id).toBe(first.questionLogId);

    const summary = logs[1] as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      'answerPreview',
      'createdAt',
      'feedbackRating',
      'id',
      'questionPreview',
      'refusalReason',
      'refused',
    ]);
    expect(Array.from(summary.questionPreview as string).length).toBe(120);
    expect(Array.from(summary.answerPreview as string).length).toBe(160);
    expect(summary.refused).toBe(false);
    expect(summary.refusalReason).toBeNull();
    expect(summary.feedbackRating).toBeNull();
    expect(summary.createdAt).toMatch(ISO_MICROSECONDS);
    expect(JSON.stringify(logs)).not.toContain(longQuestion);
  });

  it('短问题与短回答也不会在摘要中完整返回', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const question = '如何退款？';
    await askQuestion(app, question);

    const logs = await listLogs(app);
    expect(logs[0]?.questionPreview).not.toBe(question);
    expect(logs[0]?.answerPreview).not.toBe('退款期限为 7 天。[1]');
  });

  it('最多返回最近 100 条', async () => {
    const app = buildApp();
    for (let index = 0; index < 101; index += 1) {
      await askQuestion(app, `第 ${index} 个问题`);
    }
    const logs = await listLogs(app);
    expect(logs.length).toBe(100);
  });

  it('摘要包含 feedback rating', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');
    await submitFeedback(app, { questionLogId, rating: 'helpful' });

    const logs = await listLogs(app);
    expect(logs[0]?.feedbackRating).toBe('helpful');
  });
});

describe('日志详情', () => {
  it('非法 UUID 返回 400，合法但不存在返回 404', async () => {
    const app = buildApp();
    const invalid = await app.inject({ method: 'GET', url: '/api/logs/abc' });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { code: string }).code).toBe(
      'invalid_review_request',
    );

    const missing = await app.inject({
      method: 'GET',
      url: '/api/logs/5f0c8f8a-1234-4abc-9def-0123456789ab',
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe('log_not_found');
  });

  it('返回完整日志、配置与全部 hits 快照', async () => {
    const app = buildApp();
    const content = '订单支付后 7 个自然日内可以提交退款申请。';
    await createDocument(app, '退款政策', content);
    await createDocument(app, '发票政策', '电子发票在发货后 24 小时内开具。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    const response = await app.inject({
      method: 'GET',
      url: `/api/logs/${questionLogId}`,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json() as Record<string, unknown> & {
      hits: Record<string, unknown>[];
    };
    expect(Object.keys(detail).sort()).toEqual([
      'answer',
      'answerModel',
      'createdAt',
      'embeddingModel',
      'feedback',
      'generationMs',
      'hits',
      'id',
      'promptVersion',
      'question',
      'ragMaxDistance',
      'ragTopK',
      'refusalReason',
      'refused',
      'retrievalMs',
    ]);
    expect(detail.question).toBe('如何申请退款？');
    expect(detail.refused).toBe(false);
    expect(detail.answerModel).toBe('deepseek-v4-pro');
    expect(detail.embeddingModel).toBe('bge-m3');
    expect(detail.ragTopK).toBe(5);
    expect(detail.ragMaxDistance).toBe(2);
    expect(detail.promptVersion).toBe('v1');
    expect(detail.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(detail.generationMs).toBeGreaterThanOrEqual(0);
    expect(detail.feedback).toBeNull();
    expect(detail.createdAt).toMatch(ISO_MICROSECONDS);

    expect(detail.hits.length).toBe(2);
    const [firstHit] = detail.hits;
    expect(Object.keys(firstHit as object).sort()).toEqual([
      'chunkContent',
      'cited',
      'distance',
      'documentTitle',
      'passedThreshold',
      'rank',
      'sourceChunkId',
      'sourceDocumentId',
    ]);
    expect(firstHit?.rank).toBe(1);
    expect(firstHit?.passedThreshold).toBe(true);
    expect(firstHit?.cited).toBe(true);
    expect(detail.hits[1]?.cited).toBe(false);
    // Fake Embedding 的距离排序不保证文档先后，只要求两个 chunk 快照都完整在场。
    const chunkContents = detail.hits.map((hit) => hit.chunkContent as string);
    expect(chunkContents.some((text) => text.includes(content))).toBe(true);
  });

  it('文档更新和删除后详情快照保持不变', async () => {
    const app = buildApp();
    const originalContent = '订单支付后 7 个自然日内可以提交退款申请。';
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '退款政策',
        content: originalContent,
        sourceType: 'text',
      },
    });
    const documentId = (created.json() as { id: string }).id;
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    const detailBefore = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    const { updatedAt } = detailBefore.json() as { updatedAt: string };
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '新退款政策',
        content: '退款期限调整为 14 天。',
        sourceType: 'text',
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(updated.statusCode).toBe(200);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
    });
    expect(removed.statusCode).toBe(204);

    const response = await app.inject({
      method: 'GET',
      url: `/api/logs/${questionLogId}`,
    });
    const detail = response.json() as {
      hits: { documentTitle: string; chunkContent: string }[];
    };
    expect(detail.hits.length).toBe(1);
    expect(detail.hits[0]?.documentTitle).toBe('退款政策');
    expect(detail.hits[0]?.chunkContent).toContain(originalContent);
  });
});

describe('Feedback', () => {
  it('helpful 返回 201、详情显示反馈且不创建队列项', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    const response = await submitFeedback(app, {
      questionLogId,
      rating: 'helpful',
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'id',
      'questionLogId',
      'rating',
    ]);
    expect(body.questionLogId).toBe(questionLogId);
    expect(body.rating).toBe('helpful');
    expect(body.createdAt).toMatch(ISO_MICROSECONDS);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/logs/${questionLogId}`,
    });
    const { feedback } = detail.json() as {
      feedback: { rating: string; createdAt: string };
    };
    expect(feedback.rating).toBe('helpful');
    expect(feedback.createdAt).toMatch(ISO_MICROSECONDS);
    expect(await listQueue(app)).toEqual([]);
  });

  it('not_helpful 同时保存反馈并创建 open 队列项', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    const response = await submitFeedback(app, {
      questionLogId,
      rating: 'not_helpful',
    });
    expect(response.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/logs/${questionLogId}`,
    });
    expect(
      (detail.json() as { feedback: { rating: string } }).feedback.rating,
    ).toBe('not_helpful');

    const queue = await listQueue(app);
    expect(queue.length).toBe(1);
    expect(queue[0]?.questionLogId).toBe(questionLogId);
    expect(queue[0]?.itemType).toBe('not_helpful');
    expect(queue[0]?.status).toBe('open');
    expect(queue[0]?.note).toBeNull();
    expect(queue[0]?.resolvedAt).toBeNull();
  });

  it.each([
    ['非法 rating', { questionLogId: '5f0c8f8a-1234-4abc-9def-0123456789ab', rating: 'great' }],
    ['非法 UUID', { questionLogId: 'abc', rating: 'helpful' }],
    ['额外字段', {
      questionLogId: '5f0c8f8a-1234-4abc-9def-0123456789ab',
      rating: 'helpful',
      note: '多余',
    }],
  ])('%s返回 400', async (_label, payload) => {
    const app = buildApp();
    const response = await submitFeedback(app, payload);
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe(
      'invalid_review_request',
    );
  });

  it('日志不存在返回 404', async () => {
    const app = buildApp();
    const response = await submitFeedback(app, {
      questionLogId: '5f0c8f8a-1234-4abc-9def-0123456789ab',
      rating: 'helpful',
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { code: string }).code).toBe('log_not_found');
  });

  it('拒答日志提交反馈返回 409', async () => {
    const app = buildApp();
    const { questionLogId, refused } = await askQuestion(app, '如何申请退款？');
    expect(refused).toBe(true);

    const response = await submitFeedback(app, {
      questionLogId,
      rating: 'helpful',
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe(
      'feedback_conflict',
    );
  });

  it('重复反馈返回 409 且不产生第二个队列项', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    const first = await submitFeedback(app, {
      questionLogId,
      rating: 'not_helpful',
    });
    expect(first.statusCode).toBe(201);
    const second = await submitFeedback(app, {
      questionLogId,
      rating: 'helpful',
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('feedback_conflict');
    expect((await listQueue(app)).length).toBe(1);
  });

  it('队列写入失败时反馈整体回滚', async () => {
    const app = buildApp();
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const { questionLogId } = await askQuestion(app, '如何申请退款？');

    await database.query(`
      CREATE OR REPLACE FUNCTION task7_fail_not_helpful()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.item_type = 'not_helpful' THEN
          RAISE EXCEPTION 'Task 7 故障注入';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.query(`
      CREATE TRIGGER task7_fail_not_helpful_trigger
      BEFORE INSERT ON review_queue
      FOR EACH ROW
      EXECUTE FUNCTION task7_fail_not_helpful()
    `);

    const response = await submitFeedback(app, {
      questionLogId,
      rating: 'not_helpful',
    });
    expect(response.statusCode).toBe(500);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/logs/${questionLogId}`,
    });
    expect((detail.json() as { feedback: unknown }).feedback).toBeNull();
    expect(await listQueue(app)).toEqual([]);
  });
});

describe('Review Queue', () => {
  it('同时展示 refusal 和 not_helpful 项及完整原文', async () => {
    const app = buildApp();
    const refusal = await askQuestion(app, '公司股票代码是什么？');
    await createDocument(app, '退款政策', '订单支付后 7 个自然日内可以提交退款申请。');
    const answered = await askQuestion(app, '如何申请退款？');
    await submitFeedback(app, {
      questionLogId: answered.questionLogId,
      rating: 'not_helpful',
    });

    const queue = await listQueue(app);
    expect(queue.length).toBe(2);
    for (const item of queue) {
      expect(Object.keys(item).sort()).toEqual([
        'answer',
        'createdAt',
        'feedbackRating',
        'id',
        'itemType',
        'note',
        'question',
        'questionLogId',
        'refusalReason',
        'resolvedAt',
        'status',
      ]);
    }

    const refusalItem = queue.find(
      (item) => item.questionLogId === refusal.questionLogId,
    );
    expect(refusalItem?.itemType).toBe('refusal');
    expect(refusalItem?.refusalReason).toBe('no_chunks');
    expect(refusalItem?.feedbackRating).toBeNull();
    expect(refusalItem?.question).toBe('公司股票代码是什么？');
    expect(refusalItem?.answer).toBe('知识库中没有足够依据回答这个问题。');

    const notHelpfulItem = queue.find(
      (item) => item.questionLogId === answered.questionLogId,
    );
    expect(notHelpfulItem?.itemType).toBe('not_helpful');
    expect(notHelpfulItem?.refusalReason).toBeNull();
    expect(notHelpfulItem?.feedbackRating).toBe('not_helpful');
    expect(notHelpfulItem?.question).toBe('如何申请退款？');
    expect(notHelpfulItem?.answer).toContain('[1]');
  });

  it('open 项排在 resolved 项之前', async () => {
    const app = buildApp();
    const older = await askQuestion(app, '第一个问题？');
    const newer = await askQuestion(app, '第二个问题？');

    const queueBefore = await listQueue(app);
    const newerItem = queueBefore.find(
      (item) => item.questionLogId === newer.questionLogId,
    );
    const resolve = await app.inject({
      method: 'PUT',
      url: `/api/review-queue/${newerItem?.id as string}/resolve`,
      payload: { note: '已补充相关文档。' },
    });
    expect(resolve.statusCode).toBe(200);

    const queue = await listQueue(app);
    expect(queue.length).toBe(2);
    expect(queue[0]?.questionLogId).toBe(older.questionLogId);
    expect(queue[0]?.status).toBe('open');
    expect(queue[1]?.questionLogId).toBe(newer.questionLogId);
    expect(queue[1]?.status).toBe('resolved');
  });
});

describe('手动解决', () => {
  async function createOpenItem(
    app: ReturnType<typeof createTestApp>,
  ): Promise<string> {
    await askQuestion(app, '这是待处理问题？');
    const queue = await listQueue(app);
    return queue[0]?.id as string;
  }

  it('保存 note 与 resolvedAt 并返回 200', async () => {
    const app = buildApp();
    const itemId = await createOpenItem(app);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/review-queue/${itemId}/resolve`,
      payload: { note: '  已补充退款到账时效说明。  ' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'id',
      'note',
      'resolvedAt',
      'status',
    ]);
    expect(body.id).toBe(itemId);
    expect(body.status).toBe('resolved');
    expect(body.note).toBe('已补充退款到账时效说明。');
    expect(body.resolvedAt).toMatch(ISO_MICROSECONDS);

    const queue = await listQueue(app);
    expect(queue[0]?.status).toBe('resolved');
    expect(queue[0]?.note).toBe('已补充退款到账时效说明。');
    expect(queue[0]?.resolvedAt).toBe(body.resolvedAt);
  });

  it.each([
    ['空 note', { note: '   ' }],
    ['超长 note', { note: '备'.repeat(1001) }],
    ['额外字段', { note: '备注', force: true }],
  ])('%s返回 400', async (_label, payload) => {
    const app = buildApp();
    const itemId = await createOpenItem(app);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/review-queue/${itemId}/resolve`,
      payload,
    });
    expect(response.statusCode).toBe(400);
    const queue = await listQueue(app);
    expect(queue[0]?.status).toBe('open');
  });

  it('非法 UUID 返回 400，不存在返回 404', async () => {
    const app = buildApp();
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/review-queue/abc/resolve',
      payload: { note: '备注' },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/review-queue/5f0c8f8a-1234-4abc-9def-0123456789ab/resolve',
      payload: { note: '备注' },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe(
      'review_item_not_found',
    );
  });

  it('重复解决返回 409 且保留第一次的 note', async () => {
    const app = buildApp();
    const itemId = await createOpenItem(app);
    const first = await app.inject({
      method: 'PUT',
      url: `/api/review-queue/${itemId}/resolve`,
      payload: { note: '第一次解决。' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'PUT',
      url: `/api/review-queue/${itemId}/resolve`,
      payload: { note: '第二次解决。' },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe(
      'review_item_conflict',
    );

    const queue = await listQueue(app);
    expect(queue[0]?.note).toBe('第一次解决。');
  });
});
