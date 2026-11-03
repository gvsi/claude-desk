/**
 * The confirmed change on its way to Rules: two changes confirmed before Rules shows them land
 * together, and it waits only while the owner stays on Rules or the review Rules opened.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { land, landsHere, pendingLanding, resetLandings, takeLanding } from './landing.ts';

const DESK = 'desk-1';

afterEach(() => {
  resetLandings();
});

describe('a pending landing', () => {
  it('drawing_an_older_page_cannot_consume_a_newer_change', () => {
    land(DESK, { version: 8, rows: { tools: ['native.capture_lead', 'native.request_callback'], moneyLimit: false } });
    const drawn = pendingLanding(DESK)!;
    land(DESK, { version: 9, rows: { tools: [], moneyLimit: true } });
    takeLanding(drawn);
    const latest = pendingLanding(DESK)!;
    expect(latest.rows).toEqual({ tools: ['native.capture_lead', 'native.request_callback'], moneyLimit: true });
    takeLanding(latest);
    expect(pendingLanding(DESK)).toBeNull();
  });

  it('coalesces_card_identity_removals_and_turned_on_tools_independently_of_tools', () => {
    land(DESK, { version: 8, rows: { tools: ['native.book'], moneyLimit: false, cards: [], fallback: true, turnedOn: ['native.web_search'] } });
    land(DESK, { version: 9, rows: { tools: ['native.quote'], moneyLimit: false, cards: ['rv-quote'], fallback: false, turnedOn: [] } });
    expect(pendingLanding(DESK)?.rows).toEqual({
      tools: ['native.book', 'native.quote'], moneyLimit: false, cards: ['rv-quote'], fallback: true, turnedOn: ['native.web_search'],
    });
  });

  it('two_changes_on_one_desk_land_together', () => {
    land(DESK, { version: 8, rows: { tools: ['payments.create_refund'], moneyLimit: false } });
    land(DESK, { version: 9, rows: { tools: ['native.release_document', 'payments.create_refund'], moneyLimit: true } });
    const pending = pendingLanding(DESK);
    expect(pending?.version).toBe(9);
    expect([...(pending?.rows.tools ?? [])].sort()).toEqual(['native.release_document', 'payments.create_refund']);
    expect(pending?.rows.moneyLimit).toBe(true);
  });

  it('keeps_the_higher_version_and_the_limit_flag_whatever_the_order', () => {
    land(DESK, { version: 9, rows: { tools: [], moneyLimit: true } });
    land(DESK, { version: 8, rows: { tools: ['native.quote'], moneyLimit: false } });
    expect(pendingLanding(DESK)).toMatchObject({ version: 9, rows: { tools: ['native.quote'], moneyLimit: true } });
  });

  it('a_change_on_another_desk_takes_its_place', () => {
    land(DESK, { version: 8, rows: { tools: ['native.quote'], moneyLimit: false } });
    land('desk-2', { version: 3, rows: { tools: ['native.book'], moneyLimit: false } });
    expect(pendingLanding(DESK)).toBeNull();
    expect(pendingLanding('desk-2')).toMatchObject({ version: 3, rows: { tools: ['native.book'] } });
  });

  it('lands_only_on_rules_and_the_review_rules_opened', () => {
    expect(landsHere(DESK, '/app/desk-1/rules', null)).toBe(true);
    expect(landsHere(DESK, '/app/desk-1/rules/', null)).toBe(true);
    expect(landsHere(DESK, '/app/desk-1/rules/drafts/9', { draft: {}, fromRules: true })).toBe(true);
    // Anywhere else ends the visit: All rules, a review another page opened, another page or Desk.
    expect(landsHere(DESK, '/app/desk-1/rules/all', null)).toBe(false);
    expect(landsHere(DESK, '/app/desk-1/rules/drafts/9', { draft: {} })).toBe(false);
    expect(landsHere(DESK, '/app/desk-1/rules/drafts/9', null)).toBe(false);
    expect(landsHere(DESK, '/app/desk-1/today', null)).toBe(false);
    expect(landsHere(DESK, '/app/desk-2/rules', null)).toBe(false);
  });
});
