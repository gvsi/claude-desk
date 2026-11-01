/**
 * The agents page's own words. The send panel states the built-in agent's spending limit as static
 * copy, never formatted from a number, so this test ties its amounts to the Turner seed's mandate.
 */
import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { rivera } from '../../ds/fixtures/index.ts';
import { AGENT_START_LOST_COPY, AGENT_START_RETRY_COPY } from '../../ds/index.ts';
import { AGENTS_COPY, agentStartLostLine } from './copy.ts';

/** The words a node reads as, its elements' children included. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** The dollar amounts a line states, in cents, in the order it states them. */
function centsIn(line: string): number[] {
  return [...line.matchAll(/\$(\d+)(?![\d.,])/g)].map((match) => Number(match[1]) * 100);
}

describe('agents page copy', () => {
  it('lost_start_line_says_trying_again_is_safe', () => {
    // A lost start is retried with its key, so its line is the design system's retry-safe one, never
    // the reload line, which says a retry may run the agent twice and stays the reload fallback's.
    for (const language of ['en', 'es'] as const) {
      expect(agentStartLostLine(language), language).toBe(AGENT_START_RETRY_COPY[language]);
      expect(agentStartLostLine(language), language).not.toBe(AGENT_START_LOST_COPY[language]);
    }
  });

  it('limits_line_matches_the_seed', () => {
    const { mandate } = rivera.demoAgentIssued;
    for (const language of ['en', 'es'] as const) {
      // The signed limit panel's words: $20 a charge and $100 in total, for one hour, from Alex Kim's wallet.
      const copy = AGENTS_COPY[language];
      expect(centsIn(copy.limit.perCharge), language).toEqual([mandate.per_charge_cents]);
      expect(centsIn(copy.limit.total), language).toEqual([mandate.total_cents]);
      expect(copy.limit.duration.trim(), language).not.toBe('');
      expect(copy.limit.source, language).toContain(mandate.on_behalf_of ?? '');
      // The lead names the business and who the agent visits for, and states no amount.
      const lead = textOf(copy.sendLead('Turner Plumbing'));
      expect(lead, language).toContain('Turner Plumbing');
      expect(lead, language).toContain(mandate.on_behalf_of ?? '');
      expect(centsIn(lead), language).toEqual([]);
    }
  });
});
