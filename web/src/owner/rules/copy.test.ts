/**
 * Rivera's fixed suggestions on Rules, each offered only while its change isn't in effect under
 * the active rules: "Stop quoting on weekends" while an automatic quote rule for anyone covers a
 * Saturday or a Sunday, and "Quote water heater installs up to $600" until one is capped at $600.
 */
import { describe, expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import { RULES_CHIPS, rulesChipsToOffer } from './copy.ts';

const WEEKENDS = 'Stop quoting on weekends';
const WATER_HEATER = 'Quote water heater installs up to $600';

const WEEKDAYS: RuleCard['hours'] = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '00:00:00', end: '00:00:00' };

/** An automatic quote rule for anyone, every day and with no cap, as Rivera's seed has it, with `fields` changed. */
function quoteRule(fields: Partial<RuleCard> = {}): RuleCard {
  return {
    card_id: 'rv-quote',
    applies_to: 'native.quote',
    mode: 'auto',
    who: 'anyone',
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    reason: 'Quotes from your price list, at list price.',
    ...fields,
  };
}

describe("Rivera's fixed suggestions", () => {
  it('offers_both_in_order_while_the_rules_are_still_read', () => {
    expect(rulesChipsToOffer(undefined)).toEqual([WEEKENDS, WATER_HEATER]);
    expect(RULES_CHIPS).toEqual([WEEKENDS, WATER_HEATER]);
  });

  it('an_all_days_uncapped_quote_rule_leaves_both_on_offer', () => {
    expect(rulesChipsToOffer([quoteRule()])).toEqual([WEEKENDS, WATER_HEATER]);
  });

  it('a_weekdays_quote_rule_takes_the_weekends_suggestion_away', () => {
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS })])).toEqual([WATER_HEATER]);
  });

  it('a_quote_rule_on_a_saturday_or_a_sunday_keeps_the_weekends_suggestion', () => {
    const saturday = quoteRule({ card_id: 'sat', hours: { days: ['sat'], start: '09:00:00', end: '13:00:00' } });
    const sunday = quoteRule({ card_id: 'sun', hours: { days: ['mon', 'sun'], start: '09:00:00', end: '17:00:00' } });
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS }), saturday])).toEqual([WEEKENDS, WATER_HEATER]);
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS }), sunday])).toEqual([WEEKENDS, WATER_HEATER]);
  });

  it('a_default_rule_does_not_count', () => {
    const fallback = quoteRule({ card_id: 'default-quote', is_default: true, max_amount_cents: 60_000 });
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS }), fallback])).toEqual([WATER_HEATER]);
  });

  it('a_rule_for_someone_else_does_not_count', () => {
    const verified = quoteRule({ card_id: 'verified-quotes', who: 'verified' });
    const dana = quoteRule({ card_id: 'dana-quotes', who: 'person', person_id: 'person-dana', max_amount_cents: 60_000 });
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS }), verified, dana])).toEqual([WATER_HEATER]);
  });

  it('a_rule_that_asks_or_another_tool_does_not_count', () => {
    const asks = quoteRule({ card_id: 'quotes-ask', mode: 'ask', max_amount_cents: 60_000 });
    const links = quoteRule({ card_id: 'links', applies_to: 'native.payment_link', max_amount_cents: 60_000 });
    expect(rulesChipsToOffer([asks, links])).toEqual([WATER_HEATER]);
  });

  it('a_quote_rule_capped_at_600_dollars_takes_the_water_heater_suggestion_away', () => {
    const waterHeaters = quoteRule({ card_id: 'card-water-heater-quotes', max_amount_cents: 60_000 });
    expect(rulesChipsToOffer([quoteRule(), waterHeaters])).toEqual([WEEKENDS]);
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS, max_amount_cents: 60_000 })])).toEqual([]);
  });

  it('an_uncapped_or_other_capped_quote_rule_keeps_the_water_heater_suggestion', () => {
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS })])).toEqual([WATER_HEATER]);
    expect(rulesChipsToOffer([quoteRule({ hours: WEEKDAYS, max_amount_cents: 50_000 })])).toEqual([WATER_HEATER]);
  });
});
