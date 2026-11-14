import { cn } from '@/shared/utils';

type Segment = { value: number; className: string };

type ProgressBarProps = { total: number; segments: Segment[]; label: string; className?: string };

/** Used by the Today goals panel, the goal board and the goal page to draw rows done (and built) out of the total. */
export function ProgressBar({ total, segments, label, className }: ProgressBarProps) {
  const filled = segments[0]?.value ?? 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled} className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      {segments.map((segment) => (
        <div key={segment.className} className={segment.className} style={{ width: total > 0 ? `${(segment.value / total) * 100}%` : 0 }} />
      ))}
    </div>
  );
}
