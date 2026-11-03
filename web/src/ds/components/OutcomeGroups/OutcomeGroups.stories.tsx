import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { MoneyLimit } from '../MoneyLimit/MoneyLimit.tsx';
import { OUTCOME_GROUP_WORDS, OUTCOME_TONE } from '../OutcomeMenu/outcomeWords.ts';
import { OutcomeGroups } from './OutcomeGroups.tsx';

const { line } = rivera.paymentLimit;

const NOTE =
  "Drawn on N-R2-Setup-08-Rules, signed on 2026-10-30. The setup interview's draft rules, grouped by what Claude does, under the payment limit.";

const meta = {
  title: 'Rules/OutcomeGroups',
  component: OutcomeGroups,
  args: {
    rows: rivera.setupOutcomes,
    moneyLimit: <MoneyLimit line={line} prominent />,
  },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <OutcomeGroups {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'none', canvasNote: NOTE },
} satisfies Meta<typeof OutcomeGroups>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each group's section, in order. */
function groups(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.cd-outcome-groups__group')];
}

export const SetupRules: Story = {
  play: async ({ canvas, canvasElement }) => {
    // list_semantics_kept
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(3);
    // outcome_groups_in_order: what Claude does on its own, what it asks about, what it never does,
    // each a section named by its heading, beside its outcome's status dot.
    const headings = canvas.getAllByRole('heading', { level: 2 });
    await expect(headings.map((heading) => heading.textContent)).toEqual(['Allow', 'Ask me first', 'Never']);
    await expect(Object.values(OUTCOME_GROUP_WORDS)).toEqual(['Allow', 'Ask me first', 'Never']);
    for (const mode of ['auto', 'ask', 'never'] as const) {
      const section = canvas.getByRole('region', { name: OUTCOME_GROUP_WORDS[mode] });
      const heading = within(section).getByRole('heading', { level: 2 });
      await expect(heading.querySelector(`.cd-status-dot--${OUTCOME_TONE[mode]}`)).not.toBeNull();
      await expect(heading.querySelector('.cd-status-dot')).toHaveAttribute('aria-hidden', 'true');
    }
    // Each rule is a row: what Claude does at the left, who it's for at the right in secondary meta.
    const own = canvas.getByRole('region', { name: 'Allow' });
    const rows = within(own).getAllByRole('listitem');
    await expect(rows.map((row) => row.textContent)).toEqual([
      'Quotes from your price list, at list price Anyone',
      'Finds open times Anyone',
      'Books weekday visits in your hours Anyone',
      'Saves leads and callback requests Anyone',
      'Sends customers their own documents Verified customers',
    ]);
    const quotes = rows[0] as HTMLElement;
    const who = within(quotes).getByText('Anyone');
    expectComputed(who, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(within(quotes).getByText(/^Quotes from/), { fontSize: '14px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(who.getBoundingClientRect().right).toBeCloseTo(quotes.getBoundingClientRect().right, 0);
    await expect(within(canvas.getByRole('region', { name: 'Never' })).getByText('Refunds')).toBeVisible();

    // outcome_groups_geometry, as the board draws it: the money line's card first, then a card per
    // group 20 px apart, each padded 16 px; the heading's 20 px line 10 px over a hairline; rows
    // 40 px tall under hairlines.
    const cards = [...canvasElement.querySelectorAll<HTMLElement>('.cd-card')];
    await expect(cards).toHaveLength(4);
    // money_line_leads: the limit's line, which holds over every rule below it, in weight 520,
    // read only: the setup's rules step has no "Change" (owner ruling, 2026-10-30).
    const money = within(cards[0] as HTMLElement).getByText(line);
    expectComputed(money, { fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(within(cards[0] as HTMLElement).queryAllByRole('button')).toEqual([]);
    for (const [i, card] of cards.entries()) {
      expectComputed(card, { paddingTop: '16px', paddingLeft: '16px', paddingBottom: '16px' });
      const next = cards[i + 1];
      if (next) await expect(next.getBoundingClientRect().top - card.getBoundingClientRect().bottom).toBe(20);
    }
    // The line alone, 16 px in from the card's border: 54 px.
    await expect(Math.round((cards[0] as HTMLElement).getBoundingClientRect().height)).toBe(54);
    const [first] = groups(canvasElement);
    const title = first?.querySelector<HTMLElement>('.cd-outcome-groups__title');
    if (!title) throw new Error('No title');
    expectComputed(title, { lineHeight: '20px', paddingBottom: '10px' });
    for (const row of rows) {
      await expect(Math.round(row.getBoundingClientRect().height)).toBe(41);
      expectComputed(row, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)', paddingTop: '10px' });
    }
  },
};

export const NothingItNeverDoes: Story = {
  args: { rows: { auto: rivera.setupOutcomes.auto, ask: rivera.setupOutcomes.ask }, moneyLimit: undefined },
  parameters: { canvasNote: `${NOTE} A group with no rules is left out, and with no payment limit there's no money line.` },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Allow', 'Ask me first']);
    await expect(canvasElement.querySelectorAll('.cd-card')).toHaveLength(2);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // Who a rule is for stays at the right of its row; a long rule wraps beside it.
    const row = within(canvas.getByRole('region', { name: 'Allow' })).getAllByRole('listitem')[0] as HTMLElement;
    const who = within(row).getByText('Anyone');
    await expect(who.getBoundingClientRect().right).toBeCloseTo(row.getBoundingClientRect().right, 0);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);
  },
};
