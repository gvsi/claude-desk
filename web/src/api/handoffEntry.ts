/**
 * Which handoff a `desk_data` record entry is about, as the kernel writes them (plan 01b): the
 * handoff card handing a conversation to the owner (`part: "handoffs"`, `kind: "card"`), and the
 * owner marking a handoff done, a call-back request's or a card's (`part: "handoffs"`, no `kind`).
 * A call-back request opening its handoff writes no `desk_data` entry. The owner's record rows name
 * the two entries from this one rule, and the design system's trace will read it too.
 */
import type { LedgerEvent } from './contracts.ts';

export type HandoffEntry = 'opened' | 'done';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `opened` for a card handing a conversation over, `done` for a handoff the owner marked done, and
 * null for every other entry, a handoffs entry with a null or unknown `kind` among them.
 */
export function handoffEntryOf(event: Pick<LedgerEvent, 'kind' | 'summary'>): HandoffEntry | null {
  const { summary } = event;
  if (event.kind !== 'desk_data' || !isRecord(summary) || summary.part !== 'handoffs') return null;
  if (!Object.hasOwn(summary, 'kind')) return 'done';
  return summary.kind === 'card' ? 'opened' : null;
}
