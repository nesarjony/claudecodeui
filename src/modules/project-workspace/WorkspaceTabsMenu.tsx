import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Folder, GitBranch, HardHat, MessageSquare, MoreHorizontal, Terminal } from 'lucide-react';

import { FOREMAN_TAB_LABEL_KEY, isForemanTabAvailable } from '@/modules/foreman';
import type { AppTab } from '@/shared/types';

type WorkspaceTabsMenuProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
};

const VIEWS: Array<{ id: AppTab; labelKey: string; icon: typeof MessageSquare }> = [
  { id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git', labelKey: 'tabs.git', icon: GitBranch },
  { id: 'foreman', labelKey: FOREMAN_TAB_LABEL_KEY, icon: HardHat },
];

const MENU_WIDTH_PX = 192;

/**
 * Chat is the workspace; Shell, Files and Source Control sit behind a ⋯ menu.
 * While one of them is open, a "Chat" button leads back.
 */
export default function WorkspaceTabsMenu({ activeTab, setActiveTab }: WorkspaceTabsMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const views = VIEWS.filter((view) => view.id !== 'foreman' || isForemanTabAvailable());
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

  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.right - MENU_WIDTH_PX, window.innerWidth - MENU_WIDTH_PX - 8)),
      });
    }
    setOpen((value) => !value);
  };

  return (
    <div className="flex items-center gap-1">
      {activeTab !== 'chat' && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setActiveTab('chat');
          }}
          className="flex h-8 items-center gap-1 rounded-lg border border-border/60 bg-muted/50 px-2.5 text-xs font-medium text-foreground transition hover:bg-muted"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t('tabs.chat')}
        </button>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Shell, files, source control and Foreman"
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-muted hover:text-foreground ${
          open ? 'bg-muted text-foreground' : 'text-muted-foreground'
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: anchor.top, left: anchor.left, width: MENU_WIDTH_PX }}
            className="fixed z-[170] overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          >
            {views.map((view) => (
              <button
                key={view.id}
                type="button"
                role="menuitemradio"
                aria-checked={activeTab === view.id}
                onClick={() => {
                  setActiveTab(view.id);
                  setOpen(false);
                }}
                className={`flex h-11 w-full items-center gap-2 rounded-lg px-3 text-sm transition hover:bg-muted sm:h-9 ${
                  activeTab === view.id ? 'bg-muted font-medium text-foreground' : 'text-foreground'
                }`}
              >
                <view.icon className="h-4 w-4 text-muted-foreground" />
                {t(view.labelKey)}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
