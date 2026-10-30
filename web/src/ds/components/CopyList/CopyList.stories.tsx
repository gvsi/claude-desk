import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { CopyList } from './CopyList.tsx';

/** Share's ready-made words for Rivera Plumbing, as the board writes them. */
const WORDS = [
  { title: 'Google profile', text: 'Questions, quotes and bookings, any time: desk.example/rivera. Answered by Claude, an AI, under Maria Rivera’s rules.' },
  { title: 'Email signature', text: 'Need a plumber? Ask Rivera Plumbing any time at desk.example/rivera (answered by Claude, an AI).' },
  {
    title: 'Voicemail',
    text: 'You’ve reached Rivera Plumbing. For quotes and bookings, visit desk.example slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Maria Rivera will call you back.',
  },
];

const meta = {
  title: 'Share/CopyList',
  component: CopyList,
  args: { label: 'Ready-made words', items: WORDS, onCopy: fn(async () => {}) },
  render: (args) => (
    <div style={{ maxWidth: 628 }}>
      <CopyList {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Share' },
} satisfies Meta<typeof CopyList>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReadyMadeWords: Story = {
  parameters: { canvasNote: 'Share’s ready-made words: each block’s name and words, with Copy at its right, in one card ruled between the rows.' },
  play: async ({ args, canvas, userEvent }) => {
    const list = canvas.getByRole('list', { name: 'Ready-made words' });
    await expect(list).toHaveAttribute('role', 'list');
    expectComputed(list, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.14)', borderTopLeftRadius: '12px', backgroundColor: 'rgba(250, 249, 245, 0.03)' });
    const rows = within(list).getAllByRole('listitem');
    // Each button reads "Copy", and is named for its block: "Copy Google profile".
    await expect(rows.map((row) => within(row).getByRole('button').getAttribute('aria-label') ?? within(row).getByRole('button').textContent)).toEqual(
      WORDS.map((words) => `Copy ${words.title}`),
    );
    await expect(rows.map((row) => row.querySelector('.cd-button__label')?.firstChild?.textContent)).toEqual(['Copy', 'Copy', 'Copy']);
    // Each row: padded 14 px by 16 px, ruled from the next; its name over its words, Copy at the top right.
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expectComputed(first, { paddingTop: '14px', paddingLeft: '16px' });
    expectComputed(second, { borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    const title = within(first).getByText('Google profile', { selector: 'p' });
    expectComputed(title, { fontSize: '14px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    const words = within(first).getByText(WORDS[0]!.text);
    expectComputed(words, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(words.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(4);
    const copy = within(first).getByRole('button', { name: 'Copy Google profile' });
    await expect(Math.round(copy.getBoundingClientRect().top)).toBe(Math.round(title.getBoundingClientRect().top) - 0);
    await expect(Math.round(first.getBoundingClientRect().right - copy.getBoundingClientRect().right)).toBe(16);
    // copy_goes_through_the_callback, with the block's words as they are.
    await userEvent.click(copy);
    await expect(args.onCopy).toHaveBeenCalledWith(WORDS[0]!.text);
    await waitFor(() => expect(within(first).getByRole('status')).toHaveTextContent(/^Copied\.$/));
  },
};

export const CopyFailed: Story = {
  args: {
    onCopy: fn(async () => {
      throw new Error('The clipboard is blocked');
    }),
  },
  parameters: { canvas: 'none', canvasNote: 'No board draws a failed copy on Share: the block’s words are selected and the row says so under them.' },
  play: async ({ canvas, userEvent }) => {
    const rows = within(canvas.getByRole('list', { name: 'Ready-made words' })).getAllByRole('listitem');
    const voicemail = rows[2] as HTMLElement;
    await userEvent.click(within(voicemail).getByRole('button', { name: 'Copy Voicemail' }));
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(WORDS[2]!.text));
    await expect(within(voicemail).getByRole('status')).toHaveTextContent(/^Couldn’t copy\. The text is selected, so you can copy it yourself\.$/);
  },
};
