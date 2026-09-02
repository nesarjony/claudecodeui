import { Check, ChevronsUpDown, FolderGit2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitWorktree } from '../types/types';

type GitWorktreeSelectorProps = {
  worktrees: GitWorktree[];
  selectedPath: string | null;
  isLoading: boolean;
  isMobile: boolean;
  onChange: (path: string) => void;
};

export default function GitWorktreeSelector({
  worktrees,
  selectedPath,
  isLoading,
  isMobile,
  onChange,
}: GitWorktreeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedWorktree = worktrees.find((worktree) => worktree.path === selectedPath);
  const label = selectedWorktree?.path.split('/').filter(Boolean).at(-1) ?? 'Worktree';

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        disabled={isLoading || worktrees.length === 0}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-lg text-left transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60 ${
          isMobile ? 'px-1.5 py-1' : 'max-w-[16rem] px-3 py-1.5'
        }`}
        title={selectedWorktree?.path ?? 'Loading worktrees…'}
        aria-label="Choose Git worktree"
        aria-expanded={isOpen}
      >
        <FolderGit2 className={`shrink-0 text-muted-foreground ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
        <span className={`min-w-0 truncate font-medium ${isMobile ? 'text-xs' : 'text-sm'}`}>{label}</span>
        {worktrees.length > 1 && <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
      </button>

      {isOpen && worktrees.length > 0 && (
        <div className="absolute left-0 top-full z-[60] mt-1 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
          <div className="border-b border-border/70 px-3 py-2">
            <p className="text-xs font-semibold text-foreground">Git worktree</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">All Git actions use the selected directory.</p>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {worktrees.map((worktree) => {
              const isSelected = worktree.path === selectedPath;
              return (
                <button
                  key={worktree.path}
                  type="button"
                  onClick={() => {
                    onChange(worktree.path);
                    setIsOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent ${
                    isSelected ? 'bg-accent/70' : ''
                  }`}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {worktree.path.split('/').filter(Boolean).at(-1) ?? worktree.path}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {worktree.branch ?? 'detached'}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={worktree.path}>
                      {worktree.path}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
