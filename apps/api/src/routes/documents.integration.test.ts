import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { resetTestDatabase } from '../db/reset-test-db.js';
import { ProviderError } from '../providers/errors.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { FakeEmbeddingProvider } from '../test/fixtures.js';
import { createTestApp, testAppConfig } from '../test/test-app.js';

const apps: ReturnType<typeof createTestApp>[] = [];
const databaseUrls = loadDatabaseUrls();
let cleanupDatabase: ReturnType<typeof createDatabasePool>;
let initialDocumentIds = new Set<string>();
let resetSchemaAfterTest = false;

class ControllableEmbeddingProvider implements EmbeddingProvider {
  readonly #delegate = new FakeEmbeddingProvider();
  fail = false;

  async embedOne(input: string, signal?: AbortSignal): Promise<number[]> {
    if (this.fail) {
      throw new ProviderError({ kind: 'connection', provider: 'ollama' });
    }
    return this.#delegate.embedOne(input, signal);
  }

  async embedMany(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (this.fail) {
      throw new ProviderError({ kind: 'connection', provider: 'ollama' });
    }
    return this.#delegate.embedMany(inputs, signal);
  }
}

async function installChunkFailureTrigger(
  database: ReturnType<typeof createDatabasePool>,
): Promise<void> {
  await database.query(`
    CREATE OR REPLACE FUNCTION task5_fail_sentinel_chunk()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.content = '触发回滚' THEN
        RAISE EXCEPTION 'Task 5 故障注入';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.query(`
    CREATE TRIGGER task5_fail_sentinel_chunk_trigger
    BEFORE INSERT ON document_chunks
    FOR EACH ROW
    EXECUTE FUNCTION task5_fail_sentinel_chunk()
  `);
}

async function removeChunkFailureTrigger(
  database: ReturnType<typeof createDatabasePool>,
): Promise<void> {
  await database.query(`
    DROP TRIGGER IF EXISTS task5_fail_sentinel_chunk_trigger
    ON document_chunks
  `);
  await database.query('DROP FUNCTION IF EXISTS task5_fail_sentinel_chunk()');
}

beforeEach(async () => {
  cleanupDatabase = createDatabasePool(testAppConfig.databaseUrl);
  const documents = await cleanupDatabase.query<{ id: string }>(
    'SELECT id FROM documents',
  );
  initialDocumentIds = new Set(documents.rows.map(({ id }) => id));
  resetSchemaAfterTest = false;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await removeChunkFailureTrigger(cleanupDatabase);

  if (resetSchemaAfterTest) {
    await cleanupDatabase.end();
    await resetTestDatabase(databaseUrls);
    return;
  }

  const documents = await cleanupDatabase.query<{ id: string }>(
    'SELECT id FROM documents',
  );
  const createdDocumentIds = documents.rows
    .map(({ id }) => id)
    .filter((id) => !initialDocumentIds.has(id));
  if (createdDocumentIds.length > 0) {
    await cleanupDatabase.query(
      'DELETE FROM documents WHERE id = ANY($1::uuid[])',
      [createdDocumentIds],
    );
  }
  await cleanupDatabase.end();
});

describe('文档 API', () => {
  it('创建文档后可以读取完整详情', async () => {
    const app = createTestApp();
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '  退款政策  ',
        content: '订单支付后 7 个自然日内可以提交退款申请。',
        sourceType: 'markdown',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      id: expect.any(String),
      chunkCount: 1,
    });

    const documentId = created.json<{ id: string }>().id;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      id: documentId,
      title: '退款政策',
      content: '订单支付后 7 个自然日内可以提交退款申请。',
      sourceType: 'markdown',
      createdAt: expect.stringMatching(/Z$/u),
      updatedAt: expect.stringMatching(/Z$/u),
      indexedAt: expect.stringMatching(/Z$/u),
      chunkCount: 1,
    });
  });

  it('列表返回文档摘要而不返回正文', async () => {
    const app = createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '客服指南',
        content: '人工支持服务时间为周一至周五。',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;

    const response = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        {
          id: documentId,
          title: '客服指南',
          sourceType: 'text',
          createdAt: expect.stringMatching(/Z$/u),
          updatedAt: expect.stringMatching(/Z$/u),
          indexedAt: expect.stringMatching(/Z$/u),
          chunkCount: 1,
        },
      ]),
    );
    const listed = response
      .json<Array<Record<string, unknown>>>()
      .find((document) => document.id === documentId);
    expect(listed).not.toHaveProperty('content');
  });

  it('使用 expectedUpdatedAt 原子更新正文与全部 chunks', async () => {
    const app = createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '旧标题',
        content: '旧正文',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;
    const before = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    const beforeDocument = before.json<{ updatedAt: string }>();
    const newContent = '新'.repeat(901);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '新标题',
        content: newContent,
        sourceType: 'markdown',
        expectedUpdatedAt: beforeDocument.updatedAt,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      id: documentId,
      chunkCount: 2,
      updatedAt: expect.stringMatching(/Z$/u),
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    expect(detail.json()).toMatchObject({
      id: documentId,
      title: '新标题',
      content: newContent,
      sourceType: 'markdown',
      updatedAt: updated.json<{ updatedAt: string }>().updatedAt,
      indexedAt: updated.json<{ updatedAt: string }>().updatedAt,
      chunkCount: 2,
    });
    expect(detail.json<{ updatedAt: string }>().updatedAt).not.toBe(
      beforeDocument.updatedAt,
    );
  });

  it('删除文档返回 204，随后详情和重复删除返回 404', async () => {
    const app = createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '待删除文档',
        content: '待删除正文',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    const deletedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
    });

    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect(detail.statusCode).toBe(404);
    expect(deletedAgain.statusCode).toBe(404);
  });

  it('Embedding 失败时创建不落库并返回上游错误', async () => {
    const embeddingProvider = new ControllableEmbeddingProvider();
    embeddingProvider.fail = true;
    const app = createTestApp({ embeddingProvider });
    apps.push(app);
    const before = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '不应落库的文档',
        content: '私密正文不会进入错误响应。',
        sourceType: 'text',
      },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    expect(created.statusCode).toBe(502);
    expect(created.json()).toEqual({
      code: 'provider_error',
      message: 'Ollama 上游服务响应异常',
    });
    expect(after.json()).toEqual(before.json());
    expect(created.body).not.toContain('私密正文');
  });

  it('更新 Embedding 失败时完整保留旧版本', async () => {
    const embeddingProvider = new ControllableEmbeddingProvider();
    const app = createTestApp({ embeddingProvider });
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '稳定版本',
        content: '当前可用正文',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;
    const before = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    embeddingProvider.fail = true;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '损坏版本',
        content: '不应保存的新正文',
        sourceType: 'markdown',
        expectedUpdatedAt: before.json<{ updatedAt: string }>().updatedAt,
      },
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });

    expect(updated.statusCode).toBe(502);
    expect(after.json()).toEqual(before.json());
  });

  it('expectedUpdatedAt 冲突返回 409 且不删除当前 chunks', async () => {
    const app = createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '并发文档',
        content: '初始版本',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;
    const initial = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });
    const staleUpdatedAt = initial.json<{ updatedAt: string }>().updatedAt;
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '当前版本',
        content: '当前正文',
        sourceType: 'text',
        expectedUpdatedAt: staleUpdatedAt,
      },
    });
    const current = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });

    const conflicted = await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      payload: {
        title: '过期写入',
        content: '不应覆盖当前版本',
        sourceType: 'markdown',
        expectedUpdatedAt: staleUpdatedAt,
      },
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });

    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({
      code: 'document_conflict',
      message: '文档已被修改，请重新加载后再试',
    });
    expect(after.json()).toEqual(current.json());
  });

  it.each([
    ['空标题', { title: '  ', content: '正文', sourceType: 'text' }],
    ['空正文', { title: '空正文', content: '\r\n\t ', sourceType: 'text' }],
    ['非法类型', { title: '非法类型', content: '正文', sourceType: 'html' }],
    [
      '超过 100 KB',
      {
        title: '超限正文',
        content: `${'中'.repeat(34_133)}ab`,
        sourceType: 'text',
      },
    ],
  ])('%s返回 400 且不创建文档', async (_label, payload) => {
    const app = createTestApp();
    apps.push(app);
    const before = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload,
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'invalid_document',
      message: '文档输入不合法',
    });
    expect(after.json()).toEqual(before.json());
  });

  it.each([
    ['错误维度', () => [1]],
    [
      '稀疏向量',
      () => {
        const embedding = Array<number>(1_024);
        embedding[0] = 1;
        return embedding;
      },
    ],
  ])(
    'Provider 返回%s时返回 502 且不创建文档',
    async (_label, createEmbedding) => {
      const invalidEmbeddingProvider = {
        embedOne: async () => [1],
        embedMany: async (inputs: string[]) =>
          inputs.map(() => createEmbedding()),
      } satisfies EmbeddingProvider;
      const app = createTestApp({ embeddingProvider: invalidEmbeddingProvider });
      apps.push(app);
      const before = await app.inject({
        method: 'GET',
        url: '/api/documents',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/documents',
        payload: {
          title: '无效向量',
          content: '不会落库',
          sourceType: 'text',
        },
      });
      const after = await app.inject({
        method: 'GET',
        url: '/api/documents',
      });

      expect(response.statusCode).toBe(502);
      expect(after.json()).toEqual(before.json());
    },
  );

  it('Provider 返回稀疏向量列表时在事务前拒绝', async () => {
    const invalidEmbeddingProvider = {
      embedOne: async () => [1],
      embedMany: async (inputs: string[]) =>
        Array<number[]>(inputs.length),
    } satisfies EmbeddingProvider;
    const app = createTestApp({ embeddingProvider: invalidEmbeddingProvider });
    apps.push(app);
    const before = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '稀疏向量列表',
        content: '不会进入事务',
        sourceType: 'text',
      },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/documents',
    });

    expect(response.statusCode).toBe(502);
    expect(after.json()).toEqual(before.json());
  });

  it('区分非法 id、缺失资源，并且不提供 reindex 路由', async () => {
    const app = createTestApp();
    apps.push(app);
    const missingId = '00000000-0000-4000-8000-000000000000';

    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/documents/not-a-uuid',
    });
    const missingDetail = await app.inject({
      method: 'GET',
      url: `/api/documents/${missingId}`,
    });
    const missingUpdate = await app.inject({
      method: 'PUT',
      url: `/api/documents/${missingId}`,
      payload: {},
    });
    const missingDelete = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${missingId}`,
    });
    const reindex = await app.inject({
      method: 'POST',
      url: `/api/documents/${missingId}/reindex`,
    });

    expect(invalidId.statusCode).toBe(400);
    expect(missingDetail.statusCode).toBe(404);
    expect(missingUpdate.statusCode).toBe(404);
    expect(missingDelete.statusCode).toBe(404);
    expect(reindex.statusCode).toBe(404);
  });

  it('畸形 JSON 请求返回 400 而不是服务器错误', async () => {
    const app = createTestApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'invalid_request',
      message: '请求数据不合法',
    });
  });

  it('第二个 chunk 写入失败时创建事务整体回滚', async () => {
    const database = createDatabasePool(testAppConfig.databaseUrl);
    const app = createTestApp();
    apps.push(app);
    await installChunkFailureTrigger(database);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/documents',
        payload: {
          title: '创建事务回滚',
          content: `${'甲'.repeat(900)}\n\n触发回滚`,
          sourceType: 'text',
        },
      });
      const stored = await database.query<{ count: string }>(
        'SELECT count(*) FROM documents WHERE title = $1',
        ['创建事务回滚'],
      );

      expect(response.statusCode).toBe(500);
      expect(stored.rows[0]?.count).toBe('0');
    } finally {
      await removeChunkFailureTrigger(database);
      await database.end();
    }
  });

  it('新 chunks 写入失败时更新事务恢复旧正文与旧 chunks', async () => {
    const database = createDatabasePool(testAppConfig.databaseUrl);
    const app = createTestApp();
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: '更新事务回滚',
        content: '稳定正文',
        sourceType: 'text',
      },
    });
    const documentId = created.json<{ id: string }>().id;
    const before = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
    });

    await installChunkFailureTrigger(database);
    try {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/documents/${documentId}`,
        payload: {
          title: '不应保留的新标题',
          content: `${'乙'.repeat(900)}\n\n触发回滚`,
          sourceType: 'markdown',
          expectedUpdatedAt: before.json<{ updatedAt: string }>().updatedAt,
        },
      });
      const after = await app.inject({
        method: 'GET',
        url: `/api/documents/${documentId}`,
      });

      expect(response.statusCode).toBe(500);
      expect(after.json()).toEqual(before.json());
    } finally {
      await removeChunkFailureTrigger(database);
      await database.end();
    }
  });

  it('通过 HTTP 删除当前文档后仍保留历史证据快照', async () => {
    resetSchemaAfterTest = true;
    const database = createDatabasePool(testAppConfig.databaseUrl);
    const app = createTestApp();
    apps.push(app);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/documents',
        payload: {
          title: '历史快照文档',
          content: '需要长期保留的历史证据',
          sourceType: 'text',
        },
      });
      const documentId = created.json<{ id: string }>().id;
      const chunk = await database.query<{ id: string; content: string }>(
        'SELECT id, content FROM document_chunks WHERE document_id = $1',
        [documentId],
      );
      const chunkId = chunk.rows[0]?.id;
      const chunkContent = chunk.rows[0]?.content;
      if (!chunkId || !chunkContent) {
        throw new Error('测试文档缺少 chunk');
      }

      const questionLogId = randomUUID();
      await database.query(
        `INSERT INTO question_logs (
           id, question, answer, refused, refusal_reason,
           answer_model, embedding_model, rag_top_k, rag_max_distance,
           prompt_version, retrieval_ms, generation_ms, created_at
         ) VALUES (
           $1, '历史问题', '历史回答 [1]', false, NULL,
           'answer-model', 'embedding-model', 5, 0.45,
           'v1', 1, 1, CURRENT_TIMESTAMP
         )`,
        [questionLogId],
      );
      const hitId = randomUUID();
      await database.query(
        `INSERT INTO question_log_hits (
           id, question_log_id, source_document_id, source_chunk_id,
           document_title, chunk_content, rank, distance,
           passed_threshold, cited
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0.1, true, true)`,
        [
          hitId,
          questionLogId,
          documentId,
          chunkId,
          '历史快照文档',
          chunkContent,
        ],
      );

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${documentId}`,
      });
      const currentChunks = await database.query<{ count: string }>(
        'SELECT count(*) FROM document_chunks WHERE document_id = $1',
        [documentId],
      );
      const snapshot = await database.query<{
        sourceDocumentId: string;
        sourceChunkId: string;
        documentTitle: string;
        chunkContent: string;
      }>(
        `SELECT
           source_document_id AS "sourceDocumentId",
           source_chunk_id AS "sourceChunkId",
           document_title AS "documentTitle",
           chunk_content AS "chunkContent"
         FROM question_log_hits
         WHERE id = $1`,
        [hitId],
      );

      expect(deleted.statusCode).toBe(204);
      expect(currentChunks.rows[0]?.count).toBe('0');
      expect(snapshot.rows).toEqual([
        {
          sourceDocumentId: documentId,
          sourceChunkId: chunkId,
          documentTitle: '历史快照文档',
          chunkContent,
        },
      ]);
    } finally {
      await database.end();
    }
  });
});
