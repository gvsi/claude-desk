/**
 * What the demo suggests trying: the four things the intro dialog lists (and Today's own list
 * titles, with the line each row says once it's done). "Show me ideas" offers `breakItIdeas`
 * (`web/src/lib/breakItIdeas.ts`), in the Desk's own owner's name, which the public page shares.
 */
import type { IconName } from '../../ds/index.ts';
import type { UncountedAnswer } from './doneSignals.ts';

export interface ThingToTry {
  title: string;
  detail: string;
  icon: IconName;
  /** What Today's list says in the row once it's done. */
  done: string;
}

/** In order: the intro dialog's list, and the titles of Today's "Things to try". */
export const THINGS_TO_TRY = [
  { title: 'Chat as a customer', detail: 'Rivera’s public page opens in a new tab.', icon: 'person', done: 'Done. You chatted as a customer.' },
  { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety', done: 'Done. Safety shows what was stopped.' },
  { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check', done: "Done. Your answer went to the visitor's chat." },
  { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus', done: 'Done. Your new Desk is live.' },
] as const satisfies readonly ThingToTry[];

/**
 * What "Answer a held request" says once an answer given on Today settles a request the list doesn't
 * count, in the card's own words: the request had expired or been cancelled first, so nothing was
 * done; or, on a Desk besides the one the copy started with, the answer went through (the row's
 * done line), or it ended otherwise, said exactly as the card says it. An execution refusal uses
 * the decision's owner_plain when present; this table supplies its fallback.
 */
export const UNCOUNTED_ANSWER_LINES = {
  expired: 'Expired before you answered. Nothing was done.',
  cancelled: 'Cancelled before you answered. Nothing was done.',
  answered: THINGS_TO_TRY[2].done,
  failed: "You allowed this, but it didn't go through. Nothing was done.",
  unknown: 'You allowed this. Still confirming whether it went through.',
  refused_at_execution: "Your rules changed before this ran, so it wasn't done.",
} as const satisfies Record<UncountedAnswer, string>;
