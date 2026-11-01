import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { ChainStatus } from './ChainStatus.tsx';

const { verified, broken } = rivera.ledger;

/** The header's one status dot. */
function dotIn(root: HTMLElement): Element {
  const dots = root.querySelectorAll('.cd-status-dot');
  if (dots.length !== 1) throw new Error(`expected one status dot, found ${dots.length}`);
  return dots[0] as Element;
}

const meta = {
  title: 'Safety/ChainStatus',
  component: ChainStatus,
  args: { chainOk: verified.chain_ok, firstBadSeq: verified.first_bad_seq, entries: verified.entries.length, devKey: true },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 'var(--size-content)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'padded',
    canvas: 'N-Safety-Run1',
    canvasNote:
      "The board has no header for every entry; this one follows the board's status dots and count pills, over the list Plan 04 adds.",
  },
} satisfies Meta<typeof ChainStatus>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Ok: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('Every entry matches the chain')).toBeVisible();
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--handled');
    // The count is a pill that reads as words.
    const count = canvas.getByRole('img', { name: '3 entries' });
    await expect(count).toHaveTextContent('3');
    // The signing key sits at the end of the line, apart from the status.
    const key = canvas.getByText('Signed with a development key');
    await expect(key).toBeVisible();
    const header = canvasElement.querySelector('.cd-chain-status');
    if (!header) throw new Error('no chain status');
    await expect(Math.round(key.getBoundingClientRect().right)).toBe(Math.round(header.getBoundingClientRect().right));
  },
};

export const Broken: Story = {
  args: { chainOk: broken.chain_ok, firstBadSeq: broken.first_bad_seq, entries: broken.entries.length, devKey: false },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Entry 2 doesn't match the chain")).toBeVisible();
    await expect(canvas.queryByText('Every entry matches the chain')).toBeNull();
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--refused');
    await expect(canvas.getByRole('img', { name: '3 entries' })).toBeVisible();
    await expect(canvas.queryByText('Signed with a development key')).toBeNull();
  },
};

export const NotChecked: Story = {
  args: { chainOk: null, firstBadSeq: null, entries: 1, devKey: false },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('Not checked yet')).toBeVisible();
    await expect(dotIn(canvasElement)).toHaveClass('cd-status-dot--info');
    await expect(canvas.getByRole('img', { name: '1 entry' })).toHaveTextContent('1');
  },
};
