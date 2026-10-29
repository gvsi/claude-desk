import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { StatusDot, StatusLabel, type StatusTone } from './StatusDot.tsx';

const meta = {
  title: 'Status/StatusDot',
  component: StatusDot,
  args: { tone: 'handled' },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof StatusDot>;

export default meta;

type Story = StoryObj<typeof meta>;

const TONES: readonly { tone: StatusTone; word: string }[] = [
  { tone: 'handled', word: 'Handled' },
  { tone: 'held', word: 'Needs you' },
  { tone: 'refused', word: 'Blocked' },
  { tone: 'info', word: 'Info' },
];

export const AllTones: Story = {
  parameters: {
    canvasNote: 'The board shows the held and handled dots; blocked and info use the same 6 px dot, info hollow.',
  },
  render: () => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-12)' }}>
      {TONES.map(({ tone, word }) => (
        <li key={tone}>
          <StatusLabel tone={tone}>{word}</StatusLabel>
        </li>
      ))}
    </ul>
  ),
  play: async ({ canvas, canvasElement }) => {
    // Status is never color alone: each dot sits beside the word that says the same thing.
    for (const { word } of TONES) await expect(canvas.getByText(word)).toBeVisible();
    const dots = [...canvasElement.querySelectorAll('.cd-status-dot')];
    await expect(dots).toHaveLength(TONES.length);
    for (const dot of dots) await expect(dot).toHaveAttribute('aria-hidden', 'true');
    // Four tones, four different dots.
    const looks = dots.map((dot) => {
      const style = getComputedStyle(dot);
      return `${style.backgroundColor} ${style.borderTopColor}`;
    });
    await expect(new Set(looks).size).toBe(TONES.length);
  },
};
