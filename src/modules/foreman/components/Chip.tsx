import type { ReactNode } from 'react';

import type { ChipTone } from '@/modules/foreman/chipTone';

const TONE: Record<ChipTone, string> = {
  neutral: 'text-muted-foreground',
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  info: 'text-primary',
};

/** A small status label, in the same style as the chips on the "Foreman suggests" card. */
export function Chip({ tone = 'neutral', title, children }: { tone?: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center rounded-full border border-border/60 bg-muted/40 px-1.5 text-[11px] font-medium tabular-nums leading-5 ${TONE[tone]}`}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
