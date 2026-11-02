import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { chen, proseBlock } from '../../fixtures';
import { AppShell } from '../AppShell/AppShell.tsx';
import { expectComputed } from '../../test/expectComputed.ts';
import { settled } from '../../test/settled.ts';
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
    await expect(box).toHaveAttribute('placeholder', 'What happens if someone asks for a discount?');
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
  play: async ({ args, canvas, userEvent }) => {
    // While Claude writes, three dots show inside the log, with words for screen readers and no draft.
    const log = canvas.getByRole('log');
    const writing = within(log).getByRole('status');
    await expect(writing).toHaveTextContent('Claude is writing');
    await expect(writing).toBeVisible();
    await expect(writing.querySelectorAll('.cd-writing-indicator__dot')).toHaveLength(3);
    await expect(within(writing).getByText('Claude is writing')).toHaveClass('cd-sr-only');
    await expect(within(log).queryByText(CLAUDE_WORDS)).toBeNull();
    // The composer takes the next question meanwhile, and keeps it: Send and Enter wait for the answer.
    const box = canvas.getByRole('textbox', { name: 'Ask Claude' });
    await userEvent.click(box);
    await userEvent.keyboard('And on holidays?{Enter}');
    await expect(box).toHaveValue('And on holidays?');
    await expect(box).toHaveFocus();
    await expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(args.onSend).not.toHaveBeenCalled();
  },
};

/** The opener on the page behind the panel, as the Rules page's composer opens it. */
const OPENER = 'Ask Claude to change a rule';

/**
 * The Rules page with the panel shut: the owner app's shell, a page with its own controls and the
 * button that opens the panel, which goes in the shell's `panel`. Closing the panel removes it, as
 * the screen does.
 */
function RulesScreen(args: Parameters<typeof AskClaudePanel>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      todayHref="#today"
      business={chen.business.name}
      sidebar={
        <nav aria-label="Main">
          <a href="#rules">Rules</a>
        </nav>
      }
      panel={
        open ? (
          <AskClaudePanel
            {...args}
            onClose={() => {
              args.onClose();
              setOpen(false);
            }}
          />
        ) : null
      }
    >
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
    </AppShell>
  );
}

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: (args) => <RulesScreen {...args} />,
  parameters: {
    canvasNote:
      'No board draws the panel on a phone: under 640 px it is a modal sheet over the whole window, with no seam (from 640 to 1023 px, see Tablet); the page behind is inert, focus moves into it and stays there, and returns to what opened it.',
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
    // The whole window, so no scrim.
    await expect(getComputedStyle(sheet, '::before').content).toBe('none');

    // Focus moves in, to the composer; the page behind is inert.
    const composer = within(sheet).getByRole('textbox', { name: 'Ask Claude' });
    await expect(composer).toHaveFocus();
    const behind = [opener, canvasElement.querySelector<HTMLElement>('a[href="#quotes"]'), canvasElement.querySelector<HTMLElement>('.cd-app-shell__menu')];
    for (const control of behind) {
      await expect(control?.closest('[inert]'), `${control?.textContent ?? ''} is inert`).not.toBeNull();
      control?.focus();
      await expect(document.activeElement, `${control?.textContent ?? ''} can't take focus`).not.toBe(control);
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

/** How many lines an element's text takes: the distinct tops of its line boxes. */
function lineCount(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  return new Set(rects.map((rect) => Math.round(rect.top))).size;
}

export const Tablet: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
  render: (args) => <RulesScreen {...args} />,
  parameters: {
    canvasNote:
      'No board draws the panel on a tablet. At 768 px the sidebar’s column and the panel would leave the page 104 px, so under 1024 px the panel is a modal sheet, as on a phone; from 640 px it keeps its 400 px, docked at the window’s right edge over the scrim, with the sidebar’s column and the page behind it inert.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const width = window.innerWidth;
    await expect(width).toBe(768);
    const opener = canvas.getByRole('button', { name: OPENER });
    await userEvent.click(opener);

    // tablet_gets_a_docked_sheet: a modal sheet, the panel's own 400 px with its padding and seam,
    // flush with the window's right edge at its full height.
    const sheet = canvas.getByRole('dialog', { name: 'Ask Claude' });
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    const box = sheet.getBoundingClientRect();
    await expect([box.left, box.top, box.width, box.height]).toEqual([width - 400, 0, 400, window.innerHeight]);
    expectComputed(sheet, { borderLeftWidth: '1px', paddingLeft: '24px', backgroundColor: 'rgb(34, 34, 32)' });
    // The scrim covers the rest of the window, at the token's half-black: any point left of the
    // panel lands on the panel's own backdrop, not on the inert page.
    const scrim = getComputedStyle(sheet, '::before');
    await expect([scrim.backgroundColor, scrim.position, scrim.left, scrim.right]).toEqual(['rgba(0, 0, 0, 0.5)', 'fixed', '0px', '400px']);
    await expect(document.elementFromPoint(10, window.innerHeight / 2)).toBe(sheet);
    await expect(within(sheet).getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();

    // The sidebar's column shows at this width, and it is inert behind the sheet, as the page is.
    const column = canvasElement.querySelector<HTMLElement>('.cd-app-shell__column');
    await expect(column).not.toBeNull();
    await expect(column?.closest('[inert]')).not.toBeNull();
    await expect(canvas.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

    // Escape closes it, focus returns to what opened it, and the page is live again.
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(opener).toHaveFocus();
    await expect(canvasElement.querySelector('[inert]')).toBeNull();
  },
};

export const BesideAt1024: Story = {
  name: 'Beside the page at 1024 px',
  globals: { viewport: { value: 'tabletLandscape', isRotated: false } },
  render: (args) => <RulesScreen {...args} />,
  parameters: {
    canvasNote:
      'No board draws the panel at this width. 1024 px is the narrowest window with the panel beside the page: the sidebar’s 264 px column and the panel’s 400 px leave the page its 360 px.',
    viewport: { options: { tabletLandscape: { name: 'Tablet, landscape', styles: { width: '1024px', height: '768px' }, type: 'tablet' } } },
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const width = window.innerWidth;
    await expect(width).toBe(1024);
    await userEvent.click(canvas.getByRole('button', { name: OPENER }));

    // panel_beside_a_360_px_page: a complementary panel, and the page beside it is live.
    const panel = canvas.getByRole('complementary', { name: 'Ask Claude' });
    await expect(panel).not.toHaveAttribute('aria-modal');
    expectComputed(panel, { width: '400px', borderLeftWidth: '1px' });
    const main = canvas.getByRole('main');
    await expect(main.getBoundingClientRect().width).toBeGreaterThanOrEqual(360);
    await expect(canvasElement.querySelector('[inert]')).toBeNull();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
    await expect(lineCount(canvas.getByRole('heading', { level: 1, name: 'Rules' }))).toBe(1);
    // The story ends with the panel open, and the accessibility check runs next: let the panel finish
    // arriving, so it measures the text's own colors rather than a frame of the fade.
    await settled(canvasElement);
  },
};
