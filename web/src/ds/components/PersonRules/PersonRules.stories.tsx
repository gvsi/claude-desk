import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { PersonRules } from './PersonRules.tsx';

const NOTE =
  "Drawn on N-Run2-People-Person, built against boards in review; sign-off pending. The rules just for one person, on their page, read only: they're changed on Rules.";

const meta = {
  title: 'People/PersonRules',
  component: PersonRules,
  args: { name: rivera.people.dana.name, rules: rivera.danaRules, rulesHref: '/rules' },
  render: (args) => (
    <div style={{ maxWidth: 608 }}>
      <PersonRules {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'none', canvasNote: NOTE },
} satisfies Meta<typeof PersonRules>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DanaWhitfield: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(expectListsKeepTheirRole(canvasElement)).toBe(1);
    // person_rules_named: a section named by its heading, with the way to change them at the right.
    const section = canvas.getByRole('region', { name: 'Rules for Dana Whitfield' });
    const heading = within(section).getByRole('heading', { level: 2, name: 'Rules for Dana Whitfield' });
    const change = within(section).getByRole('link', { name: 'Change them on Rules' });
    await expect(change).toHaveAttribute('href', '/rules');
    expectComputed(change, { color: 'rgba(250, 249, 245, 0.64)', fontSize: '13px' });
    await expect(change.getBoundingClientRect().right).toBeCloseTo(section.getBoundingClientRect().right, 0);
    await expect(Math.round(change.getBoundingClientRect().top)).toBeLessThan(Math.round(heading.getBoundingClientRect().bottom));

    // person_rules_read_only: a row per rule, what it's on over its reason, then what it enforces and
    // its outcome at the right; nothing in it can be pressed.
    const rows = within(section).getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    await expect(within(section).queryByRole('button')).toBeNull();
    const [book] = rows as [HTMLElement, HTMLElement];
    const title = within(book).getByText('Book a visit');
    const reason = within(book).getByText('Dana can book Saturday morning visits.');
    const words = within(book).getByText('Dana Whitfield · Saturdays 9:00 am to 1:00 pm');
    expectComputed(title, { fontSize: '14px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(reason, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px' });
    expectComputed(words, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(within(book).getByText('Automatic')).toBeVisible();
    await expect(book.querySelector('.cd-status-dot--handled')).not.toBeNull();
    await expect(words.getBoundingClientRect().left).toBeGreaterThan(reason.getBoundingClientRect().right);

    // As the board draws them: a card of rows padded 12 px 16 px, the card 8 px under the heading.
    const card = section.querySelector<HTMLElement>('.cd-card');
    if (!card) throw new Error('No card');
    expectComputed(card, { paddingTop: '0px' });
    expectComputed(book, { paddingTop: '12px', paddingLeft: '16px', paddingBottom: '12px' });
    expectComputed(rows[1] as HTMLElement, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(Math.round(book.getBoundingClientRect().height)).toBe(82);
  },
};

export const NoRulesJustForThem: Story = {
  args: { rules: [] },
  play: async ({ canvas }) => {
    // no_rules_says_so: a quiet line in place of the card, and the way to add one on Rules.
    const section = canvas.getByRole('region', { name: 'Rules for Dana Whitfield' });
    const line = within(section).getByText('No rules just for Dana Whitfield.');
    expectComputed(line, { color: 'rgba(250, 249, 245, 0.64)' });
    await expect(within(section).queryByRole('list')).toBeNull();
    await expect(within(section).getByRole('link', { name: 'Change them on Rules' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // Under 480 px of its own width, what a rule enforces and its outcome go under its reason.
    const [book] = within(canvas.getByRole('region', { name: 'Rules for Dana Whitfield' })).getAllByRole('listitem') as HTMLElement[];
    if (!book) throw new Error('No row');
    const reason = within(book).getByText('Dana can book Saturday morning visits.');
    const words = within(book).getByText('Dana Whitfield · Saturdays 9:00 am to 1:00 pm');
    await expect(words.getBoundingClientRect().top).toBeGreaterThanOrEqual(reason.getBoundingClientRect().bottom - 1);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);
  },
};
