/**
 * How the owner's lists name a conversation and its state: one table for every list (Today's
 * "Live now", Conversations), and where a conversation's page is.
 */
import type { ConversationSummary } from '../../api/views.ts';
import type { StatusTone } from '../../ds/index.ts';

export interface ConversationStatus {
  tone: StatusTone;
  text: string;
}

/**
 * The part of a conversation's state that asks for the owner, first match: something held for
 * them, a chat paused after blocked attempts, an open handoff, or the owner in the chat. Null when
 * nothing does. `held` is how many of its requests are held now.
 */
export function attentionStatus(s: ConversationSummary, held: number, openHandoff = false): ConversationStatus | null {
  if (held > 0) return { tone: 'held', text: 'Needs you' };
  if (s.mode === 'paused') return { tone: 'held', text: 'Paused after blocked attempts' };
  if (openHandoff) return { tone: 'held', text: 'Wants you' };
  if (s.mode === 'owner') return { tone: 'info', text: "You're in this chat" };
  return null;
}

/**
 * A conversation's state, first match: what asks for the owner (`attentionStatus`), the owner's
 * own preview, then what they are: an agent, a verified customer, a visitor. `held` is how many of
 * its requests are held now. With no name on record or given, the name line (`whoLabel`) already
 * says what they are, so the status is left out (null) rather than say it twice.
 */
export function conversationStatus(s: ConversationSummary, held: number, openHandoff = false): ConversationStatus | null {
  const attention = attentionStatus(s, held, openHandoff);
  if (attention !== null) return attention;
  if (s.owner_preview) return { tone: 'info', text: 'Your own preview' };
  if (!hasName(s)) return null;
  if (s.kind === 'agent') return { tone: 'info', text: 'Agent' };
  if (s.verified) return { tone: 'handled', text: 'Verified customer' };
  return { tone: 'handled', text: 'Visitor' };
}

/** A name on record or given: more than spaces. */
function hasName(s: ConversationSummary): s is ConversationSummary & { display_name: string } {
  return s.display_name != null && s.display_name.trim() !== '';
}

/**
 * Who the conversation is with: "Your preview" for the owner's own, else the name on record or
 * given (a visitor may have typed it, so it renders as their text), else what they are.
 */
export function whoLabel(s: ConversationSummary): string {
  if (s.owner_preview) return 'Your preview';
  if (hasName(s)) return s.display_name;
  if (s.kind === 'agent') return 'Agent';
  if (s.verified) return 'Verified customer';
  return 'Visitor';
}

/** A conversation's page under the Desk. */
export function conversationPath(deskId: string, sessionId: string): string {
  return `/app/${encodeURIComponent(deskId)}/conversations/${encodeURIComponent(sessionId)}`;
}

/**
 * What Today hands the conversation's page when it opens it: a line to show there, such as why
 * joining the chat didn't go through.
 */
export interface ConversationArrival {
  notice: string;
}
