import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskIdStore } from '@/modules/foreman/foreman-task-ids.service.js';

test('the task link is kept in memory and persisted so it survives a restart', () => {
  const persisted = new Map<string, string>();
  const backing = {
    get: (key: string) => persisted.get(key) ?? null,
    set: (key: string, value: string) => void persisted.set(key, value),
    delete: (key: string) => void persisted.delete(key),
  };

  const first = createTaskIdStore(backing);
  assert.equal(first.get('sess-1'), null);
  first.set('sess-1', 'task-7');
  assert.equal(first.get('sess-1'), 'task-7');
  assert.equal(persisted.size, 1);

  // A fresh store (a restarted process) reads it back from the backing store.
  assert.equal(createTaskIdStore(backing).get('sess-1'), 'task-7');

  // A start that failed forgets its link, in memory and in the backing store.
  first.forget('sess-1');
  assert.equal(first.get('sess-1'), null);
  assert.equal(persisted.size, 0);
});

test('a failing backing store never breaks the task link', () => {
  const store = createTaskIdStore({
    get: () => { throw new Error('db closed'); },
    set: () => { throw new Error('db closed'); },
    delete: () => { throw new Error('db closed'); },
  });
  store.set('sess-1', 'task-7');
  assert.equal(store.get('sess-1'), 'task-7');
  assert.equal(store.get('other'), null);
});
