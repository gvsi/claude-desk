/**
 * One card on the agents page, as the agents boards draw them: the design system's compact `Card`
 * as a named region, its title, an optional quiet line under it, then what it holds.
 *
 * Every card is the design system's `Card` but one: the send panel holds the Desk's replies, whose
 * cards are `Card`s, and a `Card` can't hold another. The boards draw the run inside the panel's
 * card, so until the design system's card-holding frame lands, that one card's frame is drawn on
 * the card tokens (`holdsCards`).
 */
import type { ReactNode } from 'react';

import { Card } from '../../ds/index.ts';

export interface AgentsCardProps {
  /** The card's title, which also names its region. */
  title: string;
  /** One quiet line under the title. */
  lead?: ReactNode;
  /** The title's id, for a link to the card (`#send`). */
  id?: string;
  /** The send panel only: it holds reply cards, so its frame is drawn on the card tokens rather than by `Card`. */
  holdsCards?: boolean;
  children: ReactNode;
}

export function AgentsCard({ title, lead, id, holdsCards = false, children }: AgentsCardProps) {
  const inside = (
    <>
      <h2 id={id} className="cd-agents-card__title cd-type-section">
        {title}
      </h2>
      {lead === undefined ? null : <p className="cd-agents-card__lead cd-type-meta">{lead}</p>}
      <div className="cd-agents-card__body">{children}</div>
    </>
  );
  if (holdsCards) {
    // stopgap: swap for the design system's card-holding frame (design/knowledge-and-limit)
    return (
      <section className="cd-agents-card--frame" aria-label={title}>
        {inside}
      </section>
    );
  }
  return (
    <Card as="section" label={title} padding={16}>
      {inside}
    </Card>
  );
}
