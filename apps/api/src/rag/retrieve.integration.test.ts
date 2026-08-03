import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { retrieveChunks } from './retrieve.js';

const { testDatabaseUrl } = loadDatabaseUrls();
const pool = createDatabasePool(testDatabaseUrl);

function vectorWith(entries: Array<[number, number]>): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  for (const [index, value] of entries) {
    vector[index] = value;
  }
  return vector;
}

function pgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

describe('pgvector 检索', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('按余弦距离返回 topK、生成 1-based rank 并分离门槛内证据', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');

    try {
      await client.query('DELETE FROM documents');
      const documents: string[] = [];
      for (const [title, content] of [
        ['退款政策', '退款内容'],
        ['配送政策', '配送内容'],
        ['技术支持', '支持内容'],
      ]) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO documents
             (id, title, content, source_type, created_at, updated_at, indexed_at)
           VALUES ($1, $2, $3, 'markdown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id, title, content],
        );
        documents.push(id);
      }

      const embeddings = [
        vectorWith([[0, 1]]),
        vectorWith([
          [0, 0.8],
          [1, 0.6],
        ]),
        vectorWith([[1, 1]]),
      ];
      for (const [index, documentId] of documents.entries()) {
        await client.query(
          `INSERT INTO document_chunks
             (id, document_id, chunk_index, content, embedding, created_at)
           VALUES ($1, $2, 0, $3, $4::vector, CURRENT_TIMESTAMP)`,
          [
            randomUUID(),
            documentId,
            `第 ${index + 1} 个 chunk`,
            pgVector(embeddings[index] ?? []),
          ],
        );
      }

      const result = await retrieveChunks({
        database: client,
        embedding: vectorWith([[0, 1]]),
        maxDistance: 0,
        topK: 2,
      });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({
        rank: 1,
        documentTitle: '退款政策',
        content: '第 1 个 chunk',
        distance: 0,
      });
      expect(result.candidates[0]?.documentId).toEqual(expect.any(String));
      expect(result.candidates[0]?.chunkId).toEqual(expect.any(String));
      expect(result.candidates[1]).toMatchObject({
        rank: 2,
        documentTitle: '配送政策',
      });
      expect(result.candidates[1]?.distance).toBeCloseTo(0.2, 7);
      expect(result.evidence).toEqual([result.candidates[0]]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
