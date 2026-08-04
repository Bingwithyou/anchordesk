import type { ReactNode } from 'react';

import type { Citation } from '@anchordesk/shared';

export interface CitationTextProps {
  text: string;
  citations: Citation[];
}

const citationMarkerPattern = /^\[(\d+)\]$/u;

function resolveToken(token: string, citations: Citation[]): ReactNode {
  const match = citationMarkerPattern.exec(token);
  if (!match) {
    return token;
  }
  const rank = Number(match[1]);
  const citation = citations.find((candidate) => candidate.rank === rank);
  if (!citation) {
    return token;
  }
  return (
    <a
      href={`#citation-${rank}`}
      className="text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900 focus:outline-2 focus:outline-blue-700"
    >
      [{rank}]
    </a>
  );
}

export function CitationText({ text, citations }: CitationTextProps) {
  const parts = text.split(/(\[\d+\])/gu);
  return (
    <>
      {parts.map((part, index) => (
        <span key={`${index}-${part}`}>{resolveToken(part, citations)}</span>
      ))}
    </>
  );
}
