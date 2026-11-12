import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '@/shared/types';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceTabsMenu from '@/modules/project-workspace/WorkspaceTabsMenu';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain: session title, chat status/actions and the views menu on one row. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
}: WorkspaceHeaderProps) {
  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
          <div data-chat-header-status="" className="flex shrink-0 items-center gap-1" />
          <div data-chat-header-actions="" className="ml-auto flex shrink-0 items-center" />
          <WorkspaceTabsMenu activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>

      </div>
    </header>
  );
}
