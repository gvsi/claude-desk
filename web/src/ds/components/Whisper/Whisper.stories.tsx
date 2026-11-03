import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Whisper } from './Whisper.tsx';

const whisperTurn = rivera.conversations.danaLive.turns.find((turn) => turn.kind === 'whisper');
const whisperText = whisperTurn?.kind === 'whisper' ? whisperTurn.text : '';

const meta = {
  title: 'Conversation/Whisper',
  component: Whisper,
  // The time is the owner screen's display string; the design system formats none.
  args: { caption: 'Your whisper, 12:08. Only Claude sees this.', text: whisperText },
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof Whisper>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const caption = canvasElement.querySelector('.cd-whisper__caption') as HTMLElement;
    await expect(caption).toHaveTextContent(/^Your whisper, 12:08\. Only Claude sees this\.$/);
    await expect(caption.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(caption, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    // The owner's words in a dashed bubble that hugs them, marked as their own words.
    const bubble = canvas.getByText(whisperText);
    await expect(bubble).toHaveAttribute('data-copy', 'user');
    expectComputed(bubble, {
      borderTopStyle: 'dashed',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.22)',
      borderTopLeftRadius: '12px',
      fontSize: '15px',
      backgroundColor: 'rgba(0, 0, 0, 0)',
    });
    await expect(bubble.getBoundingClientRect().width).toBeLessThan(canvasElement.getBoundingClientRect().width / 2);
  },
};
