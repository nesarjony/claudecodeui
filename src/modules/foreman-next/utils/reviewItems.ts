import type { ReviewItem } from '@/modules/foreman-next/api/contract';

/**
 * Used by Today's review panel and the Review row: a lesson Foreman would serve and a playbook it would adopt are their whole text or diff, which the title does not carry,
 * so an OK on one is possible only where that text is shown. The owner never approves what he has not read.
 */
export const needsFullText = (item: ReviewItem): boolean => item.kind === 'lesson' || item.kind === 'rule';
