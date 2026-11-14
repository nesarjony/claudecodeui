import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import enForemanNext from '@/modules/i18n/locales/en/foremanNext.json';
import {
  ALERT_SEVERITIES,
  ATTENTION_EVENTS,
  ATTENTION_PHONE,
  BATCH_STATES,
  CHAT_DELIVERIES,
  CHAT_ROLES,
  DEGRADED_MODES,
  DELEGATION_KINDS,
  DELEGATION_LEVELS,
  ENTITY_KINDS,
  FORECAST_CERTAINTIES,
  FOREMAN_STATES,
  GOAL_STATES,
  HISTORY_DECIDERS,
  LEDGER_CHOICES,
  REMEMBER_SCOPES,
  RUN_FAILURE_NEXT,
  RUN_STAGE_IDS,
  RUN_STAGE_STATES,
  STUDY_STEP_IDS,
  STUDY_STEP_STATES,
  TREND_IDS,
} from '@/modules/foreman-next/api/contract';
import type { ForemanState } from '@/modules/foreman-next/api/contract';
import { BOARD_COLUMN_IDS } from '@/modules/foreman-next/work/boardColumns';

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

// The status strip's sentence depends on why a state holds, so each state names the keys it can use. The map is typed by the
// union: a new state is a compile error here, and a missing entry fails the test below.
const STATE_KEYS: Record<ForemanState, string[]> = {
  running: ['running'],
  stopped: ['stopped'],
  'workers-paused': ['workersPaused', 'workersPausedOpen'],
  paused: ['pausedOwner', 'pausedCeiling', 'pausedCeilingOpen'],
};

const family = (prefix: string, values: readonly string[], suffixes: readonly string[] = ['']): string[] =>
  values.flatMap((value) => suffixes.map((suffix) => `${prefix}.${value}${suffix}`));

// Every family is built from the contract's own value lists, so a value added to the contract has to be in the catalog.
const FAMILIES: string[] = [
  ...family('status.state', FOREMAN_STATES.flatMap((state) => STATE_KEYS[state])),
  ...family('degraded', DEGRADED_MODES, ['.title', '.detail']),
  ...family('delegation.kind', DELEGATION_KINDS),
  ...family('delegation.asks', DELEGATION_KINDS),
  ...family('delegation.level', DELEGATION_LEVELS),
  ...family('attention.events', ATTENTION_EVENTS),
  ...family('attention.phoneOption', ATTENTION_PHONE),
  ...family('today.stage', RUN_STAGE_IDS),
  ...family('today.trend', TREND_IDS),
  ...family('decide.scopes', REMEMBER_SCOPES.filter((scope) => scope !== 'repo')),
  ...family('history.by', HISTORY_DECIDERS),
  ...family('chat.role', CHAT_ROLES),
  ...family('chat.delivery', CHAT_DELIVERIES),
  ...family('alerts.severity', ALERT_SEVERITIES),
  ...family('alerts.open', ENTITY_KINDS),
  ...family('work.state', GOAL_STATES),
  ...family('work.column', BOARD_COLUMN_IDS),
  ...family('work.certainty', FORECAST_CERTAINTIES),
  ...family('work.batch.state', BATCH_STATES),
  ...family('work.study.step', STUDY_STEP_IDS),
  ...family('work.study.state', STUDY_STEP_STATES),
  ...family('run.stage', RUN_STAGE_IDS),
  ...family('run.stageState', RUN_STAGE_STATES),
  ...family('run.failureNext', RUN_FAILURE_NEXT),
  ...family('run.choice', LEDGER_CHOICES),
];

// Fixed parts of the UI that are not contract unions: the navigation, the Decide tabs, the Work views and the greeting.
const UI_FAMILIES: string[] = [
  ...family('nav', ['today', 'decide', 'work', 'settings']),
  ...family('decide.tab', ['needs', 'review', 'history']),
  ...family('work.views', ['board', 'list']),
  ...family('today.greeting', ['morning', 'afternoon', 'evening']),
];

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

  it('covers every value of the contract lists that the code builds keys from', () => {
    expect([...FAMILIES, ...UI_FAMILIES].filter((key) => !has(key))).toEqual([]);
  });

  it('keeps no state of the status strip without a sentence', () => {
    expect(FOREMAN_STATES.filter((state) => !STATE_KEYS[state])).toEqual([]);
  });
});
