import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  DocumentDetail,
  DocumentSourceType,
  DocumentSummary,
} from '@anchordesk/shared';

import { ApiClientError, type ApiClient } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { LoadingState } from '../components/LoadingState.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { formatDateTime, toUtf8ByteLength } from '../format.js';

const MAX_DOCUMENT_BYTES = 100 * 1024;

/** 上传文件的原始大小上限（pdf/docx 由服务端解析，提取文本仍受 100 KB 约束） */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface FormState {
  title: string;
  content: string;
  sourceType: DocumentSourceType;
}

const emptyForm: FormState = { title: '', content: '', sourceType: 'text' };

export interface DocumentsPageProps {
  api: ApiClient;
}

export function DocumentsPage({ api }: DocumentsPageProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [isNew, setIsNew] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{
    file: File;
    sourceType: DocumentSourceType;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const detailRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      detailAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    };
  }, []);

  function isCurrentMutation(controller: AbortController): boolean {
    return (
      mountedRef.current &&
      mutationAbortRef.current === controller &&
      !controller.signal.aborted
    );
  }

  const loadDocuments = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setListError(null);
    try {
      const result = await api.listDocuments({ signal: controller.signal });
      setDocuments(result);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      setListError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '加载文档列表失败',
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  async function openDocument(id: string) {
    if (id === selectedId && detail !== null && !needsReload) {
      return;
    }
    setNeedsReload(false);
    detailAbortRef.current?.abort();
    const requestId = ++detailRequestIdRef.current;
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setSaveError(null);
    setSaveMessage(null);
    setFileNotice(null);
    setPendingUpload(null);
    setIsNew(false);
    try {
      const result = await api.getDocument(id, { signal: controller.signal });
      if (requestId !== detailRequestIdRef.current || controller.signal.aborted) {
        return;
      }
      setDetail(result);
      setForm({
        title: result.title,
        content: result.content,
        sourceType: result.sourceType,
      });
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
          : '加载文档详情失败',
      );
    }
  }

  function resetToNewDocument() {
    detailAbortRef.current?.abort();
    detailRequestIdRef.current += 1;
    setNeedsReload(false);
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setForm(emptyForm);
    setIsNew(true);
    setSaveError(null);
    setSaveMessage(null);
    setFileNotice(null);
    setPendingUpload(null);
  }

  function startNewDocument() {
    if (saving || deleting) {
      return;
    }
    resetToNewDocument();
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (saving || deleting) {
      return;
    }
    const title = form.title.trim();
    const hasPendingUpload = isNew && pendingUpload !== null;
    if (title === '' || (!hasPendingUpload && form.content.trim() === '')) {
      setSaveError('标题和内容不能为空');
      return;
    }
    if (
      !hasPendingUpload &&
      toUtf8ByteLength(form.content) > MAX_DOCUMENT_BYTES
    ) {
      setSaveError('内容超过 100 KB 上限');
      return;
    }

    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      if (isNew) {
        const created =
          pendingUpload !== null
            ? await api.uploadDocument(
                { file: pendingUpload.file, title },
                { signal: controller.signal },
              )
            : await api.createDocument(
                {
                  title,
                  content: form.content,
                  sourceType: form.sourceType,
                },
                { signal: controller.signal },
              );
        if (!isCurrentMutation(controller)) {
          return;
        }
        setPendingUpload(null);
        await loadDocuments();
        if (!isCurrentMutation(controller)) {
          return;
        }
        await openDocument(created.id);
        if (!isCurrentMutation(controller)) {
          return;
        }
        setSaveMessage('文档已创建');
      } else {
        if (detail === null) {
          throw new ApiClientError({ message: '当前文档详情尚未加载' });
        }
        const requestId = detailRequestIdRef.current;
        const updated = await api.updateDocument(
          detail.id,
          {
            title,
            content: form.content,
            sourceType: form.sourceType,
            expectedUpdatedAt: detail.updatedAt,
          },
          { signal: controller.signal },
        );
        if (!isCurrentMutation(controller)) {
          return;
        }
        await loadDocuments();
        if (
          !isCurrentMutation(controller) ||
          requestId !== detailRequestIdRef.current
        ) {
          return;
        }
        setNeedsReload(false);
        setDetail({
          ...detail,
          title,
          content: form.content,
          sourceType: form.sourceType,
          updatedAt: updated.updatedAt,
          indexedAt: updated.updatedAt,
          chunkCount: updated.chunkCount,
        });
        setSaveMessage('文档已保存');
      }
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      if (!isCurrentMutation(controller)) {
        return;
      }
      if (requestError instanceof ApiClientError) {
        if (requestError.statusCode === 409) {
          setSaveError('文档已被修改，请重新加载最新内容后再保存');
          setNeedsReload(true);
        } else {
          setSaveError(requestError.message);
        }
      } else {
        setSaveError('保存失败，请稍后重试');
      }
    } finally {
      if (isCurrentMutation(controller)) {
        mutationAbortRef.current = null;
        setSaving(false);
      }
    }
  }

  async function handleDelete() {
    if (detail === null || deleting || saving) {
      return;
    }
    const confirmed = window.confirm(`确定删除文档「${detail.title}」吗？此操作不可恢复。`);
    if (!confirmed) {
      return;
    }
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setDeleting(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await api.deleteDocument(detail.id, { signal: controller.signal });
      if (!isCurrentMutation(controller)) {
        return;
      }
      resetToNewDocument();
      await loadDocuments();
      if (!isCurrentMutation(controller)) {
        return;
      }
      setSaveMessage('文档已删除');
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        return;
      }
      if (!isCurrentMutation(controller)) {
        return;
      }
      setSaveError(
        requestError instanceof ApiClientError
          ? requestError.message
          : '删除失败，请稍后重试',
      );
    } finally {
      if (isCurrentMutation(controller)) {
        mutationAbortRef.current = null;
        setDeleting(false);
      }
    }
  }

  async function handleFileChange(file: File | undefined) {
    setFileNotice(null);
    if (file === undefined) {
      return;
    }
    const extension = file.name.toLowerCase().split('.').pop();
    const sourceType: DocumentSourceType | undefined =
      extension === 'md'
        ? 'markdown'
        : extension === 'txt'
          ? 'text'
          : extension === 'pdf'
            ? 'pdf'
            : extension === 'docx'
              ? 'docx'
              : undefined;
    if (sourceType === undefined) {
      setFileNotice('只接受 .md、.txt、.pdf 或 .docx 文件');
      return;
    }
    const title = file.name.replace(/\.[^.]*$/u, '');
    if (sourceType === 'markdown' || sourceType === 'text') {
      if (file.size > MAX_DOCUMENT_BYTES) {
        setFileNotice('文件超过 100 KB 上限，请精简内容');
        return;
      }
      const content = await file.text();
      if (toUtf8ByteLength(content) > MAX_DOCUMENT_BYTES) {
        setFileNotice('文件内容超过 100 KB 上限，请精简内容');
        return;
      }
      setForm((current) => ({ ...current, content, sourceType, title }));
      setPendingUpload(null);
      setFileNotice(`已从 ${file.name} 载入内容（${sourceType}）`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileNotice('文件超过 10 MB 上限');
      return;
    }
    setForm((current) => ({ ...current, content: '', sourceType, title }));
    setPendingUpload({ file, sourceType });
    setFileNotice(
      `已选择 ${file.name}，保存时将上传并由服务端解析（${sourceType}）`,
    );
  }

  const selectedSummary =
    documents.find((document) => document.id === selectedId) ?? null;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">知识文档</h2>
        <button
          type="button"
          onClick={startNewDocument}
          disabled={saving || deleting}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300 focus:outline-2 focus:outline-blue-700"
        >
          新建文档
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-stone-700">文档列表</h3>
          {loading ? (
            <LoadingState label="正在加载文档列表…" />
          ) : listError !== null ? (
            <ErrorAlert message={listError} retryLabel="重新加载" onRetry={() => void loadDocuments()} />
          ) : documents.length === 0 ? (
            <EmptyState
              message="还没有任何文档"
              actionLabel="新建文档"
              onAction={startNewDocument}
              actionDisabled={saving || deleting}
            />
          ) : (
            <ul className="max-h-[70svh] space-y-1 overflow-y-auto pr-1">
              {documents.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    onClick={() => void openDocument(document.id)}
                    disabled={saving || deleting}
                    aria-current={document.id === selectedId ? 'true' : undefined}
                    className={
                      document.id === selectedId
                        ? 'w-full rounded-md border border-blue-700 bg-blue-50 px-3 py-2 text-left focus:outline-2 focus:outline-blue-700'
                        : 'w-full rounded-md border border-transparent px-3 py-2 text-left hover:bg-white focus:outline-2 focus:outline-blue-700'
                    }
                  >
                    <span className="block truncate text-sm font-medium">
                      {document.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-stone-500">
                      {document.sourceType} · {document.chunkCount} 个分块 · 更新于{' '}
                      <time dateTime={document.updatedAt}>
                        {formatDateTime(document.updatedAt)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          {selectedId !== null && detail === null && !detailError && (
            <LoadingState label="正在加载文档详情…" />
          )}
          {detailError !== null && (
            <ErrorAlert message={detailError} retryLabel="重新加载" onRetry={() => void openDocument(selectedId as string)} />
          )}

          {selectedId === null && detailError === null && (
            <EmptyState
              message={isNew ? '填写右侧表单创建新文档' : '从左侧选择一篇文档查看或编辑'}
            />
          )}

          {(detail !== null || isNew) && (
            <form
              onSubmit={handleSave}
              className="space-y-4 rounded-md border border-stone-300 bg-white p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {isNew ? '新建文档' : '编辑文档'}
                </h3>
                {!isNew && detail !== null && (
                  <>
                    <StatusBadge label={detail.sourceType} tone="neutral" />
                    <span className="text-xs text-stone-500">
                      更新于{' '}
                      <time dateTime={detail.updatedAt}>
                        {formatDateTime(detail.updatedAt)}
                      </time>
                    </span>
                  </>
                )}
              </div>

              <div>
                <label
                  htmlFor="document-title"
                  className="mb-1 block text-sm font-medium text-stone-700"
                >
                  标题
                </label>
                <input
                  id="document-title"
                  type="text"
                  value={form.title}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, title: event.target.value }))
                  }
                  disabled={saving || deleting}
                  className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100 focus:outline-2 focus:outline-blue-700"
                />
              </div>

              <div>
                <label
                  htmlFor="document-source"
                  className="mb-1 block text-sm font-medium text-stone-700"
                >
                  来源类型
                </label>
                <select
                  id="document-source"
                  value={form.sourceType}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      sourceType: event.target.value as DocumentSourceType,
                    }))
                  }
                  disabled={saving || deleting || pendingUpload !== null}
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100 focus:outline-2 focus:outline-blue-700"
                >
                  <option value="text">文本 (text)</option>
                  <option value="markdown">Markdown (markdown)</option>
                  <option value="pdf">PDF (pdf)</option>
                  <option value="docx">Word (docx)</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="document-file"
                  className="mb-1 block text-sm font-medium text-stone-700"
                >
                  从本地文件载入（.md / .txt ≤ 100 KB；.pdf / .docx ≤ 10 MB，保存时由服务端解析）
                </label>
                <input
                  id="document-file"
                  type="file"
                  accept=".md,.txt,.pdf,.docx"
                  disabled={saving || deleting}
                  onChange={(event) => void handleFileChange(event.target.files?.[0])}
                  className="block w-full text-sm text-stone-600 file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-stone-700 hover:file:bg-stone-300"
                />
                {fileNotice !== null && (
                  <p className="mt-1 text-xs text-stone-500" aria-live="polite">
                    {fileNotice}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="document-content"
                  className="mb-1 block text-sm font-medium text-stone-700"
                >
                  内容
                </label>
                <textarea
                  id="document-content"
                  value={form.content}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, content: event.target.value }))
                  }
                  disabled={saving || deleting}
                  rows={14}
                  className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm disabled:bg-stone-100 focus:outline-2 focus:outline-blue-700"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={saving || deleting}
                  className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300 focus:outline-2 focus:outline-blue-700"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
                {!isNew && (
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={deleting || saving}
                    className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-2 focus:outline-red-700"
                  >
                    {deleting ? '删除中…' : '删除文档'}
                  </button>
                )}
                <span aria-live="polite" className="text-sm">
                  {saveMessage !== null && (
                    <span className="font-medium text-green-700">{saveMessage}</span>
                  )}
                  {saveError !== null && (
                    <span className="font-medium text-red-700">{saveError}</span>
                  )}
                </span>
              </div>
            </form>
          )}
        </div>
      </div>

      {selectedSummary !== null && (
        <p className="mt-4 text-xs text-stone-500" aria-live="polite">
          当前选中：{selectedSummary.title}（{selectedSummary.chunkCount} 个分块）
        </p>
      )}
    </section>
  );
}
