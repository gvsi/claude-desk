import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { LeadRow, PersonRow } from './PersonRow.tsx';

/** The leads as the People list shows them, newest first; the screen writes each time. */
const LEADS = [
  { name: 'Sam Ortiz', time: 'Today, 11:24 am', note: 'Wants a quote to replace a kitchen faucet.' },
  { name: 'Jordan Pike', time: 'Yesterday, 8:05 pm', note: 'Asked about a gas line for an outdoor grill. Not on your price list.', recorded: true },
];

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

/** The words someone chose, as the row marks them. */
function userText(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('[data-copy="user"]')];
}

function List({ width }: { width: number }) {
  return (
    <div style={{ maxWidth: width }}>
      <ul style={{ display: 'grid', gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none' }} aria-label="Contacts on record">
        {[rivera.people.bob, rivera.people.dana].map((person) => (
          <li key={person.personId}>
            <PersonRow name={person.name} contact={person.maskedContact} href={`#people/${person.personId}`} />
          </li>
        ))}
      </ul>
      <ul style={{ display: 'grid', gap: 'var(--space-2)', margin: 'var(--space-16) 0 0', padding: 0, listStyle: 'none' }} aria-label="Leads">
        {LEADS.map((lead) => (
          <li key={lead.name}>
            <LeadRow {...lead} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const meta = {
  title: 'Navigation/PersonRow',
  component: PersonRow,
  args: { name: rivera.people.dana.name, contact: rivera.people.dana.maskedContact },
  render: () => <List width={760} />,
  parameters: { layout: 'padded', canvas: 'N-History-People' },
} satisfies Meta<typeof PersonRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const List760: Story = {
  name: 'People list',
  parameters: { canvasNote: 'The rows of the People list in its 760 px column: two people on record, then two leads, the second replayed.' },
  play: async ({ canvas }) => {
    // person_row_names_the_contact_on_record: the name as user text, the masked contact under it.
    const people = within(canvas.getByRole('list', { name: 'Contacts on record' })).getAllByRole('link');
    await expect(people.map((row) => row.getAttribute('href'))).toEqual(['#people/per-bob', '#people/per-dana']);
    const dana = people[1] as HTMLElement;
    await expect(dana).toHaveAccessibleName('Dana Whitfield Contact on record: d•••@example.com');
    await expect(userText(dana).map((el) => el.textContent)).toEqual(['Dana Whitfield']);
    expectComputed(userText(dana)[0]!, { fontSize: '15px', lineHeight: '21px', fontWeight: '420', color: PRIMARY });
    const contact = within(dana).getByText('Contact on record: d•••@example.com');
    expectComputed(contact, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    // Padded 6 px by 10 px, 2 px between its lines: 53 px tall, as on the board.
    expectComputed(dana, { paddingTop: '6px', paddingLeft: '10px', borderTopLeftRadius: '8px' });
    await expect(dana.getBoundingClientRect().height).toBe(53);
    // A row that links is quiet at rest, with no fill (the hover fill is fill-hover).
    expectComputed(dana, { backgroundColor: 'rgba(0, 0, 0, 0)', textDecorationLine: 'none' });

    // lead_row_puts_the_time_beside_the_name: the time at the right on the name's baseline, the note
    // under the name, a replayed lead's Recorded tag at the end of the second line, under the time.
    const leads = within(canvas.getByRole('list', { name: 'Leads' })).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);
    await expect(leads.map((row) => userText(row).map((el) => el.textContent))).toEqual(LEADS.map((lead) => [lead.name, lead.note]));
    for (const row of leads) {
      const time = row.querySelector<HTMLElement>('.cd-lead-row__time')!;
      const name = userText(row)[0]!;
      expectComputed(time, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
      await expect(Math.round(time.getBoundingClientRect().right)).toBe(Math.round(row.getBoundingClientRect().right) - 10);
      // On the name's baseline: both are aligned by it, so the 18 px caption sits inside the name's
      // 21 px line, a little lower (2 px with the brand fonts, 3 px with the fallback ones).
      expectComputed(time, { alignSelf: 'baseline' });
      expectComputed(name, { alignSelf: 'baseline' });
      await expect(time.getBoundingClientRect().top).toBeGreaterThan(name.getBoundingClientRect().top);
      await expect(time.getBoundingClientRect().bottom).toBeLessThanOrEqual(name.getBoundingClientRect().bottom + 1);
      // Not a link without an href.
      await expect(row.tagName).toBe('DIV');
      await expect(row.getBoundingClientRect().height).toBe(53);
    }
    const [live, replayed] = leads as [HTMLElement, HTMLElement];
    await expect(live.querySelector('.cd-recorded-tag')).toBeNull();
    const tag = replayed.querySelector<HTMLElement>('.cd-recorded-tag')!;
    await expect(tag).toHaveTextContent('Recorded');
    const time = replayed.querySelector<HTMLElement>('.cd-lead-row__time')!;
    const note = userText(replayed)[1]!;
    await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
    await expect(tag.getBoundingClientRect().top).toBe(note.getBoundingClientRect().top);
  },
};

export const Phone: Story = {
  render: () => <List width={358} />,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'N-Run2-People-Phone',
    canvasNote: 'The same rows in the phone column, 358 px between the gutters: a replayed lead’s tag takes its own line under the note.',
  },
  play: async ({ canvas }) => {
    const leads = within(canvas.getByRole('list', { name: 'Leads' })).getAllByRole('listitem').map((item) => item.firstElementChild as HTMLElement);
    const replayed = leads[1] as HTMLElement;
    const tag = replayed.querySelector<HTMLElement>('.cd-recorded-tag')!;
    const note = userText(replayed)[1]!;
    // lead_row_tag_under_the_note_when_narrow: the tag starts where the note does, under it.
    await expect(Math.round(tag.getBoundingClientRect().left)).toBe(Math.round(note.getBoundingClientRect().left));
    await expect(tag.getBoundingClientRect().top).toBeGreaterThanOrEqual(note.getBoundingClientRect().bottom);
    // The time still sits at the right of the name, and nothing scrolls sideways.
    const time = replayed.querySelector<HTMLElement>('.cd-lead-row__time')!;
    await expect(Math.round(time.getBoundingClientRect().right)).toBe(Math.round(replayed.getBoundingClientRect().right) - 10);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
