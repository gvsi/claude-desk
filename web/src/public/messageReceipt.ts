import type { EvMessage, SessionState } from '../api/contracts.ts';

/**
 * Whether this session sees a delivered message's own receipt. Kernel reply_check.finalize
 * renders reply_checked for a passed reply when no other key was given; only the owner's
 * messages supply a key (owner_said or owner_say_blocked). The API sets handoff = !verdict.ok,
 * so author !== 'owner' && handoff === false identifies the reply check without reading its words.
 * Only owner sessions keep that line (including previews); every other receipt stays verbatim.
 */
export function messageReceiptVisible(message: Pick<EvMessage, 'author' | 'handoff'>, kind: SessionState['kind'] | undefined): boolean {
  return kind === 'owner' || !(message.author !== 'owner' && message.handoff === false);
}
