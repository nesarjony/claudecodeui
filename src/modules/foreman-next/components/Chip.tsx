import type { ReactNode } from 'react';

import { TONE_TEXT } from '@/modules/foreman-next/utils/tone';
import type { Tone } from '@/modules/foreman-next/utils/tone';
import { Badge } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Used by the status strip, the decision cards, the goal board and the run view for short coloured labels. */
export function Chip({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn('px-2 py-0 text-[11px] font-medium tabular-nums', TONE_TEXT[tone], className)}>
      {children}
    </Badge>
  );
}
