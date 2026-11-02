import type { ConversationSummary } from '../../api/views.ts';
import { formatCents, formatDayAndTime } from '../../lib/format.ts';
import { afterName, firstName } from '../../lib/names.ts';
import { givenOwnerName } from '../../public/brand.ts';

/** The note at the head of an owner's transcript, beside where the chat came from. */
export const TRANSCRIPT_NOTE = 'Notes from the checks sit under each message. Select one for the full trace.';

/**
 * The take-over box's example, written as the owner would to the visitor: "Hi, it's Mike. What time
 * suits you?", in the first name of `owner_display_name`, or the business's name when the
 * owner gave none (an empty name, or setup's fallback "Owner"). A name that ends in a full stop
 * ("Acme Inc.") ends the sentence itself.
 */
export function takeOverPlaceholder(ownerDisplayName: string, businessName: string): string {
  const given = givenOwnerName(ownerDisplayName);
  const first = given === null ? '' : firstName(given).trim();
  const name = first === '' ? businessName : first;
  return `Hi, it's ${name}${afterName(name, '. What time suits you?')}`;
}

/** The line under the take-over box: the visitor reads the owner's words as they are. */
export const TAKE_OVER_HELPER = 'They see your words exactly as you write them.';

/** The whisper box's example on the plumbing demo (the copy's starting sample Desk). */
export const WHISPER_PLACEHOLDER_SAMPLE = 'Ask if the leak is under the sink';

/** The whisper box's example on every other Desk, which fits any business. */
export const WHISPER_PLACEHOLDER = "Ask what they've tried so far";

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

/**
 * The whisper box's line: Claude reads a whisper in its next reply, which runs while the visitor
 * is in the chat, or else when they next write. `name` is the one the conversation's bar shows,
 * null when it has none. The owner's preview is never an agent.
 */
export function whisperHelper(name: string | null, here: boolean, agent: boolean): string {
  const who = name ?? (agent ? 'The agent' : 'The visitor');
  return here
    ? `${who} is in the chat now. Claude will use your whisper in its reply right away.`
    : `${who} isn't in the chat now. Claude will use your whisper when ${agent ? 'it next writes' : 'they next write'}.`;
}

/**
 * The note over a demo visitor's conversation (an AI the owner started to play a customer): while it
 * runs, what it is and what to try, with Stop; once it ends, how it ended. Stopped by the owner is
 * said so; a failure or the day's model budget stopped it early; every other ending (its goal met,
 * the owner quiet, its limits, the chat closed, or a run the API no longer keeps) is "finished".
 */
export const DEMO_VISITOR_NOTE = {
  running: 'A demo visitor, played by an AI. Take over or whisper to see how Claude responds.',
  stop: 'Stop the demo visitor',
  finished: 'The demo visitor finished.',
  stopped: 'You stopped the demo visitor.',
  stoppedEarly: 'The demo visitor stopped early.',
} as const;

/** The head's pill, and the row's, on a demo visitor's conversation. */
export const DEMO_VISITOR_PILL = 'Demo visitor';

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
