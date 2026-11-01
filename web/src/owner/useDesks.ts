/**
 * The owner's reads that every owner screen shares: the copy's businesses and Desks (`desks`),
 * a Desk's Today and its held requests, polled, and the copy's Demo inbox, which Today shows. Query
 * keys start with the route key, so a screen invalidates every Desk's read of a route by that key
 * alone.
 */
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { request } from '../api/http.ts';
import { SETUP_STEPS, type BusinessOut, type DeskSetup, type DeskSummary, type NeedsYouItem, type SetupStep } from '../api/views.ts';
import { pollMs } from '../app/poll.ts';
import { readLocal } from '../lib/storage.ts';

export const DESKS_KEY = ['desks'] as const;
/**
 * The sample's business name from `backend/desk/kernel_service/seed.py`'s `rivera_seed`.
 * Any Desk whose business has this name gets the sample's example chips, including one set up
 * from the plumber example.
 * Desk ids and slugs vary per demo copy, and the API has no sample marker.
 */
export const RIVERA_SAMPLE_BUSINESS_NAME = 'Turner Plumbing';
export const ME_KEY = ['me'] as const;
export const todayKey = (deskId: string) => ['today', deskId] as const;
export const needsYouKey = (deskId: string) => ['needsYou', deskId] as const;
export const OWNER_INBOX_KEY = ['ownerInbox'] as const;

// The reads, which go out whenever they are asked for (a read ahead, a `fetchQuery`); only the hooks wait out `FRESH_MS`.
export const desksQuery = () => queryOptions({ queryKey: DESKS_KEY, queryFn: () => request('desks') });
const todayQuery = (deskId: string) =>
  queryOptions({ queryKey: todayKey(deskId), queryFn: () => request('today', { params: { desk_id: deskId } }) });
export const needsYouQuery = (deskId: string) =>
  queryOptions({ queryKey: needsYouKey(deskId), queryFn: () => request('needsYou', { params: { desk_id: deskId } }) });
export const ownerInboxQuery = () => queryOptions({ queryKey: OWNER_INBOX_KEY, queryFn: () => request('ownerInbox') });

/** How long a page waits for a Desk's Today to be read ahead before it opens Today anyway, still loading. */
export const READ_AHEAD_MS = 3_000;

/**
 * How long a page's own reads count as fresh, so a page opened just after a read ahead doesn't send
 * them again. Each read is fresh from when it came in, and a read ahead waits for its slowest, so
 * this outlasts the read ahead's cap: the first read in is still fresh when Today opens.
 */
export const FRESH_MS = READ_AHEAD_MS + 2_000;

export interface UseDesksOptions {
  /**
   * Follows the copy's Desks as the owner's frame reads them, and never reads them itself: not on
   * mount, not on window focus. For a part of a page that needs only what the frame already has.
   */
  passive?: boolean;
}

/**
 * The copy's businesses, each with its Desks, for a page of `deskId`. A list that doesn't hold that
 * Desk is read again on mount however fresh it is: only a read made now can say it isn't the owner's.
 */
export function useDesks(deskId: string, { passive = false }: UseDesksOptions = {}) {
  return useQuery({
    ...desksQuery(),
    staleTime: FRESH_MS,
    refetchOnMount: (query) => (query.state.data !== undefined && findDesk(query.state.data, deskId) !== null ? true : 'always'),
    enabled: !passive,
  });
}

/** How a screen reads Today or Needs you. */
export interface ReadOptions {
  /**
   * Whether a read that failed is sent again as this screen mounts (React Query's `retryOnMount`,
   * default true). Everything that mounts with Today passes false, as Today opens on what its first
   * reads found, a failure included: sent again, the read would start over as loading, and Today
   * would hold again, or a part of it look as if it were still loading. One reader left on would be
   * enough to send it. A poll or "Try again" still reads it again.
   */
  retryOnMount?: boolean;
}

/** A Desk's Today, polled while the tab is shown. */
export function useToday(deskId: string, { retryOnMount = true }: ReadOptions = {}) {
  return useQuery({ ...todayQuery(deskId), staleTime: FRESH_MS, refetchInterval: pollMs('today'), retryOnMount });
}

/**
 * What waits for the owner on a Desk: held requests and open callbacks, polled. With `readOnOpen`,
 * the page reads it again as it opens however fresh the kept read is, for a page that shows only
 * what a read of its own says (Rules' question about a hold).
 */
export function useNeedsYou(deskId: string, { retryOnMount = true, readOnOpen = false }: ReadOptions & { readOnOpen?: boolean } = {}) {
  return useQuery({
    ...needsYouQuery(deskId),
    staleTime: FRESH_MS,
    refetchInterval: pollMs('needsYou'),
    retryOnMount,
    ...(readOnOpen ? { refetchOnMount: 'always' as const } : {}),
  });
}

/**
 * When the last read ahead of each Desk's Today gives up (a `Date.now()` time), per app (its query
 * client, so a reload starts afresh), until the Desk's Today next opens and takes it: the first
 * visit's page, or the owner's loading page on a reload (`useTodayReadAhead`), starts reading and
 * then releases the frame. Today's own skeleton keeps waiting for its reads to settle.
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
 * Reads what a Desk's Today first shows (the copy's Desks, its Today and Needs you, and the copy's
 * Demo inbox) at once, for up to `capMs`, so a page can open onto a Today that is already drawn,
 * with nothing in it still to come in and push what is under it. A read that fails or runs long is
 * left to Today, which shows and retries it as it always does; this never throws. The Desk's Today,
 * opened next, keeps its own skeleton until its reads settle (`useTodayOpening`).
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
    queryClient.prefetchQuery(ownerInboxQuery()),
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
 * first render. Today's own skeleton continues if its reads are still out.
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
    const deadlines = deadlinesOf(queryClient);
    deadlines.set(deskId, first.deadline);
    let live = true;
    if (first.reading) {
      void readTodayUntil(queryClient, deskId, first.deadline).then(() => {
        if (live) setReading(false);
      });
    }
    return () => {
      live = false;
      // Left before Today took it (Back, another Desk, a Desk that isn't the owner's): it goes with
      // the loading page, rather than cut short the wait of a Today opened later.
      if (deadlines.get(deskId) === first.deadline) deadlines.delete(deskId);
    };
  }, [first, queryClient, deskId]);
  return reading;
}

/**
 * Forgets the read ahead of `deskId`'s Today, for a page left before Today opened from it: the
 * Desk's next Today, a later visit, has a wait of its own, and reads again what failed before.
 */
export function forgetReadAhead(queryClient: QueryClient, deskId: string): void {
  deadlinesOf(queryClient).delete(deskId);
}

/**
 * Whether a Desk's Today, just opened, is still reading what it first shows (its Today and Needs
 * you, and the copy's Demo inbox), so its sections open together rather than one by one, each
 * pushing the next down, when the owner comes from another Desk or another page. A first visit's page and a
 * reload's loading page read them first (`readTodayAhead`, `useTodayReadAhead`). Reads already in,
 * or failed, open it at once; else its skeleton continues until all three reads settle, even past
 * the frame's `READ_AHEAD_MS` deadline (plan 08c, decision 7). Offline reads paused before a send or
 * retry also settle opening: their sections show the existing error UI. Once open, it stays open.
 */
export function useTodayOpening(deskId: string): boolean {
  const queryClient = useQueryClient();
  // Whether this visit's Today was read ahead (a first visit's page, a reload's loading page), whose
  // deadline Today takes as it opens, past its cap or not: then a failed inbox read is this opening's
  // own, and Today opens on it without sending it again, as it does with its other reads. A page left
  // before Today took its deadline forgets it. Otherwise a failed inbox read is an earlier visit's
  // (the copy's inbox outlives the page, and nothing reads it while its sheet is closed), and this
  // opening reads it again.
  const [readAheadForThisVisit] = useState(() => deadlinesOf(queryClient).has(deskId));
  const today = useToday(deskId, { retryOnMount: false });
  const needsYou = useNeedsYou(deskId, { retryOnMount: false });
  // Read here only as Today opens, unless it was just read: the inbox itself reads it again while its
  // sheet is open, and never while it is closed, so this observer, which stays mounted with Today,
  // doesn't read it again on focus or reconnect.
  const inbox = useQuery({
    ...ownerInboxQuery(),
    staleTime: FRESH_MS,
    retryOnMount: !readAheadForThisVisit,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = [today, needsYou, inbox].every((query) => query.data !== undefined || query.isError || query.isPaused);
  const [open, setOpen] = useState(read);
  if (read && !open) setOpen(true);
  // Taken once Today has it: the Desk's next Today is a later visit, with a wait of its own.
  useEffect(() => {
    deadlinesOf(queryClient).delete(deskId);
  }, [queryClient, deskId]);
  return !open;
}

/** The copy changed (a new copy, a Desk added or deleted): read the businesses, the copy and its Demo inbox again. */
export async function invalidateCopy(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: DESKS_KEY }),
    queryClient.invalidateQueries({ queryKey: ME_KEY }),
    queryClient.invalidateQueries({ queryKey: OWNER_INBOX_KEY }),
  ]);
}

/**
 * The setup a Desk's cached `setup` should name once setup has carried `carried` into it: only ever
 * further on, as an interview moves only forward. A cached null stays: the API said the Desk is live
 * (or was made outside setup). A cached later step, or another interview, stays. Otherwise the
 * carried step, or null at `live`.
 */
function furtherSetup(cached: DeskSetup | null, carried: { interview_id: string; step: SetupStep }): DeskSetup | null {
  if (cached === null || cached.interview_id !== carried.interview_id) return cached;
  if (SETUP_STEPS.indexOf(carried.step) <= SETUP_STEPS.indexOf(cached.step)) return cached;
  return carried.step === 'live' ? null : { interview_id: carried.interview_id, step: carried.step };
}

/**
 * A Desk's setup interview as setup holds it now (its Desk, its id and its step), carried into the
 * copy's Desks read here (the businesses), whose `setup` names it, so the next page that reads
 * them, Today, names the step at once, while a read of them is slow and after one fails. A read of
 * them still out, which may have been answered before the step moved on, is let go first; the
 * carried step only ever moves the Desk's setup forward (`furtherSetup`); then they and the copy
 * are read again in the background, so the API stays the source. Resolves once the carried step is
 * written, without waiting for that read.
 */
export async function carrySetup(queryClient: QueryClient, state: { desk_id: string; interview_id: string; step: SetupStep }): Promise<void> {
  await queryClient.cancelQueries({ queryKey: DESKS_KEY });
  const carried = (desk: DeskSummary): DeskSummary => (desk.desk_id === state.desk_id ? { ...desk, setup: furtherSetup(desk.setup, state) } : desk);
  queryClient.setQueryData<BusinessOut[]>(DESKS_KEY, (now) => now?.map((business) => ({ ...business, desks: business.desks.map(carried) })));
  void invalidateCopy(queryClient);
}

/** A Desk's own address in the owner app, which its pages sit under. */
export function deskPath(deskId: string): string {
  return `/app/${encodeURIComponent(deskId)}`;
}

/**
 * A new copy is taking the old one's place (Start over, or a new passcode): drop the old copy's Demo
 * inbox before anything of the new copy is read, its Today read ahead included. The inbox's key
 * doesn't name a copy, so a read of the old copy's inbox still out would otherwise answer for the
 * new one and count as fresh: it is stopped, and its entries dropped, so the new copy's Today reads
 * its own.
 */
export async function dropTheOldInbox(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: OWNER_INBOX_KEY });
  queryClient.removeQueries({ queryKey: OWNER_INBOX_KEY });
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

/** Whether a Desk is live: its setup is null, or absent from an API from before setup. Answering is separate. */
export function isLive(desk: DeskSummary): boolean {
  return (desk.setup ?? null) === null;
}

/** The same Desks with this Desk's Answering set to `on`; the same list when it doesn't hold the Desk. */
export function withAnswering(businesses: BusinessOut[] | undefined, deskId: string, on: boolean): BusinessOut[] | undefined {
  if (businesses === undefined || findDesk(businesses, deskId) === null) return businesses;
  return businesses.map((b) => ({ ...b, desks: b.desks.map((d) => (d.desk_id === deskId ? { ...d, answering: on } : d)) }));
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
