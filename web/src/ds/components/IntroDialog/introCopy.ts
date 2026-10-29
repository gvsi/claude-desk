/**
 * What the intro dialog says when starting the demo fails. The web app maps the passcode route's
 * answer to one of these codes; the dialog shows the line, never the code.
 */

/** Why the demo didn't start: a wrong passcode, too many tries, or the API couldn't be reached. */
export type IntroErrorCode = 'wrong_passcode' | 'rate_limited' | 'unreachable';

/** One plain line per code, with the next step. A code added without a line is a compile error. */
export const INTRO_ERROR_COPY = {
  wrong_passcode: 'That passcode didn’t work. Check the message that shared this link, then try again.',
  rate_limited: 'That’s a lot of tries. Wait a while, then try again.',
  unreachable: 'We couldn’t reach the demo. Try again in a moment.',
} as const satisfies Record<IntroErrorCode, string>;
