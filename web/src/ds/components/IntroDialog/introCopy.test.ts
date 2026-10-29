import { describe, expect, it } from 'vitest';

import { INTRO_ERROR_COPY, type IntroErrorCode } from './introCopy';

/** Every code the web app can pass as `error`, written out so a new one has to be added here too. */
const CODES: readonly IntroErrorCode[] = ['wrong_passcode', 'rate_limited', 'unreachable'];

/**
 * What a line gives away: any code, written with underscores, spaces or hyphens and in any case,
 * and any HTTP status number.
 */
function shownCodes(text: string): string[] {
  const lower = text.toLowerCase();
  const codes = CODES.filter((code) => [code, code.replaceAll('_', ' '), code.replaceAll('_', '-')].some((form) => lower.includes(form)));
  return [...codes, ...(text.match(/\b[1-5]\d\d\b/g) ?? [])];
}

describe('intro dialog copy', () => {
  it('every_intro_error_has_copy', () => {
    expect(Object.keys(INTRO_ERROR_COPY).sort()).toEqual([...CODES].sort());
    for (const code of CODES) expect(INTRO_ERROR_COPY[code].trim(), code).not.toBe('');
    // The lines themselves, word for word.
    expect(INTRO_ERROR_COPY).toEqual({
      wrong_passcode: 'That passcode didn’t work. Check the message that shared this link, then try again.',
      rate_limited: 'That’s a lot of tries. Wait a while, then try again.',
      unreachable: 'We couldn’t reach the demo. Try again in a moment.',
    });
  });

  it('intro_copy_never_shows_a_code', () => {
    // The matcher finds a code however it is written, so the check below can't pass by matching nothing.
    expect(shownCodes('Error: wrong_passcode')).toEqual(['wrong_passcode']);
    expect(shownCodes('Rate Limited (429)')).toEqual(['rate_limited', '429']);
    expect(shownCodes('The demo is unreachable.')).toEqual(['unreachable']);
    expect(shownCodes('Wrong-passcode')).toEqual(['wrong_passcode']);

    const lines = Object.values(INTRO_ERROR_COPY);
    expect(lines).toHaveLength(CODES.length);
    expect(lines.filter((line) => shownCodes(line).length > 0)).toEqual([]);
  });
});
