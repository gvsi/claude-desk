import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { IconButton } from './IconButton.tsx';

const meta = {
  title: 'Actions/IconButton',
  component: IconButton,
  args: { label: 'Add a photo or file', icon: 'plus', onClick: fn() },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof IconButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Ghost: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const button = canvas.getByRole('button');
    await expect(button).toHaveAccessibleName(args.label);
    // The icon is drawn, never read: the label is the whole name.
    await expect(canvasElement.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const RoundPrimary: Story = {
  args: { label: 'Send', icon: 'send', variant: 'primary', shape: 'round' },
  play: async ({ args, canvas }) => {
    await expect(canvas.getByRole('button')).toHaveAccessibleName(args.label);
  },
};
