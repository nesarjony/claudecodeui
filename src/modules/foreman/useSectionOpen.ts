import { useCallback, useState } from 'react';

const STORAGE_KEY = 'foreman-tab-sections';

const read = (): Record<string, boolean> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
};

const write = (value: Record<string, boolean>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage is a convenience: without it the sections simply start at their defaults.
  }
};

/** Which sections of the tab are folded open, remembered in this browser. */
export function useSectionOpen<Id extends string>(defaults: Record<Id, boolean>) {
  const [open, setOpen] = useState<Record<Id, boolean>>(() => ({ ...defaults, ...read() }));
  const toggle = useCallback((id: Id) => {
    setOpen((current) => {
      const next = { ...current, [id]: !current[id] };
      write(next);
      return next;
    });
  }, []);
  const show = useCallback((id: Id) => {
    setOpen((current) => {
      if (current[id]) return current;
      const next = { ...current, [id]: true };
      write(next);
      return next;
    });
  }, []);
  return { open, toggle, show };
}
