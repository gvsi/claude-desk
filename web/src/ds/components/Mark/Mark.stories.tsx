import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { Mark as DeskMark, Wordmark } from './Mark.tsx';
import { MARK_GEOMETRY } from './markGeometry.ts';

const meta = {
  title: 'Layout/Mark',
  component: DeskMark,
  args: { size: 20 },
  parameters: { layout: 'padded', canvas: 'N-Today-Run1' },
} satisfies Meta<typeof DeskMark>;

export default meta;

type Story = StoryObj<typeof meta>;

const SIZES = [16, 20, 24] as const;

export const Mark: Story = {
  parameters: { canvasNote: 'The board draws the mark at 20 px in the sidebar; the 16 and 24 px sizes are shown beside it.' },
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-16)' }}>
      {SIZES.map((size) => (
        <DeskMark key={size} size={size} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const marks = [...canvasElement.querySelectorAll<SVGSVGElement>('svg.cd-mark')];
    await expect(marks.map((mark) => mark.getAttribute('width'))).toEqual(['16', '20', '24']);
    for (const mark of marks) {
      await expect(mark).toHaveAttribute('aria-hidden', 'true');
      await expect(mark).toHaveAttribute('focusable', 'false');
      await expect(mark).toHaveAttribute('viewBox', '0 0 100 100');
      // The white tile with its hairline edge, then the bell inside it: the clay dome, then the ink
      // drawn over it, in the mark's fixed colors.
      const tile = mark.querySelector(':scope > rect.cd-mark__tile');
      const art = mark.querySelector(':scope > g');
      const groups = [...(art?.children ?? [])].map((group) => group.getAttribute('class'));
      await expect(groups).toEqual(['cd-mark__clay', 'cd-mark__ink']);
      const clay = art?.querySelector(':scope > .cd-mark__clay');
      const ink = art?.querySelector(':scope > .cd-mark__ink');
      await expect(tile).not.toBeNull();
      await expect(art).toHaveAttribute('transform', MARK_GEOMETRY.art);
      expectComputed(tile as Element, { fill: 'rgb(255, 255, 255)', stroke: 'rgba(20, 20, 19, 0.1)' });
      expectComputed(clay as Element, { fill: 'rgb(217, 119, 87)' });
      expectComputed(ink as Element, { fill: 'rgb(20, 20, 19)' });
      // One clay blob; six ink strokes, each with a round dot at both ends, as the drawing has them.
      await expect([...(clay?.children ?? [])].map((shape) => shape.getAttribute('d'))).toEqual([...MARK_GEOMETRY.clay]);
      await expect(ink?.querySelectorAll(':scope > path')).toHaveLength(6);
      await expect(ink?.querySelectorAll(':scope > circle')).toHaveLength(12);
      await expect(ink?.children).toHaveLength(MARK_GEOMETRY.ink.length);
    }
  },
};

export const WithWordmark: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-10)' }}>
      <span style={{ display: 'flex', marginTop: 'var(--space-2)' }}>
        <DeskMark size={20} />
      </span>
      <Wordmark beta />
    </div>
  ),
  play: async ({ canvas }) => {
    const name = canvas.getByText('Claude Desk');
    await expect(getComputedStyle(name).fontFamily).toMatch(/^"Source Serif 4"/);
    await expect(canvas.getByText('Beta')).toBeVisible();
  },
};
