import type { IsoTime } from '@/modules/foreman-next/api/contract/foundation';

// `worker` is a session Foreman started for a batch; `handed-over` is one of the owner's own sessions that Foreman supervises (BR-2.10).
export type SessionSupervision =
  | { state: 'unsupervised' }
  | { state: 'worker'; runId: string; goal: string; batch: string; model: string; sandboxed: boolean; control: 'foreman' | 'owner' }
  | { state: 'handed-over'; runId: string; goal: string | null; since: IsoTime };
