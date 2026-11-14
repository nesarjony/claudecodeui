import type { ChatGoal, ChatMessage } from '@/modules/foreman-next/api/contract';
import { at, MINUTE_MS } from '@/modules/foreman-next/api/mock/time';

/** Used by the mock store as the goals a conversation can be about. */
export const chatGoalsFixture = (): ChatGoal[] => [
  { id: 'g-inbox', label: 'desk · Inbox' },
  { id: 'g-contacts', label: 'desk · Contacts' },
];

/** Used by the mock store as the Inbox goal's conversation (wireframes §8). */
export const inboxChatFixture = (now: number): ChatMessage[] => [
  { id: 'm1', role: 'owner', at: at(now, -30 * MINUTE_MS), text: 'Why did t1 need a second judge round?', evidence: [], actions: null, remembered: null },
  {
    id: 'm2',
    role: 'foreman',
    at: at(now, -30 * MINUTE_MS),
    text: 'Row 11 failed: its empty state used hard-coded English. The worker fixed it in round 2, and briefs now say "all UI copy comes from i18n".',
    evidence: [
      { label: 'run', kind: 'run', id: 'run-t1' },
      { label: 'verdict, row 11', kind: 'run', id: 'run-t1' },
      { label: 'decision card', kind: 'decision', id: 'dec-steer-9' },
    ],
    actions: null,
    remembered: null,
  },
  { id: 'm3', role: 'owner', at: at(now, -26 * MINUTE_MS), text: 'Pause desk after this batch, resume at 9.', evidence: [], actions: null, remembered: null },
  {
    id: 'm4',
    role: 'foreman',
    at: at(now, -26 * MINUTE_MS),
    text: 'Done: pause after t2-layout, resume 09:00.',
    evidence: [],
    actions: { id: 'act-pause', count: 2, undone: false },
    remembered: null,
  },
];
