import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { Button } from './Button.tsx';

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
