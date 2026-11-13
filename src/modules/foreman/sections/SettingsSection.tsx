import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui';
import { errorMessage, fieldErrorsOf, foremanTabApi } from '@/modules/foreman/api';
import { LoadError, Loading } from '@/modules/foreman/components/Bits';
import {
  buildPatch,
  formFromConfig,
  isDirty,
  NUMBER_FIELDS,
  roleEffortPath,
  roleModelPath,
  unplacedErrors,
  type FormValues,
  type NumberField,
} from '@/modules/foreman/settingsForm';
import type { PolledResource } from '@/modules/foreman/usePolledResource';
import type { ConfigResponse, FieldErrors, ForemanRole } from '@/modules/foreman/types';

const INPUT =
  'h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-red-500 sm:h-10 sm:text-sm';

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1" data-field={id}>
      <label htmlFor={`foreman-set-${id}`} className="block text-xs font-medium text-foreground/80">
        {label}
      </label>
      {children}
      {hint && !error && <p className="m-0 break-words text-[11px] text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`foreman-set-${id}-error`} role="alert" className="m-0 break-words text-[11px] font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

type SettingsSectionProps = {
  config: PolledResource<ConfigResponse>;
  /** After a save: refresh whatever reads the config (the status bar's mode and limit). */
  onSaved: () => void;
};

/** Foreman's config as a form. Foreman validates; its per-field messages are shown beside the fields and nothing is saved until all pass. */
export default function SettingsSection({ config, onSaved }: SettingsSectionProps) {
  const { t } = useTranslation('foreman');
  const data = config.data;
  const roles = useMemo<ForemanRole[]>(() => data?.options.roles ?? [], [data]);
  const [baseline, setBaseline] = useState<FormValues | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const formRef = useRef(form);
  const baselineRef = useRef(baseline);
  useEffect(() => {
    formRef.current = form;
    baselineRef.current = baseline;
  });

  // Adopt the server's config when it first arrives and whenever it changes under a form with no edits in it. A form
  // with edits is never overwritten by the 5-second refresh.
  useEffect(() => {
    if (!data) return;
    const fresh = formFromConfig(data.config, data.options.roles);
    const current = formRef.current;
    const base = baselineRef.current;
    if (!current || !base || !isDirty(base, current)) {
      if (!base || JSON.stringify(base) !== JSON.stringify(fresh)) {
        setBaseline(fresh);
        setForm(fresh);
      }
    }
  }, [data]);

  if (config.error && !data) return <LoadError error={config.error} onRetry={() => void config.refresh()} />;
  if (!data || !form || !baseline) return <Loading />;

  const dirty = isDirty(baseline, form);
  const setValue = (path: string, value: string) => {
    setForm({ ...form, values: { ...form.values, [path]: value } });
    setSaved(false);
    if (errors[path]) setErrors(({ [path]: _gone, ...rest }) => rest);
  };
  const setRepo = (index: number, field: 'name' | 'path', value: string) => {
    setForm({ ...form, repos: form.repos.map((repo, at) => (at === index ? { ...repo, [field]: value } : repo)) });
    setSaved(false);
    const key = `repos.${index}.${field}`;
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const save = async () => {
    const patch = buildPatch(baseline, form);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setGeneralError(null);
    setSaved(false);
    try {
      await foremanTabApi.putConfig(patch);
      setErrors({});
      setBaseline(form);
      await config.refresh();
      setSaved(true);
      onSaved();
    } catch (failure) {
      const fieldErrors = fieldErrorsOf(failure);
      if (fieldErrors) setErrors(fieldErrors);
      else setGeneralError(errorMessage(failure, t('common.failed')));
    } finally {
      setSaving(false);
    }
  };

  // Reset goes back to what the server has now (which may be newer than what the form was opened with).
  const reset = () => {
    const fresh = formFromConfig(data.config, data.options.roles);
    setBaseline(fresh);
    setForm(fresh);
    setErrors({});
    setGeneralError(null);
    setSaved(false);
  };

  const loose = unplacedErrors(errors, roles, form.repos.length);
  const errorCount = Object.keys(errors).length;
  const numberField = (field: NumberField) => (
    <Field key={field.path} id={field.path} label={t(`settings.fields.${field.path}`)} hint={t(`settings.hints.${field.path}`, { defaultValue: '' })} error={errors[field.path]}>
      <input
        id={`foreman-set-${field.path}`}
        value={form.values[field.path] ?? ''}
        onChange={(event) => setValue(field.path, event.target.value)}
        inputMode={field.inputMode}
        autoComplete="off"
        aria-invalid={errors[field.path] ? true : undefined}
        aria-describedby={errors[field.path] ? `foreman-set-${field.path}-error` : undefined}
        className={INPUT}
      />
    </Field>
  );
  const group = (name: NumberField['group']) => (
    <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
      <legend className="mb-2 p-0 text-xs font-semibold text-foreground">{t(`settings.groups.${name}`)}</legend>
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2">{NUMBER_FIELDS.filter((field) => field.group === name).map(numberField)}</div>
    </fieldset>
  );
  const select = (path: string, options: string[], label: (value: string) => string, ariaLabel?: string) => (
    <select
      id={`foreman-set-${path}`}
      aria-label={ariaLabel}
      value={form.values[path] ?? ''}
      onChange={(event) => setValue(path, event.target.value)}
      aria-invalid={errors[path] ? true : undefined}
      aria-describedby={errors[path] ? `foreman-set-${path}-error` : undefined}
      className={`${INPUT} bg-background`}
    >
      {!options.includes(form.values[path] ?? '') && <option value={form.values[path] ?? ''}>{form.values[path] ?? ''}</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {label(option)}
        </option>
      ))}
    </select>
  );

  return (
    <form
      data-testid="foreman-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="min-w-0 space-y-4"
    >
      {config.error && <LoadError error={config.error} onRetry={() => void config.refresh()} />}

      {(errorCount > 0 || generalError) && (
        <div role="alert" data-testid="foreman-settings-errors" className="space-y-1 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <p className="m-0 font-semibold">{generalError ?? t('settings.errorsTitle', { count: errorCount })}</p>
          {loose.length > 0 && (
            <ul className="m-0 list-disc pl-4">
              {loose.map(([path, message]) => (
                <li key={path} className="break-words">
                  <code>{path}</code>: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
        <legend className="mb-2 p-0 text-xs font-semibold text-foreground">{t('settings.groups.mode')}</legend>
        <Field id="mode" label={t('settings.fields.mode')} hint={t('settings.hints.mode')} error={errors.mode}>
          {select('mode', data.options.modes, (value) => t(`status.mode.${value}`, { defaultValue: value }))}
        </Field>
      </fieldset>

      {group('concurrency')}
      {group('budgets')}
      {group('thresholds')}
      <Field id="escalation.riskAtLeast" label={t('settings.fields.escalation.riskAtLeast')} hint={t('settings.hints.escalation.riskAtLeast')} error={errors['escalation.riskAtLeast']}>
        {select('escalation.riskAtLeast', data.options.risks, (value) => t(`decisions.risk.${value}`, { defaultValue: value }))}
      </Field>
      {group('sampling')}

      <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
        <legend className="mb-2 p-0 text-xs font-semibold text-foreground">{t('settings.groups.models')}</legend>
        {roles.map((role) => (
          <div key={role} className="min-w-0 space-y-2 rounded-lg border border-border/50 bg-background/40 p-2.5" data-testid="foreman-role-model">
            <p className="m-0 text-xs font-semibold text-foreground">{t(`settings.roles.${role}`, { defaultValue: role })}</p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <Field id={roleModelPath(role)} label={t('settings.model')} error={errors[roleModelPath(role)]}>
                {select(roleModelPath(role), data.options.modelAliases, (value) => value, t('settings.roleModel', { role: t(`settings.roles.${role}`, { defaultValue: role }) }))}
              </Field>
              <Field id={roleEffortPath(role)} label={t('settings.effort')} error={errors[roleEffortPath(role)]}>
                {select(roleEffortPath(role), data.options.efforts, (value) => t(`settings.efforts.${value}`, { defaultValue: value }), t('settings.roleEffort', { role: t(`settings.roles.${role}`, { defaultValue: role }) }))}
              </Field>
            </div>
            {data.config.models[role].escalate.length > 0 && (
              <p className="m-0 break-words text-[11px] text-muted-foreground">{t('settings.escalatesTo', { chain: data.config.models[role].escalate.join(' → ') })}</p>
            )}
          </div>
        ))}
      </fieldset>

      <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
        <legend className="mb-2 p-0 text-xs font-semibold text-foreground">{t('settings.groups.repos')}</legend>
        {errors.repos && (
          <p role="alert" className="m-0 text-[11px] font-medium text-red-700 dark:text-red-400">
            {errors.repos}
          </p>
        )}
        {form.repos.map((repo, index) => (
          <div key={index} className="min-w-0 space-y-2 rounded-lg border border-border/50 bg-background/40 p-2.5" data-testid="foreman-repo-row">
            <Field id={`repos.${index}.name`} label={t('settings.repoName')} error={errors[`repos.${index}.name`]}>
              <input id={`foreman-set-repos.${index}.name`} value={repo.name} onChange={(event) => setRepo(index, 'name', event.target.value)} autoComplete="off" aria-invalid={errors[`repos.${index}.name`] ? true : undefined} className={INPUT} />
            </Field>
            <Field id={`repos.${index}.path`} label={t('settings.repoPath')} error={errors[`repos.${index}.path`]}>
              <input id={`foreman-set-repos.${index}.path`} value={repo.path} onChange={(event) => setRepo(index, 'path', event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={errors[`repos.${index}.path`] ? true : undefined} className={INPUT} />
            </Field>
            <button
              type="button"
              onClick={() => setForm({ ...form, repos: form.repos.filter((_, at) => at !== index) })}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 text-xs font-medium text-foreground hover:bg-muted/60"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t('settings.removeRepo')}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setForm({ ...form, repos: [...form.repos, { name: '', path: '' }] })}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground hover:bg-muted/60"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> {t('settings.addRepo')}
        </button>
      </fieldset>

      <div className="sticky bottom-0 -mx-3 flex flex-col gap-2 border-t border-border/50 bg-card/95 px-3 py-2 backdrop-blur-sm sm:flex-row sm:items-center">
        <Button type="submit" className="h-11 flex-1 sm:h-10 sm:flex-none" disabled={!dirty || saving}>
          {saving ? t('common.working') : t('settings.save')}
        </Button>
        <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={reset} disabled={!dirty || saving}>
          {t('settings.reset')}
        </Button>
        {saved && !dirty && (
          <span role="status" data-testid="foreman-settings-saved" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {t('settings.saved')}
          </span>
        )}
      </div>
    </form>
  );
}
