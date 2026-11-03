import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { AppShellOnly } from '../components/AppShell/AppShell.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { LeadRow, PersonRow } from '../components/PersonRow/PersonRow.tsx';
import { RecordedHistoryLink } from '../components/RecordedHistoryLink/RecordedHistoryLink.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { RECORDED_HISTORY_HREF, RiveraFrame } from './parts.tsx';
import { SPEC, expectFooter, expectRecordedTags, one } from './spec.ts';

const CONTACTS = [rivera.people.bob, rivera.people.dana];

/** The leads as the phone board writes them, newest first: today's live one, then two replayed. */
const LEADS = [
  { name: 'Sam Ortiz', time: 'Today, 11:24 am', note: 'Wants a quote to replace a kitchen faucet.' },
  { name: 'Jordan Pike', time: 'Yesterday, 8:05 pm', note: 'Asked about a gas line for an outdoor grill.', recorded: true },
  { name: 'Ana Reyes', time: 'Oct 26, 11:10 am', note: 'Asked about a gas line for an outdoor grill.', recorded: true },
];

/** Customers on a phone: the top bar, then the same sections as on a laptop, in one 358 px column. */
function PeoplePhone() {
  return (
    <RiveraFrame current="people" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-filled-page">
        <div className="board-people">
          <PageHeader title="Customers" subtitle="Leads and customers on this Desk. Verified means a code reached their contact on record." />
          <section className="board-people__section" aria-labelledby="board-contacts">
            <div className="board-people__head">
              <SectionHeader id="board-contacts" title="Contacts on record" count={{ n: CONTACTS.length, label: `${CONTACTS.length} contacts on record` }} />
            </div>
            <ul role="list" className="board-people__rows" aria-labelledby="board-contacts">
              {CONTACTS.map((person) => (
                <li key={person.personId}>
                  <PersonRow name={person.name} contact={person.maskedContact} />
                </li>
              ))}
            </ul>
          </section>
          <section className="board-people__section" aria-labelledby="board-leads">
            <div className="board-people__head">
              <SectionHeader id="board-leads" title="Leads" count={{ n: LEADS.length, label: `${LEADS.length} leads` }} />
              <p className="board-people__caption cd-type-caption">
                <RecordedHistoryLink href={RECORDED_HISTORY_HREF} />
              </p>
            </div>
            <ul role="list" className="board-people__rows" aria-labelledby="board-leads">
              {LEADS.map((lead) => (
                <li key={lead.name}>
                  <LeadRow {...lead} />
                </li>
              ))}
            </ul>
          </section>
          <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly>
        </div>
      </div>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Customers, phone',
  render: () => <PeoplePhone />,
  // Drawn at a phone's window, so the play measures it there.
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-People-Phone',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'Customers at 390 px: the same PersonRow and LeadRow as on a laptop, the time still at the right of a lead’s name, and a replayed lead’s Recorded tag on its own line under the note.',
      'The top bar is AppShell’s, which writes “Menu” beside its icon where the board draws the icon alone.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Customers' }), SPEC.pageTitle);
    // The page takes 16 px gutters and scrolls only down.
    const column = one(canvasElement, '.board-people');
    await expect(Math.round(column.getBoundingClientRect().left)).toBe(16);
    await expect(Math.round(column.getBoundingClientRect().width)).toBe(358);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    const leads = canvas.getByRole('list', { name: 'Leads' });
    const rows = within(leads).getAllByRole('listitem');
    const tags = await expectRecordedTags(rows, (row) => LEADS[rows.indexOf(row)]?.recorded === true);
    await expect(tags).toHaveLength(2);
    for (const tag of tags) {
      const row = tag.closest('li') as HTMLElement;
      const note = one(row, '.cd-lead-row__note');
      const time = one(row, '.cd-lead-row__time');
      // lead_row_tag_under_the_note_when_narrow: from the note's start, on a line of its own.
      await expect(Math.round(tag.getBoundingClientRect().left)).toBe(Math.round(note.getBoundingClientRect().left));
      await expect(tag.getBoundingClientRect().top).toBeGreaterThanOrEqual(note.getBoundingClientRect().bottom);
      await expect(Math.round(time.getBoundingClientRect().right)).toBe(Math.round(row.getBoundingClientRect().right) - 10);
    }
    // A live lead keeps its 53 px; a replayed one grows by the tag's line.
    await expect(Math.round(rows[0]!.getBoundingClientRect().height)).toBe(53);
    await expectFooter(canvasElement);
  },
};
