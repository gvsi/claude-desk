import type { ConversationSummary } from '../../api/views.ts';
import { formatCents, formatDayAndTime } from '../../lib/format.ts';

/** The note at the head of an owner's transcript, beside where the chat came from. */
export const TRANSCRIPT_NOTE = 'Notes from the checks sit under each message. Select one for the full trace.';

/** The head's "Latest" line once a booking ran and its booked card was shown: what got done, not the check. */
export const LATEST_VISIT_BOOKED = 'Visit booked';

/** The head's "Latest" line once a deposit was paid and its charge or payment card was shown. */
export const LATEST_DEPOSIT_PAID = 'Deposit paid';

/** A recorded refusal, using the same words as Today and Safety. */
export const TURNED_DOWN = 'Turned down';

/** Visitor outcomes in the Conversations list. */
export const VISITOR_QUOTED = 'Quoted';
export const VISITOR_LEAD_CAPTURED = 'New lead';
export const VISITOR_OWNER_DECLINED = 'You declined';
export const VISITOR_DOCUMENT_SENT = 'Verified · Invoice sent';
export const VISITOR_VISIT_BOOKED = 'Booked';
/** A visitor row whose visitor hasn't written yet, in the open chat's own words. */
export const VISITOR_NO_MESSAGES = 'No messages yet';
export const visitorCalledBack = (ownerFirstName: string): string => `${ownerFirstName} called back`;

/** An agent's row line when a request was refused for asking more than its signed limit. */
export const AGENT_OVER_LIMIT = 'Asked to pay more than its limit, and was turned down.';
/** An agent's row line when a request was refused for any other reason, or one not known. */
export const AGENT_TURNED_DOWN = 'A request was turned down.';

/**
 * What an agent did, for its row in the Conversations list, where a visitor's own words would
 * sit: built from its confirmed outcome and the facts the API read behind it, never the agent's
 * words. "Booked Mon, Nov 2, 10:00 am." on the business's clock, "Paid $20 up front.",
 * or why its last request was turned down. Null with no outcome, an outcome only a visitor's chat
 * has, or a fact it needs missing, so the row has no line rather than a guess.
 */
export function agentLine(
  s: Pick<ConversationSummary, 'latest_outcome' | 'latest_outcome_starts_at' | 'latest_outcome_cents' | 'latest_outcome_cause'>,
  timeZone: string,
): string | null {
  switch (s.latest_outcome) {
    case 'visit_booked': {
      const when = s.latest_outcome_starts_at == null ? '' : formatDayAndTime(s.latest_outcome_starts_at, timeZone);
      return when === '' ? null : `Booked ${when}.`;
    }
    case 'deposit_paid':
      return s.latest_outcome_cents == null ? null : `Paid ${formatCents(s.latest_outcome_cents)} up front.`;
    case 'turned_down':
      return s.latest_outcome_cause === 'agent_limit' ? AGENT_OVER_LIMIT : AGENT_TURNED_DOWN;
    default:
      return null;
  }
}
