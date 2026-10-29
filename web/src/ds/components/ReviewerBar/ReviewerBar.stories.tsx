import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ReviewerBar } from './ReviewerBar.tsx';

const meta = {
  title: 'Layout/ReviewerBar',
  component: ReviewerBar,
  args: { ownerName: rivera.business.ownerName, onStartOver: fn() },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Reviewer-Arrival',
    canvasNote:
      "The board says “You're Maria today.”; the bar names the owner as the business shows them (owner_display_name) and leaves out the board's info icon, which repeats the words.",
  },
} satisfies Meta<typeof ReviewerBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A quiet note above the app, full width, on the muted fill with a hairline under it.
    const bar = canvas.getByRole('note');
    await expect(bar).toHaveTextContent("You're Maria Rivera today. This is a concept prototype.Start over");
    expectComputed(bar, {
      height: '36px',
      backgroundColor: 'rgb(46, 44, 38)',
      borderBottomWidth: '1px',
      borderBottomColor: 'rgba(250, 249, 245, 0.12)',
      fontSize: '13px',
      lineHeight: '18px',
    });
    await expect(bar.getBoundingClientRect().width).toBe(document.documentElement.clientWidth);
    // The owner's name is a name someone chose, shown as written.
    await expect(canvas.getByText(rivera.business.ownerName)).toHaveAttribute('data-copy', 'user');
    expectComputed(canvas.getByText('This is a concept prototype.'), { color: 'rgba(250, 249, 245, 0.64)' });

    // Start over is a ghost button, reached and pressed from the keyboard.
    const startOver = canvas.getByRole('button', { name: 'Start over' });
    expectComputed(startOver, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    await userEvent.tab();
    await expect(startOver).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onStartOver).toHaveBeenCalledTimes(1);
  },
};
