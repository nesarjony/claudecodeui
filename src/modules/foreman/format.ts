/** Dollars for a budget line: more digits for small amounts, so $0.0043 does not read as $0.00. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  const abs = Math.abs(amount);
  if (abs === 0) return '$0.00';
  if (abs >= 100) return `$${amount.toFixed(0)}`;
  if (abs >= 1) return `$${amount.toFixed(2)}`;
  if (abs >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

/** 0.874 -> "87%". Clamped to 0 to 100. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** 12345 -> "12.3k", 2_500_000 -> "2.5M". */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(Math.round(count));
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

/** "3 min. ago" in the UI language. Empty for a missing or unparseable time. */
export function formatAgo(iso: string | undefined | null, now: number = Date.now(), locale?: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = then - now;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size || unit === 'second') {
      return formatter.format(Math.round(diff / size), unit);
    }
  }
  return '';
}

/** The first characters of a long id, for a label that must fit a phone. */
export function shortId(id: string, length = 8): string {
  const stripped = id.replace(/^(sug|inb|les|task|act)_/, '');
  return stripped.slice(0, length);
}

/** A repo name, or the last folder of a path. */
export function repoLabel(value: string | undefined | null): string {
  if (!value) return '';
  const parts = value.split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}
