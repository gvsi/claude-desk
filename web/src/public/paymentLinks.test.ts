import { describe, expect, it } from 'vitest';

import { rivera } from '../ds/fixtures/index.ts';
import { paymentLinkClosed } from './paymentLinks.ts';

describe('payment link closure', () => {
  it('closes only the payment link named by the cancellation card', () => {
    const link = rivera.blocks.payment_link.en;
    const cancelled = { ...link, template: 'link_cancelled' as const };
    expect(paymentLinkClosed(link, [cancelled], undefined)).toBe(true);
    expect(paymentLinkClosed(link, [{ ...cancelled, fact_id: 'payment_link:other' }], undefined)).toBe(false);
  });
  it('closes paid, cancelled and expired states, keeping the action after a failed read', () => {
    const link = rivera.blocks.payment_link.en;
    for (const state of ['paid', 'cancelled', 'expired']) expect(paymentLinkClosed(link, [], state)).toBe(true);
    for (const state of ['issued', 'unknown', 'future_state', undefined]) expect(paymentLinkClosed(link, [], state)).toBe(false);
  });
});
