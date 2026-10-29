import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { SectionHeader } from './SectionHeader.tsx';

const meta = {
  title: 'Layout/SectionHeader',
  component: SectionHeader,
  args: { title: 'Needs you' },
  parameters: { layout: 'padded', canvas: 'N-Today-NeedsYou' },
} satisfies Meta<typeof SectionHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithCountAndCaption: Story = {
  args: {
    count: { n: 2, label: '2 things need you' },
    caption: 'Everything else overnight stayed inside your rules.',
  },
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole('heading', { level: 2, name: 'Needs you' });
    expectComputed(heading, { fontSize: '15px', lineHeight: '20px', fontWeight: '520' });
    // The count is read as what it means, not as a bare number.
    await expect(canvas.getByRole('img', { name: '2 things need you' })).toHaveTextContent('2');
    const caption = canvas.getByText('Everything else overnight stayed inside your rules.');
    expectComputed(caption, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    // The caption sits at the right end of the heading's line.
    const headingBox = heading.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const lineBox = canvasElement.querySelector('.cd-section-header')?.getBoundingClientRect();
    await expect(captionBox.left).toBeGreaterThan(headingBox.right);
    await expect(Math.abs((lineBox?.right ?? 0) - captionBox.right)).toBeLessThanOrEqual(1);
    await expect(Math.abs(captionBox.top + captionBox.height / 2 - (headingBox.top + headingBox.height / 2))).toBeLessThanOrEqual(2);
  },
};
