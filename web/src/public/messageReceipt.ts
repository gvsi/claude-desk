import type { EvMessage } from '../api/contracts.ts';

/**
 * Whether this view shows a delivered message's own receipt. Kernel reply_check.finalize
 * renders reply_checked for a passed reply when no other key was given; only the owner's
 * messages supply a key (owner_said or owner_say_blocked). The API sets handoff = !verdict.ok,
 * so author !== 'owner' && handoff === false identifies the reply check without reading its words.
 * Only the owner's own preview keeps that line, identified by how the chat was opened;
 * previews are visitor sessions too. The API grants previews only to the signed-in owner.
 * Showing the line at a preview address without that grant is harmless: it isn't secret.
 * Every other receipt stays verbatim.
 */
export function messageReceiptVisible(message: Pick<EvMessage, 'author' | 'handoff'>, ownerPreview: boolean): boolean {
  return ownerPreview || !(message.author !== 'owner' && message.handoff === false);
}
