import '@/modules/foreman-next/i18n';
import { FOREMAN_NEXT_ENABLED } from '@/modules/foreman-next/api/createForemanApi';
import { ForemanApiProvider } from '@/modules/foreman-next/context/ForemanApiProvider';
import { SessionSupervisionBar } from '@/modules/foreman-next/handover/SessionSupervisionBar';

/** Used by the project-workspace module in the session view to hand one of the owner's own sessions to Foreman, and to take it back; renders nothing while the new Foreman UI is off. */
export function ForemanSessionBar({ sessionId }: { sessionId: string }) {
  if (!FOREMAN_NEXT_ENABLED) return null;
  return (
    <ForemanApiProvider>
      <SessionSupervisionBar sessionId={sessionId} />
    </ForemanApiProvider>
  );
}
