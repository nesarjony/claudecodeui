import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import enForemanNext from '@/modules/i18n/locales/en/foremanNext.json';

const ROOT = join(__dirname, '..');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

const has = (key: string): boolean => {
  let node: unknown = enForemanNext;
  const parts = key.split('.');
  for (let position = 0; position < parts.length; position += 1) {
    if (node === null || typeof node !== 'object') return false;
    const record = node as Record<string, unknown>;
    const part = parts[position] as string;
    // Plurals are key_one / key_other in the catalog.
    if (position === parts.length - 1) return part in record || `${part}_one` in record || `${part}_other` in record;
    node = record[part];
  }
  return false;
};

describe('the English catalog', () => {
  it('has every static key the Foreman UI asks for, including those chosen with a condition', () => {
    const missing: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*(?:[a-zA-Z.! ]+\?\s*)?'([^'$]+)'(?:\s*:\s*'([^'$]+)')?/g)) {
        for (const key of [match[1], match[2]]) if (key && !has(key)) missing.push(`${file.replace(ROOT, '')}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every value of the families the code builds keys from', () => {
    const families: Record<string, string[]> = {
      'status.state': ['running', 'pausedOwner', 'pausedCeiling', 'pausedCeilingOpen', 'workersPaused', 'workersPausedOpen', 'stopped'],
      'degraded.api-credit': ['title', 'detail'],
      'degraded.minimax': ['title', 'detail'],
      'degraded.cloudcli': ['title', 'detail'],
      'degraded.postgres': ['title', 'detail'],
      'degraded.infigraph': ['title', 'detail'],
      'degraded.owner-away': ['title', 'detail'],
      'delegation.kind': ['product-scope', 'replan-goal', 'retry-batch', 'budget-share', 'worker-setup', 'charter'],
      'delegation.asks': ['product-scope', 'replan-goal', 'retry-batch', 'budget-share', 'worker-setup', 'charter'],
      'delegation.level': ['ask', 'recommend-wait', 'decide-tell', 'decide-silent'],
      'attention.events': ['blocking-decision', 'idle-decision', 'pause', 'stuck-work', 'decided-alone', 'progress', 'routine'],
      'attention.phoneOption': ['now', 'delayed', 'never'],
      'today.greeting': ['morning', 'afternoon', 'evening'],
      'today.stage': ['attach', 'brief', 'worker', 'checks', 'judge', 'close'],
      'today.trend': ['first-pass-yield', 'usd-per-row', 'agreed', 'false-stops'],
      'decide.tab': ['needs', 'review', 'history'],
      'decide.scopes': ['goal', 'global'],
      'history.by': ['owner', 'foreman'],
      nav: ['today', 'decide', 'work', 'settings'],
      'chat.role': ['owner', 'foreman'],
      'chat.delivery': ['next-safe-point', 'after-batch'],
      'work.column': ['waiting', 'active', 'queued', 'done'],
      'work.state': ['active', 'queued', 'paused', 'done'],
      'work.views': ['board', 'list'],
      'work.certainty': ['likely', 'uncertain'],
      'work.batch.state': ['done', 'running', 'waiting', 'queued'],
      'run.stage': ['attach', 'brief', 'worker', 'checks', 'judge', 'close'],
      'run.stageState': ['done', 'running', 'pending', 'failed'],
      'run.failureNext': ['retry', 'replan', 'ask-owner'],
      'run.choice': ['continue', 'steer', 'answer', 'ask_owner', 'stop', 'fresh_session', 'pass', 'fail', 'integrated', 'conflict', 'blocked', 'pause', 'pause_batch', 'take_over', 'hand_back', 'answered'],
    };
    const missing = Object.entries(families).flatMap(([family, names]) => names.filter((name) => !has(`${family}.${name}`)).map((name) => `${family}.${name}`));
    expect(missing).toEqual([]);
  });
});
