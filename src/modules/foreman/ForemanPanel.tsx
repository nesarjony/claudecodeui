import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Inbox, Lightbulb, ListChecks, SlidersHorizontal, Wallet } from 'lucide-react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import '@/modules/foreman/i18n';
import { foremanTabApi } from '@/modules/foreman/api';
import { Chip } from '@/modules/foreman/components/Chip';
import Section from '@/modules/foreman/components/Section';
import { DECISIONS_PAGE } from '@/modules/foreman/constants';
import DecisionsSection from '@/modules/foreman/sections/DecisionsSection';
import LessonsSection from '@/modules/foreman/sections/LessonsSection';
import NeedsYouSection from '@/modules/foreman/sections/NeedsYouSection';
import SettingsSection from '@/modules/foreman/sections/SettingsSection';
import SpendSection from '@/modules/foreman/sections/SpendSection';
import StatusBar from '@/modules/foreman/sections/StatusBar';
import TasksSection from '@/modules/foreman/sections/TasksSection';
import type { SpendRange } from '@/modules/foreman/types';
import { usePageVisible, usePolledResource } from '@/modules/foreman/usePolledResource';
import { useSectionOpen } from '@/modules/foreman/useSectionOpen';
import { formatUsd } from '@/modules/foreman/format';

type ForemanPanelProps = {
  /** False while another tab is in front: polling stops. */
  isVisible?: boolean;
  /** Opens a session's chat (the session links on needs-you items, tasks and decisions). */
  onOpenSession: (sessionId: string) => void;
};

type SectionId = 'needs' | 'tasks' | 'decisions' | 'spend' | 'lessons' | 'settings';

// A phone shows the things that need a decision first; the reading sections start folded.
const DEFAULT_OPEN: Record<SectionId, boolean> = { needs: true, tasks: true, decisions: true, spend: false, lessons: false, settings: false };

const WS_REFRESH_DEBOUNCE_MS = 300;

/**
 * The Foreman tab: status bar, then collapsible sections (needs you, tasks, live decisions, spend, lessons, settings).
 *
 * Each section's data is polled every 5 seconds while the tab is in front, the browser tab is visible and the section is
 * open. A `foreman_suggestion` frame on the chat WebSocket (a new decision) refreshes everything at once instead of
 * waiting for the next tick.
 */
export default function ForemanPanel({ isVisible = true, onOpenSession }: ForemanPanelProps) {
  const { t } = useTranslation('foreman');
  const { subscribe } = useWebSocket();
  const pageVisible = usePageVisible();
  const live = isVisible && pageVisible;
  const { open, toggle, show } = useSectionOpen(DEFAULT_OPEN);
  const [decisionLimit, setDecisionLimit] = useState(DECISIONS_PAGE);
  const [spendRange, setSpendRange] = useState<SpendRange>('today');
  const needsRef = useRef<HTMLDivElement>(null);

  const overview = usePolledResource(foremanTabApi.overview, { enabled: live });
  const inbox = usePolledResource(foremanTabApi.inbox, { enabled: live && open.needs });
  const tasks = usePolledResource(() => foremanTabApi.tasks(), { enabled: live && open.tasks });
  const decisions = usePolledResource(() => foremanTabApi.decisions({ limit: decisionLimit }), { enabled: live && open.decisions, key: String(decisionLimit) });
  const spend = usePolledResource(() => foremanTabApi.spend(spendRange), { enabled: live && open.spend, key: spendRange });
  const lessons = usePolledResource(() => foremanTabApi.lessons(), { enabled: live && open.lessons });
  const config = usePolledResource(foremanTabApi.getConfig, { enabled: live && open.settings });

  // The refreshers change identity every render; the WebSocket listener reads the latest through a ref.
  const refreshAll = useRef<() => void>(() => undefined);
  useEffect(() => {
    refreshAll.current = () => {
      void overview.refresh();
      void inbox.refresh();
      void tasks.refresh();
      void decisions.refresh();
    };
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.kind !== 'foreman_suggestion' && event.kind !== 'websocket_reconnected') return;
      clearTimeout(timer);
      timer = setTimeout(() => refreshAll.current(), WS_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe]);

  const showNeedsYou = useCallback(() => {
    show('needs');
    setTimeout(() => needsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0);
  }, [show]);

  const data = overview.data;
  const spentToday = data ? data.budgets.today.foremanUsd + data.budgets.today.workerUsd : null;

  return (
    <div data-testid="foreman-panel" className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-3 px-3 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <StatusBar overview={overview} onShowNeedsYou={showNeedsYou} />

        <div ref={needsRef} className="min-w-0 scroll-mt-3">
          <Section
            id="needs"
            title={t('sections.needs')}
            icon={Inbox}
            open={open.needs}
            onToggle={() => toggle('needs')}
            badge={data && data.needsUserCount > 0 ? <Chip tone="warn">{data.needsUserCount}</Chip> : null}
          >
            <NeedsYouSection inbox={inbox} onOpenSession={onOpenSession} onAnswered={() => void overview.refresh()} />
          </Section>
        </div>

        <Section
          id="tasks"
          title={t('sections.tasks')}
          icon={ListChecks}
          open={open.tasks}
          onToggle={() => toggle('tasks')}
          badge={data && data.activeTasks > 0 ? <Chip tone="info">{t('sections.activeCount', { count: data.activeTasks })}</Chip> : null}
        >
          <TasksSection tasks={tasks} live={live} onOpenSession={onOpenSession} onChanged={() => void overview.refresh()} />
        </Section>

        <Section id="decisions" title={t('sections.decisions')} icon={Activity} open={open.decisions} onToggle={() => toggle('decisions')}>
          <DecisionsSection
            decisions={decisions}
            limit={decisionLimit}
            onLoadMore={() => setDecisionLimit((current) => current + DECISIONS_PAGE)}
            onOpenSession={onOpenSession}
            live={live}
          />
        </Section>

        <Section
          id="spend"
          title={t('sections.spend')}
          icon={Wallet}
          open={open.spend}
          onToggle={() => toggle('spend')}
          badge={spentToday !== null ? <Chip>{formatUsd(spentToday)}</Chip> : null}
        >
          <SpendSection spend={spend} range={spendRange} onRange={setSpendRange} />
        </Section>

        <Section id="lessons" title={t('sections.lessons')} icon={Lightbulb} open={open.lessons} onToggle={() => toggle('lessons')}>
          <LessonsSection lessons={lessons} />
        </Section>

        <Section id="settings" title={t('sections.settings')} icon={SlidersHorizontal} open={open.settings} onToggle={() => toggle('settings')}>
          <SettingsSection config={config} onSaved={() => void overview.refresh()} />
        </Section>
      </div>
    </div>
  );
}
