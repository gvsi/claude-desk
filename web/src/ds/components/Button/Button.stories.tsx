import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Button } from './Button.tsx';

/** The signed-off deny answers: the refused rose at 16% behind #eba3ae words. */
const DANGER_FILL = 'rgba(220, 130, 144, 0.16)';
const DANGER_TEXT = 'rgb(235, 163, 174)';
const ANSWERS_NOTE =
  "The signed-off answer boards (N-Answers-Final, N-Answers-Verified) replace this board's four secondary answers: Deny this time is the soft red danger button, Deny always the red-text danger-ghost.";

const meta = {
  title: 'Actions/Button',
  component: Button,
  args: { variant: 'secondary', children: 'Allow this time', onClick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { variant: 'primary', children: 'Send counter-offer' },
  play: async ({ args, canvas, userEvent }) => {
    // The control for Disabled and Busy: an enabled button does call its handler.
    await userEvent.click(canvas.getByRole('button', { name: 'Send counter-offer' }));
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const Secondary: Story = {};

export const Ghost: Story = {
  args: { variant: 'ghost', children: 'Start over' },
};

export const Main: Story = {
  args: { variant: 'primary', size: 'main', children: 'Join the chat' },
};

export const Disabled: Story = {
  args: { disabled: true },
  parameters: { canvasNote: 'The board shows no disabled button; this is the approval button while it cannot be used.' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Allow this time' });
    await expect(button).toBeDisabled();
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Busy: Story = {
  args: { variant: 'primary', busy: true, children: 'Send counter-offer' },
  parameters: { canvasNote: 'The board shows no button mid-request; this is the counter-offer button while it sends.' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Send counter-offer' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const AsLink: Story = {
  args: { href: '/pay/k7Hq2vX9', children: 'Open payment page' },
  parameters: { canvasNote: 'The board has no link styled as a button; payment and document cards end with one.' },
  play: async ({ canvas }) => {
    const links = canvas.getAllByRole('link');
    await expect(links).toHaveLength(1);
    await expect(links[0]).toHaveAccessibleName('Open payment page');
    await expect(links[0]).toHaveAttribute('href', '/pay/k7Hq2vX9');
    await expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const Danger: Story = {
  args: { variant: 'danger', size: 'main', children: 'Deny this time' },
  parameters: { canvasNote: ANSWERS_NOTE },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    expectComputed(button, { backgroundColor: DANGER_FILL, color: DANGER_TEXT, fontWeight: '420', height: '40px', opacity: '1' });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const DangerGhost: Story = {
  args: { variant: 'danger-ghost', size: 'main', children: 'Deny always' },
  parameters: { canvasNote: ANSWERS_NOTE },
  play: async ({ canvas }) => {
    expectComputed(canvas.getByRole('button', { name: 'Deny always' }), {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      color: DANGER_TEXT,
      fontWeight: '420',
      height: '40px',
    });
  },
};

export const DangerBusy: Story = {
  args: { variant: 'danger', size: 'main', busy: true, children: 'Deny this time' },
  parameters: {
    canvasNote: `${ANSWERS_NOTE} No board shows it mid-request; it fades to 80%, less than the neutral buttons, so its red words still read at 4.5:1.`,
  },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    expectComputed(button, { backgroundColor: DANGER_FILL, color: DANGER_TEXT, opacity: '0.8' });
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const DangerDisabled: Story = {
  args: { variant: 'danger', size: 'main', disabled: true, children: 'Deny this time' },
  parameters: { canvasNote: `${ANSWERS_NOTE} No board shows it disabled; it dims like every disabled button and keeps its fill.` },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Deny this time' });
    await expect(button).toBeDisabled();
    expectComputed(button, { backgroundColor: DANGER_FILL, opacity: '0.4' });
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};
