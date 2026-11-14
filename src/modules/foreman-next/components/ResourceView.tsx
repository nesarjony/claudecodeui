import type { ReactNode } from 'react';

import { ErrorState } from '@/modules/foreman-next/components/ErrorState';
import { LoadingState } from '@/modules/foreman-next/components/LoadingState';
import type { Resource } from '@/modules/foreman-next/hooks/useForemanResource';

type ResourceViewProps<T> = {
  resource: Resource<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
};

/** Used by every screen and panel to show the same loading, error and empty states before the data they render. */
export function ResourceView<T>({ resource, isEmpty, empty, children }: ResourceViewProps<T>) {
  if (resource.data === null) {
    return resource.status === 'error' ? <ErrorState onRetry={() => void resource.refresh()} /> : <LoadingState />;
  }
  if (isEmpty?.(resource.data)) return <>{empty}</>;
  return <>{children(resource.data)}</>;
}
