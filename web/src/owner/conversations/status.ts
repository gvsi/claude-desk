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
 * A conversation's state, first match: something held for the owner, the owner in the chat, a
 * chat paused after blocked attempts, the owner's own preview, an agent, a verified customer, a
 * visitor. `held` is how many of its requests are held now.
 */
export function conversationStatus(s: ConversationSummary, held: number): ConversationStatus {
  if (held > 0) return { tone: 'held', text: 'Needs you' };
  if (s.mode === 'owner') return { tone: 'info', text: "You're in this chat" };
  if (s.mode === 'paused') return { tone: 'held', text: 'Paused after blocked attempts' };
  if (s.owner_preview) return { tone: 'info', text: 'Your own preview' };
  if (s.kind === 'agent') return { tone: 'info', text: 'Agent' };
  if (s.verified) return { tone: 'handled', text: 'Verified customer' };
  return { tone: 'handled', text: 'Visitor' };
}

/**
 * Who the conversation is with: "Your preview" for the owner's own, else the name on record or
 * given (a visitor may have typed it, so it renders as their text), else what they are.
 */
export function whoLabel(s: ConversationSummary): string {
  if (s.owner_preview) return 'Your preview';
  const name = s.display_name?.trim();
  if (name) return s.display_name ?? name;
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
