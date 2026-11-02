/**
 * How the owner's lists name a conversation and its state: one table for every list (Today's
 * "Live now", Conversations), and where a conversation's page is.
 */
import type { ConversationSummary } from '../../api/views.ts';
import type { StatusTone } from '../../ds/index.ts';
import { OWNER_NAME_FALLBACK } from '../../public/brand.ts';
import {
  LATEST_DEPOSIT_PAID, LATEST_VISIT_BOOKED, TURNED_DOWN,
  VISITOR_QUOTED, VISITOR_LEAD_CAPTURED, VISITOR_OWNER_DECLINED,
  VISITOR_DOCUMENT_SENT, VISITOR_NO_MESSAGES, VISITOR_VISIT_BOOKED, visitorCalledBack,
} from './copy.ts';

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

/** The name `whoLabel` shows for the conversation, or null when it says what they are instead. */
export function nameOf(s: ConversationSummary): string | null {
  return !s.owner_preview && hasName(s) ? s.display_name : null;
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


/** Only Conversations shows stored outcomes; Today keeps the shared identity/attention line. */
export function conversationListStatus(s: ConversationSummary, held: number, openHandoff = false, ownerFirstName?: string): ConversationStatus | null {
  const attention = attentionStatus(s, held, openHandoff);
  if (attention !== null) return attention;
  const status = conversationStatus(s, held, openHandoff);
  if (s.owner_preview) return status;
  if (s.kind === 'visitor') {
    const outcomes: Partial<Record<NonNullable<ConversationSummary['latest_outcome']>, ConversationStatus | undefined>> = {
      quoted: { tone: 'handled', text: VISITOR_QUOTED },
      turned_down: { tone: 'info', text: TURNED_DOWN },
      lead_captured: { tone: 'info', text: VISITOR_LEAD_CAPTURED },
      owner_declined: { tone: 'info', text: VISITOR_OWNER_DECLINED },
      // Setup's stand-in for an owner who gave no name isn't a name to call back with.
      called_back: ownerFirstName && ownerFirstName !== OWNER_NAME_FALLBACK ? { tone: 'handled', text: visitorCalledBack(ownerFirstName) } : undefined,
      deposit_paid: { tone: 'handled', text: LATEST_DEPOSIT_PAID },
      document_sent: s.verified ? { tone: 'handled', text: VISITOR_DOCUMENT_SENT } : undefined,
      visit_booked: { tone: 'handled', text: VISITOR_VISIT_BOOKED },
    };
    const outcome = s.latest_outcome != null && Object.hasOwn(outcomes, s.latest_outcome) ? outcomes[s.latest_outcome] : undefined;
    if (outcome !== undefined) return outcome;
    // A visitor who opened the page but hasn't written yet. A reply without the field draws the row as before.
    if (s.latest_visitor_text === null || s.latest_visitor_text?.trim() === '') return { tone: 'info', text: VISITOR_NO_MESSAGES };
    return status;
  }
  const words: Partial<Record<NonNullable<ConversationSummary['latest_outcome']>, string>> = {
    visit_booked: LATEST_VISIT_BOOKED, deposit_paid: LATEST_DEPOSIT_PAID, turned_down: TURNED_DOWN };
  const outcome = s.latest_outcome == null ? undefined : words[s.latest_outcome];
  return s.kind === 'agent' && (status === null || status.text === 'Agent') && outcome !== undefined
    ? { tone: 'info', text: `Agent · ${outcome}` }
    : status;
}
