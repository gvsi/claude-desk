/**
 * A Desk's signed record and its stopped attempts, as the owner screens read them: one key and one
 * request each, so Safety, a conversation's trace and Today's things to try share the same reads.
 * Query keys start with the route key, then the Desk.
 */
import { queryOptions } from '@tanstack/react-query';

import { request } from '../../api/http.ts';

/** The Desk's signed record, with the checkpoint's check of its whole chain on every read. */
export const ledgerQuery = (deskId: string) =>
  queryOptions({ queryKey: ['ledger', deskId], queryFn: () => request('ledger', { params: { desk_id: deskId }, query: { verify: true } }) });

/** The Desk's stopped attempts, newest first as the API lists them. */
export const attemptsQuery = (deskId: string) => queryOptions({ queryKey: ['safety', deskId], queryFn: () => request('safety', { params: { desk_id: deskId } }) });
