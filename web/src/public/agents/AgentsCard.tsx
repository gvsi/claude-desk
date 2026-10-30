/**
 * One card on the agents page, as the agents boards draw them: the design system's compact `Card`
 * as a named region, its title, an optional quiet line under it, then what it holds.
 *
 * The send panel holds the Desk's replies, whose cards are `Card`s, and a `Card` can't hold another.
 * The boards draw the run inside the panel's card, so that card's frame is composed on the card's
 * own tokens instead (`holdsCards`), as the design system's boards compose the owner's signed-limit
 * card: the same look, with the reply cards inside it as drawn.
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
  /** It holds reply cards: its frame is drawn on the card tokens rather than by `Card`. */
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
