import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
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

/** The opener on the page behind the panel, as the Rules page's composer opens it. */
const OPENER = 'Ask Claude to change a rule';

/**
 * A phone screen with the panel shut: a page with its own controls and the button that opens the
 * panel. Closing the panel removes it, as the screen does.
 */
function PhoneScreen(args: Parameters<typeof AskClaudePanel>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 16 }}>
      <h1 className="cd-type-page-title">Rules</h1>
      <p>
        <a href="#quotes">Quotes</a>
      </p>
      <p>
        <button type="button">Add a connector</button>
      </p>
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          {OPENER}
        </button>
      </p>
      {open ? (
        <AskClaudePanel
          {...args}
          onClose={() => {
            args.onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: (args) => <PhoneScreen {...args} />,
  parameters: {
    canvasNote:
      'No board draws the panel on a phone: under 640 px it is a modal sheet over the whole window, with no seam; the page behind is inert, focus moves into it and stays there, and returns to what opened it.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const opener = canvas.getByRole('button', { name: OPENER });
    await userEvent.click(opener);

    // A modal sheet over the whole window, named by its heading, with no seam.
    const sheet = canvas.getByRole('dialog', { name: 'Ask Claude' });
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    const box = sheet.getBoundingClientRect();
    await expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, 390, window.innerHeight]);
    expectComputed(sheet, { borderLeftWidth: '0px' });

    // Focus moves in, to the composer; the page behind is inert.
    const composer = within(sheet).getByRole('textbox', { name: 'Ask Claude' });
    await expect(composer).toHaveFocus();
    for (const behind of [opener, canvas.getByRole('link', { name: 'Quotes' }), canvas.getByRole('button', { name: 'Add a connector' })]) {
      await expect(behind.closest('[inert]'), `${behind.textContent ?? ''} is inert`).not.toBeNull();
    }

    // phone_sheet_keeps_focus: Tab and Shift+Tab stay inside the sheet, every stop on a control in it.
    for (let i = 0; i < 6; i += 1) {
      await userEvent.tab();
      await expect(sheet.contains(document.activeElement), `Tab ${i + 1} stays in the sheet`).toBe(true);
    }
    const close = within(sheet).getByRole('button', { name: 'Close' });
    close.focus();
    await userEvent.tab({ shift: true });
    await expect(sheet.contains(document.activeElement), 'Shift+Tab from the first control stays in the sheet').toBe(true);

    // Escape closes it, and focus returns to what opened it; the page is live again.
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole('dialog', { name: 'Ask Claude' })).toBeNull();
    await expect(opener).toHaveFocus();
    await expect(canvasElement.querySelector('[inert]')).toBeNull();

    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
};
