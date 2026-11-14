import { AppError } from '@/shared/utils.js';

/**
 * Waits for a turn that was just started only long enough to report an immediate refusal or startup failure; whatever happens after the
 * admission window reaches Foreman as events. A lost admission race (another run started first) is a 409 RUN_IN_PROGRESS, any other
 * immediate failure a 502 TURN_START_FAILED.
 */
// Consumed by foreman-sessions.service.ts for every start, message and compact it dispatches.
export async function awaitTurnAdmission(
  sessionId: string,
  turn: Promise<{ started: boolean; error: string | null }>,
  admissionWindowMs: number,
): Promise<void> {
  const outcome = turn.then(
    (result) => ({ ok: true as const, result }),
    (failure: unknown) => ({ ok: false as const, failure }),
  );
  const early = await Promise.race([
    outcome,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), admissionWindowMs);
      timer.unref?.();
    }),
  ]);

  if (!early) {
    // Admitted and still running; whatever happens next reaches Foreman as events.
    void outcome.then((settled) => {
      const message = settled.ok ? settled.result.error : settled.failure instanceof Error ? settled.failure.message : String(settled.failure);
      if (message) {
        console.warn(`[Foreman bridge] turn for session ${sessionId} failed: ${message}`);
      }
    });
    return;
  }

  if (!early.ok) {
    throw new AppError(
      `The turn could not be started: ${early.failure instanceof Error ? early.failure.message : String(early.failure)}`,
      { code: 'TURN_START_FAILED', statusCode: 502 },
    );
  }
  if (!early.result.started) {
    const message = early.result.error ?? 'The turn was not started.';
    const lostRace = /already in progress/i.test(message);
    throw new AppError(message, {
      code: lostRace ? 'RUN_IN_PROGRESS' : 'TURN_START_FAILED',
      statusCode: lostRace ? 409 : 502,
    });
  }
  if (early.result.error) {
    throw new AppError(`The turn failed immediately: ${early.result.error}`, { code: 'TURN_START_FAILED', statusCode: 502 });
  }
}
