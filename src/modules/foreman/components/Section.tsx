import type { ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';

type SectionProps = {
  id: string;
  title: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  /** A short label next to the title: a count, a state. */
  badge?: ReactNode;
  children: ReactNode;
};

/**
 * A collapsible block of the Foreman tab. The whole header row is the button (44px tall, so a thumb hits it), and the
 * body is mounted only while open, so a folded section costs nothing and fetches nothing.
 */
export default function Section({ id, title, icon: Icon, open, onToggle, badge, children }: SectionProps) {
  const headingId = `foreman-section-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`foreman-section-${id}`}
      className="min-w-0 rounded-xl border border-border/60 bg-card/70 text-[13px] leading-5"
    >
      <h2 id={headingId} className="m-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${headingId}-body`}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-muted/60"
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden />
          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</span>
          {badge ? <span className="flex shrink-0 items-center gap-1">{badge}</span> : null}
        </button>
      </h2>
      {open && (
        <div id={`${headingId}-body`} className="min-w-0 space-y-3 border-t border-border/50 px-3 pb-3 pt-3">
          {children}
        </div>
      )}
    </section>
  );
}
