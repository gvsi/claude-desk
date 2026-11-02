import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { RecordedNote } from './RecordedNote.tsx';

const LINE = 'Recorded history, replayed into your copy. It happened before you arrived.';

/** The note's parts: its icon and its words. */
function partsOf(canvasElement: HTMLElement): { note: HTMLElement; icon: SVGSVGElement; words: HTMLElement } {
  const note = canvasElement.querySelector<HTMLElement>('.cd-recorded-note');
  const icon = note?.querySelector('svg');
  const words = note?.querySelector<HTMLElement>('.cd-recorded-note__text');
  if (!note || !icon || !words) throw new Error('the note, its icon or its words are missing');
  return { note, icon, words };
}

const meta = {
  title: 'Recorded history/RecordedNote',
  component: RecordedNote,
  parameters: { layout: 'padded', canvas: 'N-History-Conversations' },
} satisfies Meta<typeof RecordedNote>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  // A conversation's reading column, where the note sits under the open conversation's head.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-reading)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText(LINE)).toBeVisible();
    const { note, icon, words } = partsOf(canvasElement);
    await expect(note.tagName).toBe('P');
    await expect(note).toHaveTextContent(LINE);

    // Caption type in secondary ink; the 14 px history icon, hidden from screen readers, 2 px
    // down so it sits on the first line, 6 px before the words.
    expectComputed(note, { fontSize: '13px', lineHeight: '18px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.64)', columnGap: '6px' });
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon.getBoundingClientRect().height).toBe(14);
    expectComputed(icon, { marginTop: '2px' });
    await expect(Math.round(icon.getBoundingClientRect().top - note.getBoundingClientRect().top)).toBe(2);
    await expect(Math.round(words.getBoundingClientRect().left - icon.getBoundingClientRect().right)).toBe(6);
  },
};

export const Wrapped: Story = {
  parameters: { canvas: 'N-History-Safety', canvasNote: 'The line alone at the opened attempt’s inner width, where the board draws it inside the card.' },
  // An attempt's detail card, narrow enough that the line wraps as the Safety board draws it.
  decorators: [
    (Story) => (
      <div style={{ width: 358, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const { icon, words } = partsOf(canvasElement);
    // Two lines, the second under the words, not under the icon; the icon stays on the first.
    await expect(Math.round(words.getBoundingClientRect().height)).toBe(34);
    const lines = [...words.getClientRects()];
    await expect(Math.round(Math.min(...lines.map((line) => line.left)))).toBe(Math.round(words.getBoundingClientRect().left));
    await expect(icon.getBoundingClientRect().bottom).toBeLessThan(words.getBoundingClientRect().top + 17);
  },
};
