import { createContext, useContext, type ReactNode } from 'react';

import './Card.css';

/**
 * What a Card sits inside: nothing, a card, or a frame (a card that `holdsCards`). Only the cards
 * directly in a frame may be cards; a frame may sit only at the top level.
 */
type Inside = 'none' | 'card' | 'frame';
const InsideCard = createContext<Inside>('none');

export interface CardProps {
  /** The element the card is: `article` for a thing (a held request, a capability), `section`, `li` in a list, or `div`. */
  as?: 'div' | 'article' | 'section' | 'li';
  /** The card's accessible name (`aria-label`): its heading's words, or what it is about. */
  label?: string;
  /**
   * The id of the element inside the card that names it (`aria-labelledby`), in place of `label`,
   * for a name that is shown text rendered from Markdown, so the name reads as the text does,
   * without its marks.
   */
  labelledBy?: string;
  /**
   * `20` (the default) for a card a screen is about; `16` for compact cards in a grid; `0` for a
   * card of rows that pad themselves, so their hairlines run edge to edge.
   */
  padding?: 0 | 16 | 20;
  /**
   * A frame that holds cards one level deep, such as the agents page's "Send an agent" card, which
   * holds the agent's run and the Desk's reply cards in it (N-R2-Agents-04). A card inside one of
   * those still throws, and a frame throws anywhere but the top level: inside a card or a frame.
   */
  holdsCards?: boolean;
  /**
   * `0` for a card that scrolls inside itself, so a keyboard can reach and scroll it, such as
   * Safety's open attempt beside the list. Its border then shows keyboard focus.
   */
  tabIndex?: 0;
  children: ReactNode;
}

/**
 * A quiet container: a faint fill, a 1 px border and the card radius. Cards never sit inside cards;
 * in development a nested Card throws, so the mistake shows up in its story. The one exception is a
 * card that `holdsCards`: the cards directly in it are allowed.
 */
export function Card({ as: Tag = 'div', label, labelledBy, padding = 20, holdsCards = false, tabIndex, children }: CardProps) {
  const inside = useContext(InsideCard);
  if (import.meta.env.DEV) {
    if (holdsCards && inside !== 'none') {
      throw new Error('A Card that holds cards is inside another Card. Only a card at the top level may hold cards.');
    }
    if (!holdsCards && inside === 'card') {
      throw new Error('A Card is inside another Card. Use a hairline or spacing to group things inside one card.');
    }
  }
  return (
    <Tag
      className={`cd-card cd-card--padding-${padding}`}
      // A plain div can't carry a name, so a named div card is a group.
      role={Tag === 'div' && (label !== undefined || labelledBy !== undefined) ? 'group' : undefined}
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={tabIndex}
    >
      <InsideCard.Provider value={holdsCards ? 'frame' : 'card'}>{children}</InsideCard.Provider>
    </Tag>
  );
}
