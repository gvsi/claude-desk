/**
 * One card on the agents page, as the agents boards draw them: the design system's compact `Card`
 * as a named region, its title, an optional quiet line under it, then what it holds. The send
 * panel's card holds the Desk's reply cards, which only that panel's own `Card` may do, so it draws
 * that `Card` itself around the same inside (`AgentsCardContent`).
 */
import type { ReactNode, Ref } from 'react';

import { Card } from '../../ds/index.ts';

export interface AgentsCardProps {
  /** The card's title, which also names its region. */
  title: string;
  /** One quiet line under the title. */
  lead?: ReactNode;
  /** The title's id, for a link to the card (`#send`). */
  id?: string;
  /** The title, for a script to move focus to: it then takes focus (`tabIndex={-1}`), never a Tab stop. */
  titleRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}

export function AgentsCard({ title, lead, id, titleRef, children }: AgentsCardProps) {
  return (
    <Card as="section" label={title} padding={16}>
      <AgentsCardContent title={title} lead={lead} id={id} titleRef={titleRef}>
        {children}
      </AgentsCardContent>
    </Card>
  );
}

/** What an agents card holds: its title, the line under it, then its body. */
export function AgentsCardContent({ title, lead, id, titleRef, children }: AgentsCardProps) {
  return (
    <>
      <h2 ref={titleRef} id={id} className="cd-agents-card__title cd-type-section" tabIndex={titleRef === undefined ? undefined : -1}>
        {title}
      </h2>
      {lead === undefined ? null : <p className="cd-agents-card__lead cd-type-meta">{lead}</p>}
      <div className="cd-agents-card__body">{children}</div>
    </>
  );
}
