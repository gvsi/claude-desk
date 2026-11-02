import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DemoInboxEntry } from '../../../api/contracts.ts';
import { chen } from '../../fixtures/index.ts';
import { DemoInboxPanel, type DemoInboxPanelProps } from './DemoInboxPanel.tsx';

const [codeEntry] = chen.demoInbox.entries;
const notice = chen.demoInbox.notices.find((n) => n.entry_id === codeEntry?.entry_id);

/** An urgent callback's alert to the owner, as the kernel stores it, without the title it reads under. */
const alert: DemoInboxEntry = {
  entry_id: 'inbox-urgent',
  to: 'owner',
  kind: 'alert',
  body: 'Reported as urgent through “Emergency callback”. Sam Lee · (510) 555-0100 · My pipes have burst',
  created_at: '2026-11-01T09:00:00Z',
  decision_id: null,
};
const alertNotice = { entry_id: alert.entry_id, to: 'owner', preview: 'Urgent callback requested' };

/** The line above an opened entry's body: its title or its kind. */
const kindOf = (html: string) => html.match(/cd-demo-inbox__kind[^>]*>([^<]*)</)?.[1];

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

  it('a_replayed_notice_shows_once_as_its_latest_item', () => {
    if (!codeEntry || !notice) throw new Error('the Chen fixture has no code entry');
    const rows = (html: string) => html.match(/<li /g)?.length ?? 0;
    // The same notice twice, as an event replay after a reconnect appends it: one row, the latest.
    const opened = render({ items: [{ notice, entry: null }, { notice, entry: codeEntry }] });
    expect(rows(opened)).toBe(1);
    expect(opened).toContain('482913');
    expect(opened).not.toContain('Opening');
    const failedLast = render({ items: [{ notice, entry: codeEntry }, { notice, entry: null, failed: true }] });
    expect(rows(failedLast)).toBe(1);
    expect(failedLast).toContain('Couldn’t open this entry.');
    expect(failedLast).not.toContain('482913');
    // For the owner too, and between other notices.
    const other = { ...notice, entry_id: 'inbox-other', to: 'owner', preview: 'A request needs your answer' };
    const owner = render({ viewer: 'owner', items: [{ notice, entry: null }, { notice: other, entry: null }, { notice, entry: codeEntry }] });
    expect(rows(owner)).toBe(2);
    // Newest first: the code's latest arrival is the newest, so it leads.
    expect(owner.indexOf('482913')).toBeLessThan(owner.indexOf('A request needs your answer'));
  });

  it('an_owner_alert_reads_under_its_title_or_else_its_kind', () => {
    // The kernel titles the owner's alerts with their preview line; one without a title, or with a
    // blank one, reads as its kind, as every entry did before.
    const owner = (entry: DemoInboxEntry) => render({ viewer: 'owner', items: [{ notice: alertNotice, entry }] });
    expect(kindOf(owner({ ...alert, title: 'Urgent callback requested' }))).toBe('Urgent callback requested');
    for (const untitled of [alert, { ...alert, title: null }, { ...alert, title: '' }, { ...alert, title: '   ' }]) {
      expect(kindOf(owner(untitled)), JSON.stringify(untitled.title)).toBe('Alert');
    }
    // A visitor's panel reads in their own language, so its rows keep their kind: the kernel titles
    // no entry a session reads, and a title the screen passes anyway doesn't show.
    if (!codeEntry || !notice) throw new Error('the Chen fixture has no code entry');
    const visitor = render({ items: [{ notice, entry: { ...codeEntry, title: 'New verification code' } }] });
    expect(kindOf(visitor)).toBe('Verification code');
  });

  it('an_owner_alert_in_spanish_reads_as_its_kind', () => {
    // The kernel's titles are English only, so the owner's panel in Spanish reads a titled alert as
    // its kind, "Aviso", never under the English line.
    const html = render({
      viewer: 'owner',
      language: 'es',
      items: [{ notice: alertNotice, entry: { ...alert, title: 'Urgent callback requested' } }],
    });
    expect(kindOf(html)).toBe('Aviso');
    expect(html).not.toContain('Urgent callback requested');
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
