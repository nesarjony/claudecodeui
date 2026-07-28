import { useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeft } from 'lucide-react';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useWorkspace } from '../../hooks/useWorkspace';
import SessionPane, { type SharedPaneProps } from '../workspace/SessionPane';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });

  // --- Native multi-pane workspace (browser split-view) --------------------
  const workspace = useWorkspace();

  const resolvePane = useCallback(
    (pane: { sessionId: string | null; newProjectId?: string | null }) => {
      if (pane.sessionId) {
        for (const proj of projects) {
          const sess = (proj.sessions || []).find((s) => s.id === pane.sessionId);
          if (sess) return { project: proj, session: sess };
        }
        return { project: null, session: null };
      }
      // New-session pane: a project with no session yet → render the composer.
      if (pane.newProjectId) {
        const proj = projects.find((p) => p.projectId === pane.newProjectId) || null;
        return { project: proj, session: null };
      }
      return { project: null, session: null };
    },
    [projects],
  );

  const sharedPaneProps: SharedPaneProps = {
    ws,
    sendMessage,
    isMobile,
    isLoading: isLoadingProjects,
    onInputFocusChange: setIsInputFocused,
    onSessionProcessing: markSessionProcessing,
    onSessionIdle: markSessionIdle,
    processingSessions,
    onSessionEstablished: (targetSessionId, context) =>
      registerOptimisticSession({ sessionId: targetSessionId, ...context }),
    onShowSettings: openSettings,
    externalMessageUpdate,
    newSessionTrigger,
  };

  // Multi-pane grid: up to 4 panes on desktop, up to 2 on mobile (where more
  // than two would wrap code one character per line). Mobile stacks its two
  // panes vertically (top/bottom); desktop tiles horizontally / 2x2.
  const maxPanes = isMobile ? 2 : 8;
  const effLayout = Math.min(Math.max(workspace.layout, 1), maxPanes);
  const gridActive = effLayout > 1;
  const gridPanes = workspace.panes.slice(0, effLayout);

  // Mobile always uses the slide-over drawer (no room for a permanent column);
  // desktop uses the drawer only in single-pane view. The grid keeps the
  // permanent column on desktop — that's where you click sessions to fill panes.
  const sidebarDrawer = isMobile || !gridActive;
  const showDrawerToggle = !isMobile && !gridActive && !workspace.isSolo;

  // In grid mode, clicking a session in the sidebar fills the focused pane
  // instead of navigating the single view (and collapses the mobile drawer).
  const sidebarProps =
    gridActive
      ? {
          ...sidebarSharedProps,
          onSessionSelect: (session: { id: string }) => {
            workspace.assignActive(session.id);
            if (isMobile) setSidebarOpen(false);
          },
          // "New Session" fills the focused pane with a fresh composer instead of
          // driving the (hidden) single view — otherwise the click does nothing.
          onNewSession: (project: Parameters<typeof sidebarSharedProps.onNewSession>[0]) => {
            workspace.assignNewSessionActive(project.projectId);
            if (isMobile) setSidebarOpen(false);
          },
        }
      : showDrawerToggle
        ? {
            // Desktop single-pane: the sidebar is a drawer, so collapse it after
            // any navigation (mobile already does this internally; desktop does not).
            ...sidebarSharedProps,
            onSessionSelect: (session: Parameters<typeof sidebarSharedProps.onSessionSelect>[0]) => {
              sidebarSharedProps.onSessionSelect(session);
              setSidebarOpen(false);
            },
            onProjectSelect: (project: Parameters<typeof sidebarSharedProps.onProjectSelect>[0]) => {
              sidebarSharedProps.onProjectSelect(project);
              setSidebarOpen(false);
            },
            onNewSession: (project: Parameters<typeof sidebarSharedProps.onNewSession>[0]) => {
              sidebarSharedProps.onNewSession(project);
              setSidebarOpen(false);
            },
          }
        : sidebarSharedProps;

  const gridColsClass = isMobile
    ? 'grid-cols-1 grid-rows-2'
    : effLayout === 2
      ? 'grid-cols-2 grid-rows-1'
      : effLayout === 3
        ? 'grid-cols-3 grid-rows-1'
        : effLayout === 6
          ? 'grid-cols-3 grid-rows-2'
          : effLayout === 8
            ? 'grid-cols-4 grid-rows-2'
            : 'grid-cols-2 grid-rows-2';

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!sidebarDrawer ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarProps} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative flex h-full w-[85vw] max-w-sm transform flex-col border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            {/* Mobile split-view toggle: 1 session (full) or 2 (top/bottom).
                Lives in the drawer because the header's top-right is taken by the
                tab icons — a floating switcher would overlap them on a phone. */}
            {isMobile && (
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">View</span>
                <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
                  {[
                    { n: 1, label: 'Full' },
                    { n: 2, label: 'Split' },
                  ].map(({ n, label }) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        workspace.setLayout(n);
                        setSidebarOpen(false);
                      }}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        effLayout === n
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <Sidebar {...sidebarProps} />
            </div>
          </div>
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Split-view layout switcher — desktop only (hidden on mobile, where the
            grid is unusable, and inside desktop panes = ?solo) */}
        {!workspace.isSolo && !isMobile && (
          <div className="absolute right-2 top-2 z-40 flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/90 p-0.5 shadow-sm backdrop-blur">
            {showDrawerToggle && (
              <>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="flex h-6 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                  title="Sessions"
                  aria-label="Open sessions"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </button>
                <div className="mx-0.5 h-4 w-px bg-border/60" />
              </>
            )}
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => workspace.setLayout(n)}
                className={`flex h-6 w-7 items-center justify-center rounded-md text-[11px] font-medium transition-colors ${
                  workspace.layout === n
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={n === 1 ? 'Single view' : `${n} panes`}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {!gridActive ? (
          <MainContent
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            ws={ws}
            sendMessage={sendMessage}
            isMobile={isMobile}
            onMenuClick={() => setSidebarOpen(true)}
            isLoading={isLoadingProjects}
            onInputFocusChange={setIsInputFocused}
            onSessionProcessing={markSessionProcessing}
            onSessionIdle={markSessionIdle}
            processingSessions={processingSessions}
            onNavigateToSession={(targetSessionId: string, options) =>
              navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
            }
            onSessionEstablished={(targetSessionId, context) =>
              registerOptimisticSession({ sessionId: targetSessionId, ...context })
            }
            onShowSettings={openSettings}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
          />
        ) : (
          <div className={`grid h-full min-h-0 gap-0.5 p-0.5 ${gridColsClass}`}>
            {gridPanes.map((pane) => {
              const resolved = resolvePane(pane);
              return (
                <SessionPane
                  key={pane.id}
                  project={resolved.project}
                  session={resolved.session}
                  projects={projects}
                  shared={sharedPaneProps}
                  isActive={pane.id === workspace.activePaneId}
                  isRunning={Boolean(resolved.session && processingSessions.has(resolved.session.id))}
                  onFocus={() => workspace.focusPane(pane.id)}
                  onClose={() => workspace.clearPane(pane.id)}
                  onExpand={() => {
                    // Collapsing to the single view: that view is driven by the
                    // URL session, so point it at this pane's session first.
                    if (resolved.session) navigate(`/session/${resolved.session.id}`);
                    workspace.expandPane(pane.id);
                  }}
                  onNavigate={(sid) => workspace.assignPane(pane.id, sid)}
                  onMenu={isMobile ? () => { workspace.focusPane(pane.id); setSidebarOpen(true); } : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={setActiveTab}
      />
    </div>
  );
}
