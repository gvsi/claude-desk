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
