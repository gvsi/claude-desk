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
      // The panel's one line with amounts: the signed limit, $20 a charge and $100 in total.
      const copy = AGENTS_COPY[language];
      expect(centsIn(copy.limitLine), language).toEqual([mandate.per_charge_cents, mandate.total_cents]);
      expect(copy.limitLine, language).toContain(mandate.on_behalf_of ?? '');
      // The lead names the business and who the agent visits for, and states no amount.
      const lead = copy.sendLead('Rivera Plumbing');
      expect(lead, language).toContain('Rivera Plumbing');
      expect(lead, language).toContain(mandate.on_behalf_of ?? '');
      expect(centsIn(lead), language).toEqual([]);
    }
  });
});
