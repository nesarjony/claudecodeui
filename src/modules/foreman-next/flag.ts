/** Used by the lazy entries and the app's router: the new Foreman UI exists only in a build made with `VITE_FOREMAN_NEXT_API` set to `mock` or `real`. */
export const FOREMAN_NEXT_ENABLED = import.meta.env.VITE_FOREMAN_NEXT_API === 'mock' || import.meta.env.VITE_FOREMAN_NEXT_API === 'real';
