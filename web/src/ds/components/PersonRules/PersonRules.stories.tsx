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
    expectComputed(change, { color: 'rgba(250, 249, 245, 0.64)', fontSize: '14px' });
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
    expectComputed(title, { fontSize: '15px', lineHeight: '21px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(reason, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px' });
    expectComputed(words, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(within(book).getByText('Automatic')).toBeVisible();
    await expect(book.querySelector('.cd-status-dot--handled')).not.toBeNull();
    await expect(words.getBoundingClientRect().left).toBeGreaterThan(reason.getBoundingClientRect().right);

    // As the board draws them: a card of rows padded 12 px 16 px, the card 8 px under the heading.
    const card = section.querySelector<HTMLElement>('.cd-card');
    if (!card) throw new Error('No card');
    expectComputed(card, { paddingTop: '0px' });
    expectComputed(book, { paddingTop: '12px', paddingLeft: '16px', paddingBottom: '12px' });
    expectComputed(rows[1] as HTMLElement, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    await expect(Math.round(book.getBoundingClientRect().height)).toBe(85);
  },
};

export const NoRulesJustForThem: Story = {
  args: { rules: [] },
  play: async ({ canvas }) => {
    // no_rules_says_so: a quiet line in place of the card, and the way to add one on Rules.
    const section = canvas.getByRole('region', { name: 'Rules for Dana Whitfield' });
    const line = within(section).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'No rules just for Dana Whitfield.');
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

export const NarrowPhoneWithALimit: Story = {
  args: {
    rules: [
      {
        key: 'rv-dana-links',
        title: 'Payment link',
        rule: { card_id: 'rv-dana-links', mode: 'auto', reason: 'Dana can pay by link without asking you.' },
        words: [{ field: 'who', text: 'Dana Whitfield' }],
        limit: '$10,000',
      },
    ],
  },
  globals: { viewport: { value: 'narrow', isRotated: false } },
  parameters: {
    canvasNote: `${NOTE} The largest limit a rule can carry, at the narrowest phone width.`,
    viewport: { options: { narrow: { name: 'Narrow phone', styles: { width: '320px', height: '844px' }, type: 'mobile' } } },
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(320);
    // narrow_phone_limit_fits: the outcome's long phrase wraps inside the row, and nothing scrolls sideways.
    await expect(canvas.getByText('Automatic up to $10,000; over $10,000, ask me first')).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);
  },
};

/** The words in an element's text that its lines split: a word whose letters sit on more than one line. */
function splitWords(element: Element): string[] {
  const split: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (const match of text.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      if (tops.size > 1) split.push(match[0]);
    }
  }
  return split;
}

export const LongRuleNarrow: Story = {
  name: 'A long rule, narrow',
  args: {
    rules: [
      {
        key: 'rv-dana-weekend',
        title: 'Book a weekend emergency visit',
        rule: { card_id: 'rv-dana-weekend', mode: 'auto', reason: 'Dana can book a weekend emergency visit at her home without asking you first.' },
        words: [
          { field: 'who', text: 'Dana Whitfield' },
          { field: 'who', text: 'Verified' },
          { field: 'hours', text: 'Saturdays and Sundays, 9:00 am to 1:00 pm' },
          { field: 'review', text: 'Checked by the reviewer' },
        ],
      },
      {
        key: 'rv-dana-links',
        title: 'Payment link',
        rule: { card_id: 'rv-dana-links', mode: 'auto', reason: 'Dana can pay her invoices by link without asking you first.' },
        words: [
          { field: 'who', text: 'Dana Whitfield' },
          { field: 'limits', text: 'Up to $10,000' },
          { field: 'review', text: 'Checked by the reviewer' },
        ],
        limit: '$10,000',
      },
    ],
  },
  render: (args) => (
    <div style={{ width: 520 }}>
      <PersonRules {...args} />
    </div>
  ),
  parameters: { canvasNote: `${NOTE} A long rule in a column just wide enough to keep each row on one line.` },
  play: async ({ canvas }) => {
    // outcome_words_stay_whole: the outcome shrinks only to its longest word, wrapping between words
    // and never inside one, however long the rest of the row is.
    const rows = within(canvas.getByRole('region', { name: 'Rules for Dana Whitfield' })).getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    for (const row of rows) {
      const outcome = row.querySelector<HTMLElement>('.cd-outcome');
      if (!outcome) throw new Error('No outcome');
      await expect(splitWords(outcome), `${row.textContent ?? ''}: no word split across lines`).toEqual([]);
      // Nothing in the outcome reaches past it, and it stays inside its row.
      const box = outcome.getBoundingClientRect();
      for (const part of outcome.querySelectorAll('*')) {
        await expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);
      }
      await expect(box.right).toBeLessThanOrEqual(row.getBoundingClientRect().right - 16 + 0.5);
    }
  },
};

/** A name the voice rules would flag if it were the component's own words: its initials are in capitals. */
const MARKED_NAME = 'JJ Okafor';

export const MarkedName: Story = {
  name: 'A name marked as theirs',
  args: {
    name: MARKED_NAME,
    rules: [
      {
        key: 'rv-jj-saturday',
        title: 'Book a visit',
        rule: { card_id: 'rv-jj-saturday', mode: 'ask', reason: 'Saturday visits wait for you to say yes.' },
        words: [{ field: 'hours', text: 'Saturdays 9:00 am to 1:00 pm' }],
      },
    ],
  },
  parameters: { canvasNote: `${NOTE} The person's name is theirs, marked as user text inside the component's words.` },
  play: async ({ canvas }) => {
    // person_name_is_user_text: "Rules for" is the component's copy; the name in it is marked as theirs.
    const section = canvas.getByRole('region', { name: `Rules for ${MARKED_NAME}` });
    const heading = within(section).getByRole('heading', { level: 2, name: `Rules for ${MARKED_NAME}` });
    const marked = heading.querySelectorAll('[data-copy="user"]');
    await expect(marked).toHaveLength(1);
    await expect(marked[0]).toHaveTextContent(new RegExp(`^${MARKED_NAME}$`));
    await expect(heading).toHaveTextContent(new RegExp(`^Rules for ${MARKED_NAME}$`));
  },
};

export const MarkedNameNoRules: Story = {
  name: 'A name marked as theirs, no rules',
  args: { name: MARKED_NAME, rules: [] },
  parameters: { canvasNote: `${NOTE} With no rules, the line names the person, marked as user text.` },
  play: async ({ canvas }) => {
    const line = canvas.getByText((_, el) => el?.tagName === 'P' && el.textContent === `No rules just for ${MARKED_NAME}.`);
    const marked = line.querySelectorAll('[data-copy="user"]');
    await expect(marked).toHaveLength(1);
    await expect(marked[0]).toHaveTextContent(new RegExp(`^${MARKED_NAME}$`));
  },
};

/** A name holding a right-to-left override (U+202E) with no end: unisolated, it would reorder the words after it. */
const OVERRIDE_NAME = 'Dana \u202EWhitfield';

export const NameWithDirectionOverride: Story = {
  name: 'A name with a direction override',
  args: { name: OVERRIDE_NAME, rules: [] },
  parameters: { canvasNote: `${NOTE} A name holding a right-to-left override (U+202E): the name is isolated, so it can't reorder the words after it.` },
  play: async ({ canvasElement }) => {
    // person_name_is_isolated: the "." after the name stays after it, at its right.
    const line = canvasElement.querySelector<HTMLElement>('.cd-person-rules__none');
    const name = line?.querySelector<HTMLElement>('[data-copy="user"]');
    const dot = line?.lastChild;
    if (!line || !name || !dot || dot.textContent !== '.') throw new Error('No line with the name and its "."');
    const range = document.createRange();
    range.selectNodeContents(dot);
    await expect(range.getBoundingClientRect().left, 'the "." after the name').toBeGreaterThanOrEqual(name.getBoundingClientRect().right - 0.5);
    expectComputed(name, { unicodeBidi: 'isolate' });
    const heading = canvasElement.querySelector<HTMLElement>('h2 [data-copy="user"]');
    if (!heading) throw new Error('No name in the heading');
    expectComputed(heading, { unicodeBidi: 'isolate' });
  },
};
