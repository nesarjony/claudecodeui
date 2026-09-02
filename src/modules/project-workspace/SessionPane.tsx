import { useState } from 'react';
import type { ComponentProps } from 'react';
import { Maximize2, Menu, X } from 'lucide-react';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import type { AppTab, Project, ProjectSession } from '@/shared/types';

// Everything MainContent needs that is shared across every pane (socket, session
// protection, settings, etc.). The per-pane bits (which project/session it shows,
// its active tab, how it navigates/closes) are supplied by SessionPane itself.
//
// Panes are NOT full separate chrome: each renders MainContent with its heavy
// full-width header SUPPRESSED (showHeader={false}) and instead carries a single
// slim strip — icon-only tabs (Chat/Shell/Files/Git) + pane controls. So the
// tab bodies are fully reused, but four panes no longer stack four 53px headers.
export type SharedPaneProps = Omit<
  ComponentProps<typeof WorkspaceMain>,
  | 'selectedProject'
  | 'selectedSession'
  | 'activeTab'
  | 'setActiveTab'
  | 'onMenuClick'
  | 'onNavigateToSession'
  | 'showHeader'
  | 'isActivePane'
>;

type SessionPaneProps = {
  project: Project | null;
  session: ProjectSession | null;
  projects: Project[];
  shared: SharedPaneProps;
  isActive: boolean;
  onFocus: () => void;
  onClose: () => void;
  onExpand: () => void;
  onNavigate: (sessionId: string) => void;
  // True while this pane's session has an active LLM run -- drives the animated
  // running border so you can tell at a glance which panes are working.
  isRunning?: boolean;
  // Mobile only: the pane's own header menu button opens the global session
  // drawer (so you can fill/switch this pane). Undefined on desktop = no-op.
  onMenu?: () => void;
};

function sessionLabel(session: ProjectSession): string {
  const s = session as { summary?: string; title?: string; name?: string; id: string };
  return s.summary || s.title || s.name || s.id;
}

export default function SessionPane({
  project,
  session,
  projects,
  shared,
  isActive,
  onFocus,
  onClose,
  onExpand,
  onNavigate,
  onMenu,
  isRunning = false,
}: SessionPaneProps) {
  // Each pane owns its active tool tab independently from the route-level workspace.
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  // Empty panes reveal their session chooser only after the user requests it.
  const [showList, setShowList] = useState(false);

  const title = session
    ? sessionLabel(session)
    : project
      ? `New session · ${project.displayName}`
      : 'Empty pane';

  const handleSessionEstablished: SharedPaneProps['onSessionEstablished'] = (sessionId, context) => {
    shared.onSessionEstablished(sessionId, context);
    onNavigate(sessionId);
  };

  return (
    <div
      className={`pane-chat group relative flex min-w-0 flex-col overflow-hidden rounded-lg border ${
        isRunning ? 'pane-running' : isActive ? 'border-primary' : 'border-border/50'
      }`}
      onMouseDownCapture={onFocus}
    >
      {project ? (
        <>
          {/* Slim shared header strip — replaces MainContent's 53px header.
              One line: mobile menu · active dot · session title · icon tabs
              (Chat/Shell/Files/Git) · expand to full view · close.
              FULLY TRANSPARENT overlay — just the title + tab icons floating over
              the chat, which scrolls underneath. The header costs the pane no
              height; the tab pill and buttons keep their own small backgrounds so
              they stay legible over any content. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-2 py-1 [&_button]:pointer-events-auto">
            {onMenu && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onMenu();
                }}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground md:hidden"
                title="Sessions"
                aria-label="Open sessions"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                isRunning
                  ? 'animate-pulse bg-emerald-500'
                  : isActive
                    ? 'bg-primary'
                    : 'bg-muted-foreground/40'
              }`}
            />
            <span
              className="min-w-0 flex-1 truncate text-xs font-bold tracking-tight text-foreground [text-shadow:0_1px_2px_hsl(var(--background)),0_0_4px_hsl(var(--background)),0_0_8px_hsl(var(--background))]"
              title={title}
            >
              {title}
            </span>
            <div className="flex-shrink-0">
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={false}
                shouldShowBrowserTab={false}
              />
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              title="Expand to full view"
              aria-label="Expand this pane to the full workspace"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              title="Close this pane"
              aria-label="Close this pane"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1">
            <WorkspaceMain
              {...shared}
              selectedProject={project}
              selectedSession={session}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              showHeader={false}
              isActivePane={isActive}
              onMenuClick={onMenu ?? (() => {})}
              // A new/created session inside this pane fills THIS pane rather
              // than navigating the (hidden) single view.
              onNavigateToSession={(targetSessionId) => onNavigate(targetSessionId)}
              onSessionEstablished={handleSessionEstablished}
            />
          </div>
        </>
      ) : showList ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 items-center justify-between px-3 pb-1 pt-3">
            <span className="text-xs font-medium text-muted-foreground">Choose a session</span>
            <button
              type="button"
              onClick={() => setShowList(false)}
              className="rounded px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {projects.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground/70">No sessions yet.</div>
            ) : (
              projects.map((proj) => (
                <div key={proj.projectId}>
                  <div className="truncate px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    {proj.displayName}
                  </div>
                  {(proj.sessions || []).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onNavigate(s.id)}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent/60"
                    >
                      <span className="text-muted-foreground">·</span>
                      <span className="truncate">{sessionLabel(s)}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <div className="text-sm font-medium text-muted-foreground">Empty pane</div>
          <button
            type="button"
            onClick={() => setShowList(true)}
            className="rounded-lg border border-border/60 bg-card px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            Choose a session
          </button>
          <div className="text-[11px] text-muted-foreground/60">or pick one from the sidebar</div>
        </div>
      )}
    </div>
  );
}
