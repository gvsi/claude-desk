import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Pill } from './Pill.tsx';

const meta = {
  title: 'Status/Pill',
  component: Pill,
  args: { children: 'Public' },
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof Pill>;

export default meta;

type Story = StoryObj<typeof meta>;

const LEVELS = ['Public', 'Verified', 'Agent'] as const;

export const Levels: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
      {LEVELS.map((level) => (
        <Pill key={level}>{level}</Pill>
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    for (const level of LEVELS) {
      const pill = canvas.getByText(level);
      // Outlined, never filled: a level is a word in a thin outline.
      await expect(getComputedStyle(pill).borderTopStyle).toBe('solid');
      await expect(getComputedStyle(pill).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
  },
};
