/**
 * Safety's words and the few rules behind them: what each kind of record entry is called, where an
 * entry came from, what an attempt was about, which checkpoint stopped it, the one entry an attempt
 * is shown with, the one time an entry shows, and whether the week stopped anything at all.
 */
import type { LedgerEntry, LedgerEvent, LedgerPage } from '../../api/contracts.ts';
import type { Attempt, ThisWeek, Triage, TriageCategory } from '../../api/views.ts';
import type { Checkpoint } from '../../ds/index.ts';
import { localDate } from '../../lib/format.ts';

/** Known record entries, as a row names them; newer kinds keep the generic fallback below. */
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
} as const satisfies Partial<Record<LedgerEvent['kind'], string>>;

/**
 * Where an entry came from, the same words on every row, detail and trace: the checkpoint wrote it,
 * or the chat service reported it and the checkpoint recorded the report unchecked.
 */
export const ORIGIN_COPY = {
  kernel: 'Recorded by the checkpoint',
  api: 'Reported by the chat service, not checked by the checkpoint',
} as const satisfies Record<LedgerEvent['origin'], string>;

/** What an attempt was about, by its triage category. Two categories share "Money". */
export const CATEGORY_COPY = {
  impersonation: 'Posing as you',
  discount_push: 'Money',
  over_limit: 'Money',
  private_data: 'Private data',
  code_redirect: 'Codes',
  injection: 'Hidden instructions',
  other: 'Other',
} as const satisfies Record<TriageCategory, string>;

/** An attempt Claude hasn't sorted into a category yet. */
export const NOT_SORTED = 'Not sorted yet';

/** Each category's words once, in `CATEGORY_COPY`'s order: one filter each. */
export const CATEGORY_LABELS: readonly string[] = [...new Set(Object.values(CATEGORY_COPY))];

/** An entry replayed from the recorded history into this copy. */
export const REPLAYED_LABEL = 'Recorded history, replayed into your copy';

/** Where an entry came from, in `ORIGIN_COPY`'s words. Anything but the checkpoint reads as reported, never as checked. */
export function originCopy(origin: string): string {
  return origin === 'kernel' ? ORIGIN_COPY.kernel : ORIGIN_COPY.api;
}

/** A kind of entry's name; a kind this build doesn't know is named as plainly as it can be. */
export function kindCopy(kind: string): string {
  return Object.hasOwn(LEDGER_KIND_COPY, kind) ? LEDGER_KIND_COPY[kind as keyof typeof LEDGER_KIND_COPY] : 'Other entry';
}

/** The checkpoint that stopped an attempt: a blocked reply at the reply checkpoint, anything else at the action checkpoint. */
export function stoppedBy(a: Pick<Attempt, 'kind'>): Checkpoint {
  return a.kind === 'reply_blocked' ? 'reply' : 'action';
}

/** The entry an attempt is shown with: the one whose `seq` is its `ledger_seq`, or null when the page doesn't hold it. */
export function entryFor(a: Pick<Attempt, 'ledger_seq'>, page: Pick<LedgerPage, 'entries'> | undefined): LedgerEntry | null {
  return page?.entries.find((entry) => entry.seq === a.ledger_seq) ?? null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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

/** Safety's headline, in Claude's voice, for `n` attempts stopped in the last seven days. */
export function stoppedHeadline(n: number): string {
  return n === 1 ? '1 attempt to talk me around was stopped this week.' : `${n} attempts to talk me around were stopped this week.`;
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
  return attempts.some((a) => {
    if (a.kind === 'held') return false;
    const date = localDate(a.created_at, week.timezone);
    return date === null || date >= week.start;
  });
}
