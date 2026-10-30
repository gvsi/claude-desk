/**
 * The owner's reads that every owner screen shares: the copy's businesses and Desks (`desks`),
 * and a Desk's Today and its held requests, polled. Query keys start with the route key, so a
 * screen invalidates every Desk's read of a route by that key alone.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';

import { request } from '../api/http.ts';
import type { BusinessOut, CopyOut, DeskSummary, NeedsYouItem } from '../api/views.ts';
import { pollMs } from '../app/poll.ts';
import { readLocal } from '../lib/storage.ts';

export const DESKS_KEY = ['desks'] as const;
export const ME_KEY = ['me'] as const;
export const todayKey = (deskId: string) => ['today', deskId] as const;
export const needsYouKey = (deskId: string) => ['needsYou', deskId] as const;

/** The copy's businesses, each with its Desks. */
export function useDesks() {
  return useQuery({ queryKey: DESKS_KEY, queryFn: () => request('desks') });
}

/** A Desk's Today, polled while the tab is shown. */
export function useToday(deskId: string) {
  return useQuery({
    queryKey: todayKey(deskId),
    queryFn: () => request('today', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('today'),
  });
}

/** What waits for the owner on a Desk: held requests and open callbacks, polled. */
export function useNeedsYou(deskId: string) {
  return useQuery({
    queryKey: needsYouKey(deskId),
    queryFn: () => request('needsYou', { params: { desk_id: deskId } }),
    refetchInterval: pollMs('needsYou'),
  });
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

/** Where a copy opens: the last Desk's Today when it is in the copy, else its first Desk's; null when it has none. */
export function copyTodayPath(copy: CopyOut): string | null {
  const deskId = lastOrFirst(copy.desks);
  return deskId === null ? null : todayPath(deskId);
}

/** The first word of the owner's name, as the API writes `Today.greeting_name`. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** Held requests in `items`, oldest first by when they were held, whatever order the answer lists them in. */
export function heldOldestFirst(items: readonly NeedsYouItem[]): Extract<NeedsYouItem, { decision: object }>[] {
  return items
    .filter((item): item is Extract<NeedsYouItem, { decision: object }> => item.decision !== undefined)
    .sort((a, b) => Date.parse(a.held_at) - Date.parse(b.held_at));
}
