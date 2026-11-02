/**
 * Today's words for a Desk whose setup isn't finished, as the signed board writes them
 * (UXC-P1101-After): the card that leads the owner back into the interview. The setup steps' names
 * are setup's own (`STEP_NAMES`).
 */
import type { UnfinishedSetupStep } from '../../api/views.ts';

export const CONTINUE_SETUP_COPY = {
  notLive: 'Not live yet',
  /** Before the business's name, which is the owner's own words. */
  title: 'Finish setting up ',
  action: 'Continue setup',
  stepsLabel: 'Setup steps',
} as const;

/**
 * What the card says under its title, by the step setup stopped at: where the owner picks up
 * (`pickUp`), then, only while Answering is off, that it stays off until the Desk is live
 * (`answeringOff`). Answering is separate from setup: an owner can turn it on before setup
 * finishes. A Desk that is live has no card, so no line.
 */
export const CONTINUE_SETUP_LINES: Readonly<Record<UnfinishedSetupStep, { pickUp: string; answeringOff: string }>> = {
  questions: {
    pickUp: 'Your answers are saved. Pick up at the questions.',
    answeringOff: 'Claude takes messages only until your Desk is live.',
  },
  tools: {
    pickUp: 'Your answers are saved. Pick up at your tools.',
    answeringOff: 'Claude takes messages only until your Desk is live.',
  },
  rules: {
    pickUp: "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live.",
    answeringOff: 'Claude takes messages only until then.',
  },
  situations: {
    pickUp: "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live.",
    answeringOff: 'Claude takes messages only until then.',
  },
  safety_check: {
    pickUp: "Your answers are saved. Pick up at the safety check, and I'll check your rules again before anything goes live.",
    answeringOff: 'Claude takes messages only until then.',
  },
  preview: {
    pickUp: 'Your answers are saved. Pick up at going live.',
    answeringOff: 'Claude takes messages only until then.',
  },
};

/** The card's line for `step`: where the owner picks up, and that Answering stays off only while it is off. */
export function continueSetupLine(step: UnfinishedSetupStep, answering: boolean): string {
  const { pickUp, answeringOff } = CONTINUE_SETUP_LINES[step];
  return answering ? pickUp : `${pickUp} ${answeringOff}`;
}

/** Literal Today copy shared by the page and its word-free loading measurements. */
export const TODAY_COPY = {
  chatDetail: 'Your public page opens in a new tab. Ask about a price or a time.',
  breakBeforeOwner: "Ask for a discount, another customer's address or ",
  breakAfterOwner: "'s home number. Safety shows what was refused and why.",
  waiting: 'A request is waiting for your answer.',
  heldBy: 'Held by your rule: ',
  /** "Answer a held request" before anything is held. */
  heldNone: 'When a request waits for your answer, it shows up here.',
  createDetail: 'Describe a business in a few sentences. Claude drafts the rules, and you confirm them.',
  handledTitle: 'Handled by Claude, or by you',
  turnedDownEmpty: 'Nothing turned down in the last 7 days.',
  /** The link to the Desk's Safety page, under Turned down here and under Rules' always-on rules. */
  openSafety: 'Open Safety',
  vision: 'Vision: where a Desk could go next',
} as const;

export const handledCount = (count: number) => `Claude handled ${count}`;
export const steppedInCount = (count: number) => `You stepped in ${count} ${count === 1 ? 'time' : 'times'}`;

/**
 * "How your Desk works" on Today, as the signed board writes it: three numbered steps, each its
 * title and one line, the second naming the business as the Desk has it.
 */
export const HOW_IT_WORKS_TITLE = 'How your Desk works';

/** "Step 1" over each step's title. */
export const stepLabel = (n: number) => `Step ${n}`;

/** The three steps, in order. */
export function howItWorksSteps(business: string): readonly { title: string; line: string }[] {
  return [
    { title: 'Someone asks', line: 'A customer on your page, or their AI agent' },
    { title: 'Claude answers', line: `As ${business}, and says it's an AI` },
    { title: 'Your rules decide', line: 'Bookings, quotes, payments and documents are checked first' },
  ];
}

/** Today's counts under the steps, over the briefing's window (since last night). */
export interface TodayCounts {
  /** What Claude did on its own: the answers and the bookings. */
  handled: number;
  /** What waits for the owner now. */
  held: number;
  /** The requests the kernel refused. */
  turnedDown: number;
}

export type TodayOutcomeKind = keyof TodayCounts;

/** One outcome on the Today line: its count, and the words before and after it. */
export interface TodayOutcome {
  kind: TodayOutcomeKind;
  count: number;
  before: string;
  after: string;
}

/** The Today line: its lead and the outcomes that have a count, or one quiet line when none has. */
export type TodayOutcomesLine = { quiet: true; line: string } | { quiet: false; lead: string; parts: readonly TodayOutcome[] };

/**
 * The Today line's words, in one place: "Today, Claude", then "handled 2 on its own", "held 1 for
 * you" and "turned down 1 request" (or "3 requests"), in that order, each left out at 0; when all
 * three are 0, "Today, Claude hasn't been asked anything yet." alone.
 */
export function todayOutcomes({ handled, held, turnedDown }: TodayCounts): TodayOutcomesLine {
  const parts: TodayOutcome[] = [
    { kind: 'handled', count: handled, before: 'handled ', after: ' on its own' },
    { kind: 'held', count: held, before: 'held ', after: ' for you' },
    { kind: 'turnedDown', count: turnedDown, before: 'turned down ', after: turnedDown === 1 ? ' request' : ' requests' },
  ];
  const counted = parts.filter((part) => part.count > 0);
  if (counted.length === 0) return { quiet: true, line: "Today, Claude hasn't been asked anything yet." };
  return { quiet: false, lead: 'Today, Claude', parts: counted };
}

/** An outcome's words as one string: "handled 2 on its own". */
export const outcomeWords = ({ before, count, after }: TodayOutcome) => `${before}${count}${after}`;
