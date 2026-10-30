import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { AttemptRow, type AttemptRowProps } from './AttemptRow.tsx';

/** Each segment's state, first to last: passed, stopped or not reached. */
function segmentStates(link: HTMLElement): string[] {
  const meter = link.querySelector('.cd-checkpoint-meter__segments');
  if (!meter) throw new Error('no checkpoint meter');
  return [...meter.children].map((segment) => {
    const state = [...segment.classList].find((name) => name.startsWith('cd-checkpoint-meter__segment--'));
    return state?.replace('cd-checkpoint-meter__segment--', '') ?? 'none';
  });
}

/**
 * stopped_by_is_text: the checkpoint that stopped it is visible words, read as "Stopped by: …" in
 * the row's name; the four-segment meter beside them is hidden from screen readers.
 */
async function expectStoppedBy(link: HTMLElement, checkpoint: string, states: string[]) {
  const name = within(link).getByText(checkpoint);
  await expect(name).toBeVisible();
  await expect(name.closest('[aria-hidden="true"]')).toBeNull();
  await expect(link).toHaveAccessibleName(new RegExp(`Stopped by: ${checkpoint}$`));
  const meter = link.querySelector('.cd-checkpoint-meter__segments');
  await expect(meter).toHaveAttribute('aria-hidden', 'true');
  await expect(segmentStates(link)).toEqual(states);
  // Only the stopping segment carries the refused color, as a 6 px dot.
  const stopped = link.querySelector('.cd-checkpoint-meter__segment--stopped') as HTMLElement;
  expectComputed(stopped, { backgroundColor: 'rgb(220, 130, 144)', width: '6px', height: '6px' });
}

const meta = {
  title: 'Safety/AttemptRow',
  component: AttemptRow,
  args: {
    time: '9:52 am',
    title: "Asked for Raj Patel's invoice",
    who: 'From chat',
    stoppedBy: 'action',
    href: '#safety/dec-raj-invoice',
  },
  // The board's attempts list: one link per attempt, in a list.
  render: (args: AttemptRowProps) => (
    <ul style={{ width: 560, maxWidth: '100%', margin: 0, padding: 0, listStyle: 'none' }}>
      <li>
        <AttemptRow {...args} />
      </li>
    </ul>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Safety-Run1',
    canvasNote:
      "The board's meter puts the reply checkpoint before the auto reviewer; it follows the order the checks run here: who's asking, the action checkpoint, the auto reviewer, then the reply checkpoint. Times are the screen's strings, so the time column is wider than the board's.",
  },
} satisfies Meta<typeof AttemptRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActionCheckpoint: Story = {
  play: async ({ args, canvas }) => {
    const link = canvas.getByRole('link', { name: /^9:52 am Asked for Raj Patel's invoice From chat/ });
    await expect(link).toHaveAttribute('href', args.href);
    await expect(link).not.toHaveAttribute('aria-current');
    await expectStoppedBy(link, 'Action checkpoint', ['passed', 'stopped', 'unreached', 'unreached']);

    // The board's grid: time, what they tried and who, then the checkpoint, on one row.
    expectComputed(link, { borderTopLeftRadius: '8px', minHeight: '50px', backgroundColor: 'rgba(0, 0, 0, 0)' });
    const time = canvas.getByText('9:52 am');
    const title = canvas.getByText("Asked for Raj Patel's invoice");
    const checkpoint = canvas.getByText('Action checkpoint');
    expectComputed(time, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)', fontVariantNumeric: 'tabular-nums' });
    expectComputed(title, { fontSize: '14px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText('From chat'), { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(checkpoint, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(time.getBoundingClientRect().right).toBeLessThan(title.getBoundingClientRect().left);
    await expect(title.getBoundingClientRect().right).toBeLessThan(checkpoint.getBoundingClientRect().left);
  },
};

export const ReplyCheckpoint: Story = {
  args: {
    time: '11:22 am',
    title: 'Pushed for a same-day guarantee',
    who: 'From chat',
    stoppedBy: 'reply',
    href: '#safety/msg-same-day',
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: /^11:22 am Pushed for a same-day guarantee From chat/ });
    await expectStoppedBy(link, 'Reply checkpoint', ['passed', 'passed', 'passed', 'stopped']);
  },
};

export const Current: Story = {
  args: {
    time: '12:24 am',
    title: 'Posed as you to get the customer list',
    who: 'From the chat service',
    stoppedBy: 'who',
    href: '#safety/dec-customer-list',
    current: true,
  },
  play: async ({ canvas }) => {
    // The attempt open beside the list is marked current, on the selected fill.
    const link = canvas.getByRole('link', { name: /^12:24 am Posed as you to get the customer list/ });
    await expect(link).toHaveAttribute('aria-current', 'true');
    expectComputed(link, { backgroundColor: 'rgb(60, 57, 47)' });
    await expectStoppedBy(link, "Who's asking", ['stopped', 'unreached', 'unreached', 'unreached']);
  },
};
