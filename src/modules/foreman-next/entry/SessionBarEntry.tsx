import '@/modules/foreman-next/i18n';
import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { foremanApi } from '@/modules/foreman-next/entry/foremanApi';
import { SessionSupervisionBar } from '@/modules/foreman-next/handover/SessionSupervisionBar';

/** Loaded lazily by ForemanSessionBar: the hand-over bar of one session with the app's API. */
export default function SessionBarEntry({ sessionId }: { sessionId: string }) {
  return (
    <ForemanApiProvider api={foremanApi}>
      <SessionSupervisionBar sessionId={sessionId} />
    </ForemanApiProvider>
  );
}
