import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type { EmbeddingProvider } from '../providers/types.js';
import { chunkDocument } from '../rag/chunk.js';
import type { EvaluationDocument } from './fixtures.js';

export interface EmbeddedChunk {
  document: EvaluationDocument;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export async function embedKnowledge(
  documents: EvaluationDocument[],
  provider: EmbeddingProvider,
): Promise<EmbeddedChunk[]> {
  const chunks = documents.flatMap((document) =>
    chunkDocument(document.content).map((content, chunkIndex) => ({
      document,
      chunkIndex,
      content,
    })),
  );
  if (chunks.length === 0) {
    throw new Error('固定评测知识库没有可索引内容');
  }

  const embeddings = await provider.embedMany(
    chunks.map((chunk) => chunk.content),
  );
  return chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? [],
  }));
}

export async function insertKnowledge(
  client: PoolClient,
  documents: EvaluationDocument[],
  chunks: EmbeddedChunk[],
): Promise<void> {
  const documentIds = new Map<string, string>();
  for (const document of documents) {
    const documentId = randomUUID();
    documentIds.set(document.filename, documentId);
    await client.query(
      `INSERT INTO documents
         (id, title, content, source_type, created_at, updated_at, indexed_at)
       VALUES ($1, $2, $3, 'markdown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [documentId, document.title, document.content],
    );
  }

  for (const chunk of chunks) {
    const documentId = documentIds.get(chunk.document.filename);
    if (!documentId) {
      throw new Error('评测文档与 chunk 的关联无效');
    }
    await client.query(
      `INSERT INTO document_chunks
         (id, document_id, chunk_index, content, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5::vector, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        documentId,
        chunk.chunkIndex,
        chunk.content,
        vectorLiteral(chunk.embedding),
      ],
    );
  }
}
