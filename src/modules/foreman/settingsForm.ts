import type { FieldErrors, ForemanConfig, ForemanRole } from '@/modules/foreman/types';

export type RepoRow = { name: string; path: string };

/** The form's state: every number and choice as the text in its input (so half-typed values survive), plus the repo rows. */
export type FormValues = { values: Record<string, string>; repos: RepoRow[] };

export type NumberField = { path: string; group: 'concurrency' | 'budgets' | 'thresholds' | 'sampling'; inputMode: 'numeric' | 'decimal' };

/** The numeric settings, in display order. The paths are the config's own, so Foreman's field errors line up with them. */
export const NUMBER_FIELDS: NumberField[] = [
  { path: 'maxConcurrentSessions', group: 'concurrency', inputMode: 'numeric' },
  { path: 'perRepo', group: 'concurrency', inputMode: 'numeric' },
  { path: 'budgets.perTaskUsd', group: 'budgets', inputMode: 'decimal' },
  { path: 'budgets.perDayUsd', group: 'budgets', inputMode: 'decimal' },
  { path: 'autoAnswerConfidence', group: 'thresholds', inputMode: 'decimal' },
  { path: 'escalation.confidenceBelow', group: 'thresholds', inputMode: 'decimal' },
  { path: 'escalation.maxSteps', group: 'thresholds', inputMode: 'numeric' },
  { path: 'context.notesAt', group: 'thresholds', inputMode: 'decimal' },
  { path: 'context.actAt', group: 'thresholds', inputMode: 'decimal' },
  { path: 'evals.decisionQualityRate', group: 'sampling', inputMode: 'decimal' },
];

export const CHOICE_PATHS = ['mode', 'escalation.riskAtLeast'] as const;

const getPath = (source: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), source);

const setPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (next === null || typeof next !== 'object') cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
};

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** The paths of the per-role pickers: `models.planner.model` and `models.planner.effort`. */
export const roleModelPath = (role: ForemanRole): string => `models.${role}.model`;
export const roleEffortPath = (role: ForemanRole): string => `models.${role}.effort`;

export function formFromConfig(config: ForemanConfig, roles: ForemanRole[]): FormValues {
  const values: Record<string, string> = {};
  for (const field of NUMBER_FIELDS) values[field.path] = text(getPath(config, field.path));
  for (const path of CHOICE_PATHS) values[path] = text(getPath(config, path));
  for (const role of roles) {
    values[roleModelPath(role)] = text(getPath(config, roleModelPath(role)));
    values[roleEffortPath(role)] = text(getPath(config, roleEffortPath(role)));
  }
  return { values, repos: config.repos.map((repo) => ({ name: repo.name, path: repo.path })) };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** What the input's text means as a number. Anything that is not clearly one is sent as the text itself, so Foreman says what is wrong. */
export function parseNumberText(raw: string): number | string {
  const trimmed = raw.trim();
  return NUMBER.test(trimmed) ? Number(trimmed) : trimmed;
}

const isNumberPath = (path: string): boolean => NUMBER_FIELDS.some((field) => field.path === path);

/** The partial config to PUT: only what changed against `baseline`. Empty when nothing did. */
export function buildPatch(baseline: FormValues, current: FormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(current.values)) {
    if (value === baseline.values[path]) continue;
    setPath(patch, path, isNumberPath(path) ? parseNumberText(value) : value);
  }
  if (JSON.stringify(current.repos) !== JSON.stringify(baseline.repos)) {
    patch.repos = current.repos.map((repo) => ({ name: repo.name.trim(), path: repo.path.trim() }));
  }
  return patch;
}

export const isDirty = (baseline: FormValues, current: FormValues): boolean => Object.keys(buildPatch(baseline, current)).length > 0;

/** Error paths no visible field shows (so they must be listed on their own, never lost). */
export function unplacedErrors(errors: FieldErrors, roles: ForemanRole[], repoCount: number): Array<[string, string]> {
  const known = new Set<string>([
    ...NUMBER_FIELDS.map((field) => field.path),
    ...CHOICE_PATHS,
    ...roles.flatMap((role) => [roleModelPath(role), roleEffortPath(role)]),
    'repos',
  ]);
  for (let index = 0; index < repoCount; index += 1) {
    known.add(`repos.${index}.name`);
    known.add(`repos.${index}.path`);
  }
  return Object.entries(errors).filter(([path]) => !known.has(path));
}
