import { describe, expect, it } from 'vitest';

import { createMockStore } from '@/modules/foreman-next/api/mock/mockStore';
import { boardColumns } from '@/modules/foreman-next/work/boardColumns';

describe('boardColumns', () => {
  const store = createMockStore(Date.now());
  const columns = boardColumns(store.goals, []);

  it('puts a goal with decisions holding it in Waiting on you and also in its own column', () => {
    expect(columns.waiting.map((goal) => goal.name)).toEqual(['Inbox']);
    expect(columns.active.map((goal) => goal.name)).toEqual(['Inbox', 'Reports']);
  });

  it('keeps a goal that waits for workers on a read-only repo among the active work, and out of Waiting on you: it waits for no decision', () => {
    expect(columns.active.find((goal) => goal.state === 'read-only')?.readOnly).toEqual({ repo: 'desk' });
    expect(columns.waiting.map((goal) => goal.state)).not.toContain('read-only');
  });

  it('puts queued and finished goals in their own columns only', () => {
    expect(columns.queued.map((goal) => goal.name)).toEqual(['Contacts', 'Conversation']);
    expect(columns.done.map((goal) => goal.name)).toEqual(['demo']);
  });

  it('keeps a finished goal out of Waiting on you even if a stale hold remains', () => {
    const finished = store.goals.map((goal) => (goal.state === 'done' ? { ...goal, waitsOnYou: { decisions: 1, rowsHeld: 3 } } : goal));
    expect(boardColumns(finished, []).waiting.map((goal) => goal.name)).toEqual(['Inbox']);
  });
});
