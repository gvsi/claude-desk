import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { TextLink } from './TextLink.tsx';

const meta = {
  title: 'Actions/TextLink',
  component: TextLink,
  args: { href: '#rule-discounts', children: 'See rule' },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof TextLink>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'See rule' });
    await expect(link).toHaveAttribute('href', '#rule-discounts');
    await expect(link).not.toHaveAttribute('target');
    await expect(link).not.toHaveAttribute('rel');
  },
};

export const External: Story = {
  args: { href: 'https://www.w3.org/TR/WCAG22/#contrast-minimum', children: 'Read the contrast guidance', external: true },
  parameters: { canvasNote: 'The board’s links stay in the app; an external link opens a new tab.' },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Read the contrast guidance' });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
  },
};
