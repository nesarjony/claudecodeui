import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ATTENTION_PHONE } from '@/modules/foreman-next/api/contract';
import type { AttentionPolicy, AttentionRule } from '@/modules/foreman-next/api/contract';
import { InlineError } from '@/modules/foreman-next/components/InlineError';
import { NativeSelect } from '@/modules/foreman-next/components/NativeSelect';
import { useAction } from '@/modules/foreman-next/hooks/useAction';
import { useForemanApi } from '@/modules/foreman-next/hooks/useForemanApi';
import { Button, Input } from '@/shared/ui';

const DELAYS_MINUTES = [30, 60, 120, 240];

/** Used by the Settings screen to read and edit the attention policy (BR-4.9): what interrupts the owner on the phone, what waits for the briefing, what is only logged, and the quiet hours. */
export function AttentionForm({ policy }: { policy: AttentionPolicy }) {
  const { t } = useTranslation('foremanNext');
  const api = useForemanApi();
  const { busy, failed, run } = useAction();
  // The policy as edited; nothing is sent until the owner presses Save.
  const [draft, setDraft] = useState(policy);

  const setRule = (event: AttentionRule['event'], change: Partial<AttentionRule>) =>
    setDraft((current) => ({ ...current, rules: current.rules.map((rule) => (rule.event === event ? { ...rule, ...change } : rule)) }));

  const choosePhone = (rule: AttentionRule, value: string) => {
    const phone = ATTENTION_PHONE.find((option) => option === value);
    if (phone) setRule(rule.event, { phone, phoneDelayMinutes: phone === 'delayed' ? (rule.phoneDelayMinutes ?? 30) : null });
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
                      <NativeSelect aria-label={t('attention.phoneFor', { event: label })} value={rule.phone} onChange={(event) => choosePhone(rule, event.target.value)}>
                        {ATTENTION_PHONE.map((option) => (
                          <option key={option} value={option}>
                            {t(`attention.phoneOption.${option}`)}
                          </option>
                        ))}
                      </NativeSelect>
                      {rule.phone === 'delayed' ? (
                        <NativeSelect aria-label={t('attention.delayFor', { event: label })} value={rule.phoneDelayMinutes ?? 30} onChange={(event) => setRule(rule.event, { phoneDelayMinutes: Number(event.target.value) })}>
                          {DELAYS_MINUTES.map((minutes) => (
                            <option key={minutes} value={minutes}>
                              {t('attention.delay', { minutes })}
                            </option>
                          ))}
                        </NativeSelect>
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
          <Input type="time" value={draft.quietFrom} onChange={(event) => setDraft({ ...draft, quietFrom: event.target.value })} className="w-auto" />
        </label>
        <label className="flex items-center gap-2">
          {t('attention.quietTo')}
          <Input type="time" value={draft.quietTo} onChange={(event) => setDraft({ ...draft, quietTo: event.target.value })} className="w-auto" />
        </label>
        <label className="flex items-center gap-2">
          {t('attention.briefingAt')}
          <Input type="time" value={draft.briefingAt} onChange={(event) => setDraft({ ...draft, briefingAt: event.target.value })} className="w-auto" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('attention.quietNote')}</p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void run(() => api.setAttention(draft))}>
          {t('common.save')}
        </Button>
        {failed ? <InlineError /> : null}
      </div>
    </div>
  );
}
