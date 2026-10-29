import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { chen } from '../../fixtures/index.ts';
import { DemoInboxPanel, type DemoInboxPanelProps } from './DemoInboxPanel.tsx';

const [codeEntry] = chen.demoInbox.entries;
const notice = chen.demoInbox.notices.find((n) => n.entry_id === codeEntry?.entry_id);

function render(props: Partial<DemoInboxPanelProps>): string {
  return renderToStaticMarkup(
    createElement(DemoInboxPanel, { viewer: 'visitor', language: 'en', items: [], onRetry: () => {}, ...props }),
  );
}

describe('DemoInboxPanel', () => {
  it('an_entry_for_another_notice_never_shows', () => {
    if (!codeEntry || !notice) throw new Error('the Chen fixture has no code entry');
    // The same code entry, under a notice it doesn't belong to: its body stays hidden, and the
    // item reads as not opened, with a way to fetch it again, for the owner and a visitor alike.
    const other = { ...notice, entry_id: 'inbox-code-someone-else' };
    for (const viewer of ['owner', 'visitor'] as const) {
      const html = render({ viewer, items: [{ notice: other, entry: codeEntry }] });
      expect(html).not.toContain('482913');
      expect(html).toContain('Couldn’t open this entry.');
      expect(html).toContain('Try again');
    }
    // Under its own notice it shows.
    expect(render({ items: [{ notice, entry: codeEntry }] })).toContain('482913');
  });
});
