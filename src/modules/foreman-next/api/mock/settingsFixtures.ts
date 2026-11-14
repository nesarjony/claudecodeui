import type { AttentionPolicy, DelegationRule } from '@/modules/foreman-next/api/contract';

/** Used by the mock store as the trust ladder; one kind already qualifies for a suggestion. */
export const delegationFixture = (): DelegationRule[] => [
  { kind: 'product-scope', level: 'ask', vetoWindowHours: null, agreed: 11, decided: 12, suggestion: 'recommend-wait', locked: false },
  { kind: 'replan-goal', level: 'decide-tell', vetoWindowHours: 6, agreed: 9, decided: 9, suggestion: null, locked: false },
  { kind: 'retry-batch', level: 'decide-silent', vetoWindowHours: null, agreed: 14, decided: 14, suggestion: null, locked: false },
  { kind: 'budget-share', level: 'ask', vetoWindowHours: null, agreed: 3, decided: 4, suggestion: null, locked: false },
  { kind: 'worker-setup', level: 'ask', vetoWindowHours: null, agreed: 0, decided: 0, suggestion: null, locked: false },
  { kind: 'charter', level: 'ask', vetoWindowHours: null, agreed: 0, decided: 0, suggestion: null, locked: true },
];

/** Used by the mock store as the attention policy of wireframes §13. */
export const attentionFixture = (): AttentionPolicy => ({
  rules: [
    { event: 'blocking-decision', phone: 'now', phoneDelayMinutes: null, briefing: false },
    { event: 'idle-decision', phone: 'delayed', phoneDelayMinutes: 240, briefing: true },
    { event: 'pause', phone: 'now', phoneDelayMinutes: null, briefing: false },
    { event: 'stuck-work', phone: 'delayed', phoneDelayMinutes: 30, briefing: false },
    { event: 'decided-alone', phone: 'never', phoneDelayMinutes: null, briefing: true },
    { event: 'progress', phone: 'never', phoneDelayMinutes: null, briefing: true },
    { event: 'routine', phone: 'never', phoneDelayMinutes: null, briefing: false },
  ],
  quietFrom: '23:00',
  quietTo: '08:00',
  briefingAt: '08:00',
});
