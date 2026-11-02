/**
 * When each of Today's five things to try is done, as pure functions of reads the owner app already
 * makes. A thing is done only on what the reads show the owner did in this copy: never on replayed
 * history, never on the seed's own stopped reply or hold, and never on a click alone.
 */
import type { Decision, DecisionState, LedgerEntry, LedgerPage } from '../../api/contracts.ts';
import type { Attempt, BusinessOut, ConversationSummary, OwnerTranscript } from '../../api/views.ts';
import { isLive } from '../useDesks.ts';

/** The five things, in the list's order: the intro dialog's four, with "Watch a demo visitor" second. */
export const THINGS = ['chat', 'demo', 'break', 'answer', 'create'] as const;

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
 * of the five are, always "of 5", even before "Answer a held request" shows.
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
 * "Watch a demo visitor": the Desk's conversations list a demo visitor's chat, which the owner
 * started in this copy. A replayed chat is history, not the owner's.
 */
export function demoVisitorRan(conversations: readonly ConversationSummary[]): boolean {
  return conversations.some((c) => c.demo_visitor === true && c.replayed !== true);
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

/** The decision a signed entry is about: its `ref_id`, as the kernel sets it for approvals and runs. */
function decisionOf(entry: LedgerEntry): string | null {
  return entry.event.ref_id ?? null;
}

/**
 * "Answer a held request", from the record: an answer the kernel took that took effect. The kernel
 * writes an approval entry as it takes an answer (the answer given, and the state it records then);
 * its notes for an answer it refused carry `refused` and no such state, and a cancel or an expiry
 * carries no answer. A deny takes effect as it's taken (`denied`). An allow (`approved`) takes effect
 * once its run is done: an `execute` entry for the same decision in state `executed`, which a run
 * reconciled later records too. An allow refused at execution, or whose run failed or isn't
 * confirmed, hasn't.
 */
export function answeredOnRecord(ledger: Pick<LedgerPage, 'entries'>): boolean {
  const done = new Set<string>();
  for (const e of ledger.entries) {
    const id = decisionOf(e);
    if (e.event.kind === 'execute' && id !== null && !isReplayed(e) && e.event.summary.state === 'executed') done.add(id);
  }
  return ledger.entries.some((e) => {
    if (e.event.kind !== 'approval' || isReplayed(e)) return false;
    const { summary } = e.event;
    if (summary.answer == null || summary.refused != null) return false;
    if (summary.state === 'denied') return true;
    const id = decisionOf(e);
    return summary.state === 'approved' && id !== null && done.has(id);
  });
}

/**
 * The states that say an answer given here took effect: allowed (running or done) or denied. One
 * that failed, isn't confirmed yet, or was refused at execution hasn't, and neither has a late
 * answer that found the request already expired or cancelled.
 */
const TOOK_EFFECT: ReadonlySet<DecisionState> = new Set<DecisionState>(['approved', 'executed', 'denied']);

/** "Answer a held request", in this view: one of the answers given here took effect. */
export function answeredInView(decisions: Iterable<Pick<Decision, 'state'>>): boolean {
  for (const decision of decisions) if (TOOK_EFFECT.has(decision.state)) return true;
  return false;
}

/**
 * How an answer given here ended when "Answer a held request" doesn't count it: the request had
 * expired or been cancelled first; the answer failed, isn't confirmed yet, or was refused at
 * execution; or, where the list doesn't count answers, it took effect (`answered`).
 */
export type UncountedAnswer = 'expired' | 'cancelled' | 'answered' | 'failed' | 'unknown' | 'refused_at_execution';

/**
 * How the latest answer given here ended, when "Answer a held request" doesn't count it. A late
 * answer to a request already expired or cancelled never counts, and neither does one that didn't
 * take effect (or isn't confirmed yet). One that took effect counts where the list counts answers
 * (`countsHere`, the Desk the copy started with); elsewhere it is `answered`. Null when there is
 * none, or when the list counts it.
 */
export function uncountedAnswer(latest: Pick<Decision, 'state'> | null, countsHere: boolean): UncountedAnswer | null {
  if (latest === null) return null;
  const { state } = latest;
  if (state === 'expired' || state === 'cancelled') return state;
  if (state === 'failed' || state === 'unknown' || state === 'refused_at_execution') return state;
  if (TOOK_EFFECT.has(state)) return countsHere ? null : 'answered';
  return null;
}

/** The copy's Desks in the order the API lists them, the order they were made. */
export function listedDesks(businesses: readonly BusinessOut[]): string[] {
  return businesses.flatMap((b) => b.desks.map((d) => d.desk_id));
}

/** The first Desk the copy lists: the one it started with, while it is listed. Null when it lists none. */
export function firstDesk(businesses: readonly BusinessOut[]): string | null {
  return listedDesks(businesses)[0] ?? null;
}

/**
 * What the list keeps of the copy it shows, across visits to Today in this app: the Desk the copy
 * started with (still that one once it is deleted), every Desk the copy has listed, and the memory
 * of what was seen done.
 */
export interface Kept {
  startedWith: string | null;
  seen: ReadonlySet<string>;
  memory: DoneMemory;
}

const NOTHING_KEPT: Kept = { startedWith: null, seen: new Set(), memory: NOTHING_DONE };

/**
 * `kept` once the copy lists `listed`: the first Desk listed is the one the copy started with, if
 * none was yet, and every Desk listed is seen. Returns `kept` itself when nothing changed.
 */
export function keepFor(kept: Kept, listed: readonly string[]): Kept {
  const startedWith = kept.startedWith ?? listed[0] ?? null;
  const unseen = listed.filter((id) => !kept.seen.has(id));
  if (startedWith === kept.startedWith && unseen.length === 0) return kept;
  return { ...kept, startedWith, seen: unseen.length === 0 ? kept.seen : new Set([...kept.seen, ...unseen]) };
}

/**
 * What a newly drawn list starts from: what was kept, while the copy still lists a Desk it saw (a
 * Desk deleted leaves the others), else nothing (Reset demo makes a copy of all new Desks). Which
 * reads settled stays with the list that read them: a newly drawn list's first settled reads are
 * its own.
 */
export function restoreKept(kept: Kept | undefined, listed: readonly string[]): Kept {
  if (kept === undefined || !listed.some((id) => kept.seen.has(id))) return NOTHING_KEPT;
  return { ...kept, memory: { done: kept.memory.done, settled: {} } };
}

/**
 * "Create your own Desk": the copy lists a live Desk besides the one it started with. A Desk counts
 * once its setup has gone live (`setup` null, or absent from an API from before setup), never while
 * it still names its setup, even with Answering on. While the first Desk is listed this is the
 * first Desk plus at least one live Desk; once it has been deleted, any live Desk still listed is
 * another.
 */
export function madeAnotherDesk(businesses: readonly BusinessOut[], startedWith: string): boolean {
  return businesses.some((b) => b.desks.some((d) => d.desk_id !== startedWith && isLive(d)));
}
