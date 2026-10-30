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
  parameters: { layout: 'padded', canvas: 'N-Safety-Run1' },
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

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: {
    title: 'Connectors',
    subtitle: 'What Claude can reach, and the accounts behind it.',
    actions: <Button variant="secondary">Add a connector</Button>,
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'The Connectors page’s header on a phone, as the phone Connectors board (N-Conn-24-Phone-Connectors) draws it: the title with its action on one line, the subtitle under both. That board joins the reference boards with the Connectors page’s stories.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    const title = canvas.getByRole('heading', { level: 1, name: 'Connectors' });
    const action = canvas.getByRole('button', { name: 'Add a connector' });
    const subtitle = canvas.getByText('What Claude can reach, and the accounts behind it.');
    // The action stays on the title's line, at its right; the subtitle runs under both, 8 px under the title.
    await expect(action.getBoundingClientRect().top).toBe(title.getBoundingClientRect().top);
    await expect(action.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    await expect(Math.round(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(8);
    await expect(subtitle.getBoundingClientRect().right).toBeGreaterThan(action.getBoundingClientRect().left);
  },
};
