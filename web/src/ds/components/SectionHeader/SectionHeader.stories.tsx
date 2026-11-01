import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SectionHeader } from './SectionHeader.tsx';

const meta = {
  title: 'Layout/SectionHeader',
  component: SectionHeader,
  args: { title: 'Needs you' },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof SectionHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithCountAndCaption: Story = {
  args: {
    count: { n: 2, label: '2 things need you' },
    caption: 'Everything else overnight stayed inside your rules.',
  },
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole('heading', { level: 2, name: 'Needs you' });
    expectComputed(heading, { fontSize: '15px', lineHeight: '20px', fontWeight: '520' });
    // The count is read as what it means, not as a bare number.
    await expect(canvas.getByRole('img', { name: '2 things need you' })).toHaveTextContent('2');
    const caption = canvas.getByText('Everything else overnight stayed inside your rules.');
    expectComputed(caption, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    // The caption sits at the right end of the heading's line.
    const headingBox = heading.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const lineBox = canvasElement.querySelector('.cd-section-header')?.getBoundingClientRect();
    await expect(captionBox.left).toBeGreaterThan(headingBox.right);
    await expect(Math.abs((lineBox?.right ?? 0) - captionBox.right)).toBeLessThanOrEqual(1);
    await expect(Math.abs(captionBox.top + captionBox.height / 2 - (headingBox.top + headingBox.height / 2))).toBeLessThanOrEqual(2);
  },
};

/** A phone's line: 390 px less the 16 px gutter on each side. */
const PHONE_LINE = 358;

export const LongTitle: Story = {
  args: {
    title: 'What Claude can do here when you are away and cannot answer yourself',
    count: { n: 2, label: '2 things need you' },
    caption: 'Everything else overnight stayed inside your rules.',
  },
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%', display: 'grid', rowGap: 'var(--space-24)' }}>
      <SectionHeader {...args} />
      <SectionHeader level={3} title="Documents for bookings.and.invoices@turnerplumbingandheatingservices.example" />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a title wider than a phone's line; it wraps inside the line, as N-Today-Run1's header would.",
  },
  play: async ({ canvas, canvasElement }) => {
    const line = canvas.getByTestId('phone-line');
    // Nothing reaches past the line: a long title wraps, and so does a word with no break in it.
    await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    const lineRight = line.getBoundingClientRect().right;
    for (const header of canvasElement.querySelectorAll<HTMLElement>('.cd-section-header')) {
      await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      for (const part of header.querySelectorAll('*')) {
        await expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(lineRight + 0.5);
      }
    }
    // Each title takes more than one 20 px line.
    const long = canvas.getByRole('heading', { level: 2 });
    const unbroken = canvas.getByRole('heading', { level: 3 });
    await expect(long.getBoundingClientRect().height).toBeGreaterThan(20);
    await expect(unbroken.getBoundingClientRect().height).toBeGreaterThan(20);
    // The caption drops under the wrapped title, left-aligned.
    const captionBox = canvas.getByText('Everything else overnight stayed inside your rules.').getBoundingClientRect();
    await expect(captionBox.top).toBeGreaterThanOrEqual(long.getBoundingClientRect().bottom);
    await expect(Math.abs(captionBox.left - line.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
  },
};
