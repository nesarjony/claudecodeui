import type { IsoTime } from '@/modules/foreman-next/api/contract';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Whole dollars from $10 up, cents below, as the wireframes write them: $11, $12.40, $0.38. */
export function formatUsd(amount: number): string {
  return Number.isInteger(amount) && amount >= 10 ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * A reading that may be missing, as the status strip shows it: an em dash when there is none (`null`, or anything that is not a finite amount), never `$NaN` or a `$0.00` that
 * would pass for a real zero; "<$0.01" for a real amount below a cent, so a small month is not shown as nothing.
 */
export function formatUsdOrDash(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return '—';
  return amount > 0 && amount < 0.005 ? '<$0.01' : formatUsd(amount);
}

/** The wall-clock time of a timestamp in the owner's time zone, 24-hour, for "closes 18:00" and "resumes 14:00". */
export function formatClock(time: IsoTime): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The short weekday of a forecast date: "Thu". */
export function formatWeekday(time: IsoTime): string {
  return new Date(time).toLocaleDateString([], { weekday: 'short' });
}

/** The day and month of a resume date: "1 Dec". */
export function formatDay(time: IsoTime): string {
  return new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Time left until a deadline, coarse enough to read at a glance: "3h 12m", "42m", "<1m". */
export function formatRemaining(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / MINUTE_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** How long ago something happened, as one unit: "40m", "2h", "3d". */
export function formatAgo(milliseconds: number): string {
  if (milliseconds >= DAY_MS) return `${Math.floor(milliseconds / DAY_MS)}d`;
  if (milliseconds >= HOUR_MS) return `${Math.floor(milliseconds / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(milliseconds / MINUTE_MS))}m`;
}

/** A decision's duration: "3.1s". */
export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}
