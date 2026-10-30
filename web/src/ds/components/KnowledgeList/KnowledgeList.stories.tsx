import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { KnowledgeList, type KnowledgeRowView } from './KnowledgeList.tsx';

/**
 * What Rivera Plumbing's Desk knows, as N-Run2-Settings-Knowledge draws it. Fixture data: the list
 * waits on an API that returns the Desk's knowledge items to the owner. The third is a note the
 * kernel keeps owner-only, so its title and text never reach the web.
 */
const ITEMS: KnowledgeRowView[] = [
  { id: 'website', title: 'Your website', detail: 'rivera-plumbing.example, read during setup', readers: ['public'] },
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
  name: 'What I know now',
  parameters: { canvasNote: 'The list at the Knowledge column’s 720 px: two items customers can see, then a note only the owner can see.' },
  play: async ({ canvas, canvasElement }) => {
    // knowledge_list_is_a_named_section: its heading names the section and the list.
    const heading = canvas.getByRole('heading', { level: 2, name: 'What I know now' });
    const section = canvas.getByRole('region', { name: 'What I know now' });
    const list = within(section).getByRole('list', { name: 'What I know now' });
    expectListsKeepTheirRole(canvasElement);
    const rows = within(list).getAllByRole('listitem');
    await expect(rows.map(rowWords)).toEqual([
      ['Your website', 'rivera-plumbing.example, read during setup', 'Customers can see this'],
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
      expectComputed(title, { fontSize: '14px', lineHeight: '20px', fontWeight: '520', color: PRIMARY });
      expectComputed(detail, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
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
 * A withheld item is owner-only whatever its label says: the kernel withholds the title only of an
 * item it keeps to the owner, so the row never says customers can see it.
 */
export const WithheldIsOwnerOnly: Story = {
  name: 'Withheld item',
  args: { items: [{ id: 'note-0b7a', title: null, detail: 'Added Oct 28', readers: ['public'] }] },
  parameters: { canvas: 'none', canvasNote: 'A guard for N-Run2-Settings-Knowledge’s third row: a withheld item with a public label still reads “Only you”.' },
  play: async ({ canvas }) => {
    const [row] = within(canvas.getByRole('list', { name: 'What I know now' })).getAllByRole('listitem');
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
    const rows = within(canvas.getByRole('list', { name: 'What I know now' })).getAllByRole('listitem');
    for (const row of rows) {
      // The pill keeps its line at the right; the words wrap beside it, and nothing scrolls sideways.
      const pill = row.querySelector('.cd-pill') as HTMLElement;
      await expect(Math.round(row.getBoundingClientRect().right - pill.getBoundingClientRect().right)).toBe(16);
      await expect(pill.getBoundingClientRect().height).toBe(20);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
