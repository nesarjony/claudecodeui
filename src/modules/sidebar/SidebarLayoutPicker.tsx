import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useWorkspace } from '@/shared/hooks/useWorkspace';
import { cn } from '@/shared/utils';

const LAYOUTS = [
  { panes: 1, cols: 1, rows: 1, label: 'Single' },
  { panes: 2, cols: 2, rows: 1, label: '2 side by side' },
  { panes: 3, cols: 3, rows: 1, label: '3 columns' },
  { panes: 4, cols: 2, rows: 2, label: '2 × 2' },
  { panes: 6, cols: 3, rows: 2, label: '3 × 2' },
  { panes: 8, cols: 4, rows: 2, label: '4 × 2' },
] as const;

const POPOVER_WIDTH_PX = 248;

/** A miniature of a pane grid. */
function GridGlyph({ cols, rows, className }: { cols: number; rows: number; className?: string }) {
  const width = 16;
  const height = 12;
  const gap = 1.2;
  const cellW = (width - gap * (cols - 1)) / cols;
  const cellH = (height - gap * (rows - 1)) / rows;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {Array.from({ length: rows }).flatMap((_, row) =>
        Array.from({ length: cols }).map((__, col) => (
          <rect
            key={`${row}-${col}`}
            x={col * (cellW + gap)}
            y={row * (cellH + gap)}
            width={cellW}
            height={cellH}
            rx={0.8}
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

type SidebarLayoutPickerProps = {
  /** Where the picker opens: under the header button, or beside the collapsed rail. */
  placement?: 'below' | 'right';
};

/**
 * One button showing the current pane grid; it opens a small picker of grid
 * layouts. Hidden inside a desktop pane loaded with `?solo`.
 */
export default function SidebarLayoutPicker({ placement = 'below' }: SidebarLayoutPickerProps) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (workspace.isSolo) return null;
  const current = LAYOUTS.find((layout) => layout.panes === workspace.layout) ?? LAYOUTS[0];

  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor(
        placement === 'right'
          ? { top: rect.top, left: rect.right + 8 }
          : { top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - POPOVER_WIDTH_PX - 8) },
      );
    }
    setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Layout: ${current.label}`}
        title={`Layout: ${current.label}`}
        className={cn(
          'flex items-center justify-center rounded-lg transition-colors hover:bg-accent/80 hover:text-foreground',
          placement === 'right' ? 'h-8 w-8' : 'h-7 w-7',
          open ? 'bg-accent/80 text-foreground' : 'text-muted-foreground',
        )}
      >
        <GridGlyph cols={current.cols} rows={current.rows} className="h-3.5 w-[1.15rem]" />
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Pane layout"
            style={{ top: anchor.top, left: anchor.left, width: POPOVER_WIDTH_PX }}
            className="fixed z-[170] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          >
            <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Layout
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {LAYOUTS.map((layout) => {
                const isCurrent = layout.panes === workspace.layout;
                return (
                  <button
                    key={layout.panes}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    onClick={() => {
                      workspace.setLayout(layout.panes);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border px-1 py-2 transition',
                      isCurrent
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <GridGlyph cols={layout.cols} rows={layout.rows} className="h-7 w-10" />
                    <span className="text-[10px] font-medium leading-tight">{layout.label}</span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
