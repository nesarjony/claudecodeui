import { Navigate, Route, Routes } from 'react-router-dom';

import '@/modules/foreman-next/i18n';
import type { ForemanApi } from '@/modules/foreman-next/api/contract';
import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { DecideScreen } from '@/modules/foreman-next/decide/DecideScreen';
import { DecisionRecordScreen } from '@/modules/foreman-next/decide/DecisionRecordScreen';
import { HistoryTab } from '@/modules/foreman-next/decide/HistoryTab';
import { NeedsYouTab } from '@/modules/foreman-next/decide/NeedsYouTab';
import { ReviewTab } from '@/modules/foreman-next/decide/ReviewTab';
import { ForemanShell } from '@/modules/foreman-next/ForemanShell';
import { SettingsScreen } from '@/modules/foreman-next/settings/SettingsScreen';
import { TodayScreen } from '@/modules/foreman-next/today/TodayScreen';
import { foremanPath } from '@/modules/foreman-next/utils/foremanPaths';
import { GoalScreen } from '@/modules/foreman-next/work/GoalScreen';
import { RunScreen } from '@/modules/foreman-next/work/RunScreen';
import { WorkScreen } from '@/modules/foreman-next/work/WorkScreen';

/** Used by the app's router under `/foreman/*`: the new Foreman control UI, separate from the Foreman tab in the workspace. Tests pass their own API. */
export function ForemanNextRoutes({ api }: { api?: ForemanApi }) {
  return (
    <ForemanApiProvider api={api}>
      <Routes>
        <Route element={<ForemanShell />}>
          <Route index element={<TodayScreen />} />
          <Route path="decide" element={<DecideScreen />}>
            <Route index element={<Navigate to="needs" replace />} />
            <Route path="needs/:questionId?" element={<NeedsYouTab />} />
            <Route path="review" element={<ReviewTab />} />
            <Route path="history" element={<HistoryTab />} />
          </Route>
          <Route path="decisions/:decisionId" element={<DecisionRecordScreen />} />
          <Route path="work" element={<WorkScreen />} />
          <Route path="work/runs/:runId" element={<RunScreen />} />
          <Route path="work/:goalId" element={<GoalScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to={foremanPath.today} replace />} />
        </Route>
      </Routes>
    </ForemanApiProvider>
  );
}
