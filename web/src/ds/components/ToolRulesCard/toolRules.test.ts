import { describe, expect, test } from 'vitest';

import type { NormalizedAction, RuleCard } from '../../../api/contracts.ts';
import { groupsOverlap, rulesForTool } from './toolRules.ts';

function card(fields: Partial<RuleCard> & Pick<RuleCard, 'card_id' | 'applies_to'>): RuleCard {
  return {
    mode: 'auto',
    who: 'anyone',
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    reason: 'A reason.',
    ...fields,
  };
}

const quote = { tool: 'native.quote', effects: ['change'] } as const;
const capture = { tool: 'native.capture_lead', effects: ['change'] } as const;
const link = { tool: 'native.payment_link', effects: ['charge'] } as const;
const mandate = { tool: 'native.charge_mandate', effects: ['charge'] } as const;
const refund = { tool: 'payments.create_refund', effects: ['pay_out', 'private_data'] } as const;
const documents = { tool: 'native.release_document', effects: ['private_data', 'send_message'] } as const;

const ids = (cards: readonly RuleCard[]) => cards.map((c) => c.card_id);

describe('rulesForTool', () => {
  test('matches_a_generated_business_action_to_its_own_rule', () => {
    const action: Pick<NormalizedAction, 'tool' | 'effects'> = { tool: 'desk.intake', effects: ['change'] };
    const own = card({ card_id: 'intake', applies_to: 'desk.intake', mode: 'never' });
    const group = card({ card_id: 'changes', applies_to: 'effect:change', mode: 'ask' });
    expect(ids(rulesForTool(action, [group, own]))).toEqual(['intake']);
  });

  test('a_tool_card_hides_the_group_rule_it_outranks', () => {
    // A tool card is more specific than an effect card at the same level, and covers everyone the
    // group card does, so the group card governs nothing on that tool.
    const own = card({ card_id: 'quote', applies_to: 'native.quote' });
    const group = card({ card_id: 'changes', applies_to: 'effect:change', mode: 'ask' });
    expect(ids(rulesForTool(quote, [group, own]))).toEqual(['quote']);
    // A tool with no card of its own is governed by the group card.
    expect(ids(rulesForTool(capture, [group, own]))).toEqual(['changes']);
  });

  test('a_person_scoped_group_rule_outranks_tool_cards_for_everyone_else', () => {
    // A card for one person or agent beats a card for one tool: the agent's charge rule governs its
    // payment links and charges, beside each tool's rule for everyone else, and comes first.
    const agentCharges = card({ card_id: 'agent-charges', applies_to: 'effect:charge', who: 'agent', agent_key_id: 'demo-agent', max_amount_cents: 2000 });
    const linkCard = card({ card_id: 'link', applies_to: 'native.payment_link', max_amount_cents: 30000 });
    const mandateCard = card({ card_id: 'mandate', applies_to: 'native.charge_mandate', max_amount_cents: 2000 });
    const cards = [linkCard, mandateCard, agentCharges];
    expect(ids(rulesForTool(link, cards))).toEqual(['agent-charges', 'link']);
    expect(ids(rulesForTool(mandate, cards))).toEqual(['agent-charges', 'mandate']);
    expect(ids(rulesForTool(refund, cards))).toEqual([]);
    // The same agent's own card on the tool outranks its group card there.
    const agentLink = card({ card_id: 'agent-link', applies_to: 'native.payment_link', who: 'agent', agent_key_id: 'demo-agent' });
    expect(ids(rulesForTool(link, [...cards, agentLink]))).toEqual(['agent-link', 'link']);
    // Another agent's card doesn't.
    const otherLink = { ...agentLink, card_id: 'other-link', agent_key_id: 'other-agent' };
    expect(ids(rulesForTool(link, [...cards, otherLink]))).toEqual(['other-link', 'agent-charges', 'link']);
  });

  test('a_narrower_tool_card_leaves_the_group_rule_for_everyone_else', () => {
    // A card for record owners only doesn't cover everyone the group card does, so the group card
    // still decides for the rest.
    const ownCharges = card({ card_id: 'own', applies_to: 'payments.create_refund', who: 'record_owner', mode: 'ask' });
    const payouts = card({ card_id: 'payouts', applies_to: 'effect:pay_out', mode: 'ask' });
    expect(ids(rulesForTool(refund, [payouts, ownCharges]))).toEqual(['own', 'payouts']);
    // A wider one does cover them.
    const anyoneRefunds = { ...ownCharges, card_id: 'anyone', who: 'anyone' } as const;
    expect(ids(rulesForTool(refund, [payouts, anyoneRefunds]))).toEqual(['anyone']);
  });

  test('an_auto_group_rule_covers_a_tool_only_with_every_effect', () => {
    // effect:send_message auto alone doesn't cover documents, which also touch private data.
    const send = card({ card_id: 'send', applies_to: 'effect:send_message', who: 'record_owner' });
    expect(ids(rulesForTool(documents, [send]))).toEqual([]);
    // With an auto card for private data at the same level, both cover it jointly.
    const privateData = card({ card_id: 'private', applies_to: 'effect:private_data', who: 'record_owner' });
    expect(ids(rulesForTool(documents, [send, privateData]))).toEqual(['send', 'private']);
    // A joint combination needs one principal who satisfies every card: a private-data card for
    // agent A and a send-message card for agent B cover nobody, so neither governs documents.
    const agentPrivate = card({ card_id: 'a-private', applies_to: 'effect:private_data', who: 'agent', agent_key_id: 'agent-a' });
    const otherAgentSend = card({ card_id: 'b-send', applies_to: 'effect:send_message', who: 'agent', agent_key_id: 'agent-b' });
    expect(ids(rulesForTool(documents, [agentPrivate, otherAgentSend]))).toEqual([]);
    // The same agent's two cards do cover it jointly.
    const sameAgentSend = { ...otherAgentSend, card_id: 'a-send', agent_key_id: 'agent-a' };
    expect(ids(rulesForTool(documents, [agentPrivate, sameAgentSend]))).toEqual(['a-private', 'a-send']);
    // So do a person's two cards; another person's, or an agent's, don't combine with them.
    const danaPrivate = card({ card_id: 'dana-private', applies_to: 'effect:private_data', who: 'person', person_id: 'per-dana' });
    const danaSend = { ...danaPrivate, card_id: 'dana-send', applies_to: 'effect:send_message' };
    const bobSend = { ...danaSend, card_id: 'bob-send', person_id: 'per-bob' };
    expect(ids(rulesForTool(documents, [danaPrivate, danaSend]))).toEqual(['dana-private', 'dana-send']);
    expect(ids(rulesForTool(documents, [danaPrivate, bobSend]))).toEqual([]);
    expect(ids(rulesForTool(documents, [danaPrivate, sameAgentSend]))).toEqual([]);
    // A scoped card and a card for a group of people sit at different specificity: no joint cover.
    expect(ids(rulesForTool(documents, [agentPrivate, send]))).toEqual([]);
    // An ask or never group card covers it alone.
    const askSend = { ...send, card_id: 'ask-send', mode: 'ask' } as const;
    expect(ids(rulesForTool(documents, [askSend]))).toEqual(['ask-send']);
    // A joint combination covers only the people every card in it is for: anyone's private-data
    // card with the record owners' send-message card covers record owners. A verified-people ask
    // card for the tool covers every record owner too, so it outranks both: only it governs.
    const anyonePrivate = card({ card_id: 'anyone-private', applies_to: 'effect:private_data', who: 'anyone' });
    const verifiedAsk = card({ card_id: 'verified-ask', applies_to: 'native.release_document', who: 'verified', mode: 'ask' });
    expect(ids(rulesForTool(documents, [anyonePrivate, send, verifiedAsk]))).toEqual(['verified-ask']);
    // With an anyone send-message card too, anyone's private-data card has a combination for
    // anyone, which the verified card doesn't cover, so the two anyone cards still govern.
    const anyoneSend = card({ card_id: 'anyone-send', applies_to: 'effect:send_message', who: 'anyone' });
    expect(ids(rulesForTool(documents, [anyonePrivate, send, anyoneSend, verifiedAsk]))).toEqual(['verified-ask', 'anyone-private', 'anyone-send']);
  });

  test('never_group_rules_always_show_and_defaults_never_do', () => {
    const own = card({ card_id: 'quote', applies_to: 'native.quote' });
    const never = card({ card_id: 'no-changes', applies_to: 'effect:change', mode: 'never' });
    const fallback = card({ card_id: 'default:native.quote', applies_to: 'native.quote', mode: 'ask', is_default: true });
    // A never card always wins, whatever else covers the tool; a default card is the fallback line.
    expect(ids(rulesForTool(quote, [own, never, fallback]))).toEqual(['quote', 'no-changes']);
    expect(ids(rulesForTool(quote, [fallback]))).toEqual([]);
    // A card for another tool or effect is never listed.
    expect(ids(rulesForTool(quote, [card({ card_id: 'book', applies_to: 'native.book' }), card({ card_id: 'reads', applies_to: 'effect:read' })]))).toEqual([]);
  });

  test('groups_of_people_overlap_and_one_person_is_no_group', () => {
    // Anyone, verified people and record owners nest, so any two share someone.
    for (const a of ['anyone', 'verified', 'record_owner'] as const) {
      for (const b of ['anyone', 'verified', 'record_owner'] as const) expect({ a, b, overlap: groupsOverlap({ who: a }, { who: b }) }).toEqual({ a, b, overlap: true });
    }
    // A card for one person or one agent is no group.
    expect(groupsOverlap({ who: 'person' }, { who: 'anyone' })).toBe(false);
    expect(groupsOverlap({ who: 'verified' }, { who: 'agent' })).toBe(false);
  });
});
