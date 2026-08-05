import type {
  CreateDocumentRequest,
  DocumentCreatedResponse,
  DocumentDetail,
  DocumentSummary,
  DocumentUpdatedResponse,
  FeedbackRequest,
  FeedbackResponse,
  LogDetail,
  LogSummary,
  QuestionResponse,
  ResolvedReviewItem,
  ResolveReviewRequest,
  ReviewQueueItem,
  UpdateDocumentRequest,
} from '@anchordesk/shared';

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4000';

export function resolveApiBaseUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = environment.VITE_API_BASE_URL?.trim();
  return configured === undefined || configured === ''
    ? DEFAULT_API_BASE_URL
    : configured;
}

export interface ApiClientErrorOptions {
  message: string;
  code?: string;
  statusCode?: number;
}

export class ApiClientError extends Error {
  readonly code: string | undefined;
  readonly statusCode: number | undefined;

  constructor({ message, code, statusCode }: ApiClientErrorOptions) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface RequestOptions {
  signal?: AbortSignal;
}

async function requestJson<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiClientError({
      message: '无法连接本机 API，请确认后端已经启动',
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const code =
      typeof payload === 'object' && payload !== null && 'code' in payload &&
      typeof payload.code === 'string'
        ? payload.code
        : undefined;
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload &&
      typeof payload.message === 'string' && payload.message.length > 0
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiClientError({ message, code, statusCode: response.status });
  }

  return payload as T;
}

export interface ApiClient {
  askQuestion(question: string, options?: RequestOptions): Promise<QuestionResponse>;
  listDocuments(options?: RequestOptions): Promise<DocumentSummary[]>;
  getDocument(id: string, options?: RequestOptions): Promise<DocumentDetail>;
  createDocument(
    input: CreateDocumentRequest,
    options?: RequestOptions,
  ): Promise<DocumentCreatedResponse>;
  updateDocument(
    id: string,
    input: UpdateDocumentRequest,
    options?: RequestOptions,
  ): Promise<DocumentUpdatedResponse>;
  deleteDocument(id: string, options?: RequestOptions): Promise<void>;
  listLogs(options?: RequestOptions): Promise<LogSummary[]>;
  getLog(id: string, options?: RequestOptions): Promise<LogDetail>;
  submitFeedback(
    input: FeedbackRequest,
    options?: RequestOptions,
  ): Promise<FeedbackResponse>;
  listReviewQueue(options?: RequestOptions): Promise<ReviewQueueItem[]>;
  resolveReviewItem(
    id: string,
    input: ResolveReviewRequest,
    options?: RequestOptions,
  ): Promise<ResolvedReviewItem>;
}

export function createApiClient(baseUrl: string = DEFAULT_API_BASE_URL): ApiClient {
  return {
    askQuestion: (question, options) =>
      requestJson(baseUrl, 'POST', '/api/questions', { question }, options),
    listDocuments: (options) =>
      requestJson(baseUrl, 'GET', '/api/documents', undefined, options),
    getDocument: (id, options) =>
      requestJson(baseUrl, 'GET', `/api/documents/${id}`, undefined, options),
    createDocument: (input, options) =>
      requestJson(baseUrl, 'POST', '/api/documents', input, options),
    updateDocument: (id, input, options) =>
      requestJson(baseUrl, 'PUT', `/api/documents/${id}`, input, options),
    deleteDocument: (id, options) =>
      requestJson(baseUrl, 'DELETE', `/api/documents/${id}`, undefined, options),
    listLogs: (options) =>
      requestJson(baseUrl, 'GET', '/api/logs', undefined, options),
    getLog: (id, options) =>
      requestJson(baseUrl, 'GET', `/api/logs/${id}`, undefined, options),
    submitFeedback: (input, options) =>
      requestJson(baseUrl, 'POST', '/api/feedback', input, options),
    listReviewQueue: (options) =>
      requestJson(baseUrl, 'GET', '/api/review-queue', undefined, options),
    resolveReviewItem: (id, input, options) =>
      requestJson(baseUrl, 'PUT', `/api/review-queue/${id}/resolve`, input, options),
  };
}
