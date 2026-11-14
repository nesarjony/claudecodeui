import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { RunDecision } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { formatUsd } from '@/modules/foreman-next/utils/foremanFormat';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { buttonVariants } from '@/shared/ui';

function MakerLabel({ decision }: { decision: RunDecision }) {
  const { t } = useTranslation('foremanNext');
  if (decision.maker.type === 'code') return <>{t('run.makerRules')}</>;
  const label = decision.model ?? (decision.maker.type === 'role' ? decision.maker.role : t('record.makerOwner'));
  return <>{decision.costUsd === null ? label : `${label} · ${formatUsd(decision.costUsd)}`}</>;
}

/** Used by the run view for every decision Foreman made on this run: the turn, the choice, who made it and what it cost, with the decision card behind each. */
export function RunDecisionsPanel({ decisions }: { decisions: RunDecision[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('run.decisions')}>
      <ol className="space-y-2 text-sm">
        {decisions.map((decision) => (
          <li key={decision.turn} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="w-14 tabular-nums text-muted-foreground">{t('run.decisionTurn', { turn: decision.turn })}</span>
              <span className="w-24 font-medium">{t(`run.choice.${decision.choice}`)}</span>
              <span className="flex-1 text-muted-foreground">
                <MakerLabel decision={decision} />
              </span>
              {decision.cardId ? (
                <Link to={foremanPath.decision(decision.cardId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  {t('run.card')}
                </Link>
              ) : null}
            </div>
            {decision.quote ? <p className="pl-[4.5rem] text-muted-foreground">"{decision.quote}"</p> : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
