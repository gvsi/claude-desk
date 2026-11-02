/**
 * An agent's line in the Conversations list: what it did, from its confirmed outcome and the facts
 * the API read behind it, in the business's time zone. Never the agent's own words.
 */
import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../../api/views.ts';
import { agentLine, takeOverPlaceholder, whisperHelper } from './copy.ts';

const LA = 'America/Los_Angeles';

type Facts = Pick<ConversationSummary, 'latest_outcome' | 'latest_outcome_starts_at' | 'latest_outcome_cents' | 'latest_outcome_cause'>;

const none: Facts = { latest_outcome: null, latest_outcome_starts_at: null, latest_outcome_cents: null, latest_outcome_cause: null };

describe('whisperHelper', () => {
  it('names_an_agent_and_uses_it_while_away_or_the_shared_line_while_here', () => {
    for (const name of [null, "Alex Kim's assistant"]) {
      const who = name ?? 'The agent';
      expect(whisperHelper(name, false, true)).toBe(`${who} isn't in the chat now. Claude will use your whisper when it next writes.`);
      expect(whisperHelper(name, true, true)).toBe(`${who} is in the chat now. Claude will use your whisper in its reply right away.`);
    }
  });
});

describe('agentLine', () => {
  it('says_when_a_booked_visit_starts_on_the_business_clock', () => {
    // 10:00 am in Los Angeles on Monday, November 2, after the clocks went back.
    expect(agentLine({ ...none, latest_outcome: 'visit_booked', latest_outcome_starts_at: '2026-11-02T18:00:00Z' }, LA))
      .toBe('Booked Mon, Nov 2, 10:00 am.');
    expect(agentLine({ ...none, latest_outcome: 'visit_booked', latest_outcome_starts_at: '2026-11-02T18:00:00Z' }, 'America/New_York'))
      .toBe('Booked Mon, Nov 2, 1:00 pm.');
  });

  it('says_what_was_paid_up_front', () => {
    expect(agentLine({ ...none, latest_outcome: 'deposit_paid', latest_outcome_cents: 2000 }, LA)).toBe('Paid $20 up front.');
    expect(agentLine({ ...none, latest_outcome: 'deposit_paid', latest_outcome_cents: 4050 }, LA)).toBe('Paid $40.50 up front.');
  });

  it('says_why_a_request_was_turned_down_only_for_the_agents_limit', () => {
    expect(agentLine({ ...none, latest_outcome: 'turned_down', latest_outcome_cause: 'agent_limit' }, LA))
      .toBe('Asked to pay more than its limit, and was turned down.');
    for (const cause of ['owner_rule', 'no_rule', null] as const) {
      expect(agentLine({ ...none, latest_outcome: 'turned_down', latest_outcome_cause: cause }, LA)).toBe('A request was turned down.');
    }
    expect(agentLine({ latest_outcome: 'turned_down' }, LA)).toBe('A request was turned down.');
  });

  it('has_no_line_without_an_outcome_or_a_fact_it_needs', () => {
    expect(agentLine(none, LA)).toBeNull();
    expect(agentLine({}, LA)).toBeNull();
    expect(agentLine({ ...none, latest_outcome: 'visit_booked' }, LA)).toBeNull();
    expect(agentLine({ latest_outcome: 'visit_booked' }, LA)).toBeNull();
    expect(agentLine({ ...none, latest_outcome: 'visit_booked', latest_outcome_starts_at: 'not a time' }, LA)).toBeNull();
    expect(agentLine({ ...none, latest_outcome: 'deposit_paid' }, LA)).toBeNull();
    expect(agentLine({ latest_outcome: 'deposit_paid' }, LA)).toBeNull();
    expect(agentLine({ ...none, latest_outcome_starts_at: '2026-11-02T18:00:00Z', latest_outcome_cents: 2000 }, LA)).toBeNull();
    // Outcomes only a visitor's chat has say nothing here.
    expect(agentLine({ ...none, latest_outcome: 'quoted' }, LA)).toBeNull();
  });
});

describe('takeOverPlaceholder', () => {
  it('writes_as_the_owners_first_name', () => {
    expect(takeOverPlaceholder('Mike Turner', 'Turner Plumbing')).toBe("Hi, it's Mike. What time suits you?");
  });

  it('writes_as_the_business_when_the_owner_gave_no_name', () => {
    // Setup's fallback owner, "Owner", and an empty name both leave the business's name, whose
    // full stop ends the sentence on its own.
    expect(takeOverPlaceholder('Owner', 'Acme Inc.')).toBe("Hi, it's Acme Inc. What time suits you?");
    expect(takeOverPlaceholder('', 'Acme Inc.')).toBe("Hi, it's Acme Inc. What time suits you?");
    expect(takeOverPlaceholder('   ', 'Turner Plumbing')).toBe("Hi, it's Turner Plumbing. What time suits you?");
  });
});
