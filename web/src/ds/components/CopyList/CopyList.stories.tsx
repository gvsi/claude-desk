import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { CopyList } from './CopyList.tsx';

/** Share's ready-made words for Turner Plumbing, as the board writes them. */
const WORDS = [
  { title: 'Google profile', text: 'Questions, quotes and bookings, any time: desk.example/rivera. Answered by Claude, an AI, under Mike Turner’s rules.' },
  { title: 'Email signature', text: 'Need a plumber? Ask Turner Plumbing any time at desk.example/rivera (answered by Claude, an AI).' },
  {
    title: 'Voicemail',
    text: 'You’ve reached Turner Plumbing. For quotes and bookings, visit desk.example slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Mike Turner will call you back.',
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
    expectComputed(title, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    const words = within(first).getByText(WORDS[0]!.text);
    expectComputed(words, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)' });
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
    await expect(within(voicemail).getByRole('status')).toHaveTextContent(/^Copy didn’t work\. The text is selected, so copy it yourself\.$/);
  },
};

/** A business and an owner whose names the voice rules would flag if they were the list's own words. */
const BUSINESS = 'AAA Plumbing';
const OWNER = 'JJ Okafor';
const theirs = (name: string) => <bdi data-copy="user">{name}</bdi>;

export const MarkedNames: Story = {
  name: 'Names marked as theirs',
  args: {
    items: [
      {
        title: 'Email signature',
        text: <>Need a plumber? Ask {theirs(BUSINESS)} any time at desk.example/aaa (answered by Claude, an AI).</>,
      },
      {
        title: 'Voicemail',
        text: (
          <>
            You’ve reached {theirs(BUSINESS)}. For quotes and bookings, visit desk.example slash aaa, where Claude, an AI, answers any time. For an
            emergency, leave a message and {theirs(OWNER)} will call you back.
          </>
        ),
      },
    ],
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Share’s ready-made words for a business whose names have capitals: the words are the screen’s, with each name in them marked as user text.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // copy_list_names_are_user_text: each name inside the words is marked, and Copy copies the words
    // exactly as they read, names and all, as plain text.
    const rows = within(canvas.getByRole('list', { name: 'Ready-made words' })).getAllByRole('listitem') as HTMLElement[];
    const signature = 'Need a plumber? Ask AAA Plumbing any time at desk.example/aaa (answered by Claude, an AI).';
    const voicemail =
      'You’ve reached AAA Plumbing. For quotes and bookings, visit desk.example slash aaa, where Claude, an AI, answers any time. For an emergency, leave a message and JJ Okafor will call you back.';
    const [first, second] = rows as [HTMLElement, HTMLElement];
    const firstWords = first.querySelector('.cd-copy-list__words');
    const secondWords = second.querySelector('.cd-copy-list__words');
    await expect(firstWords).toHaveTextContent(signature, { normalizeWhitespace: false });
    await expect([...(firstWords?.querySelectorAll('[data-copy="user"]') ?? [])].map((el) => el.textContent)).toEqual([BUSINESS]);
    await expect([...(secondWords?.querySelectorAll('[data-copy="user"]') ?? [])].map((el) => el.textContent)).toEqual([BUSINESS, OWNER]);
    await userEvent.click(within(first).getByRole('button', { name: 'Copy Email signature' }));
    await expect(args.onCopy).toHaveBeenLastCalledWith(signature);
    await userEvent.click(within(second).getByRole('button', { name: 'Copy Voicemail' }));
    await expect(args.onCopy).toHaveBeenLastCalledWith(voicemail);
  },
};

export const LineBreakAndHiddenWords: Story = {
  name: 'Words with a line break and hidden words',
  args: {
    items: [
      {
        title: 'Business card',
        text: (
          <>
            Ask {theirs(BUSINESS)} any time at desk.example/aaa.
            <br />
            Answered by Claude, an AI.<span className="cd-sr-only"> The link opens a chat.</span>
          </>
        ),
      },
    ],
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Share’s ready-made words with a line break and words only a screen reader hears: Copy copies what is shown, the line break included and the hidden words left out.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // copy_list_copies_what_is_shown: the line break comes through as one, and words a screen reader
    // hears but nobody sees aren't copied.
    const row = within(canvas.getByRole('list', { name: 'Ready-made words' })).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: 'Copy Business card' }));
    await expect(args.onCopy).toHaveBeenLastCalledWith('Ask AAA Plumbing any time at desk.example/aaa.\nAnswered by Claude, an AI.');
  },
};
