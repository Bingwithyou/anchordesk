import { z } from 'zod';

import type { RefusalReason } from '@anchordesk/shared';

import type { RetrievedChunk } from '../providers/types.js';

type GenerationRefusalReason = Extract<
  RefusalReason,
  | 'model_refused'
  | 'empty_answer'
  | 'invalid_model_output'
  | 'invalid_citation'
>;

export type AnswerContractResult =
  | {
      kind: 'answer';
      answer: string;
      citationRanks: [number, ...number[]];
      citedEvidence: [RetrievedChunk, ...RetrievedChunk[]];
    }
  | {
      kind: 'refusal';
      refusalReason: GenerationRefusalReason;
    };

const generatedAnswerSchema = z
  .object({
    answer: z.string(),
    supported: z.boolean(),
    citationRanks: z.array(z.number()),
  })
  .strict();

function refuse(refusalReason: GenerationRefusalReason): AnswerContractResult {
  return { kind: 'refusal', refusalReason };
}

function parseInlineCitationRanks(answer: string): number[] | undefined {
  const ranks: number[] = [];
  for (const match of answer.matchAll(/\[([^\]\r\n]+)\]/gu)) {
    const token = match[1];
    if (token === undefined || !/\d/u.test(token)) {
      continue;
    }
    if (!/^[1-9]\d*$/u.test(token)) {
      return undefined;
    }
    const rank = Number(token);
    if (!Number.isSafeInteger(rank)) {
      return undefined;
    }
    ranks.push(rank);
  }
  return [...new Set(ranks)];
}

function sameRanks(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((rank, index) => rank === sortedRight[index]);
}

export function validateGeneratedAnswer(
  rawOutput: string,
  evidence: RetrievedChunk[],
): AnswerContractResult {
  let json: unknown;
  try {
    json = JSON.parse(rawOutput) as unknown;
  } catch {
    return refuse('invalid_model_output');
  }

  const parsed = generatedAnswerSchema.safeParse(json);
  if (!parsed.success) {
    return refuse('invalid_model_output');
  }
  if (!parsed.data.supported) {
    return refuse('model_refused');
  }

  const answer = parsed.data.answer.trim();
  if (answer === '') {
    return refuse('empty_answer');
  }

  const declaredRanks = parsed.data.citationRanks;
  if (
    declaredRanks.length === 0 ||
    declaredRanks.some(
      (rank) => !Number.isSafeInteger(rank) || rank <= 0,
    ) ||
    new Set(declaredRanks).size !== declaredRanks.length
  ) {
    return refuse('invalid_citation');
  }

  const inlineRanks = parseInlineCitationRanks(answer);
  if (
    inlineRanks === undefined ||
    inlineRanks.length === 0 ||
    !sameRanks(inlineRanks, declaredRanks)
  ) {
    return refuse('invalid_citation');
  }

  const evidenceByRank = new Map(evidence.map((chunk) => [chunk.rank, chunk]));
  const sortedRanks = [...declaredRanks].sort((a, b) => a - b);
  const citedEvidence = sortedRanks.map((rank) => evidenceByRank.get(rank));
  if (citedEvidence.some((chunk) => chunk === undefined)) {
    return refuse('invalid_citation');
  }

  const firstRank = sortedRanks[0];
  const firstEvidence = citedEvidence[0];
  if (firstRank === undefined || firstEvidence === undefined) {
    return refuse('invalid_citation');
  }

  return {
    kind: 'answer',
    answer,
    citationRanks: [firstRank, ...sortedRanks.slice(1)],
    citedEvidence: [
      firstEvidence,
      ...citedEvidence.slice(1).filter((chunk) => chunk !== undefined),
    ],
  };
}
