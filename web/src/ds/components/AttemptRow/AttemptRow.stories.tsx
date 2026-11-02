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

    // A live attempt carries no Recorded tag, and one with no reason given no label.
    await expect(canvas.queryByText('Recorded')).toBeNull();
    await expect(link.querySelector('.cd-recorded-tag')).toBeNull();
    await expect(link.querySelector('.cd-status-label')).toBeNull();
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

export const Recorded: Story = {
  args: {
    time: 'Yesterday, 10:10 pm',
    title: 'Asked for your number in plain digits, not a card',
    who: 'Recorded by your Desk as it happened',
    stoppedBy: 'reply',
    href: '#safety/msg-plain-digits',
    recorded: true,
  },
  parameters: {
    canvas: 'N-History-Safety',
    canvasNote: 'One replayed attempt, as the board marks it: the Recorded tag 10 px after where it came from. The board lists it with four others.',
  },
  play: async ({ canvas }) => {
    // The tag's word joins the row's name, before the checkpoint that stopped it.
    const link = canvas.getByRole('link', { name: /^Yesterday, 10:10 pm Asked for your number in plain digits, not a card Recorded by your Desk as it happened Recorded Stopped by/ });
    await expectStoppedBy(link, 'Reply checkpoint', ['passed', 'passed', 'passed', 'stopped']);
    const tag = within(link).getByText('Recorded');
    await expect(tag).toHaveTextContent(/^Recorded$/);
    await expect(tag.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(tag, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)', whiteSpace: 'nowrap' });

    // On the line of where it came from, 10 px after it, its words on the same baseline.
    const who = within(link).getByText('Recorded by your Desk as it happened');
    const whoBox = who.getBoundingClientRect();
    const tagBox = tag.getBoundingClientRect();
    await expect(Math.round(tagBox.left - whoBox.right)).toBe(10);
    await expect(tagBox.top).toBe(whoBox.top);
    await expect(tagBox.height).toBe(whoBox.height);
    // The row keeps its signed height.
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(50);
  },
};

export const RecordedNarrow: Story = {
  ...Recorded,
  // A phone's list: the meter goes under the words, and where it came from gives way to the tag.
  render: (args: AttemptRowProps) => (
    <ul style={{ width: 300, maxWidth: '100%', margin: 0, padding: 0, listStyle: 'none' }}>
      <li>
        <AttemptRow {...args} />
      </li>
    </ul>
  ),
  parameters: {
    canvas: 'N-History-Safety',
    canvasNote: 'A replayed attempt in a phone-wide list, narrower than the board draws it, where where it came from gives way to the tag.',
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: /Recorded Stopped by: Reply checkpoint$/ });
    const who = within(link).getByText('Recorded by your Desk as it happened');
    const tag = within(link).getByText('Recorded');
    // Where it came from ellipsizes first; the tag keeps its whole width inside the row.
    await expect(who.scrollWidth).toBeGreaterThan(who.clientWidth);
    await expect(tag.scrollWidth).toBeLessThanOrEqual(tag.clientWidth);
    await expect(tag.getBoundingClientRect().right).toBeLessThanOrEqual(link.getBoundingClientRect().right - 10);
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
  },
};

export const TurnedDown: Story = {
  args: {
    time: '9:52 am',
    why: 'Your rule says no',
    title: 'Asked for 50% off the drain clearing',
    who: 'Recorded by your Desk as it happened',
    stoppedBy: 'action',
    href: '#safety/dec-half-off',
  },
  play: async ({ canvas }) => {
    // Why it was turned down, then what they tried and where it came from under it, unchanged.
    const link = canvas.getByRole('link', { name: /^9:52 am Your rule says no Asked for 50% off the drain clearing Recorded by your Desk as it happened/ });
    await expectStoppedBy(link, 'Action checkpoint', ['passed', 'stopped', 'unreached', 'unreached']);
    const why = within(link).getByText('Your rule says no');
    const label = why.closest('.cd-status-label') as HTMLElement;
    await expect(label.querySelector('.cd-status-dot--refused')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(why, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.92)' });
    const title = within(link).getByText('Asked for 50% off the drain clearing');
    expectComputed(title, { fontSize: '14px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(why.getBoundingClientRect().bottom).toBeLessThanOrEqual(title.getBoundingClientRect().top);
    await expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(within(link).getByText('Recorded by your Desk as it happened').getBoundingClientRect().top);
    // The time stands on the label's line: the same type, its words' tops level.
    const time = canvas.getByText('9:52 am');
    const timeTop = time.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(time).paddingTop);
    await expect(timeTop).toBe(why.getBoundingClientRect().top);
  },
};

export const TurnedDownNarrow: Story = {
  args: {
    time: '9:52 am',
    why: "Your rules couldn't be checked, so I said no",
    title: 'Asked to book Saturday at 9:00 am',
    who: 'Recorded by your Desk as it happened',
    stoppedBy: 'action',
    href: '#safety/dec-saturday',
  },
  // A phone's list: the longest label wraps inside the row rather than running past it.
  render: (args: AttemptRowProps) => (
    <ul style={{ width: 300, maxWidth: '100%', margin: 0, padding: 0, listStyle: 'none' }}>
      <li>
        <AttemptRow {...args} />
      </li>
    </ul>
  ),
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: /^9:52 am Your rules couldn't be checked, so I said no Asked to book/ });
    const why = within(link).getByText("Your rules couldn't be checked, so I said no");
    await expect(why.getBoundingClientRect().right).toBeLessThanOrEqual(link.getBoundingClientRect().right - 10);
    await expect(why.scrollWidth).toBeLessThanOrEqual(why.clientWidth);
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
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
