/**
 * The line beside a conversation's title that says what happened last ("Latest: …"), as the
 * owner reads it on the conversation's page.
 */
import type { EvMessage } from '../../api/contracts.ts';
import type { OwnerTranscriptItem } from '../../api/views.ts';
import { LATEST_DEPOSIT_PAID, LATEST_VISIT_BOOKED } from './copy.ts';

/** The cards that report a task done, each with the owner's words for that task. */
const DONE: Readonly<Partial<Record<string, string>>> = {
  booking_confirmed: LATEST_VISIT_BOOKED,
  charge_confirmed: LATEST_DEPOSIT_PAID,
  payment_confirmed: LATEST_DEPOSIT_PAID,
};

/**
 * The task a checked message reports done, in the owner's words, or null. It needs a card that
 * reports the task done and an action that ran for it: a status of the turn, before the message,
 * that says it was executed. A draft the check stopped and Claude rewrote stays in the same turn,
 * so the scan steps over it. A request, a hold or a refusal ran nothing. A payment card
 * is the one exception: only the kernel issues it, as the Desk's own message, once the checkout
 * it completed has paid, so that message is itself the record that the payment ran. A message
 * that hands the chat to the owner reports no task done: the handoff is what happened last.
 */
function doneIn(items: readonly OwnerTranscriptItem[], index: number, message: EvMessage): string | null {
  if (message.handoff || message.blocks.some((block) => block.kind === 'card' && block.template === 'handoff')) return null;
  const card = message.blocks.filter((block) => block.kind === 'card' && DONE[block.template ?? ''] !== undefined).at(-1);
  const words = card === undefined ? undefined : DONE[card.template ?? ''];
  if (card === undefined || words === undefined) return null;
  if (card.template === 'payment_confirmed' && message.author === 'desk') return words;
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'stopped_draft') continue;
    if (item?.kind !== 'status') break;
    if (item.event !== null && 'state' in item.event && item.event.state === 'executed') return words;
  }
  return null;
}

/**
 * The kernel's line for the action that ran just before Claude's checked reply, in its turn, or
 * null: the receipt's own words for what was done ("Quoted from Mike Turner's price list"), so the
 * line names the action rather than the reply's check. Only the status nearest the reply counts, so
 * a hold or refusal after the action isn't hidden behind it. A draft the check stopped and Claude
 * rewrote stays in the turn, so the scan steps over it. A reply that hands the chat to the owner
 * names no action: the handoff is what happened last. The owner's and the Desk's own messages are
 * theirs, not an action's. The turn is read from the items the owner's transcript shows: a status
 * counts when nothing shown comes between it and the reply.
 */
function actionBefore(items: readonly OwnerTranscriptItem[], index: number, message: EvMessage): string | null {
  if (message.author !== 'claude') return null;
  if (message.handoff || message.blocks.some((block) => block.kind === 'card' && block.template === 'handoff')) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'stopped_draft') continue;
    if (item?.kind !== 'status' || item.event === null || !('state' in item.event)) return null;
    return item.event.state === 'executed' ? item.event.visitor_plain : null;
  }
  return null;
}

/**
 * What happened last in the chat: the task its newest message reports done, else the action that
 * ran just before its newest checked reply, else the kernel's line for its newest receipt or
 * message. Where the owner joined or left carries no line of the kernel's, so it is passed over.
 */
export function latestOf(items: readonly OwnerTranscriptItem[]): string | null {
  const ordered = [...items].sort((a, b) => a.n - b.n);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i];
    if (item === undefined) continue;
    const { event, owner_plain: ownerPlain } = item;
    if (event === null || !('visitor_plain' in event)) continue;
    if (event.type === 'message') return doneIn(ordered, i, event) ?? actionBefore(ordered, i, event) ?? event.visitor_plain;
    return event.state === 'refused_at_execution' && ownerPlain != null ? ownerPlain : event.visitor_plain;
  }
  return null;
}
