import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';

import { cn } from '@/shared/utils';

/** Used by the delegation and attention settings, the run controls, the chat drawer and the New goal dialog: the browser's own select, so the keyboard works as expected, styled like the shared Input. */
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn('h-9 rounded-md border border-input bg-transparent px-2 text-sm', className)} {...props} />
));
NativeSelect.displayName = 'NativeSelect';
