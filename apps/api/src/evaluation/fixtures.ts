import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
export const defaultFixtureRoot = resolve(repositoryRoot, 'fixtures');

const evaluationCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    question: z.string().trim().min(1),
    expectedOutcome: z.enum(['answer', 'refusal']),
    expectedRefusalStage: z
      .enum(['retrieval', 'generation'])
      .nullable(),
    expectedDocumentTitles: z.array(z.string().trim().min(1)),
    requiredFacts: z.array(z.string().trim().min(1)),
  })
  .strict();

const evaluationCasesSchema = z.array(evaluationCaseSchema).length(12);

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export interface EvaluationDocument {
  filename: string;
  title: string;
  content: string;
}

export interface EvaluationFixtures {
  documents: EvaluationDocument[];
  cases: EvaluationCase[];
}

const documentFilenames = ['refunds.md', 'shipping.md', 'support.md'] as const;

function validateFixtureSemantics(
  documents: EvaluationDocument[],
  cases: EvaluationCase[],
): void {
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error('评测用例 id 必须唯一');
  }

  const answerCases = cases.filter((item) => item.expectedOutcome === 'answer');
  const generationCases = cases.filter(
    (item) => item.expectedRefusalStage === 'generation',
  );
  const retrievalCases = cases.filter(
    (item) => item.expectedRefusalStage === 'retrieval',
  );
  if (
    answerCases.length !== 6 ||
    generationCases.length !== 2 ||
    retrievalCases.length !== 4
  ) {
    throw new Error('评测用例必须包含 6 个可回答、2 个生成拒答和 4 个检索拒答');
  }

  for (const item of cases) {
    if (item.expectedOutcome === 'answer') {
      if (
        item.expectedRefusalStage !== null ||
        item.expectedDocumentTitles.length === 0 ||
        item.requiredFacts.length === 0
      ) {
        throw new Error(`可回答用例合同无效：${item.id}`);
      }
    } else if (
      item.expectedRefusalStage === null ||
      item.requiredFacts.length !== 0
    ) {
      throw new Error(`拒答用例合同无效：${item.id}`);
    }
  }

  const contentByTitle = new Map(
    documents.map((document) => [document.title, document.content]),
  );
  for (const item of answerCases) {
    const content = item.expectedDocumentTitles
      .map((title) => contentByTitle.get(title) ?? '')
      .join('\n');
    if (item.requiredFacts.some((fact) => !content.includes(fact))) {
      throw new Error(`预期事实未出现在知识文档中：${item.id}`);
    }
  }
}

export async function loadEvaluationFixtures(
  fixtureRoot = defaultFixtureRoot,
): Promise<EvaluationFixtures> {
  const documents = await Promise.all(
    documentFilenames.map(async (filename) => {
      const content = await readFile(
        resolve(fixtureRoot, 'knowledge', filename),
        'utf8',
      );
      const title = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim();
      if (!title) {
        throw new Error(`知识文档缺少一级标题：${filename}`);
      }
      return { filename, title, content };
    }),
  );
  const casesJson = await readFile(
    resolve(fixtureRoot, 'evaluation', 'cases.json'),
    'utf8',
  );
  const cases = evaluationCasesSchema.parse(JSON.parse(casesJson) as unknown);

  validateFixtureSemantics(documents, cases);
  return { documents, cases };
}
