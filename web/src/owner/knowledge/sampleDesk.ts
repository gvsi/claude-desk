import type { QueryClient } from '@tanstack/react-query';

import type { BusinessOut } from '../../api/views.ts';
import { startingDeskFor } from '../arrival/keptCopy.ts';
import { findDesk, RIVERA_SAMPLE_BUSINESS_NAME } from '../useDesks.ts';

/** Sample knowledge belongs to the copy's starting Desk in the sample business, including after a reload. */
export function isStartingSampleDesk(queryClient: QueryClient, businesses: readonly BusinessOut[], deskId: string): boolean {
  return findDesk(businesses, deskId)?.business.name === RIVERA_SAMPLE_BUSINESS_NAME
    && startingDeskFor(queryClient, businesses) === deskId;
}
