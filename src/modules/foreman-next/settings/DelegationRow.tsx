import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';

import type { DelegationChange, DelegationLevel, DelegationRule } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

const LEVELS: DelegationLevel[] = ['ask', 'recommend-wait', 'decide-tell', 'decide-silent'];
const VETO_WINDOWS_HOURS = [1, 2, 6, 12, 24];
const DEFAULT_VETO_HOURS = 6;

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm';

const changeTo = (level: DelegationLevel, vetoWindowHours: number | null): DelegationChange => ({
  level,
  vetoWindowHours: level === 'decide-tell' ? (vetoWindowHours ?? DEFAULT_VETO_HOURS) : null,
});

/** Used by the delegation table for one kind of decision on the trust ladder: its level, how often the owner agreed with Foreman, and Foreman's suggestion to move it up. */
export function DelegationRow({ rule, onChanged }: { rule: DelegationRule; onChanged: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const kindLabel = t(`delegation.kind.${rule.kind}`);

  const apply = async (change: DelegationChange) => {
    if (await run(() => api.setDelegation(rule.kind, change))) onChanged();
  };

  const chooseLevel = (event: ChangeEvent<HTMLSelectElement>) => void apply(changeTo(event.target.value as DelegationLevel, rule.vetoWindowHours));
  const chooseWindow = (event: ChangeEvent<HTMLSelectElement>) => void apply(changeTo('decide-tell', Number(event.target.value)));

  return (
    <tr className="border-t align-top">
      <th scope="row" className="py-2 pr-3 text-left font-normal">
        {kindLabel}
        {rule.kind === 'worker-setup' ? <span className="block text-xs text-muted-foreground">{t('delegation.note.worker-setup')}</span> : null}
      </th>
      <td className="px-3 py-2">
        {rule.locked ? (
          <span className="text-muted-foreground">{t('delegation.locked')}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t('delegation.levelFor', { kind: kindLabel })} value={rule.level} disabled={busy} onChange={chooseLevel} className={SELECT_CLASS}>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`delegation.level.${level}`)}
                </option>
              ))}
            </select>
            {rule.level === 'decide-tell' ? (
              <select aria-label={t('delegation.vetoFor', { kind: kindLabel })} value={rule.vetoWindowHours ?? DEFAULT_VETO_HOURS} disabled={busy} onChange={chooseWindow} className={SELECT_CLASS}>
                {VETO_WINDOWS_HOURS.map((hours) => (
                  <option key={hours} value={hours}>
                    {t('delegation.veto', { hours })}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        )}
        {failed ? <InlineError /> : null}
      </td>
      <td className="px-3 py-2 tabular-nums">{rule.decided === 0 ? '–' : t('delegation.agreed', { agreed: rule.agreed, decided: rule.decided })}</td>
      <td className="py-2 pl-3">
        {rule.suggestion ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('delegation.suggests', { level: t(`delegation.level.${rule.suggestion}`) })}</span>
            <Button size="sm" disabled={busy} onClick={() => void apply(changeTo(rule.suggestion as DelegationLevel, null))}>
              {t('delegation.approve')}
            </Button>
          </div>
        ) : (
          '–'
        )}
      </td>
    </tr>
  );
}
