import { describe, expect, it } from 'vitest';

import { dodItems, evidenceLines, isActiveTask, lastDecisionLine } from '@/modules/foreman/taskView';

describe('dodItems', () => {
  it('reads a list of strings', () => {
    expect(dodItems(['pnpm verify passes', '  ', 'no new lint errors'])).toEqual([
      { text: 'pnpm verify passes', met: null },
      { text: 'no new lint errors', met: null },
    ]);
  });
  it('reads objects with text/title/description and a met flag or status', () => {
    expect(dodItems([{ text: 'a', met: true }, { title: 'b', done: false }, { description: 'c', status: 'passed' }, { criterion: 'd' }, { nothing: 1 }])).toEqual([
      { text: 'a', met: true },
      { text: 'b', met: false },
      { text: 'c', met: true },
      { text: 'd', met: null },
    ]);
  });
  it('reads a multi-line string with bullets and checkboxes', () => {
    expect(dodItems('- [ ] tests added\n* [x] docs\n1. ship it\n\n')).toEqual([
      { text: 'tests added', met: null },
      { text: 'docs', met: null },
      { text: 'ship it', met: null },
    ]);
  });
  it('digs criteria out of an object, and is empty for anything else', () => {
    expect(dodItems({ criteria: ['x'] })).toEqual([{ text: 'x', met: null }]);
    expect(dodItems(undefined)).toEqual([]);
    expect(dodItems(42)).toEqual([]);
  });
});

describe('lastDecisionLine, evidenceLines, isActiveTask', () => {
  it('gives one readable line', () => {
    expect(lastDecisionLine('steer: add a test')).toBe('steer: add a test');
    expect(lastDecisionLine({ action: 'steer', reason: 'no test' })).toBe('steer: no test');
    expect(lastDecisionLine({ summary: 'ran the judge' })).toBe('ran the judge');
    expect(lastDecisionLine(null)).toBe('');
  });
  it('flattens evidence', () => {
    expect(evidenceLines('one')).toEqual(['one']);
    expect(evidenceLines(['a', { text: 'b' }, { ref: 'c' }, 7])).toEqual(['a', 'b', 'c']);
    expect(evidenceLines(undefined)).toEqual([]);
  });
  it('tells active from finished', () => {
    expect(isActiveTask({ id: '1', status: 'running' })).toBe(true);
    expect(isActiveTask({ id: '1', status: 'needs_user' })).toBe(true);
    expect(isActiveTask({ id: '1', status: 'done' })).toBe(false);
    expect(isActiveTask({ id: '1' })).toBe(false);
  });
});
