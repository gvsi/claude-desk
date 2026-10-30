import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { CountPill } from './CountPill.tsx';

const meta = {
  title: 'Status/CountPill',
  component: CountPill,
  args: { count: 2, label: '2 need you' },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof CountPill>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas }) => {
    // The number is what a sighted person sees; the label is what a screen reader says.
    const pill = canvas.getByRole('img', { name: args.label });
    await expect(pill).toHaveAccessibleName('2 need you');
    await expect(pill).toHaveTextContent(/^2$/);
  },
};
