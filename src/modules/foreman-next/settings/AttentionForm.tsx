import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AttentionPolicy, AttentionRule } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button } from '@/shared/ui';

const PHONE_OPTIONS: AttentionRule['phone'][] = ['now', 'delayed', 'never'];
const DELAYS_MINUTES = [30, 60, 120, 240];
const SELECT_CLASS = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm';
const TIME_CLASS = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm';

/** Used by the Settings screen to read and edit the attention policy (BR-4.9): what interrupts the owner on the phone, what waits for the briefing, what is only logged, and the quiet hours. */
export function AttentionForm({ policy, onSaved }: { policy: AttentionPolicy; onSaved: () => void }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // The policy as edited; nothing is sent until the owner presses Save.
  const [draft, setDraft] = useState(policy);

  const setRule = (event: AttentionRule['event'], change: Partial<AttentionRule>) =>
    setDraft((current) => ({ ...current, rules: current.rules.map((rule) => (rule.event === event ? { ...rule, ...change } : rule)) }));

  const save = async () => {
    if (await run(() => api.setAttention(draft))) onSaved();
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">{t('attention.event')}</th>
              <th scope="col" className="px-3 py-1 font-medium">{t('attention.phone')}</th>
              <th scope="col" className="px-3 py-1 font-medium">{t('attention.briefing')}</th>
              <th scope="col" className="py-1 pl-3 font-medium">{t('attention.logOnly')}</th>
            </tr>
          </thead>
          <tbody>
            {draft.rules.map((rule) => {
              const label = t(`attention.events.${rule.event}`);
              return (
                <tr key={rule.event} className="border-t">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={t('attention.phoneFor', { event: label })}
                        value={rule.phone}
                        onChange={(event) => setRule(rule.event, { phone: event.target.value as AttentionRule['phone'], phoneDelayMinutes: event.target.value === 'delayed' ? (rule.phoneDelayMinutes ?? 30) : null })}
                        className={SELECT_CLASS}
                      >
                        {PHONE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {t(`attention.phoneOption.${option}`)}
                          </option>
                        ))}
                      </select>
                      {rule.phone === 'delayed' ? (
                        <select aria-label={t('attention.delayFor', { event: label })} value={rule.phoneDelayMinutes ?? 30} onChange={(event) => setRule(rule.event, { phoneDelayMinutes: Number(event.target.value) })} className={SELECT_CLASS}>
                          {DELAYS_MINUTES.map((minutes) => (
                            <option key={minutes} value={minutes}>
                              {t('attention.delay', { minutes })}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={t('attention.briefingFor', { event: label })} checked={rule.briefing} onChange={(event) => setRule(rule.event, { briefing: event.target.checked })} />
                  </td>
                  <td className="py-2 pl-3 text-muted-foreground">{rule.phone === 'never' && !rule.briefing ? '✓' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          {t('attention.quietFrom')}
          <input type="time" value={draft.quietFrom} onChange={(event) => setDraft({ ...draft, quietFrom: event.target.value })} className={TIME_CLASS} />
        </label>
        <label className="flex items-center gap-2">
          {t('attention.quietTo')}
          <input type="time" value={draft.quietTo} onChange={(event) => setDraft({ ...draft, quietTo: event.target.value })} className={TIME_CLASS} />
        </label>
        <label className="flex items-center gap-2">
          {t('attention.briefingAt')}
          <input type="time" value={draft.briefingAt} onChange={(event) => setDraft({ ...draft, briefingAt: event.target.value })} className={TIME_CLASS} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('attention.quietNote')}</p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {failed ? <InlineError /> : null}
      </div>
    </div>
  );
}
