import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { chen, proseBlock } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { AskClaudePanel } from './AskClaudePanel.tsx';

const OWNER_WORDS = 'Add Payments, so clients can pay their invoices';
const CLAUDE_WORDS = 'I can add Payments, so clients can pay with a test payment link. Have a look before anything turns on.';

/** Linda's question and Claude's answer, as the screen puts them in the panel. */
const conversation = (
  <>
    <VisitorMessage text={OWNER_WORDS} />
    <ClaudeMessage blocks={[proseBlock(CLAUDE_WORDS)]} language="en" ownerName={chen.business.ownerName} />
  </>
);

const meta = {
  title: 'Rules/AskClaudePanel',
  component: AskClaudePanel,
  args: { onClose: fn(), onSend: fn(), children: conversation },
  render: (args) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', height: '100vh' }}>
      <AskClaudePanel {...args} />
    </div>
  ),
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote: 'The offer card under the reply is a Task 3 piece (ConnectorOfferCard), so it is left out here.',
  },
} satisfies Meta<typeof AskClaudePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AddPayments: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // ask_claude_panel_is_a_log: an aside named "Ask Claude", 400 px wide on the panel ground with
    // a hairline on its left, holding the conversation in a polite log.
    const panel = canvas.getByRole('complementary', { name: 'Ask Claude' });
    expectComputed(panel, {
      width: '400px',
      backgroundColor: 'rgb(34, 34, 32)',
      borderLeftWidth: '1px',
      borderLeftColor: 'rgba(250, 249, 245, 0.12)',
    });
    const log = within(panel).getByRole('log');
    await expect(log).toHaveAttribute('aria-live', 'polite');
    await expect(within(log).getByText(OWNER_WORDS)).toBeVisible();
    // Claude speaks in serif; the owner in sans.
    expectComputed(within(log).getByText(CLAUDE_WORDS), { fontFamily: /Source Serif 4/ });
    expectComputed(within(log).getByText(OWNER_WORDS), { fontFamily: /Hanken Grotesk/ });
    // The composer at the bottom, below the log.
    const box = within(panel).getByRole('textbox', { name: 'Ask Claude' });
    await expect(box).toHaveAttribute('placeholder', 'Ask Claude');
    await expect(box.getBoundingClientRect().top).toBeGreaterThan(log.getBoundingClientRect().bottom - 1);
    await expect(panel.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom).toBeLessThan(80);

    // Close and Escape both call onClose.
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(box);
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(2);

    // Sending a message.
    await userEvent.type(box, 'Turn off Payments');
    await userEvent.keyboard('{Enter}');
    await expect(args.onSend).toHaveBeenCalledTimes(1);
    await expect(args.onSend).toHaveBeenCalledWith('Turn off Payments');
  },
};

export const Writing: Story = {
  args: { busy: true, children: <VisitorMessage text={OWNER_WORDS} /> },
  play: async ({ canvas }) => {
    // While Claude writes, the line says so inside the log, and no draft shows.
    const log = canvas.getByRole('log');
    await expect(within(log).getByText('Claude is writing')).toBeVisible();
    await expect(within(log).queryByText(CLAUDE_WORDS)).toBeNull();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'No board draws the panel on a phone: under 640 px it takes the full width, with no seam.' },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const panel = canvas.getByRole('complementary', { name: 'Ask Claude' });
    await expect(panel.getBoundingClientRect().width).toBe(390);
    expectComputed(panel, { borderLeftWidth: '0px' });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
