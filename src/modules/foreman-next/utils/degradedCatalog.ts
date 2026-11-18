// The contract still calls the loss of the worker and helper routes `minimax`; both are DeepSeek's now, and the catalog says so.
const CATALOG_KEY: Record<string, string> = { minimax: 'deepseek' };

/** Used by the degraded-modes list and the catalog test: where the catalog describes a degraded mode, which is the contract's own name except for the legacy one. */
export const degradedCatalogKey = (mode: string): string => CATALOG_KEY[mode] ?? mode;
