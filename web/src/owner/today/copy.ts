/**
 * Today's words for a Desk whose setup isn't finished, as the signed board writes them
 * (UXC-P1101-After): the card that leads the owner back into the interview. The setup steps' names
 * are setup's own (`STEP_NAMES`).
 */
import type { SetupStep } from '../../api/views.ts';

export const CONTINUE_SETUP_COPY = {
  notLive: 'Not live yet',
  /** Before the business's name, which is the owner's own words. */
  title: 'Finish setting up ',
  action: 'Continue setup',
  stepsLabel: 'Setup steps',
} as const;

/**
 * What the card says under its title, by the step setup stopped at: where the owner picks up, and
 * that Answering stays off until the Desk is live. A Desk that is live has no card, so no line.
 */
export const CONTINUE_SETUP_LINES: Readonly<Record<Exclude<SetupStep, 'live'>, string>> = {
  questions: 'Your answers are saved. Pick up at the questions. Answering stays off until your Desk is live.',
  tools: 'Your answers are saved. Pick up at your tools. Answering stays off until your Desk is live.',
  rules: "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
  situations:
    "Your answers are saved. Pick up at your rules, and I'll check them again before anything goes live. Answering stays off until then.",
  safety_check:
    "Your answers are saved. Pick up at the safety check, and I'll check your rules again before anything goes live. Answering stays off until then.",
  preview: 'Your answers are saved. Pick up at going live. Answering stays off until then.',
};
