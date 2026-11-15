import { useId } from 'react';
import type { ReactNode } from 'react';

import { Card } from '@/shared/ui';
import { cn } from '@/shared/utils';

type PanelProps = { title: ReactNode; aside?: ReactNode; className?: string; children: ReactNode };

/** Used by the Today, Decide, Work and Settings screens as the titled box that every group of content sits in. */
export function Panel({ title, aside, className, children }: PanelProps) {
  const headingId = useId();
  return (
    <Card className={cn('min-w-0', className)} role="region" aria-labelledby={headingId}>
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 id={headingId} className="text-sm font-semibold">
          {title}
        </h2>
        {aside ? <div className="flex items-center gap-2 text-xs text-muted-foreground">{aside}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </Card>
  );
}
