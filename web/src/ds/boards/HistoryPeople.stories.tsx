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
import {
  SPEC,
  expectFooter,
  expectFooterAtFoot,
  expectOwnerFrame,
  expectRecordedLink,
  expectRecordedTags,
  expectTabOrder,
  footerLink,
  one,
  some,
} from './spec.ts';

/** People on record: their name and the contact on record, masked as the kernel sends it. */
const CONTACTS = [rivera.people.bob, rivera.people.dana];

interface Lead {
  name: string;
  /** As the screen writes it; the design system formats no times. */
  time: string;
  note: string;
  recorded?: boolean;
}

/** The leads, newest first: today's live one, then two from the recorded history. */
const LEADS: Lead[] = [
  { name: 'Sam Ortiz', time: 'Today, 11:24 am', note: 'Wants a quote to replace a kitchen faucet.' },
  { name: 'Jordan Pike', time: 'Yesterday, 8:05 pm', note: 'Asked about a gas line for an outdoor grill. Not on your price list.', recorded: true },
  { name: 'Ana Reyes', time: 'Oct 26, 11:10 am', note: 'Asked about a gas line for an outdoor grill. Not on your price list.', recorded: true },
];

/**
 * People, which the owner's sidebar calls Customers: those on record (`PersonRow`), then the leads
 * (`LeadRow`), each replayed lead with its Recorded tag at the end of its second line, under the time.
 */
function HistoryPeople() {
  return (
    <RiveraFrame current="people" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 3, label: '3 blocked' } }}>
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
  title: 'Boards/Recorded history, people',
  render: () => <HistoryPeople />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-History-People',
    canvasNote: [
      'People, which the sidebar calls Customers: the contacts on record, then the leads under “Includes recorded history” (RecordedHistoryLink), each replayed lead with the Recorded tag (RecordedTag) at the end of its second line, under its time.',
      'The rows are PersonRow and LeadRow; the page, its 760 px column, its sections and the footer at the window’s foot are page layout the web app (plan 04) owns, composed here from PageHeader, SectionHeader, RecordedHistoryLink and the tokens.',
      'A lead’s note reads without the board’s “Lead ·” before it: the section’s heading says it, and facts are never joined with a middle dot (run 2’s phone board, N-Run2-People-Phone, drops it too).',
      'The render sets a replayed lead’s icon on the text’s baseline, 2 px above the words’ middle, which makes that row 2 px taller; the tag here is the one tag, its icon centered on the line as the other boards draw it, and every row keeps its height.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The board's own window: a 14-inch laptop's.
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Customers', { fill: true });
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Customers' }), SPEC.pageTitle);

    // The page pads itself as the main area pads a page; its one column is 760 px, centered.
    const main = canvas.getByRole('main');
    expectComputed(one(main, '.board-filled-page'), SPEC.main);
    const page = one(main, '.board-people');
    const mainBox = main.getBoundingClientRect();
    const pageBox = page.getBoundingClientRect();
    await expect(pageBox.width).toBe(760);
    await expect(Math.round(pageBox.left - mainBox.left)).toBe(Math.round(mainBox.right - pageBox.right));

    // Each section's head over a hairline; the Leads caption 4 px under its header.
    for (const head of some(page, '.board-people__head')) {
      expectComputed(head, { borderBottomWidth: '1px', borderBottomColor: 'rgba(250, 249, 245, 0.12)', paddingBottom: '8px' });
    }
    const contacts = canvas.getByRole('list', { name: 'Contacts on record' });
    const leads = canvas.getByRole('list', { name: 'Leads' });
    const leadsSection = leads.closest('section') as HTMLElement;
    const caption = within(leadsSection).getByRole('link', { name: 'Includes recorded history' });
    await expectRecordedLink(caption, RECORDED_HISTORY_HREF);
    const header = one(leadsSection, '.cd-section-header');
    await expect(Math.round(caption.closest('p')!.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBe(4);

    // recorded_rows_are_tagged: no one on record is tagged, nor today's live lead; each replayed
    // lead is, at the end of its second line, under its time.
    const people = within(contacts).getAllByRole('listitem');
    await expect(await expectRecordedTags(people, () => false)).toEqual([]);
    const rows = within(leads).getAllByRole('listitem');
    await expect(rows.map((row) => one(row, '.cd-person-row__name').textContent)).toEqual(LEADS.map((lead) => lead.name));
    const tags = await expectRecordedTags(rows, (row) => LEADS[rows.indexOf(row)]?.recorded === true);
    await expect(tags).toHaveLength(2);
    for (const tag of tags) {
      const row = tag.closest('li') as HTMLElement;
      const time = one(row, '.cd-lead-row__time');
      const note = one(row, '.cd-lead-row__note');
      await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
      await expect(tag.getBoundingClientRect().top).toBe(note.getBoundingClientRect().top);
      await expect(tag.getBoundingClientRect().top).toBeGreaterThanOrEqual(time.getBoundingClientRect().bottom);
    }
    // Every lead keeps one height, tagged or not.
    await expect(new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))).toEqual(new Set([51]));

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // The author link is in the sidebar before Claude acts for you; the caption is the page's stop.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    const reached = await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      footerLink(canvasElement),
      within(column).getByRole('switch', { name: 'Claude acts for you' }),
      caption,
    ]);
    await expect(reached.filter((stop) => main.contains(stop))).toEqual([caption]);
    await expect(column.contains(footerLink(canvasElement))).toBe(true);
  },
};
