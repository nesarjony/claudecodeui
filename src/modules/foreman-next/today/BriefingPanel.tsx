import { useTranslation } from 'react-i18next';

import type { Briefing } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';

function greetingKey(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = now.getHours();
  if (hour < 12) return 'morning';
  return hour < 18 ? 'afternoon' : 'evening';
}

/** Used by the Today screen for the briefing Foreman wrote: four sentences that say what happened, what needs the owner, whether goals are on track and what is left. */
export function BriefingPanel({ briefing }: { briefing: Briefing | null }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t(`today.greeting.${greetingKey(new Date())}`)}>
      {briefing ? (
        <div className="space-y-1.5 text-sm">
          {briefing.sentences.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('today.noBriefing')}</p>
      )}
    </Panel>
  );
}
