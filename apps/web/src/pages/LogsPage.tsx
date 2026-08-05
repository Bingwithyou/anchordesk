import { useCallback, useEffect, useRef, useState } from 'react';

import type { LogDetail, LogSummary } from '@anchordesk/shared';

import { ApiClientError, type ApiClient } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { LoadingState } from '../components/LoadingState.js';
import { StatusBadge } from '../components/StatusBadge.js';
import {
  feedbackLabels,
  formatDateTime,
  refusalReasonLabels,
} from '../format.js';

export interface LogsPageProps {
  api: ApiClient;
}

export function LogsPage({ api }: LogsPageProps) {
  const [logs, setLogs] = useState<LogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, []);

  const loadLogs = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setListError(null);
    try {
      const result = await api.listLogs({ signal: controller.signal });
      setLogs(result);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      setListError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '加载运行日志失败',
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  async function openLog(id: string) {
    if (id === selectedId && detail !== null) {
      return;
    }
    detailAbortRef.current?.abort();
    const requestId = ++detailRequestIdRef.current;
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await api.getLog(id, { signal: controller.signal });
      if (requestId !== detailRequestIdRef.current || controller.signal.aborted) {
        return;
      }
      setDetail(result);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      if (requestId !== detailRequestIdRef.current) {
        return;
      }
      setDetailError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '加载日志详情失败',
      );
    } finally {
      if (requestId === detailRequestIdRef.current) {
        setDetailLoading(false);
      }
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">运行日志</h2>
        <button
          type="button"
          onClick={() => void loadLogs()}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-200 focus:outline-2 focus:outline-blue-700"
        >
          刷新列表
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-stone-700">
            最近 100 条
          </h3>
          {loading ? (
            <LoadingState label="正在加载日志列表…" />
          ) : listError !== null ? (
            <ErrorAlert message={listError} retryLabel="重新加载" onRetry={() => void loadLogs()} />
          ) : logs.length === 0 ? (
            <EmptyState message="还没有任何问答日志" actionLabel="刷新" onAction={() => void loadLogs()} />
          ) : (
            <ul className="max-h-[70svh] space-y-1 overflow-y-auto pr-1">
              {logs.map((log) => (
                <li key={log.id}>
                  <button
                    type="button"
                    onClick={() => void openLog(log.id)}
                    aria-current={log.id === selectedId ? 'true' : undefined}
                    className={
                      log.id === selectedId
                        ? 'w-full rounded-md border border-blue-700 bg-blue-50 px-3 py-2 text-left focus:outline-2 focus:outline-blue-700'
                        : 'w-full rounded-md border border-transparent px-3 py-2 text-left hover:bg-white focus:outline-2 focus:outline-blue-700'
                    }
                  >
                    <span className="block truncate text-sm font-medium">
                      {log.questionPreview}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-stone-500">
                      {log.answerPreview}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {log.refused ? (
                        <StatusBadge label="拒答" tone="amber" />
                      ) : (
                        <StatusBadge label="已回答" tone="green" />
                      )}
                      {log.feedbackRating !== null && (
                        <StatusBadge
                          label={`反馈：${feedbackLabels[log.feedbackRating]}`}
                          tone={log.feedbackRating === 'helpful' ? 'green' : 'red'}
                        />
                      )}
                      <time dateTime={log.createdAt} className="text-xs text-stone-500">
                        {formatDateTime(log.createdAt)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          {selectedId === null && (
            <EmptyState message="从左侧选择一条日志查看完整详情" />
          )}
          {selectedId !== null && detailLoading && (
            <LoadingState label="正在加载日志详情…" />
          )}
          {detailError !== null && (
            <ErrorAlert message={detailError} retryLabel="重新加载" onRetry={() => void openLog(selectedId as string)} />
          )}
          {detail !== null && (
            <article className="space-y-4 rounded-md border border-stone-300 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">日志详情</h3>
                {detail.refused ? (
                  <StatusBadge label={`拒答：${refusalReasonLabels[detail.refusalReason ?? 'invalid_model_output']}`} tone="amber" />
                ) : (
                  <StatusBadge label="已回答" tone="green" />
                )}
                <time dateTime={detail.createdAt} className="text-xs text-stone-500">
                  {formatDateTime(detail.createdAt)}
                </time>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-stone-700">问题</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {detail.question}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-stone-700">回答</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {detail.answer}
                </p>
              </div>

              {detail.feedback !== null && (
                <div>
                  <h4 className="text-sm font-semibold text-stone-700">反馈</h4>
                  <p className="mt-1 text-sm">
                    {feedbackLabels[detail.feedback.rating]}{' '}
                    <time dateTime={detail.feedback.createdAt} className="text-xs text-stone-500">
                      {formatDateTime(detail.feedback.createdAt)}
                    </time>
                  </p>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-stone-500">Answer 模型</dt>
                  <dd className="break-all font-medium">{detail.answerModel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Embedding 模型</dt>
                  <dd className="break-all font-medium">{detail.embeddingModel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Prompt 版本</dt>
                  <dd className="font-medium">{detail.promptVersion}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Top K</dt>
                  <dd className="font-medium">{detail.ragTopK}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">距离门槛</dt>
                  <dd className="font-medium">{detail.ragMaxDistance}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">检索耗时</dt>
                  <dd className="font-medium">{detail.retrievalMs} ms</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">生成耗时</dt>
                  <dd className="font-medium">
                    {detail.generationMs === null ? '未生成' : `${detail.generationMs} ms`}
                  </dd>
                </div>
              </dl>

              <div>
                <h4 className="mb-2 text-sm font-semibold text-stone-700">
                  证据快照（{detail.hits.length}）
                </h4>
                {detail.hits.length === 0 ? (
                  <EmptyState message="该日志没有保存任何候选分块" />
                ) : (
                  <ol className="space-y-2">
                    {detail.hits.map((hit) => (
                      <li
                        key={hit.rank}
                        className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">#{hit.rank}</span>
                          <span className="break-words text-sm font-medium">
                            {hit.documentTitle}
                          </span>
                          {hit.passedThreshold ? (
                            <StatusBadge label="通过门槛" tone="green" />
                          ) : (
                            <StatusBadge label="未过门槛" tone="neutral" />
                          )}
                          {hit.cited ? (
                            <StatusBadge label="被引用" tone="amber" />
                          ) : (
                            <StatusBadge label="未引用" tone="neutral" />
                          )}
                          <span className="text-xs text-stone-500">
                            距离：{hit.distance.toFixed(4)}
                          </span>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-stone-600">
                          {hit.chunkContent}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
