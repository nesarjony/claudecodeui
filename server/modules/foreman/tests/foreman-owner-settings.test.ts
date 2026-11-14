import assert from 'node:assert/strict';
import test from 'node:test';

import { narrowerOwnerSettings, ownerTurnSettings, readToolLists } from '@/modules/foreman/foreman-owner-settings.service.js';
import type { ForemanOwnerSettings } from '@/shared/types.js';

/** The comparison of an owner's settings, case by case: Foreman's turns run with the narrower of the stored and the owner's latest, never wider. */

const MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
const settings = (permissionMode: string, allowedTools: string[] = [], disallowedTools: string[] = []): ForemanOwnerSettings => ({ permissionMode, allowedTools, disallowedTools });

test('of two known modes the stricter wins, in the order plan < default < acceptEdits < auto < bypassPermissions, for every pair', () => {
  for (const [baseRank, base] of MODES.entries()) {
    for (const [currentRank, current] of MODES.entries()) {
      const expected = MODES[Math.min(baseRank, currentRank)];
      assert.equal(narrowerOwnerSettings(settings(base), settings(current)).permissionMode, expected, `${base} vs ${current}`);
    }
  }
});

test('a mode outside the order is never taken over the stored one: the stored mode stays', () => {
  for (const known of MODES) {
    assert.equal(narrowerOwnerSettings(settings(known), settings('dontAsk')).permissionMode, known);
    assert.equal(narrowerOwnerSettings(settings('dontAsk'), settings(known)).permissionMode, 'dontAsk');
  }
  assert.equal(narrowerOwnerSettings(settings('dontAsk'), settings('yolo')).permissionMode, 'dontAsk');
});

test('the allowed tools are the ones both allow, the denied ones every one either denies, in the stored order first and without repeats', () => {
  const cases: Array<[string[], string[], string[]]> = [
    [['Read', 'Grep'], ['Grep', 'Read'], ['Read', 'Grep']],
    [['Read', 'Grep'], ['Read'], ['Read']],
    [['Read'], ['Read', 'Write'], ['Read']],
    [['Read'], [], []],
    [[], ['Read'], []],
    [['Bash(git:*)'], ['Bash'], []],
    [['Read', 'Read'], ['Read'], ['Read']],
  ];
  for (const [base, current, expected] of cases) {
    assert.deepEqual(narrowerOwnerSettings(settings('default', base), settings('default', current)).allowedTools, expected, `${base} ∩ ${current}`);
  }
  const unions: Array<[string[], string[], string[]]> = [
    [['WebFetch'], ['Bash(rm:*)'], ['WebFetch', 'Bash(rm:*)']],
    [['WebFetch'], ['WebFetch'], ['WebFetch']],
    [[], ['Read'], ['Read']],
    [['Read'], [], ['Read']],
    [[], [], []],
  ];
  for (const [base, current, expected] of unions) {
    assert.deepEqual(narrowerOwnerSettings(settings('default', [], base), settings('default', [], current)).disallowedTools, expected, `${base} ∪ ${current}`);
  }
});

test('whatever the owner\'s latest holds, the answer is never wider than the stored settings', () => {
  const lists = [[], ['Read'], ['Read', 'Write'], ['Write', 'WebFetch'], ['Bash']];
  for (const baseMode of [...MODES, 'dontAsk']) {
    for (const currentMode of [...MODES, 'dontAsk']) {
      for (const baseAllowed of lists) {
        for (const currentAllowed of lists) {
          for (const currentDenied of lists) {
            const base = settings(baseMode, baseAllowed, ['WebSearch']);
            const answer = narrowerOwnerSettings(base, settings(currentMode, currentAllowed, currentDenied));
            const rank = (mode: string) => (MODES.includes(mode) ? MODES.indexOf(mode) : -1);
            assert.ok(answer.permissionMode === baseMode || rank(answer.permissionMode) < rank(baseMode), 'mode no wider');
            assert.ok(answer.allowedTools.every((tool) => baseAllowed.includes(tool) && currentAllowed.includes(tool)), 'nothing allowed beyond both');
            assert.ok(['WebSearch', ...currentDenied].every((tool) => answer.disallowedTools.includes(tool)), 'nothing denied is dropped');
          }
        }
      }
    }
  }
});

test('a Foreman turn uses the stored settings until the owner runs again after adoption, then the narrower of the two', () => {
  const base = { ...settings('acceptEdits', ['Read', 'Grep'], ['WebFetch']), adoptedAt: '2026-11-14T09:00:00.000Z' };
  const stored = settings('acceptEdits', ['Read', 'Grep'], ['WebFetch']);
  assert.deepEqual(ownerTurnSettings(base, null), stored, 'nothing recorded');
  assert.deepEqual(ownerTurnSettings(base, { settings: settings('plan'), seenAt: '2026-11-14T08:59:59.999Z' }), stored, 'a run before the adoption');
  assert.deepEqual(ownerTurnSettings(base, { settings: settings('plan'), seenAt: '2026-11-14T09:00:00.000Z' }), stored, 'the run the adoption took its settings from');
  assert.deepEqual(
    ownerTurnSettings(base, { settings: settings('default', ['Read'], ['Bash']), seenAt: '2026-11-14T09:00:00.001Z' }),
    settings('default', ['Read'], ['WebFetch', 'Bash']),
    'narrowed by a later run',
  );
  assert.deepEqual(ownerTurnSettings(base, { settings: settings('bypassPermissions', ['Read', 'Grep', 'Edit']), seenAt: '2026-11-14T10:00:00.000Z' }), stored, 'a wider one changes nothing');
});

test('stored tool lists are read only when both are lists of strings', () => {
  assert.deepEqual(readToolLists({ allowedTools: ['Read'], disallowedTools: [] }), { allowedTools: ['Read'], disallowedTools: [] });
  for (const value of [null, 'x', [], {}, { allowedTools: ['Read'] }, { allowedTools: 'Read', disallowedTools: [] }, { allowedTools: [1], disallowedTools: [] }]) {
    assert.equal(readToolLists(value), null, JSON.stringify(value));
  }
});
