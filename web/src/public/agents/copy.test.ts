/**
 * The agents page's own words. The send panel states the built-in agent's spending limit as static
 * copy, never formatted from a number, so this test ties its amounts to the Rivera seed's mandate.
 */
import { describe, expect, it } from 'vitest';

import { rivera } from '../../ds/fixtures/index.ts';
import { AGENTS_COPY } from './copy.ts';

/** The dollar amounts a line states, in cents, in the order it states them. */
function centsIn(line: string): number[] {
  return [...line.matchAll(/\$(\d+)(?![\d.,])/g)].map((match) => Number(match[1]) * 100);
}

describe('agents page copy', () => {
  it('limits_line_matches_the_seed', () => {
    const { mandate } = rivera.demoAgentIssued;
    for (const language of ['en', 'es'] as const) {
      const line = AGENTS_COPY[language].sendLead('Rivera Plumbing');
      expect(centsIn(line), language).toEqual([mandate.per_charge_cents, mandate.total_cents]);
      expect(line, language).toContain('Rivera Plumbing');
      expect(line, language).toContain(mandate.on_behalf_of ?? '');
    }
  });
});
