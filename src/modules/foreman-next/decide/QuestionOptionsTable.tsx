import { useTranslation } from 'react-i18next';

import type { QuestionOption } from '@/modules/foreman-next/api/contract';
import { Chip } from '@/modules/foreman-next/components/Chip';

/** Used by the question card for the options and what each one does to the goal's rows, cost and risk. */
export function QuestionOptionsTable({ options, recommendedId }: { options: QuestionOption[]; recommendedId: string | null }) {
  const { t } = useTranslation('foremanNext');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('decide.options')}</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('decide.options')}
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              {t('decide.rowsNow')}
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              {t('decide.cost')}
            </th>
            <th scope="col" className="py-1 pl-3 font-medium">
              {t('decide.risk')}
            </th>
          </tr>
        </thead>
        <tbody>
          {options.map((option) => (
            <tr key={option.id} className="border-t">
              <th scope="row" className="py-1.5 pr-3 font-normal">
                <span className="mr-2 font-semibold">{option.id}</span>
                {option.label}
                {option.id === recommendedId ? <Chip tone="info" className="ml-2">{t('decide.recommended')}</Chip> : null}
              </th>
              <td className="px-3 py-1.5 text-right tabular-nums">{option.rowsDelta > 0 ? `+${option.rowsDelta}` : option.rowsDelta}</td>
              <td className="px-3 py-1.5">{option.cost}</td>
              <td className="py-1.5 pl-3">{option.risk}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
