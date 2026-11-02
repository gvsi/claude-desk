/**
 * Safety's words and the few rules behind them: what each kind of record entry is called, where an
 * entry came from, what an attempt was about, why a request was turned down, which checkpoint
 * stopped it, the one entry an attempt is shown with, the one time an entry shows, and whether the
 * week stopped or turned down anything at all.
 */
import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import { handoffEntryOf, takeoverEntryOf, type HandoffEntry } from '../../api/handoffEntry.ts';
import type { Attempt, RefusalCause, ThisWeek, Triage, TriageCategory } from '../../api/views.ts';
import type { Checkpoint } from '../../ds/index.ts';
import { localDate } from '../../lib/format.ts';

/** Each kind of record entry, as a row of the record names it. A kind missing here is a compile error. */
export const LEDGER_KIND_COPY = {
  session: 'Chat started',
  auth: 'Credential check',
  verify: 'Identity check',
  decide: 'Action checked',
  review: 'Second look by Claude',
  breaker: 'Chat paused',
  approval: 'Your answer',
  execute: 'Action ran',
  payment: 'Payment',
  document_link: 'Document link',
  reply: 'Reply checked',
  policy: 'Rules changed',
  tool_pin: 'Tool definition',
  takeover: 'Take over',
  whisper: 'Whisper',
  rate_limit: 'Rate limit',
  agent_auth: 'Agent signature',
  head_checkpoint: 'Record checkpoint',
  desk_data: 'Desk details changed',
  web_search: 'Web search',
  business_tools: "Your Desk's jobs changed",
} as const satisfies Record<LedgerEvent['kind'], string>;

/**
 * Where an entry came from, the same words on every row, detail and trace: the checkpoint wrote it,
 * or the chat service reported it and the checkpoint recorded the report unchecked.
 */
export const ORIGIN_COPY = {
  kernel: 'Recorded by the checkpoint',
  api: 'Reported by the chat service, not checked by the checkpoint',
} as const satisfies Record<LedgerEvent['origin'], string>;

/** Each checkpoint event's subject, in the owner's words and order, with one filter per category. */
export const CATEGORY_COPY = {
  prices: 'Prices and discounts',
  records: "Someone's records",
  codes: 'Verification codes',
  instructions: 'Instructions in a message',
  limits: 'Above a limit',
  wording: "The AI's wording",
  other: 'Other',
} as const satisfies Record<TriageCategory, string>;

/**
 * Why a request was turned down, by its cause, in the owner's signed words: the label beside a
 * refused entry. A cause missing here, or one the API's document adds, is a compile error.
 */
export const CAUSE_COPY = {
  owner_rule: 'Your rule says no',
  not_verified: 'Not verified yet',
  not_their_record: 'Only for the person it belongs to',
  recipient: 'Only to you or a contact on record',
  no_such_slot: "That time isn't open",
  unknown_item: 'Not on the price list',
  over_quote_ceiling: 'Over the $10,000 quote ceiling',
  quote_unpayable: "That quote can't be paid now",
  no_such_charge: "Couldn't find that payment",
  not_refundable: "That payment can't be refunded",
  no_such_document: 'No such document',
  no_amount: 'Not a valid amount',
  tool_not_available: 'Not a tool this chat can use',
  incomplete_request: "The request wasn't in a form I can use",
  paused: 'The chat was paused',
  no_rules: 'No rules turned on yet',
  rules_unchecked: "Your rules couldn't be checked, so I said no",
  agent_pay_out: "Agents can't send money out",
  agent_limit: "Outside the agent's spending limit",
  other_copy: 'Not a record on this Desk',
  no_rule: 'No rule covers this yet',
} as const satisfies Record<RefusalCause, string>;

/**
 * The label beside a refused entry, saying why it was turned down, or null: for an entry with no
 * cause (the API couldn't place it, or sent none), a cause this build has no words for yet, and
 * anything but a refused request, since a stopped draft or a hold was never turned down.
 */
export function causeLabel(a: Pick<Attempt, 'kind' | 'cause'>): string | null {
  const { cause } = a;
  if (a.kind !== 'refused' || cause === null || !Object.hasOwn(CAUSE_COPY, cause)) return null;
  return CAUSE_COPY[cause];
}

/**
 * The label beside a stopped reply of Claude's in the list, where a refused request's says why it
 * was turned down: the API's own line for it. So the list reads as the requests the headline counts,
 * and the replies, which it doesn't.
 */
export const REPLY_STOPPED_LABEL = 'A reply was stopped before it was shown';

/**
 * The label beside an entry in the list: why a request was turned down, that a reply was stopped, or
 * null. A stopped reply Claude hasn't sorted yet has none: its row reads the API's reason, which
 * already starts with the same words.
 */
export function rowLabel(a: Pick<Attempt, 'kind' | 'cause' | 'triage'>): string | null {
  if (a.kind === 'reply_blocked') return triageOf(a) === null ? null : REPLY_STOPPED_LABEL;
  return causeLabel(a);
}

/** What Safety holds, under its title as the other owner pages say theirs: both of its views, in the owner's signed words. */
export const SAFETY_SUBTITLE = 'Requests the checkpoint turned down, replies it stopped before they were shown, and the signed record of every entry.';

/** The header's way to the requests held for the owner, which the reload's shapes measure too. */
export const heldForYou = (n: number): string => `${n} held for you`;

/** An attempt Claude hasn't sorted into a category yet. */
export const NOT_SORTED = 'Not sorted yet';

/** Each category's words in `CATEGORY_COPY`'s order: one filter each. */
export const CATEGORY_LABELS: readonly string[] = Object.values(CATEGORY_COPY);

/** An entry replayed from the recorded history into this copy. */
export const REPLAYED_LABEL = 'Recorded history, replayed into your copy';

/** Where an entry came from, in `ORIGIN_COPY`'s words. Anything but the checkpoint reads as reported, never as checked. */
export function originCopy(origin: string): string {
  return origin === 'kernel' ? ORIGIN_COPY.kernel : ORIGIN_COPY.api;
}

/** A kind of entry's name; a kind this build doesn't know is named as plainly as it can be. */
export function kindCopy(kind: string): string {
  return Object.hasOwn(LEDGER_KIND_COPY, kind) ? LEDGER_KIND_COPY[kind as LedgerEvent['kind']] : 'Other entry';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `desk_data` entries about a conversation handed to the owner (`part: "handoffs"`), by
 * `handoffEntryOf`, in the owner's signed words: the handoff card handing one over, the owner
 * marking one done, and the kernel closing one when a call-back request replaced it, the owner
 * took the chat over, the owner wrote in it, or the visitor booked a time in it.
 */
export const HANDOFF_ENTRY_COPY = {
  opened: 'Chat handed to you',
  done: 'Chat marked done',
  replaced: 'Chat moved to a call-back',
  took_over: 'Handoff closed when you took over',
  wrote: 'Handoff closed when you wrote in the chat',
  booked: 'Handoff closed when they booked a time',
} as const satisfies Record<HandoffEntry, string>;

/**
 * An entry's name as a row of the record names it: its kind's, but a `desk_data` entry about a
 * handoff says which one it is, and a mode change back to Claude says so. Every other entry, a
 * handoffs entry this build doesn't know or a mode change with no readable direction among them,
 * keeps its kind's name.
 */
export function entryCopy(event: Pick<LedgerEvent, 'kind' | 'summary'>): string {
  const handoff = handoffEntryOf(event);
  if (handoff !== null) return HANDOFF_ENTRY_COPY[handoff];
  if (takeoverEntryOf(event) === 'handback') return 'Hand back to Claude';
  return kindCopy(event.kind);
}

/** The checkpoint that stopped an attempt: a blocked reply at the reply checkpoint, anything else at the action checkpoint. */
export function stoppedBy(a: Pick<Attempt, 'kind'>): Checkpoint {
  return a.kind === 'reply_blocked' ? 'reply' : 'action';
}

/** The entry an attempt is shown with: the one whose `seq` is its `ledger_seq`, or null when the page doesn't hold it. */
export function entryFor(a: Pick<Attempt, 'ledger_seq'>, page: Pick<LedgerPage, 'entries'> | undefined): LedgerEntry | null {
  return page?.entries.find((entry) => entry.seq === a.ledger_seq) ?? null;
}

/**
 * The replay marker inside the signed entry (`event.summary.replayed`, which only the kernel's
 * replay writes), or null for a live entry. `at` is null when the marker names no time.
 */
export function replayedOf(entry: LedgerEntry): { at: string | null } | null {
  const marker = entry.event.summary.replayed;
  if (!isRecord(marker)) return null;
  return { at: typeof marker.at === 'string' ? marker.at : null };
}

/**
 * The one time an entry shows: when a replayed entry happened in the recorded history, else when
 * the checkpoint wrote it. The signed entry itself is never changed.
 */
export function entryTime(entry: LedgerEntry): string {
  return replayedOf(entry)?.at ?? entry.created_at;
}

/**
 * When an attempt happened: its entry's time once the record is read (so a replayed attempt shows
 * when it happened in the recorded history), else the attempt's own `created_at`.
 */
export function attemptTime(a: Pick<Attempt, 'ledger_seq' | 'created_at'>, page: Pick<LedgerPage, 'entries'> | undefined): string {
  const entry = entryFor(a, page);
  return entry === null ? a.created_at : entryTime(entry);
}

/** An attempt's triage when it has a usable one: owner-facing words Claude wrote, and a category. */
export function triageOf(a: Pick<Attempt, 'triage'>): Triage | null {
  const triage: unknown = a.triage;
  if (!isRecord(triage) || typeof triage.summary !== 'string' || triage.summary.trim() === '') return null;
  return triage as unknown as Triage;
}

/** The filter an attempt falls under: its category's words, "Other" for a category this build doesn't know, or "Not sorted yet". */
export function categoryLabel(a: Pick<Attempt, 'triage'>): string {
  const triage = triageOf(a);
  if (triage === null) return NOT_SORTED;
  return Object.hasOwn(CATEGORY_COPY, triage.category) ? CATEGORY_COPY[triage.category] : CATEGORY_COPY.other;
}

/** Safety's headline, in Claude's voice, for the `n` requests the kernel refused in the last seven days. */
export function turnedDownHeadline(n: number): string {
  if (n === 0) return "I didn't turn down any requests this week.";
  return n === 1 ? 'I turned down 1 request this week.' : `I turned down ${n} requests this week.`;
}

/**
 * Whether anything was stopped in the last seven days, as Today's "Last 7 days" frames them: a
 * request the kernel refused or a draft of Claude's the reply check stopped, by its `created_at`'s
 * local date in the week's time zone, from `start` on. An attempt newer than the week Today last
 * read (just past midnight, or with the clocks apart) counts too, and so does one whose time can't
 * be read, which may be this week's: the week is never said to have stopped nothing when it may
 * have. A hold is the one kind that isn't stopped, so a kind this build doesn't know yet counts.
 */
export function anythingStoppedIn(attempts: readonly Pick<Attempt, 'kind' | 'created_at'>[], week: Pick<ThisWeek, 'timezone' | 'start'>): boolean {
  return attempts.some((a) => a.kind !== 'held' && maybeThisWeek(a, week));
}

/**
 * Whether a request may have been turned down in the last seven days, by the same clock as
 * `anythingStoppedIn`: a refused request this week (or newer than the week Today last read, or at
 * a time that can't be read), or a kind this build doesn't know yet. A draft of Claude's the reply
 * check stopped is no request anyone made, and a hold isn't turned down, so neither counts; the
 * week is never said to have turned nothing down when it may have.
 */
export function anythingTurnedDownIn(attempts: readonly Pick<Attempt, 'kind' | 'created_at'>[], week: Pick<ThisWeek, 'timezone' | 'start'>): boolean {
  return attempts.some((a) => a.kind !== 'held' && a.kind !== 'reply_blocked' && maybeThisWeek(a, week));
}

/** An attempt from `week.start` on, by its `created_at`'s local date in the week's time zone, or at a time that can't be read. */
function maybeThisWeek(a: Pick<Attempt, 'created_at'>, week: Pick<ThisWeek, 'timezone' | 'start'>): boolean {
  const date = localDate(a.created_at, week.timezone);
  return date === null || date >= week.start;
}
