import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { FeedbackRating, QuestionResponse } from '@anchordesk/shared';

import { ApiClientError, createApiClient } from '../api/client.js';
import { CitationText } from '../components/CitationText.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { refusalReasonLabels } from '../format.js';

const api = createApiClient();

type FeedbackStatus = {
  questionLogId: string;
  rating: FeedbackRating;
  message: string;
} | null;

export function QuestionPage() {
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuestionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackStatus>(null);
  const [feedbackSubmittingFor, setFeedbackSubmittingFor] = useState<
    string | null
  >(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const feedbackAbortRef = useRef<AbortController | null>(null);
  const feedbackRequestIdRef = useRef(0);
  const currentLogIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      feedbackAbortRef.current?.abort();
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed === '' || submitting) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    feedbackAbortRef.current?.abort();
    feedbackRequestIdRef.current += 1;
    currentLogIdRef.current = null;
    setSubmitting(true);
    setError(null);
    setResult(null);
    setFeedback(null);
    setFeedbackError(null);
    setFeedbackSubmittingFor(null);
    try {
      const response = await api.askQuestion(trimmed, { signal: controller.signal });
      currentLogIdRef.current = response.questionLogId;
      setResult(response);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      setError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '提问失败，请稍后重试',
      );
    } finally {
      if (abortRef.current === controller && !controller.signal.aborted) {
        setSubmitting(false);
      }
    }
  }

  async function handleFeedback(rating: FeedbackRating) {
    if (
      !result ||
      result.refused ||
      feedback !== null ||
      feedbackSubmittingFor !== null
    ) {
      return;
    }
    const logId = result.questionLogId;
    feedbackAbortRef.current?.abort();
    const controller = new AbortController();
    feedbackAbortRef.current = controller;
    const requestId = ++feedbackRequestIdRef.current;
    setFeedbackSubmittingFor(logId);
    setFeedbackError(null);
    try {
      await api.submitFeedback(
        { questionLogId: logId, rating },
        { signal: controller.signal },
      );
      if (
        requestId !== feedbackRequestIdRef.current ||
        currentLogIdRef.current !== logId ||
        controller.signal.aborted
      ) {
        return;
      }
      setFeedback({
        questionLogId: logId,
        rating,
        message: rating === 'helpful' ? '已记录：有帮助' : '已记录：没帮助',
      });
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      if (
        requestId !== feedbackRequestIdRef.current ||
        currentLogIdRef.current !== logId
      ) {
        return;
      }
      if (requestError instanceof ApiClientError) {
        setFeedbackError(
          requestError.statusCode === 409
            ? '该回答已经提交过反馈'
            : requestError.message,
        );
      } else {
        setFeedbackError('反馈提交失败，请稍后重试');
      }
    } finally {
      if (
        requestId === feedbackRequestIdRef.current &&
        currentLogIdRef.current === logId &&
        !controller.signal.aborted
      ) {
        setFeedbackSubmittingFor((current) =>
          current === logId ? null : current,
        );
      }
    }
  }

  const canSubmit = question.trim() !== '' && !submitting;

  return (
    <section className="mx-auto max-w-3xl">
      <h2 className="text-base font-semibold">向知识库提问</h2>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <div>
          <label
            htmlFor="question-input"
            className="mb-1 block text-sm font-medium text-stone-700"
          >
            问题
          </label>
          <textarea
            id="question-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={submitting}
            rows={3}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100 focus:outline-2 focus:outline-blue-700"
            placeholder="请输入要查询的问题"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300 focus:outline-2 focus:outline-blue-700"
          >
            {submitting ? '提交中…' : '提交问题'}
          </button>
          {submitting && (
            <span role="status" className="text-sm text-stone-500">
              正在检索并生成回答…
            </span>
          )}
        </div>
      </form>

      <div aria-live="polite" className="mt-6 space-y-4">
        {error !== null && <ErrorAlert message={error} />}

        {result !== null && result.refused && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusBadge label="拒答" tone="amber" />
              <span className="text-sm text-amber-800">
                {refusalReasonLabels[result.refusalReason]}
              </span>
            </div>
            <p className="mt-2 text-sm font-medium text-amber-900">
              {result.answer}
            </p>
            <p className="mt-2 text-xs text-amber-700">
              该问题已进入“待处理”页面，可在其中补充依据或手动解决。
            </p>
          </div>
        )}

        {result !== null && !result.refused && (
          <div className="space-y-4">
            <div className="rounded-md border border-stone-300 bg-white px-4 py-3">
              <p className="whitespace-pre-wrap break-words text-sm leading-7">
                <CitationText text={result.answer} citations={result.citations} />
              </p>
            </div>

            {result.citations.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">引用依据</h3>
                <ol className="space-y-2">
                  {result.citations.map((citation) => (
                    <li
                      key={citation.rank}
                      id={`citation-${citation.rank}`}
                      className="rounded-md border border-stone-300 bg-white px-4 py-3"
                    >
                      <p className="text-sm font-medium">
                        [{citation.rank}] {citation.documentTitle}
                      </p>
                      <p className="mt-1 break-words text-sm text-stone-600">
                        {citation.preview}
                      </p>
                      <p className="mt-1 text-xs text-stone-500">
                        距离：{citation.distance.toFixed(4)}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-stone-600">这个回答有帮助吗？</span>
              <button
                type="button"
                disabled={
                  feedback !== null ||
                  feedbackSubmittingFor === result.questionLogId
                }
                onClick={() => handleFeedback('helpful')}
                className="rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-2 focus:outline-green-700"
              >
                有帮助
              </button>
              <button
                type="button"
                disabled={
                  feedback !== null ||
                  feedbackSubmittingFor === result.questionLogId
                }
                onClick={() => handleFeedback('not_helpful')}
                className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-2 focus:outline-red-700"
              >
                没有帮助
              </button>
              {feedback !== null && (
                <span
                  role="status"
                  className="text-sm font-medium text-green-700"
                >
                  {feedback.message}，该回答的反馈已锁定
                </span>
              )}
            </div>
            {feedbackError !== null && (
              <ErrorAlert message={feedbackError} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
