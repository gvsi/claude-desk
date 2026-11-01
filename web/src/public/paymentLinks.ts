import type { CardBlock } from '../api/contracts.ts';

// The owner's closed states. Expired links keep their action; adding expiry here is a one-line change.
export const CLOSED_LINK_STATES: readonly string[] = ['cancelled', 'paid'];

export function paymentLinkClosed(link: Pick<CardBlock, 'fact_id'>, cancellations: readonly CardBlock[], state: unknown): boolean {
  return (typeof state === 'string' && CLOSED_LINK_STATES.includes(state)) ||
    (!!link.fact_id && cancellations.some((card) => card.template === 'link_cancelled' && card.fact_id === link.fact_id));
}
