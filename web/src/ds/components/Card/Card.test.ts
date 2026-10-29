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
});
