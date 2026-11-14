import type { ForemanOwnerSettings } from '@/shared/types.js';

/**
 * The owner's settings on a session handed over to Foreman: what Foreman's turns may run with. Stored at adoption, narrowed by the owner's
 * later own runs, never widened.
 */

// Strictest first: plan allows no edits, default asks for them, acceptEdits allows edits, auto lets a classifier decide, bypassPermissions asks nothing.
const MODES_BY_WIDTH = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];

/**
 * The narrower of two of an owner's settings: the stricter mode, only the tools both allow (intersection), every tool either denies (union).
 * The answer is never wider than `base` in any part, whatever `current` holds; it is `base` itself when `current` is as wide or wider.
 * A mode outside the known order cannot be ranked, so then `base`'s mode stays: a guess could widen it. List order follows `base`, then
 * `current`, without repeats.
 */
// Consumed by `ownerTurnSettings` below and by its unit tests.
export function narrowerOwnerSettings(base: ForemanOwnerSettings, current: ForemanOwnerSettings): ForemanOwnerSettings {
  const baseRank = MODES_BY_WIDTH.indexOf(base.permissionMode);
  const currentRank = MODES_BY_WIDTH.indexOf(current.permissionMode);
  const stricter = baseRank !== -1 && currentRank !== -1 && currentRank < baseRank;
  return {
    permissionMode: stricter ? current.permissionMode : base.permissionMode,
    allowedTools: [...new Set(base.allowedTools.filter((tool) => current.allowedTools.includes(tool)))],
    disallowedTools: [...new Set([...base.disallowedTools, ...current.disallowedTools])],
  };
}

/**
 * The settings a Foreman turn on an adopted session runs with: the owner's base settings (stored at adoption, at `adoptedAt`), narrowed by
 * the owner's latest own run when there is one newer than the adoption. So the owner narrowing the mode or the tools in the UI applies from
 * Foreman's next turn, widening them does not, and restoring them returns to the base.
 */
// Consumed by foreman-sessions.service.ts for every message and compact of an adopted session.
export function ownerTurnSettings(
  base: ForemanOwnerSettings & { adoptedAt: string },
  latest: { settings: ForemanOwnerSettings; seenAt: string } | null,
): ForemanOwnerSettings {
  const stored = { permissionMode: base.permissionMode, allowedTools: base.allowedTools, disallowedTools: base.disallowedTools };
  return latest && latest.seenAt > base.adoptedAt ? narrowerOwnerSettings(stored, latest.settings) : stored;
}

/** Reads stored tool lists (`{ allowedTools, disallowedTools }` of strings); null for anything else, which the caller treats as unknown. */
// Consumed by foreman-run-modes.service.ts (a run's lists) and foreman-session-state.service.ts (the owner's lists at adoption).
export function readToolLists(value: unknown): Pick<ForemanOwnerSettings, 'allowedTools' | 'disallowedTools'> | null {
  const lists = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === 'string');
  return lists && strings(lists.allowedTools) && strings(lists.disallowedTools) ? { allowedTools: lists.allowedTools, disallowedTools: lists.disallowedTools } : null;
}
