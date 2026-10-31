import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectBalancedLines } from '../../test/expectBalancedLines.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { ConnectorReview } from './ConnectorReview.tsx';

const HINT = "You'll see the change to your rules before anything runs.";

const meta = {
  title: 'Connectors/ConnectorReview',
  component: ConnectorReview,
  args: {
    connector: chen.connectors.views.payments,
    tools: chen.paymentsReview.tools,
    onChangeOutcome: fn(),
    onTurnOn: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 960, minHeight: 360 }}>
      <ConnectorReview {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-11b-Payments-Review',
    canvasNote:
      'Each tool shows the always-on rule that covers it, "No money moves without your rule or a signed limit", where the board says none of the owner\'s rules covers it yet.',
  },
} satisfies Meta<typeof ConnectorReview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ChenPayments: Story = {
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    // The page's h1, with the connector's "Built in" beside its name.
    const title = canvas.getByRole('heading', { level: 1, name: 'Review what Claude could do with Payments Built in' });
    expectComputed(title, { fontFamily: '"Source Serif 4", Georgia, serif', fontSize: '24px' });
    await expect(canvas.getByText("A built-in connector, so there's nothing to sign in to. Nothing runs until you turn it on.")).toBeVisible();
    // review_starts_at_ask_me_first: a row per tool, each at "Ask me first", with what covers it.
    const card = canvas.getByRole('region', { name: 'Tools' });
    const rows = within(card).getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    for (const [index, tool] of args.tools.entries()) {
      const row = rows[index] as HTMLElement;
      await expect(within(row).getByText(tool.name)).toBeVisible();
      await expect(within(row).getByText(tool.description)).toBeVisible();
      await expect(within(row).getByText('Covered by your always-on rule: No money moves without your rule or a signed limit')).toBeVisible();
      await expect(within(row).getByRole('button', { name: `Ask me first. Change the outcome of: ${tool.name}` })).toBeVisible();
    }
    expectComputed(within(rows[0] as HTMLElement).getByText('Payment link'), { fontWeight: '520' });
    await expect(canvas.getByText(HINT)).toBeVisible();
    // The outcome is a menu: a pick goes to the screen with the tool's key.
    await userEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: /^Ask me first/ }));
    await userEvent.click(canvas.getByRole('menuitemradio', { name: 'Automatic' }));
    await expect(args.onChangeOutcome).toHaveBeenCalledWith('native.payment_link', 'auto');
    // Two clicks on "Turn it on" turn it on once; it waits with a spinner on the pressed button only.
    const turnOn = canvas.getByRole('button', { name: 'Turn it on' });
    await userEvent.click(turnOn);
    await userEvent.click(turnOn);
    await expect(args.onTurnOn).toHaveBeenCalledTimes(1);
    await expect(turnOn).toHaveAttribute('aria-busy', 'true');
    await expect(turnOn.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    // Cancel still leaves.
    const cancel = canvas.getByRole('button', { name: 'Cancel' });
    await expect(cancel.querySelector('.cd-button__spinner')).toBeNull();
  },
};

export const CancelFirst: Story = {
  parameters: { canvasNote: 'The same review, left with Cancel before anything is sent; the board draws the review only.' },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(args.onTurnOn).not.toHaveBeenCalled();
  },
};

export const GoogleCalendar: Story = {
  args: { connector: rivera.googleCalendar.view, intro: rivera.googleCalendar.review.intro, tools: rivera.googleCalendar.review.tools },
  parameters: {
    canvas: 'N-Conn-09-GCal-Review',
    canvasNote:
      'Google Calendar is catalog-only in the demo, so this shows what the review supports once it works. Its tool starts at "Ask me first", as the contract requires of every new tool, with the rules that cover it shown; it never starts at "Automatic" from the Bookings rule, as an earlier draft of this board showed. The current render agrees.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Review what Claude could do with Google Calendar Mock' })).toBeVisible();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expect(canvas.getByText(`Nothing runs until you turn it on. ${rivera.googleCalendar.review.intro}`)).toBeVisible();
    // No rule of the owner's covers it yet, so it starts at Ask me first.
    await expect(canvas.getByText('No rule of yours covers this yet, so it starts at Ask me first.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: "Ask me first. Change the outcome of: See when you're free" })).toBeVisible();
  },
};

export const CoveredByARule: Story = {
  args: {
    connector: rivera.googleCalendar.view,
    intro: rivera.googleCalendar.review.intro,
    tools: [
      {
        ...rivera.googleCalendar.review.tools[0],
        key: 'calendar.free_busy',
        name: "See when you're free",
        description: "Reads only when you're busy. Never sees what an event is.",
        mode: 'ask',
        coveredBy: [
          { text: 'Payment links up to $300, checked by the reviewer.', mode: 'auto', limit: '$300' },
          { text: 'Private data only to its verified owner', mode: 'always_on' },
        ],
      },
    ],
    onChangeOutcome: undefined,
  },
  parameters: {
    canvas: 'none',
    canvasNote: "A tool one of the owner's rules already covers, read-only; no board draws it (nearest: N-Conn-09-GCal-Review).",
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText('Covered by your rule: Payment links up to $300, checked by the reviewer. · Automatic up to $300; over $300, ask me first'),
    ).toBeVisible();
    await expect(canvas.getByText('Covered by your always-on rule: Private data only to its verified owner')).toBeVisible();
    await expect(canvas.queryByText(/No rule of yours/)).toBeNull();
    // Without onChangeOutcome, the outcome is words and a dot.
    await expect(canvas.queryByRole('button', { name: /Change the outcome/ })).toBeNull();
    await expect(canvas.getByText('Ask me first')).toBeVisible();
  },
};

export const TurningOn: Story = {
  args: { pending: true },
  parameters: { canvasNote: 'The review while the screen turns Payments on; no board draws it. The button keeps its label under its spinner.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const turnOn = canvas.getByRole('button', { name: 'Turn it on' });
    await expect(turnOn).toHaveAttribute('aria-busy', 'true');
    await expect(turnOn.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    await expect(canvasElement.querySelector('.cd-connector-review')).toHaveAttribute('aria-busy', 'true');
    const cancel = canvas.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(turnOn);
    await userEvent.click(cancel);
    await expect(args.onTurnOn).not.toHaveBeenCalled();
    await expect(args.onCancel).not.toHaveBeenCalled();
    // The outcomes can't change while it turns on.
    for (const menu of canvas.getAllByRole('button', { name: /Change the outcome/ })) await expect(menu).toBeDisabled();
  },
};

export const Error: Story = {
  args: { error: "Payments couldn't be turned on just now. Nothing changed. Try again in a moment." },
  parameters: { canvasNote: 'The review after a failed try, with the screen\'s message; no board draws it.' },
  play: async ({ args, canvas, userEvent }) => {
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent("Payments couldn't be turned on just now. Nothing changed. Try again in a moment.");
    // Turn it on works again.
    await userEvent.click(canvas.getByRole('button', { name: 'Turn it on' }));
    await expect(args.onTurnOn).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'The review on a phone; no board draws it. Each outcome sits on its own line under its tool.' },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    for (const row of within(canvas.getByRole('region', { name: 'Tools' })).getAllByRole('listitem')) {
      const text = row.querySelector('.cd-connector-review__text');
      if (text === null) throw new globalThis.Error('No text');
      await expect(within(row).getByRole('button').getBoundingClientRect().top).toBeGreaterThanOrEqual(text.getBoundingClientRect().bottom);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};

/**
 * A connector with a long name. The demo's connectors are named in a word or two, so this stands
 * for a long one: Google Calendar's view, named for the business's calendar. Wrapped greedily, its
 * title would leave the Mock badge alone on the last line, on a laptop and on a phone.
 */
const LONG_NAMED: ConnectorView = { ...rivera.googleCalendar.view, name: 'Google Calendar for Bayview Heating & Plumbing' };
const LONG_TITLE = `Review what Claude could do with ${LONG_NAMED.name} Mock`;

export const LongName: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { connector: LONG_NAMED, tools: rivera.googleCalendar.review.tools },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws a connector name this long; the demo\'s are a word or two. The nearest is N-Conn-09-GCal-Review. The title balances its lines, so its Mock badge doesn\'t sit alone on the second.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(1440);
    await expectBalancedLines(canvas.getByRole('heading', { level: 1 }), LONG_TITLE, 2);
  },
};

export const LongNameOnAPhone: Story = {
  name: 'Long name on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: { connector: LONG_NAMED, tools: rivera.googleCalendar.review.tools },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws a connector name this long, or this review on a phone. The nearest is N-Conn-09-GCal-Review, at the canvas\'s width; on a phone the title takes four lines beside its tile, balanced too.',
  },
  play: async ({ canvas }) => {
    await expect(window.innerWidth).toBe(390);
    await expectBalancedLines(canvas.getByRole('heading', { level: 1 }), LONG_TITLE);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
