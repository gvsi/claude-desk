import type { QueryClient } from '@tanstack/react-query';

import type { BusinessOut } from '../../api/views.ts';
import { keepFor, listedDesks, restoreKept, type Kept } from './doneSignals.ts';

/** Per app, the copy identity and Things to try memory, preserved after deleting its first Desk. */
export const keptByApp = new WeakMap<QueryClient, Kept>();

/** Remember the starting Desk while any Desk already seen still belongs to this copy. */
export function startingDeskFor(queryClient: QueryClient, businesses: readonly BusinessOut[]): string | null {
  const listed = listedDesks(businesses);
  const kept = keepFor(restoreKept(keptByApp.get(queryClient), listed), listed);
  keptByApp.set(queryClient, kept);
  return kept.startedWith;
}
