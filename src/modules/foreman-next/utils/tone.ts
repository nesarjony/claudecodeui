export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

/** The text colour of each tone, shared by the chips and the state glyphs so one meaning always has one colour. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  info: 'text-primary',
};
