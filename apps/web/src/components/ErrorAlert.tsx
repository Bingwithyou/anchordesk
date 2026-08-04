export interface ErrorAlertProps {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
}

export function ErrorAlert({ message, retryLabel, onRetry }: ErrorAlertProps) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <p className="font-medium">操作失败</p>
      <p className="mt-1 break-words">{message}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 focus:outline-2 focus:outline-red-600"
        >
          {retryLabel ?? '重试'}
        </button>
      )}
    </div>
  );
}
