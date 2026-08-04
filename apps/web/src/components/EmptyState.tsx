export interface EmptyStateProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

export function EmptyState({
  message,
  actionLabel,
  onAction,
  actionDisabled = false,
}: EmptyStateProps) {
  return (
    <div className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center">
      <p className="text-sm text-stone-600">{message}</p>
      {actionLabel !== undefined && onAction !== undefined && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className="mt-3 rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300 focus:outline-2 focus:outline-blue-700"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
