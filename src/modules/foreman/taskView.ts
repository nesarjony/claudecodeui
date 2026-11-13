import type { Lesson, TaskSummary } from '@/modules/foreman/types';

/** Statuses of a task that is still in flight. Everything else counts as finished. */
export const ACTIVE_TASK_STATUSES = ['queued', 'planning', 'running', 'needs_user', 'verifying'] as const;

export const isActiveTask = (task: TaskSummary): boolean => (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status ?? '');

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export type DodItem = { text: string; met: boolean | null };

/**
 * The Definition of Done, whatever shape the planner stored it in: a list of strings, a list of objects
 * (`text`/`title`/`description`/`criterion`, with `met`/`done`/`passed`), or one multi-line string.
 */
export function dodItems(dod: unknown): DodItem[] {
  if (typeof dod === 'string') {
    return dod
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean)
      .map((text) => ({ text, met: null }));
  }
  if (Array.isArray(dod)) {
    return dod
      .map((entry): DodItem | null => {
        if (typeof entry === 'string') return entry.trim() ? { text: entry.trim(), met: null } : null;
        if (!isRecord(entry)) return null;
        const text = asText(entry.text) || asText(entry.title) || asText(entry.description) || asText(entry.criterion);
        if (!text) return null;
        const flag = [entry.met, entry.done, entry.passed].find((value) => typeof value === 'boolean');
        const status = asText(entry.status);
        return { text, met: typeof flag === 'boolean' ? flag : status ? ['met', 'done', 'passed', 'pass'].includes(status) : null };
      })
      .filter((item): item is DodItem => item !== null);
  }
  if (isRecord(dod)) {
    const inner = dod.criteria ?? dod.items ?? dod.checks;
    if (inner !== undefined) return dodItems(inner);
  }
  return [];
}

/** One line for the task's last decision, from a string or a `{ action, reason, summary }` object. */
export function lastDecisionLine(value: TaskSummary['lastDecision']): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return asText(value.summary) || [asText(value.action), asText(value.reason)].filter(Boolean).join(': ');
}

/** Evidence for a lesson as readable lines (a string, a list of strings, or a list of objects with text). */
export function evidenceLines(evidence: Lesson['evidence']): string[] {
  if (typeof evidence === 'string') return evidence.trim() ? [evidence.trim()] : [];
  if (Array.isArray(evidence)) {
    return evidence.flatMap((entry) => {
      if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : [];
      if (isRecord(entry)) {
        const text = asText(entry.text) || asText(entry.summary) || asText(entry.note) || asText(entry.ref) || asText(entry.id);
        return text ? [text] : [];
      }
      return [];
    });
  }
  return [];
}
