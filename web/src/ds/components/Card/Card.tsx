import { createContext, useContext, type ReactNode } from 'react';

import './Card.css';

/** True inside a Card, so a second Card inside it can say so. */
const InsideCard = createContext(false);

export interface CardProps {
  /** The element the card is: `article` for a thing (a held request, a capability), `section`, `li` in a list, or `div`. */
  as?: 'div' | 'article' | 'section' | 'li';
  /** The card's accessible name (`aria-label`): its heading's words, or what it is about. */
  label?: string;
  /** `20` (the default) for a card a screen is about; `16` for compact cards in a grid. */
  padding?: 16 | 20;
  children: ReactNode;
}

/**
 * A quiet container: a faint fill, a 1 px border and the card radius. Cards never sit inside cards;
 * in development a nested Card throws, so the mistake shows up in its story.
 */
export function Card({ as: Tag = 'div', label, padding = 20, children }: CardProps) {
  const nested = useContext(InsideCard);
  if (nested && import.meta.env.DEV) {
    throw new Error('A Card is inside another Card. Use a hairline or spacing to group things inside one card.');
  }
  return (
    <Tag
      className={`cd-card cd-card--padding-${padding}`}
      // A plain div can't carry a name, so a named div card is a group.
      role={Tag === 'div' && label !== undefined ? 'group' : undefined}
      aria-label={label}
    >
      <InsideCard.Provider value>{children}</InsideCard.Provider>
    </Tag>
  );
}
