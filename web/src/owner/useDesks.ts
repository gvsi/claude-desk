/**
 * The owner's reads that every owner screen shares: the copy's businesses and Desks (`desks`),
 * and a Desk's Today and its held requests, polled. Query keys start with the route key, so a
 * screen invalidates every Desk's read of a route by that key alone.
 */
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';

import { request } from '../api/http.ts';
import type { BusinessOut, DeskSummary, NeedsYouItem } from '../api/views.ts';
import { pollMs } from '../app/poll.ts';
import { readLocal } from '../lib/storage.ts';

export const DESKS_KEY = ['desks'] as const;
export const ME_KEY = ['me'] as const;
export const todayKey = (deskId: string) => ['today', deskId] as const;
export const needsYouKey = (deskId: string) => ['needsYou', deskId] as const;

// The reads, which go out whenever they are asked for (a read ahead, a `fetchQuery`); only the hooks wait out `FRESH_MS`.
export const desksQuery = () => queryOptions({ queryKey: DESKS_KEY, queryFn: () => request('desks') });
const todayQuery = (deskId: string) =>
  queryOptions({ queryKey: todayKey(deskId), queryFn: () => request('today', { params: { desk_id: deskId } }) });
const needsYouQuery = (deskId: string) =>
  queryOptions({ queryKey: needsYouKey(deskId), queryFn: () => request('needsYou', { params: { desk_id: deskId } }) });

/** How long a page's own reads count as fresh: a page opened just after the read ahead doesn't send them again. */
const FRESH_MS = 2_000;

/**
 * The copy's businesses, each with its Desks, for a page of `deskId`. A list that doesn't hold that
 * Desk is read again on mount however fresh it is: only a read made now can say it isn't the owner's.
 */
export function useDesks(deskId: string) {
  return useQuery({
    ...desksQuery(),
    staleTime: FRESH_MS,
    refetchOnMount: (query) => (query.state.data !== undefined && findDesk(query.state.data, deskId) !== null ? true : 'always'),
  });
}

/** A Desk's Today, polled while the tab is shown. */
export function useToday(deskId: string) {
  return useQuery({ ...todayQuery(deskId), staleTime: FRESH_MS, refetchInterval: pollMs('today') });
}

/** What waits for the owner on a Desk: held requests and open callbacks, polled. */
export function useNeedsYou(deskId: string) {
  return useQuery({ ...needsYouQuery(deskId), staleTime: FRESH_MS, refetchInterval: pollMs('needsYou') });
}

/**
 * Reads what a Desk's Today first shows (the copy's Desks, its Today and Needs you) at once, for up
 * to `capMs`, so a page can open onto a Today that is already drawn. A read that fails or runs long
 * is left to Today, which shows and retries it as it always does; this never throws.
 */
export async function readTodayAhead(queryClient: QueryClient, deskId: string, capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  const reads = Promise.all([
    queryClient.prefetchQuery(desksQuery()),
    queryClient.prefetchQuery(todayQuery(deskId)),
    queryClient.prefetchQuery(needsYouQuery(deskId)),
  ]);
  await Promise.race([reads, cap]);
  clearTimeout(timer);
}

/** The copy changed (a new copy, a Desk added or deleted): read the businesses and the copy again. */
export async function invalidateCopy(queryClient: QueryClient): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: DESKS_KEY }), queryClient.invalidateQueries({ queryKey: ME_KEY })]);
}

/** A Desk's Today. */
export function todayPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}/today`;
}

/** The business that holds `deskId`, and the Desk, or null when the copy has no such Desk. */
export function findDesk(businesses: readonly BusinessOut[], deskId: string): { business: BusinessOut; desk: DeskSummary } | null {
  for (const business of businesses) {
    const desk = business.desks.find((d) => d.desk_id === deskId);
    if (desk) return { business, desk };
  }
  return null;
}

/** Of `desks`, the last Desk the owner opened when it is one of them, else the first; null when there are none. */
export function lastOrFirst(desks: readonly { desk_id: string }[]): string | null {
  const last = readLocal('lastDesk');
  if (last !== null && desks.some((d) => d.desk_id === last)) return last;
  return desks[0]?.desk_id ?? null;
}

/** The first word of the owner's name, as the API writes `Today.greeting_name`. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** Held requests in `items`, oldest first by when they were held, whatever order the answer lists them in. */
export function heldOldestFirst(items: readonly NeedsYouItem[]): Extract<NeedsYouItem, { decision: object }>[] {
  return items
    .filter((item): item is Extract<NeedsYouItem, { decision: object }> => item.decision != null)
    .sort((a, b) => Date.parse(a.held_at) - Date.parse(b.held_at));
}
