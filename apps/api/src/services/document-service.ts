import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type {
  CreateDocumentRequest,
  DocumentCreatedResponse,
  DocumentDetail,
  DocumentSummary,
  DocumentUpdatedResponse,
  UpdateDocumentRequest,
} from '@anchordesk/shared';

import { inTransaction } from '../db/transaction.js';
import { ProviderError } from '../providers/errors.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { chunkDocument } from '../rag/chunk.js';

export interface DocumentService {
  createDocument(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<DocumentCreatedResponse>;
  deleteDocument(id: string): Promise<void>;
  getDocument(id: string): Promise<DocumentDetail | null>;
  listDocuments(): Promise<DocumentSummary[]>;
  updateDocument(
    id: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<DocumentUpdatedResponse>;
}

export interface CreateDocumentServiceOptions {
  database: Pool;
  embeddingProvider: EmbeddingProvider;
}

export const MAX_DOCUMENT_CONTENT_BYTES = 100 * 1024;

export type DocumentServiceErrorCode =
  | 'invalid_document'
  | 'document_not_found'
  | 'document_conflict';

const documentErrorDetails: Record<
  DocumentServiceErrorCode,
  { message: string; statusCode: 400 | 404 | 409 }
> = {
  invalid_document: { message: '文档输入不合法', statusCode: 400 },
  document_not_found: { message: '文档不存在', statusCode: 404 },
  document_conflict: {
    message: '文档已被修改，请重新加载后再试',
    statusCode: 409,
  },
};

export class DocumentServiceError extends Error {
  readonly code: DocumentServiceErrorCode;
  readonly statusCode: 400 | 404 | 409;

  constructor(code: DocumentServiceErrorCode = 'invalid_document') {
    const details = documentErrorDetails[code];
    super(details.message);
    this.name = 'DocumentServiceError';
    this.code = code;
    this.statusCode = details.statusCode;
  }
}

export function parseCreateDocumentInput(value: unknown): CreateDocumentRequest {
  if (typeof value !== 'object' || value === null) {
    throw new DocumentServiceError();
  }

  const input = value as Record<string, unknown>;
  const allowedFields = new Set(['title', 'content', 'sourceType']);
  if (
    Object.keys(input).length !== allowedFields.size ||
    Object.keys(input).some((field) => !allowedFields.has(field)) ||
    typeof input.title !== 'string' ||
    typeof input.content !== 'string' ||
    (input.sourceType !== 'markdown' && input.sourceType !== 'text')
  ) {
    throw new DocumentServiceError();
  }

  const title = input.title.trim();
  if (
    Array.from(title).length < 1 ||
    Array.from(title).length > 120 ||
    input.content.trim() === '' ||
    Buffer.byteLength(input.content, 'utf8') > MAX_DOCUMENT_CONTENT_BYTES
  ) {
    throw new DocumentServiceError();
  }

  return {
    title,
    content: input.content,
    sourceType: input.sourceType,
  };
}

export function parseUpdateDocumentInput(value: unknown): UpdateDocumentRequest {
  if (typeof value !== 'object' || value === null) {
    throw new DocumentServiceError();
  }

  const input = value as Record<string, unknown>;
  const allowedFields = new Set([
    'title',
    'content',
    'sourceType',
    'expectedUpdatedAt',
  ]);
  if (
    Object.keys(input).length !== allowedFields.size ||
    Object.keys(input).some((field) => !allowedFields.has(field)) ||
    typeof input.expectedUpdatedAt !== 'string' ||
    !isValidExpectedUpdatedAt(input.expectedUpdatedAt)
  ) {
    throw new DocumentServiceError();
  }

  const document = parseCreateDocumentInput({
    title: input.title,
    content: input.content,
    sourceType: input.sourceType,
  });
  return { ...document, expectedUpdatedAt: input.expectedUpdatedAt };
}

function isValidExpectedUpdatedAt(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

function validateEmbeddings(
  embeddings: number[][],
  expectedCount: number,
): void {
  const invalidResponse = (): ProviderError =>
    new ProviderError({
      kind: 'invalid_response',
      provider: 'ollama',
    });

  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    throw invalidResponse();
  }

  for (let embeddingIndex = 0; embeddingIndex < expectedCount; embeddingIndex += 1) {
    const embedding = embeddings[embeddingIndex];
    if (!Array.isArray(embedding) || embedding.length !== 1024) {
      throw invalidResponse();
    }

    for (let valueIndex = 0; valueIndex < embedding.length; valueIndex += 1) {
      const value = embedding[valueIndex];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidResponse();
      }
    }

    const norm = Math.hypot(...embedding);
    if (!Number.isFinite(norm) || norm <= 1e-12) {
      throw invalidResponse();
    }
  }
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

async function insertDocumentChunks(
  client: PoolClient,
  documentId: string,
  chunks: string[],
  embeddings: number[][],
): Promise<void> {
  for (const [chunkIndex, content] of chunks.entries()) {
    await client.query(
      `INSERT INTO document_chunks
         (id, document_id, chunk_index, content, embedding, created_at)
       VALUES
         ($1, $2, $3, $4, $5::vector, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        documentId,
        chunkIndex,
        content,
        vectorLiteral(embeddings[chunkIndex] ?? []),
      ],
    );
  }
}

export function createDocumentService({
  database,
  embeddingProvider,
}: CreateDocumentServiceOptions): DocumentService {
  return {
    async createDocument(
      value: unknown,
      signal?: AbortSignal,
    ): Promise<DocumentCreatedResponse> {
      const input = parseCreateDocumentInput(value);
      const chunks = chunkDocument(input.content);
      if (chunks.length === 0) {
        throw new DocumentServiceError();
      }
      const embeddings = await embeddingProvider.embedMany(chunks, signal);
      validateEmbeddings(embeddings, chunks.length);

      const documentId = randomUUID();
      await inTransaction(database, async (client) => {
        await client.query(
          `INSERT INTO documents
             (id, title, content, source_type, created_at, updated_at, indexed_at)
           VALUES
             ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [documentId, input.title, input.content, input.sourceType],
        );
        await insertDocumentChunks(
          client,
          documentId,
          chunks,
          embeddings,
        );
      });

      return { id: documentId, chunkCount: chunks.length };
    },

    async deleteDocument(id: string): Promise<void> {
      const deleted = await database.query(
        'DELETE FROM documents WHERE id = $1 RETURNING id',
        [id],
      );
      if (deleted.rowCount !== 1) {
        throw new DocumentServiceError('document_not_found');
      }
    },

    async getDocument(id: string): Promise<DocumentDetail | null> {
      const result = await database.query<DocumentDetail>(
        `SELECT
           d.id,
           d.title,
           d.content,
           d.source_type AS "sourceType",
           to_char(
             d.created_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "createdAt",
           to_char(
             d.updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "updatedAt",
           to_char(
             d.indexed_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "indexedAt",
           count(c.id)::integer AS "chunkCount"
         FROM documents d
         LEFT JOIN document_chunks c ON c.document_id = d.id
         WHERE d.id = $1
         GROUP BY d.id`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async listDocuments(): Promise<DocumentSummary[]> {
      const result = await database.query<DocumentSummary>(
        `SELECT
           d.id,
           d.title,
           d.source_type AS "sourceType",
           to_char(
             d.created_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "createdAt",
           to_char(
             d.updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "updatedAt",
           to_char(
             d.indexed_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "indexedAt",
           count(c.id)::integer AS "chunkCount"
         FROM documents d
         LEFT JOIN document_chunks c ON c.document_id = d.id
         GROUP BY d.id
         ORDER BY d.updated_at DESC, d.id ASC`,
      );
      return result.rows;
    },

    async updateDocument(
      id: string,
      value: unknown,
      signal?: AbortSignal,
    ): Promise<DocumentUpdatedResponse> {
      const existing = await database.query<{ id: string }>(
        'SELECT id FROM documents WHERE id = $1',
        [id],
      );
      if (!existing.rows[0]) {
        throw new DocumentServiceError('document_not_found');
      }

      const input = parseUpdateDocumentInput(value);
      const chunks = chunkDocument(input.content);
      if (chunks.length === 0) {
        throw new DocumentServiceError();
      }
      const embeddings = await embeddingProvider.embedMany(chunks, signal);
      validateEmbeddings(embeddings, chunks.length);

      const updatedAt = await inTransaction(database, async (client) => {
        const updated = await client.query<{ updatedAt: string }>(
          `WITH version AS (SELECT clock_timestamp() AS value)
           UPDATE documents d
           SET
             title = $2,
             content = $3,
             source_type = $4,
             updated_at = version.value,
             indexed_at = version.value
           FROM version
           WHERE d.id = $1
             AND d.updated_at = $5::timestamptz
           RETURNING to_char(
             d.updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS "updatedAt"`,
          [
            id,
            input.title,
            input.content,
            input.sourceType,
            input.expectedUpdatedAt,
          ],
        );
        const version = updated.rows[0]?.updatedAt;
        if (updated.rowCount !== 1 || !version) {
          throw new DocumentServiceError('document_conflict');
        }

        await client.query('DELETE FROM document_chunks WHERE document_id = $1', [
          id,
        ]);
        await insertDocumentChunks(client, id, chunks, embeddings);
        return version;
      });

      return { id, chunkCount: chunks.length, updatedAt };
    },
  };
}
