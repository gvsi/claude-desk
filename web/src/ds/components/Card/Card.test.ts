import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Card } from './Card.tsx';

describe('Card', () => {
  it('card_is_never_nested', () => {
    // Two cards side by side are fine; a card inside a card fails in development.
    const siblings = createElement('div', null, createElement(Card, null, 'One'), createElement(Card, null, 'Two'));
    expect(renderToStaticMarkup(siblings).match(/class="cd-card /g)).toHaveLength(2);
    const nested = createElement(Card, null, createElement('p', null, createElement(Card, null, 'Inner')));
    expect(() => renderToStaticMarkup(nested)).toThrow(/A Card is inside another Card/);
  });

  it('a_card_that_holds_cards_lets_one_level_in', () => {
    // A frame such as the agents page's "Send an agent" card holds the Desk's reply cards.
    const frame = (children: ReturnType<typeof createElement>) => createElement(Card, { holdsCards: true, children });
    expect(renderToStaticMarkup(frame(createElement(Card, null, 'Reply card'))).match(/class="cd-card /g)).toHaveLength(2);
    // Only one level: a card inside the held card still fails.
    const deeper = frame(createElement(Card, null, createElement(Card, null, 'Inner')));
    expect(() => renderToStaticMarkup(deeper)).toThrow(/A Card is inside another Card/);
    // A frame is legal only at the top level: not inside a card, and not inside another frame.
    const framed = createElement(Card, null, frame(createElement('p', null, 'Run')));
    expect(() => renderToStaticMarkup(framed)).toThrow(/A Card that holds cards is inside another Card/);
    const nestedFrames = frame(frame(createElement(Card, null, 'Reply card')));
    expect(() => renderToStaticMarkup(nestedFrames)).toThrow(/A Card that holds cards is inside another Card/);
    // Nor inside a card that a frame holds.
    const frameInHeldCard = frame(createElement(Card, null, frame(createElement('p', null, 'Run'))));
    expect(() => renderToStaticMarkup(frameInHeldCard)).toThrow(/A Card that holds cards is inside another Card/);
  });

  it('padding_zero_for_rows_that_reach_the_edge', () => {
    // A card of link rows pads each row itself, so its hairlines run edge to edge.
    expect(renderToStaticMarkup(createElement(Card, { padding: 0, children: 'Rows' }))).toMatch(/^<div class="cd-card cd-card--padding-0">/);
    expect(renderToStaticMarkup(createElement(Card, null, 'One'))).toMatch(/^<div class="cd-card cd-card--padding-20">/);
  });

  it('named_div_card_is_a_group', () => {
    // A plain div can't carry a name, so a named div card is a group; an article keeps its own role.
    expect(renderToStaticMarkup(createElement(Card, { label: 'Turner Plumbing', children: 'One' }))).toMatch(
      /^<div class="cd-card [^"]*" role="group" aria-label="Turner Plumbing">/,
    );
    expect(renderToStaticMarkup(createElement(Card, null, 'One'))).not.toMatch(/role=|aria-label=/);
    expect(renderToStaticMarkup(createElement(Card, { as: 'article', label: 'Turner Plumbing', children: 'One' }))).toMatch(
      /^<article class="cd-card [^"]*" aria-label="Turner Plumbing">/,
    );
  });
});
