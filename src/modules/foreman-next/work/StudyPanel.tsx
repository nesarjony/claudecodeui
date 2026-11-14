import { useTranslation } from 'react-i18next';

import type { StudyStep } from '@/modules/foreman-next/api/contract';
import { Panel } from '@/modules/foreman-next/components/Panel';
import { StateGlyph } from '@/modules/foreman-next/components/StateGlyph';
import type { GlyphState } from '@/modules/foreman-next/components/StateGlyph';

const GLYPH_OF: Record<StudyStep['state'], GlyphState> = { done: 'done', running: 'running', pending: 'queued' };

/** Used by the goal page while Foreman studies a new goal, before any strategy exists (wireframes §14, step 3): what it reads and how far it is. */
export function StudyPanel({ steps }: { steps: StudyStep[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <Panel title={t('work.study.title')}>
      <p className="mb-3 text-sm text-muted-foreground">{t('work.study.intro')}</p>
      <ol className="space-y-1 text-sm">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            <StateGlyph state={GLYPH_OF[step.state]} label={t(`work.study.state.${step.state}`)} />
            {t(`work.study.step.${step.id}`)}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
