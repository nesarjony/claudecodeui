import { describe, expect, it } from 'vitest';

import { buildPatch, formFromConfig, isDirty, parseNumberText, unplacedErrors } from '@/modules/foreman/settingsForm';
import { CONFIG, ROLES } from '@/modules/foreman/tests/fixtures';

describe('formFromConfig', () => {
  it('turns every setting the form shows into the text of its input', () => {
    const form = formFromConfig(CONFIG, ROLES);
    expect(form.values['budgets.perDayUsd']).toBe('25');
    expect(form.values['escalation.riskAtLeast']).toBe('medium');
    expect(form.values['models.judge.model']).toBe('api-sonnet');
    expect(form.values['models.planner.effort']).toBe('high');
    expect(form.values.mode).toBe('shadow');
    expect(form.repos).toEqual([{ name: 'desk', path: '/mnt/dev/moveon/desk' }]);
  });
});

describe('parseNumberText', () => {
  it('turns clear numbers into numbers and sends anything else as the text, so Foreman can say what is wrong', () => {
    expect(parseNumberText(' 12.5 ')).toBe(12.5);
    expect(parseNumberText('-1')).toBe(-1);
    expect(parseNumberText('.5')).toBe(0.5);
    expect(parseNumberText('1e2')).toBe(100);
    expect(parseNumberText('abc')).toBe('abc');
    expect(parseNumberText('')).toBe('');
    expect(parseNumberText('0x10')).toBe('0x10');
    expect(parseNumberText('1,5')).toBe('1,5');
  });
});

describe('buildPatch', () => {
  const base = formFromConfig(CONFIG, ROLES);
  it('is empty when nothing changed', () => {
    expect(buildPatch(base, structuredClone(base))).toEqual({});
    expect(isDirty(base, structuredClone(base))).toBe(false);
  });
  it('holds only what changed, nested like the config', () => {
    const next = structuredClone(base);
    next.values['budgets.perDayUsd'] = '40';
    next.values['models.judge.model'] = 'api-opus';
    next.values.mode = 'autonomous';
    next.values['escalation.maxSteps'] = '2';
    expect(buildPatch(base, next)).toEqual({
      budgets: { perDayUsd: 40 },
      models: { judge: { model: 'api-opus' } },
      mode: 'autonomous',
      escalation: { maxSteps: 2 },
    });
    expect(isDirty(base, next)).toBe(true);
  });
  it('sends a non-number as the text', () => {
    const next = structuredClone(base);
    next.values['budgets.perDayUsd'] = 'lots';
    next.values.perRepo = '';
    expect(buildPatch(base, next)).toEqual({ budgets: { perDayUsd: 'lots' }, perRepo: '' });
  });
  it('replaces the whole repo list when a row changes, trimmed', () => {
    const next = structuredClone(base);
    next.repos.push({ name: ' web ', path: ' /srv/web ' });
    expect(buildPatch(base, next)).toEqual({ repos: [{ name: 'desk', path: '/mnt/dev/moveon/desk' }, { name: 'web', path: '/srv/web' }] });
  });
});

describe('unplacedErrors', () => {
  it('lists errors no visible field shows', () => {
    const errors = { 'budgets.perDayUsd': 'x', 'repos.0.path': 'y', 'repos.3.path': 'z', 'models.judge.model': 'm', workerBilling: 'w', repos: 'r' };
    expect(unplacedErrors(errors, ROLES, 1)).toEqual([
      ['repos.3.path', 'z'],
      ['workerBilling', 'w'],
    ]);
  });
});
