import type { ReactNode } from 'react';

type EmptyStateProps = { title: string; body?: string; children?: ReactNode };

/** Used by every screen for "nothing here yet" (wireframes §15): a sentence that says what is true and, when there is one, the next step. */
export function EmptyState({ title, body, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {body ? <p className="max-w-md text-sm text-muted-foreground">{body}</p> : null}
      {children}
    </div>
  );
}
