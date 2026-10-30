import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Mark as DeskMark, Wordmark } from './Mark.tsx';

const meta = {
  title: 'Layout/Mark',
  component: DeskMark,
  args: { size: 20 },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof DeskMark>;

export default meta;

type Story = StoryObj<typeof meta>;

const SIZES = [16, 20, 24] as const;

export const Mark: Story = {
  parameters: { canvasNote: 'The board draws the mark at 20 px in the sidebar; the 16 and 24 px sizes are shown beside it.' },
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-16)' }}>
      {SIZES.map((size) => (
        <DeskMark key={size} size={size} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const marks = [...canvasElement.querySelectorAll('svg')];
    await expect(marks.map((mark) => mark.getAttribute('width'))).toEqual(['16', '20', '24']);
    for (const mark of marks) {
      await expect(mark).toHaveAttribute('aria-hidden', 'true');
      await expect(mark).toHaveAttribute('viewBox', '0 0 20 20');
      // Clay (#e08968), the mark's only color.
      await expect(getComputedStyle(mark).stroke).toBe('rgb(224, 137, 104)');
    }
  },
};

export const WithWordmark: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-10)' }}>
      <span style={{ display: 'flex', marginTop: 'var(--space-2)' }}>
        <DeskMark size={20} />
      </span>
      <Wordmark beta />
    </div>
  ),
  play: async ({ canvas }) => {
    const name = canvas.getByText('Claude Desk');
    await expect(getComputedStyle(name).fontFamily).toMatch(/^"Source Serif 4"/);
    await expect(canvas.getByText('Beta')).toBeVisible();
  },
};
