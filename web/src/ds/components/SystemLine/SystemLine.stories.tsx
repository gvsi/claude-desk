import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { EvOwnerJoined } from '../../../api/contracts.ts';
import { chen, rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { SystemLine } from './SystemLine.tsx';

const joined = rivera.events.takeOver.find((event): event is EvOwnerJoined => event.type === 'owner_joined') as EvOwnerJoined;

const meta = {
  title: 'Conversation/SystemLine',
  component: SystemLine,
  args: { text: `${joined.name} joined the chat`, initials: 'MT' },
  parameters: { layout: 'padded', canvas: 'N-Public-Handoff-Run1' },
} satisfies Meta<typeof SystemLine>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No clock time, in any form: no contract carries one, and visitor surfaces show none. */
const CLOCK = /\d{1,2}:\d{2}|\b(?:am|pm)\b/i;

/** What a screen reader reads in the line: its words, with every other part hidden. */
async function expectLineReads(line: HTMLElement, words: string) {
  const text = line.querySelector('.cd-system-line__text');
  await expect(text?.textContent).toBe(words);
  for (const part of line.children) {
    if (part !== text) await expect(part).toHaveAttribute('aria-hidden', 'true');
  }
}

export const OwnerJoined: Story = {
  parameters: { canvasNote: "The board ends the line with a time; no contract carries one, so the line is EvOwnerJoined's name and nothing else." },
  play: async ({ canvas, canvasElement }) => {
    const line = canvas.getByRole('status');
    await expectLineReads(line, 'Mike Turner joined the chat');
    await expect(line.textContent).not.toMatch(CLOCK);
    expectComputed(line, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    // Centered between two hairlines, which screen readers skip.
    const rules = canvasElement.querySelectorAll('.cd-system-line__rule');
    await expect(rules).toHaveLength(2);
    for (const rule of rules) {
      await expect(rule).toHaveAttribute('aria-hidden', 'true');
      expectComputed(rule, { height: '1px', backgroundColor: 'rgba(250, 249, 245, 0.12)' });
    }
    const [left, right] = [...rules].map((rule) => rule.getBoundingClientRect().width);
    await expect(Math.abs((left ?? 0) - (right ?? 0))).toBeLessThanOrEqual(1);
    // The initials sit beside the words and are hidden from screen readers.
    const initials = canvasElement.querySelector('.cd-system-line__initials') as HTMLElement;
    await expect(initials).toHaveAttribute('aria-hidden', 'true');
    await expect(initials.textContent).toBe('MT');
  },
};

export const OwnerLeft: Story = {
  args: { text: 'Claude is helping again.', initials: undefined },
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote: 'The board quotes this line under the composer as what Lucía sees when Mike hands back; here it is the line itself.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expectLineReads(canvas.getByRole('status'), 'Claude is helping again.');
    await expect(canvasElement.querySelector('.cd-system-line__initials')).toBeNull();
  },
};

export const Verified: Story = {
  args: { text: `Verified with a code sent to ${chen.people.raj.maskedContact}`, initials: undefined },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: "The board adds a sage check and a time; the line carries only its words, and the verification form's line adds the simulated label.",
  },
  play: async ({ canvas }) => {
    const line = canvas.getByRole('status');
    await expectLineReads(line, 'Verified with a code sent to •••• 0142');
    await expect(line.textContent).not.toMatch(CLOCK);
  },
};
