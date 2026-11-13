import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { foremanTabApi } from '@/modules/foreman/api';
import { Empty, LoadError, Loading } from '@/modules/foreman/components/Bits';
import { statusTone } from '@/modules/foreman/chipTone';
import { Chip } from '@/modules/foreman/components/Chip';
import ConfirmDialog from '@/modules/foreman/components/ConfirmDialog';
import { formatPercent, repoLabel } from '@/modules/foreman/format';
import { evidenceLines } from '@/modules/foreman/taskView';
import type { PolledResource } from '@/modules/foreman/usePolledResource';
import type { Lesson } from '@/modules/foreman/types';

function LessonCard({ lesson, onRetire }: { lesson: Lesson; onRetire: (lesson: Lesson) => void }) {
  const { t } = useTranslation('foreman');
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = evidenceLines(lesson.evidence);
  const retired = lesson.status === 'retired';
  return (
    <li data-testid="foreman-lesson" data-status={lesson.status} className={`min-w-0 space-y-1.5 rounded-lg border border-border/50 bg-background/40 p-2.5 ${retired ? 'opacity-60' : ''}`}>
      <p className="m-0 whitespace-pre-wrap break-words text-sm text-foreground">{lesson.text ?? lesson.id}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {lesson.status && <Chip tone={statusTone(lesson.status)}>{t(`lessons.status.${lesson.status}`, { defaultValue: lesson.status })}</Chip>}
        {typeof lesson.confidence === 'number' && <Chip title={t('lessons.confidenceTitle')}>{t('lessons.confidence', { percent: formatPercent(lesson.confidence) })}</Chip>}
        {typeof lesson.uses === 'number' && <Chip>{t('lessons.uses', { count: lesson.uses })}</Chip>}
      </div>
      {evidence.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowEvidence((value) => !value)} aria-expanded={showEvidence} className="min-h-9 text-xs font-medium text-primary">
            {showEvidence ? t('lessons.hideEvidence') : t('lessons.showEvidence', { count: evidence.length })}
          </button>
          {showEvidence && (
            <ul className="m-0 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {evidence.map((line, index) => (
                <li key={`${index}-${line}`} className="break-words">{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!retired && (
        <button
          type="button"
          onClick={() => onRetire(lesson)}
          className="min-h-9 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {t('lessons.retire')}
        </button>
      )}
    </li>
  );
}

type LessonsSectionProps = {
  lessons: PolledResource<Lesson[]>;
};

/** What Foreman has learned, per repo. A lesson that is wrong or out of date can be retired. */
export default function LessonsSection({ lessons }: LessonsSectionProps) {
  const { t } = useTranslation('foreman');
  const [repo, setRepo] = useState('');
  const [retiring, setRetiring] = useState<Lesson | null>(null);

  const all = lessons.data ?? [];
  const repos = [...new Set(all.map((lesson) => lesson.repo ?? ''))].sort();
  const visible = all.filter((lesson) => !repo || (lesson.repo ?? '') === repo);
  const groups = [...new Set(visible.map((lesson) => lesson.repo ?? ''))].sort();

  return (
    <>
      {lessons.error && <LoadError error={lessons.error} onRetry={() => void lessons.refresh()} />}
      {!lessons.data && !lessons.error && <Loading />}
      {lessons.data && all.length === 0 && <Empty>{t('lessons.empty')}</Empty>}
      {repos.length > 1 && (
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{t('lessons.repo')}</span>
          <select value={repo} onChange={(event) => setRepo(event.target.value)} className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground">
            <option value="">{t('lessons.allRepos')}</option>
            {repos.map((value) => (
              <option key={value} value={value}>{value ? repoLabel(value) : t('lessons.noRepo')}</option>
            ))}
          </select>
        </label>
      )}
      {groups.map((group) => (
        <div key={group || 'none'} className="min-w-0 space-y-1.5" data-testid="foreman-lesson-group">
          <h3 className="m-0 text-xs font-semibold text-foreground/80">{group ? repoLabel(group) : t('lessons.noRepo')}</h3>
          <ul className="m-0 min-w-0 list-none space-y-1.5 p-0">
            {visible
              .filter((lesson) => (lesson.repo ?? '') === group)
              .map((lesson) => (
                <LessonCard key={lesson.id} lesson={lesson} onRetire={setRetiring} />
              ))}
          </ul>
        </div>
      ))}
      {retiring && (
        <ConfirmDialog
          open
          title={t('lessons.retireTitle')}
          description={t('lessons.retireBody')}
          confirmLabel={t('lessons.retire')}
          onConfirm={async () => {
            await foremanTabApi.retireLesson(retiring.id);
            await lessons.refresh();
            setRetiring(null);
          }}
          onCancel={() => setRetiring(null)}
        />
      )}
    </>
  );
}
