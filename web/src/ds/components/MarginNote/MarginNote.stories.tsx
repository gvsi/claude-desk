import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { MarginNote } from './MarginNote.tsx';

const LEAD_SAVED = 'Name and phone saved to Customers as a new lead.';

const meta = {
  title: 'Conversation/MarginNote',
  component: MarginNote,
  args: { text: LEAD_SAVED, onOpen: fn() },
  // The conversation's reading column, where notes sit under their message.
  decorators: [
    (Story) => (
      <div style={{ width: 'var(--size-reading)', maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof MarginNote>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LeadSaved: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // An owner note that isn't a checkpoint result: the hollow dot, the owner screen's words.
    const note = canvas.getByRole('button', { name: `${LEAD_SAVED} Open the full trace.` });
    await expect(note).toHaveTextContent(LEAD_SAVED);
    const dot = canvasElement.querySelector('.cd-status-dot');
    if (!dot) throw new Error('no dot on the note');
    await expect(dot).toHaveClass('cd-status-dot--info');
    expectComputed(dot, { backgroundColor: 'rgba(0, 0, 0, 0)', borderTopWidth: '1px', borderTopStyle: 'solid' });
    expectComputed(note, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await userEvent.click(note);
    await expect(args.onOpen).toHaveBeenCalledTimes(1);
  },
};
