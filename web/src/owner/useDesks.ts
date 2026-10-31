/**
 * The owner's reads that every owner screen shares: the copy's businesses and Desks (`desks`),
 * and a Desk's Today and its held requests, polled. Query keys start with the route key, so a
 * screen invalidates every Desk's read of a route by that key alone.
 */
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

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

/** How long a page waits for a Desk's Today to be read ahead before it opens Today anyway, still loading. */
export const READ_AHEAD_MS = 3_000;

/**
 * How long a page's own reads count as fresh, so a page opened just after a read ahead doesn't send
 * them again. Each read is fresh from when it came in, and a read ahead waits for its slowest, so
 * this outlasts the read ahead's cap: the first read in is still fresh when Today opens.
 */
export const FRESH_MS = READ_AHEAD_MS + 2_000;

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

/**
 * A Desk's Today, polled while the tab is shown. A part of the Today page passes `retryOnMount:
 * false`: it mounts once the page has read Today (`useTodayOpening`), and a read that failed isn't
 * sent again just because it mounted, which would show it loading again; the part shows the failure
 * until a poll or "Try again" reads Today again.
 */
export function useToday(deskId: string, { retryOnMount = true }: { retryOnMount?: boolean } = {}) {
  return useQuery({ ...todayQuery(deskId), staleTime: FRESH_MS, refetchInterval: pollMs('today'), retryOnMount });
}

/** What waits for the owner on a Desk: held requests and open callbacks, polled. */
export function useNeedsYou(deskId: string) {
  return useQuery({ ...needsYouQuery(deskId), staleTime: FRESH_MS, refetchInterval: pollMs('needsYou') });
}

/**
 * When the last read ahead of each Desk's Today gives up (a `Date.now()` time), per app (its query
 * client, so a reload starts afresh), until the Desk's Today next opens and takes it: the first
 * visit's page, or the owner's loading page on a reload (`useTodayReadAhead`), starts reading and
 * then opens Today, which waits no longer than that, so a visit has one deadline however many pages
 * wait on it.
 */
const readAheadDeadlines = new WeakMap<QueryClient, Map<string, number>>();

function deadlinesOf(queryClient: QueryClient): Map<string, number> {
  let deadlines = readAheadDeadlines.get(queryClient);
  if (deadlines === undefined) {
    deadlines = new Map();
    readAheadDeadlines.set(queryClient, deadlines);
  }
  return deadlines;
}

/**
 * Reads what a Desk's Today first shows (the copy's Desks, its Today and Needs you) at once, for up
 * to `capMs`, so a page can open onto a Today that is already drawn. A read that fails or runs long
 * is left to Today, which shows and retries it as it always does; this never throws. The Desk's
 * Today, opened next, waits no later than this does (`useTodayOpening`).
 */
export async function readTodayAhead(queryClient: QueryClient, deskId: string, capMs: number): Promise<void> {
  const deadline = Date.now() + capMs;
  deadlinesOf(queryClient).set(deskId, deadline);
  await readTodayUntil(queryClient, deskId, deadline);
}

/** `readTodayAhead`'s reads, until `deadline` (a `Date.now()` time) at the latest. */
async function readTodayUntil(queryClient: QueryClient, deskId: string, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  const reads = Promise.all([
    queryClient.prefetchQuery(desksQuery()),
    queryClient.prefetchQuery(todayQuery(deskId)),
    queryClient.prefetchQuery(needsYouQuery(deskId)),
  ]);
  await Promise.race([reads, cap]);
  clearTimeout(timer);
}

/**
 * Whether a Desk's frame, opened at Today's address with the owner's loading page up (a reload, or
 * a Desk the copy's Desks don't list yet: `wanted`, as the frame first renders), is still reading
 * what Today first shows, so the loading page stays meanwhile and Today then opens drawn: one
 * loading step. The reads go out with the Desks', and the wait ends no later than the deadline of
 * the read ahead that opened the frame (a first visit's page), else `READ_AHEAD_MS` from the frame's
 * first render. It leaves that deadline for Today, which waits no later.
 */
export function useTodayReadAhead(deskId: string, wanted: boolean): boolean {
  const queryClient = useQueryClient();
  const [first] = useState(() => {
    const deadline = deadlinesOf(queryClient).get(deskId) ?? Date.now() + READ_AHEAD_MS;
    return { wanted, deadline, reading: wanted && Date.now() < deadline };
  });
  const [reading, setReading] = useState(first.reading);
  // Once, as the frame first renders: run again once Today has taken the deadline, it would leave
  // the spent deadline for the Desk's next Today, a later visit with a wait of its own.
  useEffect(() => {
    if (!first.wanted) return undefined;
    deadlinesOf(queryClient).set(deskId, first.deadline);
    if (!first.reading) return undefined;
    let live = true;
    void readTodayUntil(queryClient, deskId, first.deadline).then(() => {
      if (live) setReading(false);
    });
    return () => {
      live = false;
    };
  }, [first, queryClient, deskId]);
  return reading;
}

/**
 * Whether a Desk's Today, just opened, is still reading what it first shows (its Today and Needs
 * you), so it keeps its sections back and they open together rather than one by one, each pushing
 * the next down, when the owner comes from another Desk or another page. A first visit's page and a
 * reload's loading page read them first (`readTodayAhead`, `useTodayReadAhead`). Reads already in,
 * or failed, open it at once; else it waits no later than the read ahead that opened it gives up,
 * or `READ_AHEAD_MS` from when it opened. Once open, it stays open.
 */
export function useTodayOpening(deskId: string): boolean {
  const queryClient = useQueryClient();
  const today = useToday(deskId);
  const needsYou = useNeedsYou(deskId);
  const read = (today.data !== undefined || today.isError) && (needsYou.data !== undefined || needsYou.isError);
  const [deadline] = useState(() => deadlinesOf(queryClient).get(deskId) ?? Date.now() + READ_AHEAD_MS);
  const [open, setOpen] = useState(() => read || Date.now() >= deadline);
  if (read && !open) setOpen(true);
  // Taken once Today has it: the Desk's next Today is a later visit, with a wait of its own.
  useEffect(() => {
    deadlinesOf(queryClient).delete(deskId);
  }, [queryClient, deskId]);
  useEffect(() => {
    if (open) return undefined;
    const timer = setTimeout(() => setOpen(true), deadline - Date.now());
    return () => clearTimeout(timer);
  }, [open, deadline]);
  return !open;
}

/** The copy changed (a new copy, a Desk added or deleted): read the businesses and the copy again. */
export async function invalidateCopy(queryClient: QueryClient): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: DESKS_KEY }), queryClient.invalidateQueries({ queryKey: ME_KEY })]);
}

/** A Desk's own address in the owner app, which its pages sit under. */
export function deskPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}`;
}

/** A Desk's Today. */
export function todayPath(deskId: string): string {
  return `${deskPath(deskId)}/today`;
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
