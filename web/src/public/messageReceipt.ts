import type { EvMessage } from '../api/contracts.ts';

/**
 * Whether this view shows a delivered message's own receipt. The API sets handoff exactly when
 * the shown blocks include the handoff clause, whose receipt is reply_handed_off. Other replies
 * use reply_checked, including checked cards kept when a draft's prose failed; only the owner's
 * messages supply owner_said or owner_say_blocked. So author !== 'owner' && handoff === false
 * identifies the plain reply check without reading its words. Strangers don't see that line.
 * Only the owner's own preview keeps that line, identified by how the chat was opened;
 * previews are visitor sessions too. The API grants previews only to the signed-in owner.
 * Showing the line at a preview address without that grant is harmless: it isn't secret.
 * Every other receipt stays verbatim.
 */
export function messageReceiptVisible(message: Pick<EvMessage, 'author' | 'handoff'>, ownerPreview: boolean): boolean {
  return ownerPreview || !(message.author !== 'owner' && message.handoff === false);
}
