/**
 * Which handoff a `desk_data` record entry is about, as the kernel writes them (plan 01b), all with
 * `part: "handoffs"`: the handoff card handing a conversation to the owner (`kind: "card"`); the
 * owner marking a handoff done, a call-back request's or a card's (nothing more); and the kernel
 * closing an open one because a call-back request replaced it (`replaced_by`, the call-back's
 * handoff), the owner took the chat over (`closed_by: "takeover"`), the owner wrote in it
 * (`closed_by: "owner_message"`) or the visitor booked a time in it (`closed_by: "booking"`, a
 * card's handoff only). A call-back request opening its handoff writes no `desk_data` entry. The
 * owner's record rows name the entries from this one rule, and the design system's trace reads it
 * too.
 */
import type { LedgerEvent } from './contracts.ts';

export type HandoffEntry = 'opened' | 'done' | 'replaced' | 'took_over' | 'wrote' | 'booked';

/** The kernel's `closed_by` values, by the entry each names. */
const CLOSED_BY: Readonly<Record<string, HandoffEntry>> = { takeover: 'took_over', owner_message: 'wrote', booking: 'booked' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `opened` for a card handing a conversation over, `done` for a handoff the owner marked done,
 * `replaced`, `took_over`, `wrote` or `booked` for one the kernel closed, and null for every other
 * entry: a handoffs entry with a null or unknown `kind` or closing, or with two, among them, so a
 * closing this build doesn't know is never called the owner's.
 */
export function handoffEntryOf(event: Pick<LedgerEvent, 'kind' | 'summary'>): HandoffEntry | null {
  const { summary } = event;
  if (event.kind !== 'desk_data' || !isRecord(summary) || summary.part !== 'handoffs') return null;
  const keys = ['kind', 'replaced_by', 'closed_by'].filter((key) => Object.hasOwn(summary, key));
  if (keys.length === 0) return 'done';
  if (keys.length > 1) return null;
  if (keys[0] === 'kind') return summary.kind === 'card' ? 'opened' : null;
  if (keys[0] === 'replaced_by') return typeof summary.replaced_by === 'string' ? 'replaced' : null;
  const closedBy = summary.closed_by;
  return typeof closedBy === 'string' && Object.hasOwn(CLOSED_BY, closedBy) ? (CLOSED_BY[closedBy] ?? null) : null;
}

export type TakeoverEntry = 'takeover' | 'handback';

/** The recorded direction of a mode change; null when the summary doesn't identify one. */
export function takeoverEntryOf(event: Pick<LedgerEvent, 'kind' | 'summary'>): TakeoverEntry | null {
  const { summary } = event;
  if (event.kind !== 'takeover' || !isRecord(summary)) return null;
  if (summary.from === 'ai' && summary.to === 'owner') return 'takeover';
  if (summary.from === 'owner' && summary.to === 'ai') return 'handback';
  return null;
}
