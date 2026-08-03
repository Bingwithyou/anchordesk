import type { Pool, PoolClient } from 'pg';

import type { RetrievedChunk } from '../providers/types.js';

export interface RetrieveChunksOptions {
  database: Pool | PoolClient;
  embedding: number[];
  maxDistance: number;
  topK: number;
}

export interface RetrievalResult {
  candidates: RetrievedChunk[];
  evidence: RetrievedChunk[];
}

interface RetrievedChunkRow {
  documentId: string;
  chunkId: string;
  documentTitle: string;
  content: string;
  distance: number | string;
}

function formatVector(embedding: number[]): string {
  if (
    embedding.length !== 1024 ||
    !embedding.every((value) => Number.isFinite(value)) ||
    Math.hypot(...embedding) <= 1e-12
  ) {
    throw new Error('查询向量必须是有限、非零的 1024 维向量');
  }
  return `[${embedding.join(',')}]`;
}

export async function retrieveChunks({
  database,
  embedding,
  maxDistance,
  topK,
}: RetrieveChunksOptions): Promise<RetrievalResult> {
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
    throw new Error('topK 必须是 1 至 20 的整数');
  }
  if (!Number.isFinite(maxDistance) || maxDistance < 0) {
    throw new Error('maxDistance 必须是非负有限数');
  }

  const result = await database.query<RetrievedChunkRow>(
    `SELECT
       d.id AS "documentId",
       c.id AS "chunkId",
       d.title AS "documentTitle",
       c.content,
       c.embedding <=> $1::vector AS distance
     FROM document_chunks c
     INNER JOIN documents d ON d.id = c.document_id
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [formatVector(embedding), topK],
  );

  const candidates = result.rows.map((row, index) => ({
    rank: index + 1,
    documentId: row.documentId,
    chunkId: row.chunkId,
    documentTitle: row.documentTitle,
    content: row.content,
    distance: Number(row.distance),
  }));
  if (candidates.some((candidate) => !Number.isFinite(candidate.distance))) {
    throw new Error('数据库返回了无效的余弦距离');
  }

  return {
    candidates,
    evidence: candidates.filter(
      (candidate) => candidate.distance <= maxDistance,
    ),
  };
}
