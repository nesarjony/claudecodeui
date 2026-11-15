import { TONE_TEXT } from '@/modules/foreman-next/utils/tone';
import type { Tone } from '@/modules/foreman-next/utils/tone';
import { cn } from '@/shared/utils';

export type GlyphState = 'done' | 'running' | 'waiting' | 'queued' | 'failed';

const GLYPH: Record<GlyphState, { mark: string; tone: Tone }> = {
  done: { mark: '✓', tone: 'good' },
  running: { mark: '●', tone: 'info' },
  waiting: { mark: '◌', tone: 'warn' },
  queued: { mark: '○', tone: 'neutral' },
  failed: { mark: '✗', tone: 'bad' },
};

/** Used by the batch list and the run stages to show a state as the wireframes' glyph, with the state spelled out for screen readers. */
export function StateGlyph({ state, label, className }: { state: GlyphState; label: string; className?: string }) {
  const { mark, tone } = GLYPH[state];
  return (
    <span role="img" aria-label={label} className={cn('inline-block w-4 text-center', TONE_TEXT[tone], className)}>
      {mark}
    </span>
  );
}
