import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { listWords } from '../../../lib/format.ts';
import { ToolTitleList } from './ToolTitles.tsx';

const TITLES = ['Quote', 'Book a visit', 'Approved by your accountant', 'Refund'];

it('tool_title_list_reads_as_list_words_does', () => {
  // The screen's joining words must stay the ones every other list in the app uses: the line reads
  // word for word as listWords would write it, with each title its own user-text span, set off.
  for (let count = 1; count <= TITLES.length; count += 1) {
    const titles = TITLES.slice(0, count);
    const html = renderToStaticMarkup(createElement(ToolTitleList, { titles }));
    expect(html.replace(/<[^>]+>/g, '')).toBe(listWords(titles));
    expect(html.match(/<span class="cd-user-name" data-copy="user">/g)).toHaveLength(count);
  }
});
