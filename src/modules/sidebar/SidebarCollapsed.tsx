import { Settings, PanelLeftOpen, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import SidebarLayoutPicker from '@/modules/sidebar/SidebarLayoutPicker';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  restartRequired: boolean;
  t: TFunction;
};

/** Rendered by Sidebar instead of SidebarContent when the panel is collapsed to its icon rail. */
export default function SidebarCollapsed({ onExpand, onShowSettings, restartRequired, t }: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <SidebarLayoutPicker placement="right" />

      <div className="nav-divider my-1 w-6" />

      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {restartRequired && (
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label={t('version.restartRequired')}
          title={t('version.restartRequired')}
        >
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        </div>
      )}
    </div>
  );
}
