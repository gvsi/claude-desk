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

  it('a_visitor_sees_a_row_before_its_entry_only_for_a_contact', () => {
    if (!codeEntry || !notice) throw new Error('the Chen fixture has no code entry');
    const rows = (html: string) => html.match(/<li /g)?.length ?? 0;
    // The legitimate case: a code on its way to the contact on record shows its preview and Opening.
    const opening = render({ items: [{ notice, entry: null }] });
    expect(rows(opening)).toBe(1);
    expect(opening).toContain('New verification code');
    expect(opening).toContain('Opening');
    // A recipient that can't be read as a contact (blank, or the owner written another way) shows
    // nothing while opening or after failing to open, for a visitor.
    for (const to of ['', '   ', 'Owner', ' owner ', 'OWNER']) {
      const unclear = { ...notice, to, preview: 'A request needs your answer' };
      for (const failed of [false, true]) {
        const html = render({ items: [{ notice: unclear, entry: null, failed }] });
        expect(rows(html), JSON.stringify({ to, failed })).toBe(0);
        expect(html).not.toContain('A request needs your answer');
      }
      // Once its fetched entry proves it is a code for this session, it shows. An entry fetched for
      // another notice proves nothing.
      expect(rows(render({ items: [{ notice: unclear, entry: codeEntry }] })), JSON.stringify(to)).toBe(1);
      const elsewhere = { ...unclear, entry_id: 'inbox-something-else' };
      expect(rows(render({ items: [{ notice: elsewhere, entry: codeEntry }] })), JSON.stringify(to)).toBe(0);
    }
    // An entry the kernel addressed to the owner never shows to a visitor, whatever its kind says.
    expect(rows(render({ items: [{ notice, entry: { ...codeEntry, to: 'owner' } }] }))).toBe(0);
    // The owner's own panel shows every row.
    const owner = { ...notice, to: 'owner', preview: 'A request needs your answer' };
    expect(render({ viewer: 'owner', items: [{ notice: owner, entry: null }] })).toContain('A request needs your answer');
  });
});
