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

export const Caps: Story = {
  args: { caps: true, children: 'Preview' },
  parameters: {
    canvasNote:
      'No board draws the Pill in capitals alone; the owner signed it on 2026-10-30 as the "Preview" badge in the Claude Desk lockup, beside the wordmark, its only use.',
  },
  play: async ({ canvas }) => {
    // caps_pill_is_the_preview_badge: the same outline, the word written in sentence case and drawn
    // in small, slightly spaced capitals by its type style, marked as the one all-caps label.
    const pill = canvas.getByText('Preview');
    await expect(pill).toHaveAttribute('data-ds', 'preview-badge');
    await expect(getComputedStyle(pill).borderTopStyle).toBe('solid');
    await expect(getComputedStyle(pill).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await expect(getComputedStyle(pill).height).toBe('20px');
    await expect(pill.classList.contains('cd-type-badge-caps')).toBe(true);
    await expect(getComputedStyle(pill).textTransform).toBe('uppercase');
  },
};
