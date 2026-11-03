import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { VisionBar } from './VisionBar.tsx';

const LINE = 'Vision, not in the prototype. Nothing here is live.';

const meta = {
  title: 'Layout/VisionBar',
  component: VisionBar,
  args: { backHref: '#vision' },
  parameters: { layout: 'fullscreen', canvas: 'N-R2-Vision-TeamDesk' },
} satisfies Meta<typeof VisionBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    // vision_bar_labels_the_page: a quiet note across the top, 40 px on the panel with a hairline under it.
    const bar = canvas.getByRole('note', { name: 'Vision' });
    await expect(bar.getBoundingClientRect().width).toBe(document.documentElement.clientWidth);
    expectComputed(bar, {
      height: '40px',
      paddingLeft: '24px',
      paddingRight: '24px',
      columnGap: '12px',
      backgroundColor: 'rgb(34, 34, 32)',
      borderBottomWidth: '1px',
      borderBottomColor: 'rgba(250, 249, 245, 0.12)',
    });

    // The "Vision" pill first, then the line 12 px after it, in secondary meta.
    const pill = within(bar).getByText('Vision');
    await expect(pill).toHaveClass('cd-pill');
    const line = within(bar).getByText(LINE);
    expectComputed(line, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(line.getBoundingClientRect().left - pill.getBoundingClientRect().right)).toBe(12);
    await expect(bar).toHaveTextContent(`Vision${LINE}Back to Vision`);

    // "Back to Vision" is a link at the right edge, 24 px in, in meta, and the bar's one tab stop.
    const back = within(bar).getByRole('link', { name: 'Back to Vision' });
    await expect(back).toHaveAttribute('href', '#vision');
    expectComputed(back, { fontSize: '14px', color: 'rgb(126, 174, 218)' });
    await expect(Math.round(bar.getBoundingClientRect().right - back.getBoundingClientRect().right)).toBe(24);
    await userEvent.tab();
    await expect(back).toHaveFocus();
  },
};

/** On a phone the line wraps, with 16 px gutters, and the link drops under it. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'The vision boards draw the bar at a laptop’s width only (N-R2-Vision-Phone draws phones inside a laptop page); on a phone its line wraps.',
  },
  play: async ({ canvas }) => {
    const bar = canvas.getByRole('note', { name: 'Vision' });
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    expectComputed(bar, { paddingLeft: '16px', paddingRight: '16px' });
    // Nothing is clipped: the line and the link stay inside the bar.
    const back = within(bar).getByRole('link', { name: 'Back to Vision' });
    const line = within(bar).getByText(LINE);
    for (const part of [line, back]) {
      await expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(bar.getBoundingClientRect().right - 16);
    }
    await expect(bar.getBoundingClientRect().height).toBeGreaterThan(40);
  },
};
