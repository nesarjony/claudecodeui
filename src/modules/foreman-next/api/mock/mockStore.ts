import type {
  AttentionPolicy,
  AlertItem,
  ChatGoal,
  ChatMessage,
  DecisionRecord,
  DelegationRule,
  ForemanSettings,
  ForemanStatus,
  GoalDetail,
  HistoryEntry,
  OwnerQuestion,
  RepoSettings,
  ReviewItem,
  RunDetail,
  TodaySnapshot,
} from '@/modules/foreman-next/api/contract';
import { chatGoalsFixture, inboxChatFixture } from '@/modules/foreman-next/api/mock/chatFixtures';
import { decisionsFixture, historyFixture, questionsFixture, reviewFixture } from '@/modules/foreman-next/api/mock/decideFixtures';
import { attentionFixture, delegationFixture, reposFixture, settingsFixture } from '@/modules/foreman-next/api/mock/settingsFixtures';
import { alertsFixture, serviceLogFixture, statusFixture, todayFixture } from '@/modules/foreman-next/api/mock/shellFixtures';
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
  chatGoals: ChatGoal[];
  threads: Record<string, ChatMessage[]>;
  delegation: DelegationRule[];
  attention: AttentionPolicy;
  settings: ForemanSettings;
  repos: RepoSettings[];
  alerts: AlertItem[];
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
  chatGoals: chatGoalsFixture(),
  threads: { 'g-inbox': inboxChatFixture(now) },
  delegation: delegationFixture(),
  attention: attentionFixture(),
  settings: settingsFixture(),
  repos: reposFixture(now),
  alerts: alertsFixture(now),
  serviceLog: serviceLogFixture(now),
});
