import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { KnowledgeAdd } from '../components/KnowledgeAdd/KnowledgeAdd.tsx';
import { KnowledgeList, type KnowledgeRowView } from '../components/KnowledgeList/KnowledgeList.tsx';
import { expectComputed } from '../test/expectComputed.ts';
import { SettingsPage } from './parts.tsx';
import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder } from './spec.ts';

/** What the Desk knows, as the board lists it: fixture data, since the list waits on an API. */
const ITEMS: KnowledgeRowView[] = [
  { id: 'website', title: 'Your website', detail: 'turner-plumbing.example, read during setup', readers: ['public'] },
  { id: 'price-list', title: 'Price list', detail: 'From your answers in setup', readers: ['public'] },
  { id: 'note-5c1e', title: null, detail: 'Added Oct 27', readers: ['owner'] },
];

/** The note as the board writes it. */
const NOTE = 'We don’t service tankless water heaters older than 15 years. Suggest a replacement quote instead.';

const LEAD = 'Knowledge is what I answer from. It never changes your rules.';

/** Settings › Knowledge with a note just added: the list, the form, and the "Added" card's switch off. */
function SettingsKnowledge() {
  return (
    <SettingsPage current="knowledge">
      <p className="cd-type-summary">{LEAD}</p>
      <KnowledgeList items={ITEMS} />
      <KnowledgeAdd note={NOTE} onNoteChange={fn()} onAddNote={fn()} onAddFile={fn()} added={{ readers: ['owner'], onPublicChange: fn() }} />
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, knowledge',
  render: () => <SettingsKnowledge />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Knowledge',
    canvasNote: [
      'Signed on 2026-10-30.',
      'Knowledge: what the Desk knows is KnowledgeList, the note, the file and the “Added” card with its switch are KnowledgeAdd.',
      '“What I know now” waits on an API that lists a Desk’s knowledge to its owner, so its rows are fixture data; the third is an item the kernel keeps to the owner, whose title it withholds.',
      'The page is the Settings boards’ frame (SettingsPage): its column is 960 px as on every owner page (owner decision, 2026-10-30), where the board centers 1000 px, so everything sits 20 px right of the render and at the render’s height.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Settings', { fill: true });
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Settings' }), SPEC.pageTitle);
    const nav = canvas.getByRole('navigation', { name: 'Settings' });
    const current = within(nav).getByRole('link', { current: 'page' });
    await expect(current).toHaveTextContent('Knowledge');

    // The section's column: 720 px, 40 px right of the sub-nav (20 px right of the render, whose
    // column is 1000 px), led by Claude's line in serif at the render's 80 px.
    const box = (el: Element) => el.getBoundingClientRect();
    const lead = canvas.getByText(LEAD);
    const column = lead.parentElement as HTMLElement;
    await expect([Math.round(box(column).left), Math.round(box(column).width)]).toEqual([648, 720]);
    expectComputed(lead, { fontFamily: /^"Source Serif 4"/, fontSize: '18px', lineHeight: '27px', fontWeight: '360', marginTop: '0px', marginBottom: '0px' });
    await expect(Math.round(box(lead).top)).toBe(80);

    // Its parts 20 px apart at the render's heights: the list's card at 155 px and 196 px tall, the
    // note's field at 429 px and 102 px, the "Added" card at 656 px and 121 px.
    const known = canvas.getByRole('region', { name: 'What I know now' });
    const add = canvas.getByRole('region', { name: 'Add something' });
    const added = canvas.getByRole('region', { name: 'Added' });
    const list = within(known).getByRole('list', { name: 'What I know now' });
    const listCard = list.parentElement as HTMLElement;
    await expect([Math.round(box(known).top), Math.round(box(listCard).top), Math.round(box(listCard).height)]).toEqual([127, 155, 196]);
    await expect(Math.round(box(add).top)).toBe(371);
    const note = within(add).getByRole('textbox', { name: 'A note' });
    await expect(note).toHaveValue(NOTE);
    await expect([Math.round(box(note).top), Math.round(box(note).height)]).toEqual([429, 102]);
    await expect([Math.round(box(added).top), Math.round(box(added).height)]).toEqual([656, 121]);

    // The board's rows, and the just-added note owner-only until its switch is turned.
    await expect(within(list).getAllByRole('listitem').map((row) => row.querySelector('.cd-pill')?.textContent)).toEqual([
      'Customers can see this',
      'Customers can see this',
      'Only you',
    ]);
    const toggle = within(added).getByRole('switch', { name: 'Customers can see this' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expectComputed(within(add).getByRole('button', { name: 'Add a note' }), SPEC.primary);

    await expectFooter(canvasElement);
    await expectTabOrder(userEvent, [
      current,
      note,
      within(add).getByRole('button', { name: 'Add a note' }),
      within(add).getByRole('button', { name: 'Add a file' }),
      toggle,
    ]);
  },
};
