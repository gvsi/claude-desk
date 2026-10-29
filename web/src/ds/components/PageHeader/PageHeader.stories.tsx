import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from '../Button/Button.tsx';
import { PageHeader } from './PageHeader.tsx';

const runCheck = fn();

const meta = {
  title: 'Layout/PageHeader',
  component: PageHeader,
  args: { title: 'Safety' },
  // The page's content column, as on the board.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-content)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Safety' },
} satisfies Meta<typeof PageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithAction: Story = {
  args: {
    subtitle: 'Every attempt to get around your rules, and what stopped it.',
    actions: (
      <Button variant="secondary" onClick={runCheck}>
        Run a safety check
      </Button>
    ),
  },
  parameters: {
    canvasNote: "The board's serif summary under the title is the page's own content; the header holds the title, a one-line subtitle and the action.",
  },
  play: async ({ canvas, userEvent }) => {
    // The page's one h1: serif page-title, left-aligned, in the primary text color.
    const title = canvas.getByRole('heading', { level: 1, name: 'Safety' });
    expectComputed(title, {
      fontFamily: /Source Serif 4/,
      fontSize: '24px',
      lineHeight: '32px',
      fontWeight: '460',
      textAlign: 'start',
      color: 'rgba(250, 249, 245, 0.92)',
      marginTop: '0px',
    });
    await expect(canvas.getAllByRole('heading')).toEqual([title]);

    const subtitle = canvas.getByText('Every attempt to get around your rules, and what stopped it.');
    expectComputed(subtitle, { fontFamily: /Hanken Grotesk/, fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(subtitle.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);

    // The action sits at the right end of the title's line.
    const action = canvas.getByRole('button', { name: 'Run a safety check' });
    const header = title.closest('header');
    if (!header) throw new Error('the title is not inside a header');
    await expect(Math.abs(header.getBoundingClientRect().right - action.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    const titleBox = title.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    await expect(Math.abs(actionBox.top + actionBox.height / 2 - (titleBox.top + titleBox.height / 2))).toBeLessThanOrEqual(1);
    await userEvent.click(action);
    await expect(runCheck).toHaveBeenCalledTimes(1);
  },
};
