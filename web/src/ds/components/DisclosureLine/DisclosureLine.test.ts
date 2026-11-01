import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DisclosureLine, type DisclosureLineProps } from './DisclosureLine.tsx';

/** The words the line shows, tags dropped. */
function lineText(props: DisclosureLineProps): string {
  const html = renderToStaticMarkup(createElement(DisclosureLine, props));
  return html.replace(/<[^>]*>/g, '');
}

describe('DisclosureLine', () => {
  it('disclosure_line_en_es', () => {
    expect(lineText({ language: 'en', businessName: 'Turner Plumbing' })).toBe('Turner Plumbing answers with Claude, an AI.');
    expect(lineText({ language: 'es', businessName: 'Turner Plumbing' })).toBe('Turner Plumbing responde con Claude, una IA.');
    // Without a name, as on the checkout.
    expect(lineText({ language: 'en' })).toBe('This page is part of a chat with Claude, an AI.');
    expect(lineText({ language: 'es' })).toBe('Esta página es parte de un chat con Claude, una IA.');
  });

  it('a_blank_name_still_discloses', () => {
    // A name with nothing in it never leaves "answers with Claude" with no one before it.
    for (const businessName of ['', '   ']) {
      expect(lineText({ language: 'en', businessName })).toBe('This page is part of a chat with Claude, an AI.');
      expect(lineText({ language: 'es', businessName })).toBe('Esta página es parte de un chat con Claude, una IA.');
    }
  });
});
