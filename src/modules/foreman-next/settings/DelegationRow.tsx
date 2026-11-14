import { useTranslation } from 'react-i18next';
import type { ChangeEvent } from 'react';

import { DELEGATION_LEVELS } from '@/modules/foreman-next/api/contract';
import type { DelegationChange, DelegationLevel, DelegationRule } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { NativeSelect } from '@/modules/foreman-next/components/NativeSelect';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

const VETO_WINDOWS_HOURS = [1, 2, 6, 12, 24];
const DEFAULT_VETO_HOURS = 6;

const changeTo = (level: DelegationLevel, vetoWindowHours: number | null): DelegationChange => ({
  level,
  vetoWindowHours: level === 'decide-tell' ? (vetoWindowHours ?? DEFAULT_VETO_HOURS) : null,
});

/** Used by the delegation table for one kind of decision on the trust ladder: its level, how often the owner agreed with Foreman, and Foreman's suggestion to move it up. */
export function DelegationRow({ rule }: { rule: DelegationRule }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  const kindLabel = t(`delegation.kind.${rule.kind}`);

  const apply = (change: DelegationChange) => run(() => api.setDelegation(rule.kind, change));

  const chooseLevel = (event: ChangeEvent<HTMLSelectElement>) => {
    const level = DELEGATION_LEVELS.find((candidate) => candidate === event.target.value);
    if (level) void apply(changeTo(level, rule.vetoWindowHours));
  };
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
            <NativeSelect aria-label={t('delegation.levelFor', { kind: kindLabel })} value={rule.level} disabled={busy} onChange={chooseLevel}>
              {DELEGATION_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`delegation.level.${level}`)}
                </option>
              ))}
            </NativeSelect>
            {rule.level === 'decide-tell' ? (
              <NativeSelect aria-label={t('delegation.vetoFor', { kind: kindLabel })} value={rule.vetoWindowHours ?? DEFAULT_VETO_HOURS} disabled={busy} onChange={chooseWindow}>
                {VETO_WINDOWS_HOURS.map((hours) => (
                  <option key={hours} value={hours}>
                    {t('delegation.veto', { hours })}
                  </option>
                ))}
              </NativeSelect>
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
            <Button size="sm" disabled={busy} onClick={() => rule.suggestion && void apply(changeTo(rule.suggestion, null))}>
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
