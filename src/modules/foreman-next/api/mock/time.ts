import type { IsoTime } from '@/modules/foreman-next/api/contract';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Used by the mock fixtures to place sample events relative to the moment the mock was created. */
export const at = (now: number, offsetMs: number): IsoTime => new Date(now + offsetMs).toISOString();
