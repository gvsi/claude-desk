import { describe, expect, it } from 'vitest';

import type { CardBlock, ClauseTemplate } from '../../../api/contracts.ts';
import { cardView } from './cardView.ts';

/** A card block with only the fields a test names; the rest empty, as the kernel sends them. */
function block(template: ClauseTemplate, fields: Partial<CardBlock> = {}): CardBlock {
  return { kind: 'card', template, text: '', fact_id: null, title: null, lines: [], href: null, options: [], ...fields };
}

describe('cardView', () => {
  it('uses_the_block_fields', () => {
    const slots = [
      { option_id: 'S-20261103-1400', label: 'Tuesday, November 3, 2:00 pm' },
      { option_id: 'S-20261104-1000', label: 'Wednesday, November 4, 10:00 am' },
    ];
    expect(
      cardView(
        block('quote', {
          text: '$180.00\nDrain clearing\nGood until Tuesday, November 3, 2:00 pm',
          title: '$180.00',
          lines: ['Drain clearing', 'Good until Tuesday, November 3, 2:00 pm'],
          options: slots,
        }),
      ),
    ).toEqual({
      headline: '$180.00',
      details: ['Drain clearing', 'Good until Tuesday, November 3, 2:00 pm'],
      options: slots,
      href: null,
    });
    // With no title, lines or options, the card shows its text, line by line.
    expect(cardView(block('policy', { text: 'Cash or card.\nNo cheques.' }))).toEqual({
      headline: null,
      details: ['Cash or card.', 'No cheques.'],
      options: [],
      href: null,
    });
  });

  it('drops_empty_lines', () => {
    // Empty and blank lines leave no gap in the card, whether in `lines` or in the `text` fallback.
    expect(cardView(block('quote', { title: '$180.00', lines: ['', 'Drain clearing', '   ', '\n'] })).details).toEqual([
      'Drain clearing',
    ]);
    expect(cardView(block('policy', { text: '\nCash or card.\n\n  \nNo cheques.\n' })).details).toEqual([
      'Cash or card.',
      'No cheques.',
    ]);
    // A blank title is no headline, and lines alone still count as card data.
    expect(cardView(block('quote', { title: '  ', lines: ['Drain clearing'], text: 'Other' }))).toMatchObject({
      headline: null,
      details: ['Drain clearing'],
    });
  });

  it('proxied_paths_become_links', () => {
    // The API's proxied paths are the only links a card carries: checkout and document download.
    const pay = block('payment_link', { title: 'Service call deposit, $20', href: '/pay/k7Hq2vX9' });
    expect(cardView(pay).href).toBe('/pay/k7Hq2vX9');
    const doc = block('document_link', { title: 'Invoice, drain clearing', href: '/api/d/9fK2mQ' });
    expect(cardView(doc).href).toBe('/api/d/9fK2mQ');
    expect(cardView(block('payment_link', { title: 'Deposit', href: '/pay/a_B-9' })).href).toBe('/pay/a_B-9');
  });

  it('link_only_for_link_templates', () => {
    // Only payment_link and document_link carry a link; an href on any other card is dropped.
    expect(cardView(block('quote', { title: '$180.00', href: '/pay/k7Hq2vX9' })).href).toBeNull();
    expect(cardView(block('payment_confirmed', { title: 'Deposit', href: '/pay/k7Hq2vX9' })).href).toBeNull();
    expect(cardView(block('contact', { title: '(510) 555-0142', href: '/api/d/9fK2mQ' })).href).toBeNull();
    // An unknown template, as a newer kernel might send, carries no link either.
    const unknown = { ...block('quote', { title: 'Receipt', href: '/pay/k7Hq2vX9' }), template: 'refund_receipt' };
    expect(cardView(unknown as unknown as CardBlock).href).toBeNull();
    const inherited = { ...block('quote', { title: 'Receipt', href: '/pay/k7Hq2vX9' }), template: 'constructor' };
    expect(cardView(inherited as unknown as CardBlock).href).toBeNull();
  });

  it('unsafe_href_has_no_link', () => {
    const unsafe = [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      '//evil.example',
      '//evil.example/pay/k7Hq2vX9',
      'data:text/html,x',
      'https://evil.example/pay/k7Hq2vX9',
      '/pay/k7Hq2vX9?next=https://evil.example',
      '/pay/k7Hq2vX9#x',
      '/pay/../api/d/9fK2mQ',
      '/pay/k7Hq2vX9/extra',
      '/pay/k7Hq2vX9\n',
      '/pay/',
      '/PAY/k7Hq2vX9',
      '\\\\evil.example',
      '',
    ];
    for (const href of unsafe) {
      expect(cardView(block('payment_link', { title: 'Deposit', href })).href, JSON.stringify(href)).toBeNull();
      expect(cardView(block('document_link', { title: 'Invoice', href })).href, JSON.stringify(href)).toBeNull();
    }
    // Each template's path is its own: a document path on a payment card, and the reverse, is no link.
    expect(cardView(block('payment_link', { title: 'Deposit', href: '/api/d/x' })).href).toBeNull();
    expect(cardView(block('document_link', { title: 'Invoice', href: '/pay/x' })).href).toBeNull();
    // A link card with no href, or a non-string one, has no link.
    expect(cardView(block('payment_link', { title: 'Deposit' })).href).toBeNull();
    expect(cardView({ ...block('payment_link'), href: 42 } as unknown as CardBlock).href).toBeNull();
  });
});
