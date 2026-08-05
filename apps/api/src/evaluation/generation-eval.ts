import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  loadGenerationEvaluationConfig,
  type GenerationEvaluationConfig,
} from '../config.js';
import { assertSafeTestDatabaseUrls } from '../db/database-config.js';
import { createDatabasePool } from '../db/pool.js';
import { DeepSeekAnswerProvider } from '../providers/deepseek.js';
import { ProviderError } from '../providers/errors.js';
import { OllamaEmbeddingProvider } from '../providers/ollama.js';
import type { AnswerContractResult } from '../rag/answer-contract.js';
import { validateGeneratedAnswer } from '../rag/answer-contract.js';
import { retrieveChunks } from '../rag/retrieve.js';
import { defaultFixtureRoot, loadEvaluationFixtures } from './fixtures.js';
import {
  evaluateGenerationCase,
  type GenerationCaseReport,
} from './generation-evaluator.js';
import { embedKnowledge, insertKnowledge } from './knowledge.js';

export interface GenerationEvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  embeddingModel: string;
  answerModel: string;
  promptVersion: string;
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
  cases: GenerationCaseReport[];
}

export interface GenerationEvaluationResult {
  report: GenerationEvaluationReport;
  reportPath: string;
}

const reportDirectory = resolve(defaultFixtureRoot, '../reports/generation');

/** 把上游错误归类为脱敏分类，绝不包含 Key、请求头或响应正文。 */
function classifyError(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.provider}:${error.kind}`;
  }
  return 'internal';
}

function countBy(
  reports: GenerationCaseReport[],
  predicate: (report: GenerationCaseReport) => boolean,
): { passed: number; total: number } {
  const matching = reports.filter(predicate);
  return {
    passed: matching.filter((report) => report.passed).length,
    total: matching.length,
  };
}

function createReport(
  config: GenerationEvaluationConfig,
  documentCount: number,
  reports: GenerationCaseReport[],
): GenerationEvaluationReport {
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
    answerModel: config.deepseekModel,
    promptVersion: config.promptVersion,
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
  report: GenerationEvaluationReport,
): Promise<string> {
  await mkdir(reportDirectory, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/gu, '-');
  const reportPath = resolve(reportDirectory, `${timestamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

export async function runGenerationEvaluation(
  config = loadGenerationEvaluationConfig(),
): Promise<GenerationEvaluationResult> {
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
  const answerProvider = new DeepSeekAnswerProvider({
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
    promptVersion: config.promptVersion,
    timeoutMs: config.deepseekTimeoutMs,
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
  const caseReports: GenerationCaseReport[] = [];
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
          console.log(
            `正在评测用例：${index + 1}/${fixtures.cases.length}（${evaluationCase.id}）`,
          );
          const startedAt = performance.now();
          let report: GenerationCaseReport;
          try {
            const retrieval = await retrieveChunks({
              database: client,
              embedding,
              maxDistance: config.ragMaxDistance,
              topK: config.ragTopK,
            });
            let contract: AnswerContractResult | null = null;
            if (retrieval.evidence.length > 0) {
              const rawOutput = await answerProvider.generate(
                evaluationCase.question,
                retrieval.evidence,
              );
              contract = validateGeneratedAnswer(rawOutput, retrieval.evidence);
            }
            report = evaluateGenerationCase(
              evaluationCase,
              retrieval,
              contract,
              Math.round(performance.now() - startedAt),
            );
          } catch (error) {
            report = {
              ...evaluateGenerationCase(
                evaluationCase,
                { candidates: [], evidence: [] },
                null,
                Math.round(performance.now() - startedAt),
              ),
              error: classifyError(error),
              passed: false,
            };
          }
          caseReports.push(report);
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
  let result: GenerationEvaluationResult;
  try {
    result = await runGenerationEvaluation();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`生成评测失败：${message}`);
    process.exitCode = 1;
    return;
  }
  const { report, reportPath } = result;
  console.log(
    `生成评测完成：${report.summary.passed}/${report.summary.total}，报告：${reportPath}`,
  );
  if (report.summary.passed !== report.summary.total) {
    console.error('存在未通过的用例，请查看报告中的 missingRequiredFacts 与 error 字段');
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`生成评测失败：${message}`);
    process.exitCode = 1;
  });
}
