import { useTranslation } from 'react-i18next';

import type { RunStage } from '@/modules/foreman-next/api/contract';
import { StateGlyph } from '@/modules/foreman-next/components/StateGlyph';
import type { GlyphState } from '@/modules/foreman-next/components/StateGlyph';

const GLYPH_OF: Record<RunStage['state'], GlyphState> = { done: 'done', running: 'running', pending: 'queued', failed: 'failed' };

/** Used by the run header for the run's stages in order, each with its state: attach or brief, worker, checks, judge, close. */
export function RunStages({ stages }: { stages: RunStage[] }) {
  const { t } = useTranslation('foremanNext');
  return (
    <ol aria-label={t('run.stages')} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {stages.map((stage, position) => (
        <li key={stage.id} className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            {t(`run.stage.${stage.id}`)} <StateGlyph state={GLYPH_OF[stage.state]} label={t(`run.stageState.${stage.state}`)} />
          </span>
          {position < stages.length - 1 ? <span aria-hidden className="text-muted-foreground">──▸</span> : null}
        </li>
      ))}
    </ol>
  );
}
