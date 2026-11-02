import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { RecordedHistoryLink } from './RecordedHistoryLink.tsx';

/** Where the screens send it: the ledger's "Recorded history, replayed into your copy". */
const LEDGER_EXPLANATION = '#safety/recorded-history';

const meta = {
  title: 'Recorded history/RecordedHistoryLink',
  component: RecordedHistoryLink,
  args: { href: LEDGER_EXPLANATION },
  // Drawn on every recorded-history board, and twice on Today (N-Today-Run1).
  parameters: { layout: 'padded', canvas: 'N-History-Conversations' },
} satisfies Meta<typeof RecordedHistoryLink>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas }) => {
    // One link, named by its words, to the ledger's explanation the screen passes.
    const link = canvas.getByRole('link', { name: 'Includes recorded history' });
    await expect(link).toHaveAttribute('href', args.href);
    await expect(link).not.toHaveAttribute('target');

    // Caption type in secondary ink, underlined in line-control, 3 px under the words.
    expectComputed(link, {
      fontSize: '13px',
      lineHeight: '18px',
      fontWeight: '380',
      color: 'rgba(250, 249, 245, 0.64)',
      textDecorationLine: 'underline',
      textDecorationColor: 'rgba(250, 249, 245, 0.22)',
      textDecorationThickness: '1px',
      textUnderlineOffset: '3px',
    });
    // On hover the words turn primary (text-primary). The play's pointer events are synthetic and
    // never match :hover, so that is checked by eye in a browser, with a real pointer.
  },
};
