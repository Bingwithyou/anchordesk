export interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = '加载中…' }: LoadingStateProps) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-1 py-6 text-sm text-stone-500"
    >
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600"
      />
      <span>{label}</span>
    </div>
  );
}
