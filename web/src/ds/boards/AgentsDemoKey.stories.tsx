import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { CopyField } from '../components/CopyField/CopyField.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { AgentsCard, AgentsFrame, brandOf } from './parts.tsx';
import { expectAgentsDisclosure, expectFooter, expectFooterAtFoot, expectTabOrder } from './spec.ts';

/** A demo key as the board writes it: a placeholder, never a real key. */
const KEY = '0000000000000000000000000000000000000000000000000000000000000000';

function AgentsDemoKey() {
  return (
    <AgentsFrame brand={brandOf(rivera.publicDesk.en)}>
      <AgentsCard title="Try it with a demo key">
        <CopyField label="Key id" value="demo-7f3a2c" layout="block" language="en" />
        <CopyField
          label="Private key"
          value={KEY}
          copyLabel="Copy key"
          note="Shown once. It’s a demo key for this Desk, not a business credential."
          layout="block"
          language="en"
          onCopy={fn(async () => {})}
        />
      </AgentsCard>
    </AgentsFrame>
  );
}

const meta = {
  title: 'Boards/Agents page, demo key',
  render: () => <AgentsDemoKey />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Agents-02-Demo-Key',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'The demo key, shown once: the key id and the private key, each a CopyField in its mono box, with “Copy key” and the warning beside it. The key is a placeholder.',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; it is 19 px where the renders draw an earlier 17 px line, and the title above it is larger too, so everything under it sits lower than the render.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectAgentsDisclosure(canvasElement);
    const card = canvas.getByRole('region', { name: 'Try it with a demo key' });
    const keyId = within(card).getByRole('group', { name: 'Key id' });
    const key = within(card).getByRole('group', { name: 'Private key' });
    // Each value's box: 44 px, 6 px under its label; the second field 10 px under the first.
    for (const field of [keyId, key]) {
      const box = field.querySelector('code') as HTMLElement;
      await expect(Math.round(box.getBoundingClientRect().height)).toBe(44);
      expectComputed(box, { backgroundColor: 'rgba(250, 249, 245, 0.1)', fontFamily: /^"JetBrains Mono"/ });
    }
    await expect(Math.round(key.getBoundingClientRect().top - keyId.getBoundingClientRect().bottom)).toBe(10);
    // Only the key copies, and its warning sits beside the button.
    await expect(within(keyId).queryByRole('button')).toBeNull();
    const copy = within(key).getByRole('button', { name: 'Copy key' });
    await expect(within(key).getByText('Shown once. It’s a demo key for this Desk, not a business credential.')).toBeVisible();
    // The card ends 16 px under the button.
    await expect(Math.round(card.getBoundingClientRect().bottom - copy.getBoundingClientRect().bottom)).toBe(17);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
    await expectTabOrder(userEvent, [canvas.getByRole('link', { name: 'Back to the chat' }), copy]);
  },
};
