import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import enForeman from '@/modules/i18n/locales/en/foreman.json';

const ROOT = join(__dirname, '..');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

const has = (key: string): boolean => {
  let node: unknown = enForeman;
  const parts = key.split('.');
  for (let i = 0; i < parts.length; i += 1) {
    if (node === null || typeof node !== 'object') return false;
    const record = node as Record<string, unknown>;
    // Dotted keys such as "budgets.perDayUsd" are nested objects in the catalog; plurals are key_one / key_other.
    if (i === parts.length - 1) return parts[i]! in record || `${parts[i]}_one` in record || `${parts[i]}_other` in record;
    node = record[parts[i]!];
  }
  return false;
};

describe('the English catalog', () => {
  it('has every static key the Foreman tab asks for', () => {
    const missing: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'([^'$]+)'/g)) {
        const key = match[1]!;
        if (key.includes(':')) continue; // another namespace (chat:foreman.actions.*)
        if (!has(key)) missing.push(`${file.replace(ROOT, '')}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers the dynamic families: every status, kind, range, role, risk and mode the code can ask for', () => {
    const families: Record<string, string[]> = {
      'status.mode': ['shadow', 'autonomous'],
      'needs.kind': ['question', 'permission', 'budget'],
      'tasks.status': ['queued', 'planning', 'running', 'needs_user', 'verifying', 'done', 'completed', 'failed', 'killed', 'taken_over', 'unknown'],
      'tasks.kind': ['decision', 'action', 'gate', 'judge', 'needs_user', 'note'],
      'tasks.filter': ['all', 'active', 'finished'],
      'decisions.risk': ['low', 'medium', 'high'],
      'decisions.status': ['pending', 'sent', 'edited', 'dismissed', 'superseded', 'expired'],
      ranges: ['today', '7d', '30d', 'all'],
      'settings.roles': ['planner', 'strategist', 'supervisor', 'judge', 'contextKeeper', 'researcher'],
      'settings.efforts': ['low', 'medium', 'high'],
      'settings.groups': ['mode', 'concurrency', 'budgets', 'thresholds', 'sampling', 'models', 'repos'],
      'lessons.status': ['active', 'retired'],
    };
    const missing = Object.entries(families).flatMap(([family, names]) => names.filter((name) => !has(`${family}.${name}`)).map((name) => `${family}.${name}`));
    expect(missing).toEqual([]);
  });

  it('has a label for every numeric setting the form shows', async () => {
    const { NUMBER_FIELDS } = await import('@/modules/foreman/settingsForm');
    const missing = NUMBER_FIELDS.filter((field) => !has(`settings.fields.${field.path}`)).map((field) => field.path);
    expect(missing).toEqual([]);
  });
});
