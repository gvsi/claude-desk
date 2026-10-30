import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { ownerErrorCopy } from '../api/http.ts';

/** Why the latest read failed, in owner words, and a way to read it again. */
export interface ReadFailure {
  line: string;
  /** "Try again" is reading. */
  retrying: boolean;
  retry: () => void;
}

/** The parts of a polled read that say whether its latest read failed. */
type PolledRead = Pick<UseQueryResult<unknown, unknown>, 'error' | 'errorUpdatedAt' | 'dataUpdatedAt' | 'refetch'>;

/**
 * Whether the latest read of a polled query failed, kept until a read works. A screen shows it over
 * whatever was read before, so data from an earlier read never passes for current. React Query
 * starts each read of a query with nothing read yet as loading again and drops its error, so
 * without this the line would blink out at every poll, and while "Try again" reads.
 */
export function useReadFailure(read: PolledRead): ReadFailure | null {
  const [failure, setFailure] = useState<{ at: number; error: unknown } | null>(null);
  if (read.error !== null && failure?.at !== read.errorUpdatedAt) setFailure({ at: read.errorUpdatedAt, error: read.error });
  const [retrying, setRetrying] = useState(false);
  if (failure === null || read.errorUpdatedAt <= read.dataUpdatedAt) return null;
  const retry = () => {
    setRetrying(true);
    void read.refetch().finally(() => setRetrying(false));
  };
  return { line: ownerErrorCopy(failure.error), retrying, retry };
}
