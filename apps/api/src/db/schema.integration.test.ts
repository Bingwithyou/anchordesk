import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from './database-config.js';
import { runMigrations } from './migrate.js';
import { createDatabasePool } from './pool.js';

const { testDatabaseUrl } = loadDatabaseUrls();
const pool = createDatabasePool(testDatabaseUrl);
const embedding = `[1,${Array.from({ length: 1_023 }, () => '0').join(',')}]`;
const orthogonalEmbedding = `[0,1,${Array.from({ length: 1_022 }, () => '0').join(',')}]`;

interface QuestionLogOverrides {
  generationMs?: number | null;
  ragTopK?: number;
  refusalReason?: string | null;
  refused?: boolean;
  retrievalMs?: number;
}

async function insertQuestionLog(
  overrides: QuestionLogOverrides = {},
): Promise<string> {
  const questionLogId = randomUUID();
  await pool.query(
    `
      INSERT INTO question_logs (
        id,
        question,
        answer,
        refused,
        refusal_reason,
        answer_model,
        embedding_model,
        rag_top_k,
        rag_max_distance,
        prompt_version,
        retrieval_ms,
        generation_ms,
        created_at
      ) VALUES (
        $1, '问题', '答案 [1]', $2, $3, 'answer-model', 'embedding-model',
        $4, 0.55, 'v1', $5, $6, NOW()
      )
    `,
    [
      questionLogId,
      overrides.refused ?? false,
      overrides.refusalReason ?? null,
      overrides.ragTopK ?? 5,
      overrides.retrievalMs ?? 1,
      overrides.generationMs === undefined ? 1 : overrides.generationMs,
    ],
  );

  return questionLogId;
}

describe('PostgreSQL schema', () => {
  beforeAll(async () => {
    await runMigrations({ connectionString: testDatabaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('建立业务表、vector(1024) 与 cosine HNSW 索引', async () => {
    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'document_chunks',
      'documents',
      'feedback',
      'question_log_hits',
      'question_logs',
      'review_queue',
      'schema_migrations',
    ]);

    const extension = await pool.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    expect(extension.rows[0]?.extversion).toMatch(/^\d+\.\d+/u);

    const embeddingType = await pool.query<{ data_type: string }>(`
      SELECT format_type(attribute.atttypid, attribute.atttypmod) AS data_type
      FROM pg_attribute AS attribute
      JOIN pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'document_chunks'
        AND attribute.attname = 'embedding'
        AND NOT attribute.attisdropped
    `);
    expect(embeddingType.rows).toEqual([{ data_type: 'vector(1024)' }]);

    const index = await pool.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'document_chunks'
        AND indexname = 'document_chunks_embedding_hnsw_idx'
    `);
    expect(index.rows[0]?.indexdef).toContain(
      'USING hnsw (embedding vector_cosine_ops)',
    );
  });

  it('执行 1024 维向量校验和余弦距离排序', async () => {
    const documentId = randomUUID();
    await pool.query(
      `
        INSERT INTO documents (
          id, title, content, source_type, created_at, updated_at, indexed_at
        ) VALUES ($1, '向量文档', '向量正文', 'text', NOW(), NOW(), NOW())
      `,
      [documentId],
    );

    await expect(
      pool.query(
        `
          INSERT INTO document_chunks (
            id, document_id, chunk_index, content, embedding, created_at
          ) VALUES ($1, $2, 0, '错误维度', '[1,0,0]'::vector, NOW())
        `,
        [randomUUID(), documentId],
      ),
    ).rejects.toMatchObject({ code: '22000' });

    await pool.query(
      `
        INSERT INTO document_chunks (
          id, document_id, chunk_index, content, embedding, created_at
        ) VALUES
          ($1, $2, 0, '同方向', $3::vector, NOW()),
          ($4, $2, 1, '正交方向', $5::vector, NOW())
      `,
      [
        randomUUID(),
        documentId,
        embedding,
        randomUUID(),
        orthogonalEmbedding,
      ],
    );

    const distances = await pool.query<{ content: string; distance: number }>(
      `
        SELECT content, embedding <=> $1::vector AS distance
        FROM document_chunks
        WHERE document_id = $2
        ORDER BY distance
      `,
      [embedding, documentId],
    );
    expect(distances.rows.map((row) => row.content)).toEqual([
      '同方向',
      '正交方向',
    ]);
    expect(Number(distances.rows[0]?.distance)).toBeCloseTo(0);
    expect(Number(distances.rows[1]?.distance)).toBeCloseTo(1);
  });

  it('约束文档类型、chunk 外键和每份文档的 chunk 序号', async () => {
    await expect(
      pool.query(
        `
          INSERT INTO documents (
            id, title, content, source_type, created_at, updated_at, indexed_at
          ) VALUES ($1, '标题', '正文', 'html', NOW(), NOW(), NOW())
        `,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(
        `
          INSERT INTO document_chunks (
            id, document_id, chunk_index, content, embedding, created_at
          ) VALUES ($1, $2, 0, '证据', $3::vector, NOW())
        `,
        [randomUUID(), randomUUID(), embedding],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const documentId = randomUUID();
    await pool.query(
      `
        INSERT INTO documents (
          id, title, content, source_type, created_at, updated_at, indexed_at
        ) VALUES ($1, '标题', '正文', 'markdown', NOW(), NOW(), NOW())
      `,
      [documentId],
    );
    await pool.query(
      `
        INSERT INTO document_chunks (
          id, document_id, chunk_index, content, embedding, created_at
        ) VALUES ($1, $2, 0, '证据', $3::vector, NOW())
      `,
      [randomUUID(), documentId, embedding],
    );

    await expect(
      pool.query(
        `
          INSERT INTO document_chunks (
            id, document_id, chunk_index, content, embedding, created_at
          ) VALUES ($1, $2, 0, '重复序号', $3::vector, NOW())
        `,
        [randomUUID(), documentId, embedding],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('约束拒答原因、两级生成耗时、topK 和检索耗时', async () => {
    await expect(
      insertQuestionLog({
        refusalReason: 'unknown_reason',
        refused: true,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({ refusalReason: 'no_chunks', refused: false }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({ generationMs: null, refused: true }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({
        generationMs: 1,
        refusalReason: 'no_chunks',
        refused: true,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({
        generationMs: null,
        refusalReason: 'model_refused',
        refused: true,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({ generationMs: null }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({ ragTopK: 0 }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertQuestionLog({ retrievalMs: -1 }),
    ).rejects.toMatchObject({ code: '23514' });

    for (const refusalReason of [
      'no_chunks',
      'low_similarity',
      'model_refused',
      'empty_answer',
      'invalid_model_output',
      'invalid_citation',
    ]) {
      const retrievalRefusal = ['no_chunks', 'low_similarity'].includes(
        refusalReason,
      );
      await insertQuestionLog({
        generationMs: retrievalRefusal ? null : 0,
        refusalReason,
        refused: true,
      });
    }
  });

  it('约束证据快照的日志外键、rank、distance 和引用状态', async () => {
    await expect(
      pool.query(
        `
          INSERT INTO question_log_hits (
            id,
            question_log_id,
            source_document_id,
            source_chunk_id,
            document_title,
            chunk_content,
            rank,
            distance,
            passed_threshold,
            cited
          ) VALUES ($1, $2, $3, $4, '标题', '证据', 1, 0.1, true, true)
        `,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const questionLogId = await insertQuestionLog();
    const sourceDocumentId = randomUUID();
    const sourceChunkId = randomUUID();
    await pool.query(
      `
        INSERT INTO question_log_hits (
          id,
          question_log_id,
          source_document_id,
          source_chunk_id,
          document_title,
          chunk_content,
          rank,
          distance,
          passed_threshold,
          cited
        ) VALUES ($1, $2, $3, $4, '已删除来源', '历史证据', 1, 0.1, true, true)
      `,
      [randomUUID(), questionLogId, sourceDocumentId, sourceChunkId],
    );

    await expect(
      pool.query(
        `
          INSERT INTO question_log_hits (
            id, question_log_id, source_document_id, source_chunk_id,
            document_title, chunk_content, rank, distance,
            passed_threshold, cited
          ) VALUES ($1, $2, $3, $4, '标题', '证据', 1, 0.2, true, false)
        `,
        [randomUUID(), questionLogId, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    for (const invalidHit of [
      { cited: false, distance: 0.1, passed: true, rank: 0 },
      { cited: false, distance: -0.1, passed: true, rank: 2 },
      { cited: true, distance: 0.1, passed: false, rank: 3 },
    ]) {
      await expect(
        pool.query(
          `
            INSERT INTO question_log_hits (
              id, question_log_id, source_document_id, source_chunk_id,
              document_title, chunk_content, rank, distance,
              passed_threshold, cited
            ) VALUES ($1, $2, $3, $4, '标题', '证据', $5, $6, $7, $8)
          `,
          [
            randomUUID(),
            questionLogId,
            randomUUID(),
            randomUUID(),
            invalidHit.rank,
            invalidHit.distance,
            invalidHit.passed,
            invalidHit.cited,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('约束反馈和待处理队列的枚举、唯一性与解决状态', async () => {
    const feedbackLogId = await insertQuestionLog();
    await expect(
      pool.query(
        `
          INSERT INTO feedback (id, question_log_id, rating, created_at)
          VALUES ($1, $2, 'neutral', NOW())
        `,
        [randomUUID(), feedbackLogId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await pool.query(
      `
        INSERT INTO feedback (id, question_log_id, rating, created_at)
        VALUES ($1, $2, 'helpful', NOW())
      `,
      [randomUUID(), feedbackLogId],
    );
    await expect(
      pool.query(
        `
          INSERT INTO feedback (id, question_log_id, rating, created_at)
          VALUES ($1, $2, 'not_helpful', NOW())
        `,
        [randomUUID(), feedbackLogId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const reviewLogId = await insertQuestionLog();
    for (const invalidQueueItem of [
      {
        itemType: 'unknown',
        note: null,
        resolvedAt: null,
        status: 'open',
      },
      {
        itemType: 'refusal',
        note: null,
        resolvedAt: null,
        status: 'unknown',
      },
      {
        itemType: 'refusal',
        note: null,
        resolvedAt: new Date(),
        status: 'open',
      },
      {
        itemType: 'refusal',
        note: null,
        resolvedAt: null,
        status: 'resolved',
      },
      {
        itemType: 'refusal',
        note: '字'.repeat(1_001),
        resolvedAt: null,
        status: 'open',
      },
    ]) {
      await expect(
        pool.query(
          `
            INSERT INTO review_queue (
              id, question_log_id, item_type, status, note, created_at, resolved_at
            ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
          `,
          [
            randomUUID(),
            reviewLogId,
            invalidQueueItem.itemType,
            invalidQueueItem.status,
            invalidQueueItem.note,
            invalidQueueItem.resolvedAt,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }

    await pool.query(
      `
        INSERT INTO review_queue (
          id, question_log_id, item_type, status, note, created_at, resolved_at
        ) VALUES ($1, $2, 'refusal', 'open', NULL, NOW(), NULL)
      `,
      [randomUUID(), reviewLogId],
    );
    await expect(
      pool.query(
        `
          INSERT INTO review_queue (
            id, question_log_id, item_type, status, note, created_at, resolved_at
          ) VALUES ($1, $2, 'not_helpful', 'open', NULL, NOW(), NULL)
        `,
        [randomUUID(), reviewLogId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('删除文档后保留历史快照，并阻止日志与快照修改', async () => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await pool.query(
      `
        INSERT INTO documents (
          id, title, content, source_type, created_at, updated_at, indexed_at
        ) VALUES ($1, '历史标题', '历史正文', 'text', NOW(), NOW(), NOW())
      `,
      [documentId],
    );
    await pool.query(
      `
        INSERT INTO document_chunks (
          id, document_id, chunk_index, content, embedding, created_at
        ) VALUES ($1, $2, 0, '历史证据', $3::vector, NOW())
      `,
      [chunkId, documentId, embedding],
    );

    const questionLogId = await insertQuestionLog();
    const hitId = randomUUID();
    await pool.query(
      `
        INSERT INTO question_log_hits (
          id, question_log_id, source_document_id, source_chunk_id,
          document_title, chunk_content, rank, distance,
          passed_threshold, cited
        ) VALUES ($1, $2, $3, $4, '历史标题', '历史证据', 1, 0.1, true, true)
      `,
      [hitId, questionLogId, documentId, chunkId],
    );

    await pool.query('DELETE FROM documents WHERE id = $1', [documentId]);
    const chunks = await pool.query<{ count: string }>(
      'SELECT count(*) FROM document_chunks WHERE id = $1',
      [chunkId],
    );
    const hits = await pool.query<{ count: string }>(
      'SELECT count(*) FROM question_log_hits WHERE id = $1',
      [hitId],
    );
    expect(chunks.rows[0]?.count).toBe('0');
    expect(hits.rows[0]?.count).toBe('1');

    await expect(
      pool.query("UPDATE question_logs SET answer = '已篡改' WHERE id = $1", [
        questionLogId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query('DELETE FROM question_logs WHERE id = $1', [questionLogId]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query('UPDATE question_log_hits SET cited = false WHERE id = $1', [
        hitId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      pool.query('DELETE FROM question_log_hits WHERE id = $1', [hitId]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
