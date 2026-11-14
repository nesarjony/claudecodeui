import type {
  AttentionPolicy,
  ChatMessage,
  ChatSubject,
  DecisionRecord,
  DelegationRule,
  ForemanStatus,
  GoalDetail,
  HistoryEntry,
  OwnerQuestion,
  ReviewItem,
  RunDetail,
  TodaySnapshot,
} from '@/modules/foreman-next/api/contract';
import { chatSubjectsFixture, inboxChatFixture } from '@/modules/foreman-next/api/mock/chatFixtures';
import { decisionsFixture, historyFixture, questionsFixture, reviewFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { attentionFixture, delegationFixture } from '@/modules/foreman-next/api/mock/settingsFixtures';
import { serviceLogFixture, statusFixture, todayFixture } from '@/modules/foreman-next/api/mock/shellFixtures';
import { goalsFixture, runsFixture } from '@/modules/foreman-next/api/mock/workFixtures';

export type MockStore = {
  status: ForemanStatus;
  today: TodaySnapshot;
  questions: OwnerQuestion[];
  review: ReviewItem[];
  history: HistoryEntry[];
  decisions: DecisionRecord[];
  programme: string;
  goals: GoalDetail[];
  runs: RunDetail[];
  subjects: ChatSubject[];
  threads: Record<string, ChatMessage[]>;
  delegation: DelegationRule[];
  attention: AttentionPolicy;
  serviceLog: string[];
};

/** Used by the mock client and its scenarios to start from the full sample data of the wireframes. */
export const createMockStore = (now: number): MockStore => ({
  status: statusFixture(),
  today: todayFixture(now),
  questions: questionsFixture(now),
  review: reviewFixture(now),
  history: historyFixture(now),
  decisions: decisionsFixture(now),
  programme: 'desk parity, 47 screens',
  goals: goalsFixture(now),
  runs: runsFixture(),
  subjects: chatSubjectsFixture(),
  threads: { 'goal:g-inbox': inboxChatFixture(now) },
  delegation: delegationFixture(),
  attention: attentionFixture(),
  serviceLog: serviceLogFixture(now),
});
