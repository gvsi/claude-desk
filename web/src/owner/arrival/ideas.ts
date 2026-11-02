/**
 * What the demo suggests trying: the five things Today's "Things to try" counts and the intro dialog
 * lists (`INTRO_THINGS`), in the same order, "Watch a demo visitor" second; each of Today's rows
 * with the line it says once it's done. "Show me ideas" offers `breakItIdeas`
 * (`web/src/lib/breakItIdeas.ts`), in the Desk's own owner's name, which the public page shares.
 */
import type { IconName, IntroThing } from '../../ds/index.ts';
import type { UncountedAnswer } from './doneSignals.ts';

export interface ThingToTry {
  title: string;
  detail: string;
  icon: IconName;
  /** What Today's list says in the row once it's done. */
  done: string;
}

/**
 * In order, the four of Today's "Things to try" besides "Watch a demo visitor" (`DEMO_VISITOR_THING`,
 * second on Today and in the intro dialog), each with its intro dialog line and its done line.
 */
export const THINGS_TO_TRY = [
  { title: 'Chat as a customer', detail: 'Turner’s public page opens in a new tab.', icon: 'person', done: 'Done. You chatted as a customer.' },
  { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety', done: 'Done. Safety shows what was stopped.' },
  { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check', done: "Done. Your answer went to the visitor's chat." },
  { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus', done: 'Done. Your new Desk is live.' },
] as const satisfies readonly ThingToTry[];

/** The demo visitor's line in the intro dialog: the first sentence of its card's, as the dialog's details keep to one line. */
const DEMO_VISITOR_SHORT = 'An AI plays a customer on your Desk.';

/**
 * Today's "Watch a demo visitor", the second of its things to try and of the intro dialog's: an AI
 * plays a customer in a chat on the owner's own Desk, so the owner can take it over or whisper to
 * Claude while it chats. Its done row keeps these words, with its Done pill read out.
 */
export const DEMO_VISITOR_THING = {
  title: 'Watch a demo visitor',
  detail: `${DEMO_VISITOR_SHORT} Take over or whisper to Claude while it chats.`,
  /** The intro dialog's line: the first sentence of `detail`. */
  short: DEMO_VISITOR_SHORT,
  icon: 'agent',
  start: 'Start a demo visitor',
  /** Said in the detail's place, after a refused dot, when a start fails for any reason; the button stays. */
  startFailed: 'The demo visitor couldn’t start. Try again in a few minutes.',
} as const satisfies Omit<ThingToTry, 'done'> & { short: string; start: string; startFailed: string };

const [CHAT, BREAK, ANSWER, CREATE] = THINGS_TO_TRY;

/** The intro dialog's list: the five things to try, in Today's order, each with its one-line detail. */
export const INTRO_THINGS: readonly IntroThing[] = [
  CHAT,
  { title: DEMO_VISITOR_THING.title, detail: DEMO_VISITOR_THING.short, icon: DEMO_VISITOR_THING.icon },
  BREAK,
  ANSWER,
  CREATE,
].map(({ title, detail, icon }) => ({ title, detail, icon }));

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

/**
 * The longest line "Answer a held request" can end on, whose room the row keeps while an answer
 * waits, so ending doesn't grow it. An execution refusal's own owner_plain can still run longer.
 */
export const ANSWER_ROOM: string = Object.values(UNCOUNTED_ANSWER_LINES).reduce((longest, line) =>
  line.length > longest.length ? line : longest);
