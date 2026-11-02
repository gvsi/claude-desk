import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { KnowledgeList, type KnowledgeRowView } from './KnowledgeList.tsx';

/**
 * What Turner Plumbing's Desk knows, as N-Run2-Settings-Knowledge draws it. Fixture data for the
 * served knowledge list route. The third is a note the
 * kernel keeps owner-only, so its title and text never reach the web.
 */
const ITEMS: KnowledgeRowView[] = [
  { id: 'website', title: 'Your website', detail: 'turner-plumbing.example, read during setup', readers: ['public'] },
  { id: 'price-list', title: 'Price list', detail: 'From your answers in setup', readers: ['public'] },
  { id: 'note-5c1e', title: null, detail: 'Added Oct 27', readers: ['owner'] },
];

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Settings/KnowledgeList',
  component: KnowledgeList,
  args: { items: ITEMS },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <KnowledgeList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Settings-Knowledge' },
} satisfies Meta<typeof KnowledgeList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each row's words: its title, the line under it and who can see it. */
function rowWords(row: HTMLElement): string[] {
  return [...row.querySelectorAll<HTMLElement>('.cd-knowledge-list__title, .cd-knowledge-list__detail, .cd-pill')].map((el) => el.textContent ?? '');
}

export const WhatIKnowNow: Story = {
  name: 'What Claude knows',
  parameters: { canvasNote: 'The list at the Knowledge column’s 720 px: two items customers can see, then a note only the owner can see.' },
  play: async ({ canvas, canvasElement }) => {
    // knowledge_list_is_a_named_section: its heading names the section and the list.
    const heading = canvas.getByRole('heading', { level: 2, name: 'What Claude knows' });
    const section = canvas.getByRole('region', { name: 'What Claude knows' });
    const list = within(section).getByRole('list', { name: 'What Claude knows' });
    expectListsKeepTheirRole(canvasElement);
    const rows = within(list).getAllByRole('listitem');
    await expect(rows.map(rowWords)).toEqual([
      ['Your website', 'turner-plumbing.example, read during setup', 'Customers can see this'],
      ['Price list', 'From your answers in setup', 'Customers can see this'],
      ['A note only you can see', 'Added Oct 27', 'Only you'],
    ]);

    // An item's own title is its owner's words; the withheld item's title is the design system's.
    const [website, priceList, hidden] = rows as [HTMLElement, HTMLElement, HTMLElement];
    for (const row of [website, priceList]) {
      await expect(row.querySelector('.cd-knowledge-list__title')).toHaveAttribute('data-copy', 'user');
    }
    await expect(hidden.querySelector('[data-copy="user"]')).toBeNull();

    // The board's look: a card of rows, each padded 12 px 16 px and 64 px tall, a hairline between
    // them, the title in body type at 520 over the line in meta type, 2 px apart.
    const card = list.parentElement as HTMLElement;
    expectComputed(card, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '0px',
    });
    await expect(Math.round(card.getBoundingClientRect().top - heading.getBoundingClientRect().bottom)).toBe(8);
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(196);
    for (const [index, row] of rows.entries()) {
      expectComputed(row, { paddingTop: '12px', paddingRight: '16px', paddingBottom: '12px', paddingLeft: '16px' });
      expectComputed(row, index === 0 ? { borderTopWidth: '0px' } : { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
      const title = row.querySelector('.cd-knowledge-list__title') as HTMLElement;
      const detail = row.querySelector('.cd-knowledge-list__detail') as HTMLElement;
      expectComputed(title, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: PRIMARY });
      expectComputed(detail, { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
      await expect(Math.round(detail.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(2);
      // Who can see it is a pill at the row's right, centered on it.
      const pill = row.querySelector('.cd-pill') as HTMLElement;
      const rowBox = row.getBoundingClientRect();
      const pillBox = pill.getBoundingClientRect();
      await expect(Math.round(rowBox.right - pillBox.right)).toBe(16);
      await expect(Math.round(pillBox.top + pillBox.height / 2)).toBe(Math.round(rowBox.top + rowBox.height / 2));
    }
    await expect(Math.round(website.getBoundingClientRect().height)).toBe(64);
  },
};

/**
 * An item the owner keeps to themselves keeps its title: only an item the kernel forces to the owner
 * arrives with its title withheld.
 */
export const KeptPrivateByTheOwner: Story = {
  name: 'Kept private by the owner',
  args: { items: [{ id: 'note-2d4f', title: 'Gate code for the back lot', detail: 'Added Oct 28', readers: ['owner'] }] },
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Settings-Knowledge’s rows with an item the owner kept private: its own title, and “Only you”.' },
  play: async ({ canvas }) => {
    const [row] = within(canvas.getByRole('list', { name: 'What Claude knows' })).getAllByRole('listitem');
    await expect(rowWords(row as HTMLElement)).toEqual(['Gate code for the back lot', 'Added Oct 28', 'Only you']);
    await expect((row as HTMLElement).querySelector('.cd-knowledge-list__title')).toHaveAttribute('data-copy', 'user');
  },
};

/**
 * A withheld item is owner-only whatever its label says: the kernel withholds the title only of an
 * item it keeps to the owner, so the row never says customers can see it.
 */
export const WithheldIsOwnerOnly: Story = {
  name: 'Withheld item',
  args: { items: [{ id: 'note-0b7a', title: null, detail: 'Added Oct 28', readers: ['public'] }] },
  parameters: { canvas: 'none', canvasNote: 'A guard for N-Run2-Settings-Knowledge’s third row: a withheld item with a public label still reads “Only you”.' },
  play: async ({ canvas }) => {
    const [row] = within(canvas.getByRole('list', { name: 'What Claude knows' })).getAllByRole('listitem');
    await expect(rowWords(row as HTMLElement)).toEqual(['A note only you can see', 'Added Oct 28', 'Only you']);
  },
};

/** With nothing to list, nothing is drawn: no board draws the list empty, so the page leaves it out. */
export const Empty: Story = {
  args: { items: [] },
  parameters: { canvas: 'none', canvasNote: 'No board draws the list empty (N-Run2-Settings-Knowledge draws three items), so it draws nothing.' },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-knowledge-list')).toBeNull();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <KnowledgeList {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'No phone board for Knowledge yet; the rows of N-Run2-Settings-Knowledge in the phone column, 358 px between the gutters.' },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('list', { name: 'What Claude knows' })).getAllByRole('listitem');
    for (const row of rows) {
      // The pill keeps its line at the right; the words wrap beside it, and nothing scrolls sideways.
      const pill = row.querySelector('.cd-pill') as HTMLElement;
      await expect(Math.round(row.getBoundingClientRect().right - pill.getBoundingClientRect().right)).toBe(16);
      await expect(pill.getBoundingClientRect().height).toBe(20);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** A missing date takes no line or gap; the title and pill centre in the shorter row. */
export const NoDate: Story = {
  args: { items: [
    { id: 'website', title: 'Your website', detail: null, readers: ['public'] },
    { id: 'price-list', title: 'Price list', detail: 'Added Oct 27', readers: ['public'] },
  ] },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'A row without a recorded date beside a dated row.' },
  play: async ({ canvas }) => {
    const [noDate, dated] = within(canvas.getByRole('list', { name: 'What Claude knows' })).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    await expect(noDate.querySelector('.cd-knowledge-list__detail')).toBeNull();
    const words = noDate.querySelector('.cd-knowledge-list__words') as HTMLElement;
    const title = noDate.querySelector('.cd-knowledge-list__title') as HTMLElement;
    const pill = noDate.querySelector('.cd-pill') as HTMLElement;
    const rowBox = noDate.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const pillBox = pill.getBoundingClientRect();
    // No empty child or leftover gap: the words box is exactly the one title line.
    await expect(words.children).toHaveLength(1);
    await expect(words.getBoundingClientRect().height).toBe(20);
    await expect(rowBox.height).toBe(44);
    await expect(dated.getBoundingClientRect().height).toBe(65);
    await expect(titleBox.top - rowBox.top).toBe(12);
    await expect(rowBox.bottom - titleBox.bottom).toBe(12);
    await expect(titleBox.left - rowBox.left).toBe(16);
    await expect(pillBox.top + pillBox.height / 2).toBe(rowBox.top + rowBox.height / 2);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NoDatePhone: Story = {
  ...NoDate,
  globals: { viewport: { value: 'phone', isRotated: false } },
};


/** Tiled source rows put their pill below the text in the phone column. */
export const TiledPhone: Story = {
  ...Phone,
  args: { items: ITEMS.map((item, index) => ({ ...item, kind: index === 0 ? 'globe' : index === 1 ? 'list' : 'note' })) },
  parameters: { canvas: 'none', canvasNote: 'Tiled Knowledge sources below 640 px, with pills under the text.' },
  play: async ({ canvas }) => {
    const rows = within(canvas.getByRole('list', { name: 'What Claude knows' })).getAllByRole('listitem');
    for (const row of rows) {
      const words = row.querySelector('.cd-knowledge-list__words')!.getBoundingClientRect();
      const pill = row.querySelector('.cd-pill')!.getBoundingClientRect();
      await expect(pill.left).toBe(words.left);
      await expect(pill.top - words.bottom).toBe(8);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
