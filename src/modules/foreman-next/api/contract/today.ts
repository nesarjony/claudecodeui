import type { IsoTime } from '@/modules/foreman-next/api/contract/foundation';
import type { RunSummary } from '@/modules/foreman-next/api/contract/work';

export type Briefing = { generatedAt: IsoTime; sentences: string[] };

export const TREND_IDS = ['first-pass-yield', 'usd-per-row', 'agreed', 'false-stops'] as const;
export type TrendId = (typeof TREND_IDS)[number];
export type TrendMetric = { id: TrendId; previous: number | null; current: number; of: number | null };

export type TodaySnapshot = { briefing: Briefing | null; trend: TrendMetric[]; running: RunSummary[] };
