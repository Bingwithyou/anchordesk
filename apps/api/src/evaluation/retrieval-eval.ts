import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PoolClient } from 'pg';

import {
  loadRetrievalEvaluationConfig,
  type RetrievalEvaluationConfig,
} from '../config.js';
import { assertSafeTestDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { OllamaEmbeddingProvider } from '../providers/ollama.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { chunkDocument } from '../rag/chunk.js';
import { retrieveChunks } from '../rag/retrieve.js';
import {
  defaultFixtureRoot,
  loadEvaluationFixtures,
  type EvaluationDocument,
} from './fixtures.js';
import {
  evaluateRetrievalCase,
  type RetrievalCaseReport,
} from './retrieval-evaluator.js';

interface EmbeddedChunk {
  document: EvaluationDocument;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface RetrievalEvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  embeddingModel: string;
  topK: number;
  maxDistance: number;
  fixtures: {
    documentCount: number;
    caseCount: number;
    dataClassification: 'synthetic';
  };
  summary: {
    passed: number;
    total: number;
    answerPassed: number;
    answerTotal: number;
    generationRefusalPassed: number;
    generationRefusalTotal: number;
    retrievalRefusalPassed: number;
    retrievalRefusalTotal: number;
  };
  cases: RetrievalCaseReport[];
}

export interface RetrievalEvaluationResult {
  report: RetrievalEvaluationReport;
  reportPath: string;
}

const reportDirectory = resolve(defaultFixtureRoot, '../reports/retrieval');

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

async function embedKnowledge(
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

async function insertKnowledge(
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

function countBy(
  reports: RetrievalCaseReport[],
  predicate: (report: RetrievalCaseReport) => boolean,
): { passed: number; total: number } {
  const matching = reports.filter(predicate);
  return {
    passed: matching.filter((report) => report.passed).length,
    total: matching.length,
  };
}

function createReport(
  config: RetrievalEvaluationConfig,
  documentCount: number,
  reports: RetrievalCaseReport[],
): RetrievalEvaluationReport {
  const answers = countBy(
    reports,
    (report) => report.expectedOutcome === 'answer',
  );
  const generationRefusals = countBy(
    reports,
    (report) => report.expectedRefusalStage === 'generation',
  );
  const retrievalRefusals = countBy(
    reports,
    (report) => report.expectedRefusalStage === 'retrieval',
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    embeddingModel: config.ollamaEmbedModel,
    topK: config.ragTopK,
    maxDistance: config.ragMaxDistance,
    fixtures: {
      documentCount,
      caseCount: reports.length,
      dataClassification: 'synthetic',
    },
    summary: {
      passed: reports.filter((report) => report.passed).length,
      total: reports.length,
      answerPassed: answers.passed,
      answerTotal: answers.total,
      generationRefusalPassed: generationRefusals.passed,
      generationRefusalTotal: generationRefusals.total,
      retrievalRefusalPassed: retrievalRefusals.passed,
      retrievalRefusalTotal: retrievalRefusals.total,
    },
    cases: reports,
  };
}

async function writeReport(
  report: RetrievalEvaluationReport,
): Promise<string> {
  await mkdir(reportDirectory, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/gu, '-');
  const reportPath = resolve(reportDirectory, `${timestamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

export async function runRetrievalEvaluation(
  config = loadRetrievalEvaluationConfig(),
): Promise<RetrievalEvaluationResult> {
  assertSafeTestDatabaseUrls({
    databaseUrl: config.databaseUrl,
    testDatabaseUrl: config.testDatabaseUrl,
  });

  const fixtures = await loadEvaluationFixtures();
  const embeddingProvider = new OllamaEmbeddingProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaEmbedModel,
    timeoutMs: config.ollamaTimeoutMs,
  });
  const embeddedChunks = await embedKnowledge(
    fixtures.documents,
    embeddingProvider,
  );
  const questionEmbeddings: number[][] = [];
  for (const [index, evaluationCase] of fixtures.cases.entries()) {
    console.log(`正在生成评测问题向量：${index + 1}/${fixtures.cases.length}`);
    questionEmbeddings.push(
      await embeddingProvider.embedOne(evaluationCase.question),
    );
  }

  const pool = createDatabasePool(config.testDatabaseUrl);
  const caseReports: RetrievalCaseReport[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await insertKnowledge(client, fixtures.documents, embeddedChunks);
        for (const [index, evaluationCase] of fixtures.cases.entries()) {
          const embedding = questionEmbeddings[index];
          if (!embedding) {
            throw new Error(`评测问题缺少向量：${evaluationCase.id}`);
          }
          const retrieval = await retrieveChunks({
            database: client,
            embedding,
            maxDistance: config.ragMaxDistance,
            topK: config.ragTopK,
          });
          caseReports.push(
            evaluateRetrievalCase(
              evaluationCase,
              retrieval,
              config.ragMaxDistance,
            ),
          );
        }
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  const report = createReport(config, fixtures.documents.length, caseReports);
  return { report, reportPath: await writeReport(report) };
}

async function main(): Promise<void> {
  const { report, reportPath } = await runRetrievalEvaluation();
  console.log(
    `检索评测完成：${report.summary.passed}/${report.summary.total}，报告：${reportPath}`,
  );
  if (report.summary.passed !== report.summary.total) {
    throw new Error('当前检索门槛未通过全部固定用例，请查看报告');
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`检索评测失败：${message}`);
    process.exitCode = 1;
  });
}
