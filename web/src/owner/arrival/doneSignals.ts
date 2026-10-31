/**
 * When each of Today's four things to try is done, as pure functions of reads the owner app already
 * makes. A thing is done only on what the reads show the owner did in this copy: never on replayed
 * history, never on the seed's own stopped reply or hold, and never on a click alone.
 */
import type { Decision, DecisionState, LedgerEntry, LedgerPage } from '../../api/contracts.ts';
import type { Attempt, BusinessOut, ConversationSummary, OwnerTranscript } from '../../api/views.ts';

/** The four things, in the intro dialog's order. */
export const THINGS = ['chat', 'break', 'answer', 'create'] as const;

export type Thing = (typeof THINGS)[number];

/** What the reads, and what the owner did in this view, show for a thing now. */
export interface Reading {
  /** The thing's reads show it done. */
  done: boolean;
  /** Every read the thing needs has come in, and none failed. */
  settled: boolean;
  /** Something the owner did in this view shows it done, whatever the reads show yet: an answer given here. */
  inView?: boolean;
}

/**
 * What a view of the list remembers: each thing seen done, and whether it was already done in the
 * first settled read of its queries (`atLoad`, drawn still) rather than done while in view; and
 * which things' reads have settled at least once.
 */
export interface DoneMemory {
  done: Readonly<Partial<Record<Thing, { atLoad: boolean }>>>;
  settled: Readonly<Partial<Record<Thing, true>>>;
}

export const NOTHING_DONE: DoneMemory = { done: {}, settled: {} };

/**
 * The memory after a reading. A thing seen done stays done in this view, whatever later reads show
 * (an answered card dismissed, a read that fails, the first Desk deleted). Returns `memory` itself
 * when nothing changed.
 * - Done in view ticks it at once, as done in view.
 * - Until a thing's reads first settle, what some of them show waits for the rest (one preview
 *   chat read and another still out), so a thing done before the page opened is never taken for
 *   one done in view. Done in that first settled reading is done at load.
 * - Once they have settled, the reads showing it done later is done in view, even while a new read
 *   (a new preview chat's) is still out.
 */
export function remember(memory: DoneMemory, now: Record<Thing, Reading>): DoneMemory {
  let done = memory.done;
  let settled = memory.settled;
  for (const thing of THINGS) {
    const { done: isDone, settled: isSettled, inView = false } = now[thing];
    const settledBefore = settled[thing] !== undefined;
    if (done[thing] === undefined) {
      if (inView) done = { ...done, [thing]: { atLoad: false } };
      else if (isDone && (isSettled || settledBefore)) done = { ...done, [thing]: { atLoad: !settledBefore } };
    }
    if (isSettled && !settledBefore) settled = { ...settled, [thing]: true };
  }
  return done === memory.done && settled === memory.settled ? memory : { done, settled };
}

/**
 * The list's line under its heading: how long the tour takes until something is done, then how many
 * of the four are, always "of 4", the intro dialog's four, even before "Answer a held request" shows.
 */
export function doneCaption(count: number): string {
  if (count <= 0) return 'About 10 minutes. No real customer sees any of it.';
  if (count >= THINGS.length) return `All ${THINGS.length} done. No real customer sees any of it.`;
  return `${count} of ${THINGS.length} done. No real customer sees any of it.`;
}

/** Who writes a reply in a chat: Claude, or the Desk's own code-built cards. */
const REPLY_AUTHORS: ReadonlySet<string> = new Set(['claude', 'desk']);

/** The owner's own preview chats in a Desk's conversations, by session: live in this copy, never replayed. */
export function previewSessions(conversations: readonly ConversationSummary[]): string[] {
  return conversations.filter((c) => c.owner_preview && c.replayed !== true).map((c) => c.session_id);
}

/**
 * "Chat as a customer": one of the owner's preview chats got a reply. Only a delivered message by
 * Claude or the Desk is a reply: the owner's own words are delivered too, and a visiting agent's
 * words (`agent_text`) are what it wrote, not an answer. A replayed chat is history, not the owner's.
 */
export function chattedAsCustomer(transcripts: readonly (OwnerTranscript | undefined)[]): boolean {
  return transcripts.some(
    (chat) =>
      chat !== undefined &&
      chat.replayed !== true &&
      chat.items.some((item) => item.kind === 'delivered' && item.event?.type === 'message' && REPLY_AUTHORS.has(item.event.author)),
  );
}

/**
 * Whether a signed entry was replayed from the recorded history into this copy. The kernel's replay
 * marks it (`summary.replayed`); any mark at all counts, so an entry it can't read is never the owner's.
 */
function isReplayed(entry: LedgerEntry): boolean {
  const marker = entry.event.summary.replayed;
  return marker !== undefined && marker !== null && marker !== false;
}

/**
 * "Try to break it": an attempt Safety lists as stopped happened in one of the owner's preview
 * chats. Each attempt is joined to its signed entry (`ledger_seq` is the entry's `seq`), whose
 * session says where it happened, so the seed's own stopped reply, in a visitor's chat, never
 * counts, and neither does a replayed entry or one the record read doesn't hold yet.
 */
export function stoppedInPreview(attempts: readonly Attempt[], ledger: Pick<LedgerPage, 'entries'>, previews: ReadonlySet<string>): boolean {
  const bySeq = new Map(ledger.entries.map((e) => [e.seq, e]));
  return attempts.some((a) => {
    const entry = bySeq.get(a.ledger_seq);
    return entry !== undefined && !isReplayed(entry) && entry.event.session_id != null && previews.has(entry.event.session_id);
  });
}

/** The states `approvals.py` records when it takes the owner's answer: allowed, denied, or allowed and then refused at execution. */
const TAKEN: ReadonlySet<unknown> = new Set(['approved', 'denied', 'refused_at_execution']);

/**
 * "Answer a held request", from the record: an approval entry the kernel wrote as it took an answer
 * (the answer given, and a state it records then). Its notes for an answer it refused carry
 * `refused` and no such state, and a cancel or an expiry carries no answer, so neither counts.
 */
export function answeredOnRecord(ledger: Pick<LedgerPage, 'entries'>): boolean {
  return ledger.entries.some((e) => {
    if (e.event.kind !== 'approval' || isReplayed(e)) return false;
    const { summary } = e.event;
    return summary.answer != null && summary.refused == null && TAKEN.has(summary.state);
  });
}

/**
 * The states an answer given here can leave a request in: it ran or is running, it failed or its
 * outcome is unknown, it was denied, or it was refused at execution. A 409 that found the request
 * already expired or cancelled lands among the answers too, and isn't one.
 */
const ANSWERED: ReadonlySet<DecisionState> = new Set<DecisionState>(['approved', 'executed', 'failed', 'unknown', 'denied', 'refused_at_execution']);

/** "Answer a held request", in this view: one of the decisions answered here settled in an answer's state. */
export function answeredInView(decisions: Iterable<Pick<Decision, 'state'>>): boolean {
  for (const decision of decisions) if (ANSWERED.has(decision.state)) return true;
  return false;
}

/** The copy's Desks in the order the API lists them, the order they were made. */
function desksOf(businesses: readonly BusinessOut[]): string[] {
  return businesses.flatMap((b) => b.desks.map((d) => d.desk_id));
}

/** The first Desk the copy lists: the one it started with, while it is listed. Null when it lists none. */
export function firstDesk(businesses: readonly BusinessOut[]): string | null {
  return desksOf(businesses)[0] ?? null;
}

/**
 * "Create your own Desk": the copy lists a Desk besides the one it started with. While that one is
 * listed this is two or more Desks; once it has been deleted, any Desk still listed is another.
 */
export function madeAnotherDesk(businesses: readonly BusinessOut[], startedWith: string): boolean {
  return desksOf(businesses).some((id) => id !== startedWith);
}
