import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, ownerErrorCopy } from '../api/http.ts';
import type { RouteKey } from '../api/routes.ts';

/** Why the latest read failed, in owner words, and a way to read it again. */
export interface ReadFailure {
  line: string;
  /** "Try again" is reading. */
  retrying: boolean;
  retry: () => void;
}

/** The parts of a polled read that say whether its latest read failed. */
type PolledRead = Pick<UseQueryResult<unknown, unknown>, 'error' | 'errorUpdatedAt' | 'dataUpdatedAt' | 'fetchStatus' | 'refetch'>;

/**
 * Whether the latest read of a polled query failed, kept until a read works. A screen shows it over
 * whatever was read before, so data from an earlier read never passes for current. React Query
 * starts each read of a query with nothing read yet as loading again and drops its error, so
 * without this the line would blink out at every poll, and while "Try again" reads.
 * With `pausedRoute`, Today's first reads also show their existing network error while offline;
 * a retry that cannot start stays available rather than spinning until the network returns.
 */
export function useReadFailure(read: PolledRead, { pausedRoute }: { pausedRoute?: RouteKey } = {}): ReadFailure | null {
  const [failure, setFailure] = useState<{ at: number; error: unknown } | null>(null);
  const paused = pausedRoute !== undefined && read.fetchStatus === 'paused';
  const [wasPaused, setWasPaused] = useState(false);
  if (paused !== wasPaused) {
    setWasPaused(paused);
    // No request starts while offline, so it cannot time out. Keep the existing network error
    // until a read succeeds, including while a reconnect or Try again sends the paused read.
    if (paused && pausedRoute !== undefined && read.error === null) {
      setFailure({ at: Date.now(), error: new ApiError('network', { route: pausedRoute, method: 'GET', status: null }) });
    }
  }
  if (read.error !== null && failure?.at !== read.errorUpdatedAt) setFailure({ at: read.errorUpdatedAt, error: read.error });
  const [retrying, setRetrying] = useState(false);
  const failedAt = pausedRoute === undefined ? read.errorUpdatedAt : failure?.at ?? 0;
  if (failure === null || failedAt <= read.dataUpdatedAt) return null;
  const retry = () => {
    setRetrying(true);
    void read.refetch().finally(() => setRetrying(false));
  };
  return { line: ownerErrorCopy(failure.error), retrying: retrying && !paused, retry };
}
