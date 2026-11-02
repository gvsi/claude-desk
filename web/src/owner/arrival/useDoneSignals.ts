/**
 * The reads behind Today's things to try, and what this view remembers of them. Every read is one
 * another owner screen already makes, under that screen's key, so they share it: the conversations
 * list, a preview chat's transcript, Safety's attempts and its signed record, and the copy's Desks.
 * "Chat as a customer", "Try to break it" and "Answer a held request" read the Desk the copy started
 * with, on whichever Desk the list shows. "Watch a demo visitor" and "Create your own Desk" are
 * copy-wide: a demo visitor runs on the Desk it was started from, so every listed Desk's
 * conversations are read for one. A hidden list reads nothing, and a read stops once every thing it tells is
 * done. A read that is loading or failed ticks nothing and shows no error: the list is a guide.
 * What the list remembers (the Desk the copy started with and the things seen done) lasts while the
 * app runs, across visits to Today, until a reload or a new copy.
 */
import { useQueries, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import type { Decision } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { conversationsKey } from '../conversations/ConversationsPage.tsx';
import { conversationKey } from '../conversations/useTakeOver.ts';
import { attemptsQuery, ledgerQuery } from '../safety/queries.ts';
import { useDesks } from '../useDesks.ts';
import { keptByApp } from './keptCopy.ts';
import {
  THINGS,
  answeredInView,
  answeredOnRecord,
  chattedAsCustomer,
  demoVisitorRan,
  keepFor,
  listedDesks,
  madeAnotherDesk,
  previewSessions,
  remember,
  restoreKept,
  stoppedInPreview,
  uncountedAnswer,
  type Reading,
  type Thing,
  type UncountedAnswer,
} from './doneSignals.ts';

/** A thing seen done in this view, and whether it was already done at load, so its check draws still. */
export interface Done {
  atLoad: boolean;
}

export interface DoneSignals {
  /** Each thing seen done in this view; a thing not done yet is missing. */
  done: Readonly<Partial<Record<Thing, Done>>>;
  /** How many of the five are done. */
  count: number;
  /** Whether the list shows the Desk the copy started with. */
  onStartingDesk: boolean;
  /** How the answer given on this page last ended, when "Answer a held request" doesn't count it. */
  uncounted: UncountedAnswer | null;
}

export interface UseDoneSignalsOptions {
  /** False while the list is hidden: nothing is read. */
  enabled: boolean;
  /** The Desk the list shows. */
  deskId: string;
  /** The final decisions of the requests answered on this page, in this view. */
  answered: Iterable<Pick<Decision, 'state'>>;
  /** The final decision of the request answered on this page last, kept when its card is dismissed. */
  latest: Pick<Decision, 'state'> | null;
}

/** Each read follows Today's poll and is read again when the window regains focus: the owner comes back from the preview tab. */
function polled() {
  return { refetchInterval: pollMs('today'), refetchOnWindowFocus: true } as const;
}

interface Read<T> {
  status: 'pending' | 'error' | 'success';
  data: T | undefined;
}

/**
 * What a read shows, only while its latest attempt worked. React Query keeps the data of an earlier
 * read through a failure; that copy may be from before this view, so a failing read ticks nothing new.
 */
function worked<T>(read: Read<T>): T | undefined {
  return read.status === 'success' ? read.data : undefined;
}

/** How many fetches of a query have ended, with data or with an error. */
function fetchesEnded(queryClient: QueryClient, queryKey: QueryKey): number {
  const state = queryClient.getQueryState(queryKey);
  return (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0);
}

/**
 * For each read, by its key, how many of its fetches must have ended before one this list asked for
 * has: those ended when the list first saw the read, and one more if a fetch was still out then. A
 * copy another screen read earlier, or a read it asked for that lands after the list is drawn, isn't
 * this list's first read, so what it shows waits for a fresh one, and what was done before Today
 * opened is never taken for something done in view.
 */
function useFreshReads(queryClient: QueryClient) {
  const before = useRef(new Map<string, number>());
  return <T,>(queryKey: QueryKey, read: Read<T>): boolean => {
    const hash = JSON.stringify(queryKey);
    let wait = before.current.get(hash);
    if (wait === undefined) {
      wait = fetchesEnded(queryClient, queryKey) + (queryClient.getQueryState(queryKey)?.fetchStatus === 'fetching' ? 1 : 0);
      before.current.set(hash, wait);
    }
    return read.status === 'success' && fetchesEnded(queryClient, queryKey) > wait;
  };
}

export function useDoneSignals({ enabled, deskId, answered, latest }: UseDoneSignalsOptions): DoneSignals {
  const queryClient = useQueryClient();
  const fresh = useFreshReads(queryClient);
  const answeredHere = [...answered];
  // The copy's Desks as the owner's frame reads them, never read again here.
  const desks = useDesks(deskId, { passive: true });
  const businesses = desks.data;
  const listed = businesses === undefined ? [] : listedDesks(businesses);

  // What the list kept on an earlier visit to Today, while the copy is the same one.
  const [kept, setKept] = useState(() => restoreKept(keptByApp.get(queryClient), listed));
  useEffect(() => {
    keptByApp.set(queryClient, kept);
  }, [queryClient, kept]);
  // The Desk the copy started with: the first one listed when the list first read the copy, and
  // still that one after it is deleted, when the list ticks nothing new from it.
  const knowing = keepFor(kept, listed);
  const seeded = knowing.startedWith;
  const memory = knowing.memory;
  const seededListed = seeded !== null && listed.includes(seeded);
  const reading = enabled && seededListed && seeded !== null;
  const seen = memory.done;

  const conversations = useQuery({
    queryKey: conversationsKey(seeded ?? ''),
    queryFn: () => request('conversations', { params: { desk_id: seeded ?? '' } }),
    enabled: reading && (seen.chat === undefined || seen.break === undefined),
    ...polled(),
  });
  const previews = conversations.data === undefined ? [] : previewSessions(conversations.data);
  const transcripts = useQueries({
    queries: previews.map((sessionId) => ({
      queryKey: conversationKey(sessionId),
      queryFn: () => request('conversation', { params: { session_id: sessionId } }),
      enabled: reading && seen.chat === undefined,
      ...polled(),
    })),
  });
  // "Watch a demo visitor": each listed Desk's conversations, the starting Desk's among them (the same
  // read as above), until one lists a demo visitor's chat.
  const demoReads = useQueries({
    queries: listed.map((id) => ({
      queryKey: conversationsKey(id),
      queryFn: () => request('conversations', { params: { desk_id: id } }),
      enabled: enabled && seen.demo === undefined,
      ...polled(),
    })),
  });
  const attempts = useQuery({
    ...attemptsQuery(seeded ?? ''),
    enabled: reading && previews.length > 0 && seen.break === undefined,
    ...polled(),
  });
  // The signed record, verified on every read, so it isn't read for a list nobody sees.
  const ledger = useQuery({
    ...ledgerQuery(seeded ?? ''),
    enabled: reading && (seen.answer === undefined || (previews.length > 0 && seen.break === undefined)),
    ...polled(),
  });

  // Only reads whose latest attempt worked say anything, and only reads made since the list was
  // drawn settle; rows already seen done stay done (`remember`).
  const conversationsWorked = worked(conversations) !== undefined;
  const chats = transcripts.map((t) => worked(t));
  const stopped = worked(attempts);
  const record = worked(ledger);
  // The frame reads the copy's Desks as it opens and again whenever the copy changes, so what it
  // keeps is current: it settles as it is.
  const copy = worked(desks);
  const previewIds = new Set(previews);
  const now: Record<Thing, Reading> = {
    chat: {
      settled: reading && fresh(conversationsKey(seeded ?? ''), conversations) && transcripts.every((t, i) => fresh(conversationKey(previews[i] ?? ''), t)),
      done: reading && conversationsWorked && chattedAsCustomer(chats),
    },
    demo: {
      settled: enabled && listed.length > 0 && demoReads.every((read, i) => fresh(conversationsKey(listed[i] ?? ''), read)),
      done: enabled && demoReads.some((read) => {
        const listedThere = worked(read);
        return listedThere !== undefined && demoVisitorRan(listedThere);
      }),
    },
    break: {
      settled:
        reading &&
        fresh(conversationsKey(seeded ?? ''), conversations) &&
        (previews.length === 0 || (fresh(attemptsQuery(seeded ?? '').queryKey, attempts) && fresh(ledgerQuery(seeded ?? '').queryKey, ledger))),
      done: reading && conversationsWorked && stopped !== undefined && record !== undefined && stoppedInPreview(stopped, record, previewIds),
    },
    answer: {
      settled: reading && fresh(ledgerQuery(seeded ?? '').queryKey, ledger),
      done: reading && record !== undefined && answeredOnRecord(record),
      inView: reading && deskId === seeded && answeredInView(answeredHere),
    },
    create: {
      settled: enabled && copy !== undefined,
      done: enabled && copy !== undefined && seeded !== null && madeAnotherDesk(copy, seeded),
    },
  };

  const remembered = remember(memory, now);
  const next = remembered === memory ? knowing : { ...knowing, memory: remembered };
  if (next !== kept) setKept(next);
  return {
    done: remembered.done,
    count: THINGS.filter((thing) => remembered.done[thing] !== undefined).length,
    onStartingDesk: deskId === seeded,
    uncounted: uncountedAnswer(latest, reading && deskId === seeded),
  };
}
