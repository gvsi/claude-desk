import type { CardBlock, PaymentLinkState } from '../api/contracts.ts';

// Cancelled, paid and expired links lead to a page that can't take payment.
export const CLOSED_LINK_STATES: readonly PaymentLinkState[] = ['cancelled', 'paid', 'expired'];

export function paymentLinkClosed(link: Pick<CardBlock, 'fact_id'>, cancellations: readonly CardBlock[], state: unknown): boolean {
  return (typeof state === 'string' && CLOSED_LINK_STATES.includes(state as PaymentLinkState)) ||
    (!!link.fact_id && cancellations.some((card) => card.template === 'link_cancelled' && card.fact_id === link.fact_id));
}
