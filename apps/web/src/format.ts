import type { FeedbackRating, RefusalReason } from '@anchordesk/shared';

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

export const refusalReasonLabels: Record<RefusalReason, string> = {
  no_chunks: '知识库为空',
  low_similarity: '未找到相似依据',
  model_refused: '模型拒答',
  empty_answer: '空回答',
  invalid_model_output: '模型输出不合法',
  invalid_citation: '引用校验失败',
};

export const feedbackLabels: Record<FeedbackRating, string> = {
  helpful: '有帮助',
  not_helpful: '没帮助',
};

export function toUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
