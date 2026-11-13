import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { errorMessage, foremanTabApi } from '@/modules/foreman/api';
import { LoadError } from '@/modules/foreman/components/Bits';
import { Chip } from '@/modules/foreman/components/Chip';
import { goalsApi } from '@/modules/foreman/goals/api';
import {
  buildCreateGoalInput,
  GOAL_LIMITS,
  issueLines,
  validateGoalForm,
  type GoalForm as GoalFormValues,
  type GoalFormField,
} from '@/modules/foreman/goals/goalView';
import type { GoalListItem } from '@/modules/foreman/goals/types';
import { usePolledResource } from '@/modules/foreman/usePolledResource';

const INPUT =
  'w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-red-500 sm:text-sm';

const fieldId = (field: string) => `foreman-goal-${field}`;

function Field({ field, label, hint, error, children }: { field: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1" data-field={field}>
      <label htmlFor={fieldId(field)} className="block text-xs font-medium text-foreground/80">
        {label}
      </label>
      {children}
      {hint && !error && <p className="m-0 break-words text-[11px] text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${fieldId(field)}-error`} className="m-0 break-words text-[11px] font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

type GoalFormProps = {
  form: GoalFormValues;
  onChange: (form: GoalFormValues) => void;
  /** Whether the tab is in front: the repo list is fetched only then. */
  live: boolean;
  onCreated: (goal: GoalListItem) => void;
  onClose: () => void;
};

/**
 * The new-goal form. The repos to pick from come from Foreman's config; the limits are Foreman's, checked here first so
 * a bad form never leaves the browser, and Foreman's own refusal is shown as it comes.
 */
export default function GoalForm({ form, onChange, live, onCreated, onClose }: GoalFormProps) {
  const { t } = useTranslation('foreman');
  const config = usePolledResource(foremanTabApi.getConfig, { enabled: live, intervalMs: 60_000 });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const repoNames = (config.data?.config.repos ?? []).map((repo) => repo.name).filter(Boolean);
  // A single configured repo is picked for the user; with several, they choose.
  const repos = form.repos.length === 0 && !form.reposTouched && repoNames.length === 1 ? [repoNames[0]!] : form.repos;
  const effective = { ...form, repos };
  const errors = attempted ? validateGoalForm(effective) : {};
  const errorOf = (field: GoalFormField) => (errors[field] ? t(errors[field]!) : undefined);
  const invalid = (field: GoalFormField) => (errors[field] ? { 'aria-invalid': true, 'aria-describedby': `${fieldId(field)}-error` } : {});
  const set = <K extends keyof GoalFormValues>(key: K, value: GoalFormValues[K]) => onChange({ ...form, [key]: value });

  const toggleRepo = (name: string) => {
    onChange({ ...form, repos: repos.includes(name) ? repos.filter((repo) => repo !== name) : [...repos, name], reposTouched: true });
  };

  const submit = async () => {
    setAttempted(true);
    if (Object.keys(validateGoalForm(effective)).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const created = await goalsApi.create(buildCreateGoalInput(effective));
      setAttempted(false);
      onCreated(created);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const issues = failure ? issueLines(failure) : [];
  const errorCount = Object.keys(errors).length;

  return (
    <form
      data-testid="foreman-goal-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-muted/20 p-2.5"
    >
      {(errorCount > 0 || failure !== null) && (
        <div role="alert" data-testid="foreman-goal-form-errors" className="space-y-1 break-words rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <p className="m-0 font-semibold">{errorCount > 0 ? t('goals.form.errorsTitle') : errorMessage(failure, t('common.failed'))}</p>
          {errorCount === 0 && issues.length > 0 && (
            <ul className="m-0 list-disc pl-4">
              {issues.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Field field="title" label={t('goals.form.title')} error={errorOf('title')}>
        <input id={fieldId('title')} value={form.title} onChange={(event) => set('title', event.target.value)} maxLength={GOAL_LIMITS.title} autoComplete="off" className={`h-11 sm:h-10 ${INPUT}`} {...invalid('title')} />
      </Field>

      <Field field="description" label={t('goals.form.description')} hint={t('goals.form.descriptionHint')} error={errorOf('description')}>
        <textarea id={fieldId('description')} value={form.description} onChange={(event) => set('description', event.target.value)} rows={4} maxLength={GOAL_LIMITS.description} className={`resize-y py-2 ${INPUT}`} {...invalid('description')} />
      </Field>

      <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0" data-field="repos" aria-describedby={errors.repos ? `${fieldId('repos')}-error` : undefined}>
        <legend className="mb-1 p-0 text-xs font-medium text-foreground/80">{t('goals.form.repos')}</legend>
        {config.error && !config.data && <LoadError error={config.error} onRetry={() => void config.refresh()} />}
        {!config.data && !config.error && <p className="m-0 text-xs text-muted-foreground">{t('goals.form.reposLoading')}</p>}
        {config.data && repoNames.length === 0 && <p className="m-0 text-xs text-muted-foreground">{t('goals.form.reposNone')}</p>}
        {repoNames.length > 0 && (
          <div className="grid min-w-0 grid-cols-1 gap-1.5 min-[420px]:grid-cols-2">
            {repoNames.map((name) => {
              const checked = repos.includes(name);
              return (
                <label key={name} className="flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 text-sm">
                  <input type="checkbox" checked={checked} onChange={() => toggleRepo(name)} className="size-4 shrink-0 accent-primary" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                  {checked && repos[0] === name && repos.length > 1 && <Chip tone="info">{t('goals.primary')}</Chip>}
                </label>
              );
            })}
          </div>
        )}
        {repoNames.length > 1 && !errors.repos && <p className="m-0 text-[11px] text-muted-foreground">{t('goals.form.reposHint')}</p>}
        {errors.repos && (
          <p id={`${fieldId('repos')}-error`} className="m-0 text-[11px] font-medium text-red-700 dark:text-red-400">
            {t(errors.repos)}
          </p>
        )}
      </fieldset>

      <Field field="constraints" label={t('goals.form.constraints')} error={errorOf('constraints')}>
        <textarea
          id={fieldId('constraints')}
          value={form.constraints}
          onChange={(event) => set('constraints', event.target.value)}
          rows={2}
          maxLength={GOAL_LIMITS.constraints}
          placeholder={t('goals.form.constraintsPlaceholder')}
          className={`resize-y py-2 ${INPUT}`}
          {...invalid('constraints')}
        />
      </Field>

      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2">
        <Field field="budget" label={t('goals.form.budget')} hint={t('goals.form.budgetHint')} error={errorOf('budget')}>
          <input id={fieldId('budget')} value={form.budget} onChange={(event) => set('budget', event.target.value)} inputMode="decimal" autoComplete="off" className={`h-11 sm:h-10 ${INPUT}`} {...invalid('budget')} />
        </Field>
        <Field field="deadline" label={t('goals.form.deadline')} hint={t('goals.form.deadlineHint')} error={errorOf('deadline')}>
          <input id={fieldId('deadline')} type="datetime-local" value={form.deadline} onChange={(event) => set('deadline', event.target.value)} className={`h-11 sm:h-10 ${INPUT}`} {...invalid('deadline')} />
        </Field>
      </div>

      <label className="flex min-h-10 min-w-0 cursor-pointer items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={form.requirePlanApproval} onChange={(event) => set('requirePlanApproval', event.target.checked)} className="size-4 shrink-0 accent-primary" />
        <span className="min-w-0 break-words">{t('goals.form.requirePlanApproval')}</span>
      </label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="h-11 flex-1 sm:h-10 sm:flex-none" disabled={busy}>
          {busy ? t('common.working') : t('goals.form.submit')}
        </Button>
        <Button type="button" variant="outline" className="h-11 sm:h-10" disabled={busy} onClick={onClose}>
          {t('goals.form.close')}
        </Button>
      </div>
    </form>
  );
}
