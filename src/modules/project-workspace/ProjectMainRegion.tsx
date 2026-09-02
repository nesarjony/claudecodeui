import { memo, useCallback, useEffect } from 'react';

import { useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SessionEstablishedContext, SessionNavigationOptions,ProjectWorkspaceShellProps } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import SessionPane from '@/modules/project-workspace/SessionPane';
import type { SharedPaneProps } from '@/modules/project-workspace/SessionPane';
import { useWorkspace } from '@/shared/hooks/useWorkspace';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to WorkspaceMain. */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    setSidebarOpen,
    isLoadingProjects,
    openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    registerOptimisticSession,
    handleProjectSelect,
    refreshProjectsSilently,
    projects,
  } = useProjectMainState();
  const workspace = useWorkspace();
  const { assignActive, assignNewSessionActive, layout } = workspace;
  const processingSessions = useProcessingSessions();

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const handleNavigateToSession = useCallback((
    targetSessionId: string,
    options?: SessionNavigationOptions,
  ) => {
    navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) });
  }, [navigate]);

  const handleSessionEstablished = useCallback((
    targetSessionId: string,
    context: SessionEstablishedContext,
  ) => {
    registerOptimisticSession({ sessionId: targetSessionId, ...context });
  }, [registerOptimisticSession]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  const resolvePane = useCallback((pane: { sessionId: string | null; newProjectId?: string | null }) => {
    if (pane.sessionId) {
      for (const project of projects) {
        const session = (project.sessions ?? []).find((candidate) => candidate.id === pane.sessionId);
        if (session) return { project, session };
      }
      return { project: null, session: null };
    }
    const project = pane.newProjectId
      ? projects.find((candidate) => candidate.projectId === pane.newProjectId) ?? null
      : null;
    return { project, session: null };
  }, [projects]);

  useEffect(() => {
    if (layout <= 1) return;
    if (selectedSession) {
      assignActive(selectedSession.id);
    } else if (selectedProject) {
      assignNewSessionActive(selectedProject.projectId);
    }
  }, [assignActive, assignNewSessionActive, layout, selectedProject, selectedSession]);

  const sharedPaneProps: SharedPaneProps = {
    ws,
    sendMessage,
    isMobile,
    isLoading: isLoadingProjects,
    onSessionEstablished: handleSessionEstablished,
    onShowSettings: openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    onProjectSelect: handleProjectSelect,
    onProjectsRefresh: handleProjectsRefresh,
  };

  const gridClass = isMobile
    ? 'grid-cols-1 grid-rows-2'
    : workspace.layout === 2
      ? 'grid-cols-2 grid-rows-1'
      : workspace.layout === 3
        ? 'grid-cols-3 grid-rows-1'
        : workspace.layout === 6
          ? 'grid-cols-3 grid-rows-2'
          : workspace.layout === 8
            ? 'grid-cols-4 grid-rows-2'
            : 'grid-cols-2 grid-rows-2';

  return (
    <div className="relative h-full min-h-0">
      {!workspace.isSolo && !isMobile && (
        <div className="absolute right-2 top-2 z-40 flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/90 p-0.5 shadow-sm backdrop-blur">
          {[1, 2, 3, 4, 6, 8].map((layout) => (
            <button
              key={layout}
              type="button"
              onClick={() => workspace.setLayout(layout)}
              className={`flex h-6 w-7 items-center justify-center rounded-md text-[11px] font-medium transition-colors ${
                workspace.layout === layout
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={layout === 1 ? 'Single view' : `${layout} panes`}
            >
              {layout}
            </button>
          ))}
        </div>
      )}

      {workspace.layout === 1 ? (
        <WorkspaceMain
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={handleOpenSidebar}
          isLoading={isLoadingProjects}
          onNavigateToSession={handleNavigateToSession}
          onSessionEstablished={handleSessionEstablished}
          onShowSettings={openSettings}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          onProjectSelect={handleProjectSelect}
          onProjectsRefresh={handleProjectsRefresh}
        />
      ) : (
        <div className={`grid h-full min-h-0 gap-0.5 p-0.5 ${gridClass}`}>
          {workspace.panes.map((pane) => {
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
                  if (resolved.session) navigate(`/session/${resolved.session.id}`);
                  workspace.expandPane(pane.id);
                }}
                onNavigate={(sessionId) => workspace.assignPane(pane.id, sessionId)}
                onMenu={isMobile ? handleOpenSidebar : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(ProjectMainRegion);
