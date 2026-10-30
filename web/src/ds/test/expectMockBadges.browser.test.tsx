/**
 * The mock connector check also reads running text: a sentence that names a mock connector needs
 * "Mock" in its nearest block, so a card can't say "Stripe changed “Refund”" without saying
 * somewhere in it that Stripe is a mock.
 */
import { afterEach, expect, it } from 'vitest';

import { expectMockBesideExternalNames } from './expectMockBadges.ts';

let root: HTMLElement | null = null;

afterEach(() => {
  root?.remove();
  root = null;
});

/** A root holding `html`, on the page. */
function mount(html: string): HTMLElement {
  root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

it('a_named_sentence_needs_mock_in_its_block', () => {
  // The name with its badge in one card, and a sentence naming it in another card with no badge.
  const page = mount(`
    <section><span>Stripe</span><span>Mock</span></section>
    <section><p>Stripe changed “Refund”, so it's turned off until you review it.</p></section>
  `);
  expect(() => expectMockBesideExternalNames(page)).toThrow(/"Mock" is missing near: "Stripe changed/);
});

it('a_named_sentence_passes_beside_its_badge', () => {
  // The same sentence in the card that names Stripe with its badge.
  const page = mount(`
    <section>
      <p><span>Stripe</span><span>Mock</span> · Noticed today at 9:14</p>
      <p>Stripe changed “Refund”, so it's turned off until you review it.</p>
    </section>
  `);
  expect(expectMockBesideExternalNames(page)).toBe(1);
});
