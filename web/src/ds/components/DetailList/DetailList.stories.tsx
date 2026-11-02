import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { DetailList, type DetailItem } from './DetailList.tsx';

/** Settings › General's details for Turner Plumbing, as N-Run2-Settings-General writes them. */
const DETAILS: DetailItem[] = [
  { label: 'Business', value: 'Turner Plumbing' },
  { label: 'This Desk', value: 'Main line' },
  { label: 'Customers see you as', value: 'Mike Turner' },
  { label: 'Time zone', value: 'Pacific Time (Los Angeles)' },
  { label: 'Hours', value: 'Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm' },
];

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';
const HAIRLINE = 'rgba(250, 249, 245, 0.12)';

const meta = {
  title: 'Settings/DetailList',
  component: DetailList,
  args: { items: DETAILS },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <DetailList {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Run2-Settings-General',
    canvasNote:
      'Settings › General’s “Your business” card at the content column’s 720 px. The board draws a ghost Change at the right of each row; the rows are read-only, with no Change (owner decision, 2026-10-30).',
  },
} satisfies Meta<typeof DetailList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const General: Story = {
  play: async ({ canvas, canvasElement }) => {
    // detail_rows_pair_each_label_with_its_value: a description list, each label its term and each value its definition, in order.
    const terms = canvas.getAllByRole('term');
    const values = canvas.getAllByRole('definition');
    await expect(terms.map((term) => term.textContent)).toEqual(DETAILS.map((item) => item.label));
    await expect(values.map((value) => value.textContent)).toEqual(DETAILS.map((item) => item.value));
    // The values are the owner's own settings, exempt from the voice rules.
    for (const value of values) await expect(value).toHaveAttribute('data-copy', 'user');
    // Read-only: nothing in the card can be pressed or typed into.
    await expect(canvasElement.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);

    // In the card look, with no padding of its own, so the hairlines run edge to edge.
    const card = canvasElement.querySelector<HTMLElement>('.cd-card')!;
    expectComputed(card, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '0px',
    });
    // Each row padded 12 px by 16 px, a hairline over every row but the first: 66 px, 67 with its hairline.
    const rows = terms.map((term) => term.parentElement as HTMLElement);
    for (const [index, row] of rows.entries()) {
      expectComputed(row, { paddingTop: '12px', paddingRight: '16px', paddingBottom: '12px', paddingLeft: '16px' });
      expectComputed(row, index === 0 ? { borderTopWidth: '0px' } : { borderTopWidth: '1px', borderTopColor: HAIRLINE });
      await expect(Math.round(row.getBoundingClientRect().height)).toBe(index === 0 ? 66 : 67);
    }
    // The label in meta type, secondary; the value 2 px under it in body type, primary, from the same edge.
    const [label, value] = [terms[0]!, values[0]!];
    expectComputed(label, { fontSize: '14px', lineHeight: '19px', color: SECONDARY, marginTop: '0px', marginLeft: '0px' });
    expectComputed(value, { fontSize: '15px', lineHeight: '21px', color: PRIMARY, marginLeft: '0px' });
    await expect(Math.round(value.getBoundingClientRect().top - label.getBoundingClientRect().bottom)).toBe(2);
    await expect(Math.round(value.getBoundingClientRect().left)).toBe(Math.round(label.getBoundingClientRect().left));
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(336);
    await expect(within(card).queryByText('Change')).toBeNull();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ padding: '0 var(--space-16)' }}>
      <DetailList {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-Phone',
    canvasNote: 'N-Run2-Settings-Phone’s card at 358 px: a long value wraps inside its row, and nothing scrolls sideways. No Change, as on a laptop (owner decision, 2026-10-30).',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const hours = canvas.getByText(DETAILS[4]!.value);
    // Two lines of body type: the row grows, and the page never scrolls sideways.
    await expect(Math.round(hours.getBoundingClientRect().height)).toBe(42);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
