/**
 * The reads behind Today's things to try, and what this view remembers of them. Every read is one
 * another owner screen already makes, under that screen's key, so they share it: the conversations
 * list, a preview chat's transcript, Safety's attempts and its signed record, and the copy's Desks.
 * Signals 1 to 3 read the Desk the copy started with, on whichever Desk the list shows; "Create your
 * own Desk" is copy-wide. A hidden list reads nothing, and a read stops once every thing it tells is
 * done. A read that is loading or failed ticks nothing and shows no error: the list is a guide.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { Decision } from '../../api/contracts.ts';
import { request } from '../../api/http.ts';
import { pollMs } from '../../app/poll.ts';
import { conversationsKey } from '../conversations/ConversationsPage.tsx';
import { conversationKey } from '../conversations/useTakeOver.ts';
import { desksQuery } from '../useDesks.ts';
import {
  NOTHING_DONE,
  THINGS,
  answeredInView,
  answeredOnRecord,
  chattedAsCustomer,
  firstDesk,
  madeAnotherDesk,
  previewSessions,
  remember,
  stoppedInPreview,
  type Reading,
  type Thing,
} from './doneSignals.ts';

/** A thing seen done in this view, and whether it was already done at load, so its check draws still. */
export interface Done {
  atLoad: boolean;
}

export interface DoneSignals {
  /** Each thing seen done in this view; a thing not done yet is missing. */
  done: Readonly<Partial<Record<Thing, Done>>>;
  /** How many of the four are done. */
  count: number;
}

export interface UseDoneSignalsOptions {
  /** False while the list is hidden: nothing is read. */
  enabled: boolean;
  /** The Desk the list shows. */
  deskId: string;
  /** The final decisions of the requests answered on this page, in this view. */
  answered: Iterable<Pick<Decision, 'state'>>;
}

/** Each read follows Today's poll and is read again when the window regains focus: the owner comes back from the preview tab. */
function polled() {
  return { refetchInterval: pollMs('today'), refetchOnWindowFocus: true } as const;
}

/**
 * What a read shows, only while its latest attempt worked. React Query keeps the data of an earlier
 * read through a failure; that copy may be from before this view, so a failing read ticks nothing new.
 */
function worked<T>(read: { status: 'pending' | 'error' | 'success'; data: T | undefined }): T | undefined {
  return read.status === 'success' ? read.data : undefined;
}

export function useDoneSignals({ enabled, deskId, answered }: UseDoneSignalsOptions): DoneSignals {
  const [memory, setMemory] = useState(NOTHING_DONE);
  // The copy's Desks as the owner's frame keeps them, never read again here.
  const desks = useQuery({ ...desksQuery(), enabled: false });
  const businesses = desks.data;

  // The Desk the copy started with: the first one listed when this view first read the copy, and
  // still that one after it is deleted, when the list ticks nothing new from it.
  const [startedWith, setStartedWith] = useState<string | null>(null);
  const first = businesses === undefined ? null : firstDesk(businesses);
  if (startedWith === null && first !== null) setStartedWith(first);
  const seeded = startedWith ?? first;
  const seededListed = seeded !== null && businesses !== undefined && businesses.some((b) => b.desks.some((d) => d.desk_id === seeded));
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
  const attempts = useQuery({
    queryKey: ['safety', seeded ?? ''],
    queryFn: () => request('safety', { params: { desk_id: seeded ?? '' } }),
    enabled: reading && previews.length > 0 && seen.break === undefined,
    ...polled(),
  });
  // The signed record, verified on every read, so it isn't read for a list nobody sees.
  const ledger = useQuery({
    queryKey: ['ledger', seeded ?? ''],
    queryFn: () => request('ledger', { params: { desk_id: seeded ?? '' }, query: { verify: true } }),
    enabled: reading && (seen.answer === undefined || (previews.length > 0 && seen.break === undefined)),
    ...polled(),
  });

  // Only reads whose latest attempt worked say anything; rows already seen done stay done (`remember`).
  const listed = worked(conversations) !== undefined;
  const chats = transcripts.map((t) => worked(t));
  const stopped = worked(attempts);
  const record = worked(ledger);
  const copy = worked(desks);
  const previewIds = new Set(previews);
  const now: Record<Thing, Reading> = {
    chat: {
      settled: reading && listed && chats.every((chat) => chat !== undefined),
      done: reading && listed && chattedAsCustomer(chats),
    },
    break: {
      settled: reading && listed && (previews.length === 0 || (stopped !== undefined && record !== undefined)),
      done: reading && listed && stopped !== undefined && record !== undefined && stoppedInPreview(stopped, record, previewIds),
    },
    answer: {
      settled: reading && record !== undefined,
      done: reading && record !== undefined && answeredOnRecord(record),
      inView: reading && deskId === seeded && answeredInView(answered),
    },
    create: {
      settled: enabled && copy !== undefined,
      done: enabled && copy !== undefined && seeded !== null && madeAnotherDesk(copy, seeded),
    },
  };

  const next = remember(memory, now);
  if (next !== memory) setMemory(next);
  return { done: next.done, count: THINGS.filter((thing) => next.done[thing] !== undefined).length };
}
