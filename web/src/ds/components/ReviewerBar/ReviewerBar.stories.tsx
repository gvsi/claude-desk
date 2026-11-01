import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { loadWebFonts } from '../../test/fonts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ReviewerBarSkeleton as ReviewerShapes } from './ReviewerBarSkeleton.tsx';
import { ReviewerBar } from './ReviewerBar.tsx';

const meta = {
  title: 'Layout/ReviewerBar',
  component: ReviewerBar,
  args: { ownerName: rivera.business.ownerName, onStartOver: fn() },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Today-Run1',
  },
} satisfies Meta<typeof ReviewerBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A quiet note above the app, full width, on the muted fill with a hairline under it.
    const bar = canvas.getByRole('note');
    await expect(bar).toHaveTextContent("You're Mike Turner today. This is a concept prototype.Start over");
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

export const ReviewerBarSkeleton: Story = {
  beforeEach: loadWebFonts,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'P12-01, UXC-P1201-After (#artboard-dec46cf506e4): the demo bar uses its real line boxes.' },
  render: (args) => (
    <div>
      <div data-real-bar>
        <ReviewerBar {...args} />
      </div>
      <div data-shaped-bar aria-hidden="true">
        <ReviewerShapes ownerName={args.ownerName} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const real = canvasElement.querySelector<HTMLElement>('[data-real-bar]')!;
    const shapes = canvasElement.querySelector<HTMLElement>('[data-shaped-bar]')!;
    for (const [aSelector, bSelector] of [
      ['.cd-reviewer-bar', '.cd-reviewer-bar'],
      ['.cd-button', '.cd-reviewer-bar > .cd-skeleton'],
    ]) {
      const a = real.querySelector(aSelector!)!.getBoundingClientRect();
      const b = shapes.querySelector(bSelector!)!.getBoundingClientRect();
      for (const [edge, delta] of [
        ['top', real.getBoundingClientRect().top - shapes.getBoundingClientRect().top],
        ['left', 0],
        ['width', 0],
        ['height', 0],
      ] as const) {
        await expect(Math.abs(a[edge] - b[edge] - delta), `${aSelector} ${edge}`).toBeLessThanOrEqual(2);
      }
    }
  },
};

export const ReviewerBarSkeletonPhone: Story = {
  ...ReviewerBarSkeleton,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'P12-01 phone, UXC-P1201-After-Phone (#artboard-1a93c5a1f31f): two lines keep the real demo bar height.',
  },
};
