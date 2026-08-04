import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReviewQueueItem } from '@anchordesk/shared';

import { ApiClientError, createApiClient } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { LoadingState } from '../components/LoadingState.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { feedbackLabels, formatDateTime, refusalReasonLabels } from '../format.js';

const api = createApiClient();

export function ReviewQueuePage() {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const resolveRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      resolveAbortRef.current?.abort();
    };
  }, []);

  function isCurrentResolve(
    controller: AbortController,
    requestId: number,
  ): boolean {
    return (
      mountedRef.current &&
      resolveAbortRef.current === controller &&
      resolveRequestIdRef.current === requestId &&
      !controller.signal.aborted
    );
  }

  const loadQueue = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setListError(null);
    try {
      const result = await api.listReviewQueue({ signal: controller.signal });
      setItems(result);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      setListError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '加载待处理列表失败',
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  async function handleResolve(item: ReviewQueueItem) {
    if (resolvingId !== null) {
      return;
    }
    const note = (notes[item.id] ?? '').trim();
    const length = Array.from(note).length;
    if (length < 1 || length > 1000) {
      setActionMessage('备注不能为空且不能超过 1000 字');
      return;
    }

    resolveAbortRef.current?.abort();
    const controller = new AbortController();
    resolveAbortRef.current = controller;
    const requestId = ++resolveRequestIdRef.current;
    setResolvingId(item.id);
    setActionMessage(null);
    try {
      await api.resolveReviewItem(
        item.id,
        { note },
        { signal: controller.signal },
      );
      if (!isCurrentResolve(controller, requestId)) {
        return;
      }
      setNotes((current) => ({ ...current, [item.id]: '' }));
      setActionMessage('已标记为已解决');
      await loadQueue();
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      if (!isCurrentResolve(controller, requestId)) {
        return;
      }
      if (requestError instanceof ApiClientError) {
        if (requestError.statusCode === 409) {
          setActionMessage('该项目可能已在其他操作中解决，已刷新列表');
          await loadQueue();
        } else {
          setActionMessage(requestError.message);
        }
      } else {
        setActionMessage('解决失败，请稍后重试');
      }
    } finally {
      if (isCurrentResolve(controller, requestId)) {
        resolveAbortRef.current = null;
        setResolvingId(null);
      }
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">待处理</h2>
        <button
          type="button"
          onClick={() => void loadQueue()}
          disabled={resolvingId !== null}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-200 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-2 focus:outline-blue-700"
        >
          刷新列表
        </button>
      </div>

      <p className="mt-1 text-sm text-stone-600">
        {items.filter((item) => item.status === 'open').length} 项待处理，共{' '}
        {items.length} 项
      </p>

      <div aria-live="polite" className="mt-4 space-y-4">
        {loading ? (
          <LoadingState label="正在加载待处理列表…" />
        ) : listError !== null ? (
          <ErrorAlert message={listError} retryLabel="重新加载" onRetry={() => void loadQueue()} />
        ) : items.length === 0 ? (
          <EmptyState message="没有待处理项" actionLabel="刷新" onAction={() => void loadQueue()} />
        ) : (
          <ol className="space-y-3">
            {items.map((item) => {
              const resolving = resolvingId === item.id;
              const noteLength = Array.from((notes[item.id] ?? '').trim()).length;
              return (
                <li
                  key={item.id}
                  className="rounded-md border border-stone-300 bg-white p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {item.itemType === 'refusal' ? (
                      <StatusBadge label="知识拒答" tone="amber" />
                    ) : (
                      <StatusBadge label="用户反馈没帮助" tone="red" />
                    )}
                    {item.status === 'open' ? (
                      <StatusBadge label="待处理" tone="neutral" />
                    ) : (
                      <StatusBadge label="已解决" tone="green" />
                    )}
                    <time dateTime={item.createdAt} className="text-xs text-stone-500">
                      创建于 {formatDateTime(item.createdAt)}
                    </time>
                  </div>

                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-stone-500">问题</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {item.question}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-stone-500">回答</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {item.answer}
                      </dd>
                    </div>
                    {item.itemType === 'refusal' && item.refusalReason !== null && (
                      <div>
                        <dt className="text-xs text-stone-500">拒答原因</dt>
                        <dd>{refusalReasonLabels[item.refusalReason]}</dd>
                      </div>
                    )}
                    {item.feedbackRating !== null && (
                      <div>
                        <dt className="text-xs text-stone-500">用户反馈</dt>
                        <dd>{feedbackLabels[item.feedbackRating]}</dd>
                      </div>
                    )}
                    {item.note !== null && (
                      <div>
                        <dt className="text-xs text-stone-500">管理备注</dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {item.note}
                        </dd>
                      </div>
                    )}
                    {item.resolvedAt !== null && (
                      <div>
                        <dt className="text-xs text-stone-500">解决时间</dt>
                        <dd>
                          <time dateTime={item.resolvedAt}>
                            {formatDateTime(item.resolvedAt)}
                          </time>
                        </dd>
                      </div>
                    )}
                  </dl>

                  {item.status === 'open' ? (
                    <div className="mt-3 space-y-2">
                      <label
                        htmlFor={`note-${item.id}`}
                        className="block text-sm font-medium text-stone-700"
                      >
                        处理备注
                      </label>
                      <textarea
                        id={`note-${item.id}`}
                        value={notes[item.id] ?? ''}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        disabled={resolvingId !== null}
                        rows={2}
                        placeholder="记录处理说明（1～1000 字）"
                        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100 focus:outline-2 focus:outline-blue-700"
                      />
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void handleResolve(item)}
                          disabled={
                            resolvingId !== null ||
                            noteLength < 1 ||
                            noteLength > 1000
                          }
                          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300 focus:outline-2 focus:outline-blue-700"
                        >
                          {resolving ? '提交中…' : '标记为已解决'}
                        </button>
                        <span className="text-xs text-stone-500">
                          {noteLength}/1000
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-stone-500">
                      该项目已解决，备注与解决时间只读。
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {actionMessage !== null && (
          <p className="text-sm font-medium text-blue-800" role="status">
            {actionMessage}
          </p>
        )}
      </div>
    </section>
  );
}
