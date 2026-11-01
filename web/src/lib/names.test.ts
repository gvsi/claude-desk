import { expect, it } from 'vitest';

import { afterName } from './names.ts';

it('drops only a leading period after a name that already ends a sentence', () => {
  const cases = [
    ['Chen & Co.', '. Ask for Linda anytime.', ' Ask for Linda anytime.'],
    ['Acme!', '. Ask for Linda anytime.', ' Ask for Linda anytime.'],
    ['Who?', '. Ask for Linda anytime.', ' Ask for Linda anytime.'],
    ['Chen & Co. \t\n', '. Ask for Linda anytime.', ' Ask for Linda anytime.'],
    ['Rivera Plumbing', '. Ask for Linda anytime.', '. Ask for Linda anytime.'],
    ['Chen & Co. CPA', '. Ask for Linda anytime.', '. Ask for Linda anytime.'],
    ['', '. Ask for Linda anytime.', '. Ask for Linda anytime.'],
    ['Chen & Co.', ' Ask for Linda anytime.', ' Ask for Linda anytime.'],
    ['Chen & Co.', ' . Ask for Linda anytime.', ' . Ask for Linda anytime.'],
    ['Chen & Co.', '.. Ask for Linda anytime.', '. Ask for Linda anytime.'],
    ['Chen & Co.', '', ''],
  ] as const;

  for (const [name, rest, expected] of cases) {
    expect(afterName(name, rest), JSON.stringify([name, rest])).toBe(expected);
  }
});
