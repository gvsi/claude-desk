import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { AskClaudePanel } from '../components/AskClaudePanel/AskClaudePanel.tsx';
import { ConnectorOfferCard } from '../components/ConnectorOfferCard/ConnectorOfferCard.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { chen, proseBlock } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { ChenFrame, RulesPage, type RulesHub, SIDEBAR_NOTE, SIDEBAR_ROW_NOTE } from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOwnerFrame, expectRulesPage, expectTabOrder, one, some } from './spec.ts';

/** The Rules page's suggestions on Chen & Co. CPA's Desk, where Payments is the connector to add. */
const CHEN_CHIPS = ['Add Payments', 'Let verified clients book without asking', 'Why was the consultation held?'];

const CHEN_COUNTS = { conversations: { n: 1, label: '1 live conversation' } };

/** Chen & Co. CPA's Rules page as the board draws it: Bookings, Verification and Documents. */
const CHEN_THREE_CONNECTORS: RulesHub = {
  summary: 'Version 3 of your rules, checked against the always-on rules',
  sections: chen.connectors.sections.filter((section) => ['bookings', 'verification', 'documents'].includes(section.connector.id)),
};

/** The owner's words to Claude in the panel, and Claude's answer, as the board words them. */
const OWNER_WORDS = 'Add Payments, so clients can pay their invoices online';
const CLAUDE_WORDS =
  'I can add Payments, so a client can pay an invoice from a one-time link. Both of its tools start at Ask me first, so nothing is charged without you. Have a look before anything turns on.';

const meta = {
  title: 'Boards/Rules',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Linda's conversation with Claude in the panel: her words, Claude's answer and its offer card. */
function AskClaudeConversation() {
  return (
    <>
      <VisitorMessage text={OWNER_WORDS} />
      <ClaudeMessage blocks={[proseBlock(CLAUDE_WORDS)]} language="en" ownerName={chen.business.ownerName} />
      <ConnectorOfferCard {...chen.paymentsOffer} onReview={fn()} />
    </>
  );
}

export const AskClaude: Story = {
  name: 'Ask Claude to add a connector',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  render: () => (
    <ChenFrame
      current="rules"
      counts={CHEN_COUNTS}
      panel={
        <AskClaudePanel onClose={fn()} onSend={fn()}>
          <AskClaudeConversation />
        </AskClaudePanel>
      }
    >
      <RulesPage hub={CHEN_THREE_CONNECTORS} chips={CHEN_CHIPS} />
    </ChenFrame>
  ),
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote: [
      'The panel is AppShell’s panel beside the page, which narrows to make room; on a phone it is a modal sheet.',
      'The page is Chen & Co. CPA’s Rules page with its three connectors, the Desk the conversation is about, where the redrawn board puts Turner Plumbing’s page and sidebar beside Chen’s conversation. The board’s “Start from a preset” menu and payment limit lines are built with the follow-up, so the header has no action here.',
      'The offer card says what already covers Payments, the always-on money rule, where the board says no rule covers it yet.',
      'The “Add Payments” suggestion and the chat it starts are the board’s vision: the web app (plan 04) offers neither until Ask Claude can offer a connector (its Open question 5).',
      SIDEBAR_ROW_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectRulesPage(canvasElement, CHEN_CHIPS);
    // The panel at the right, 400 px wide, the window's height, and the page beside it.
    const panel = canvas.getByRole('complementary', { name: 'Ask Claude' });
    expectComputed(panel, CONNECTORS_SPEC.askClaudePanel);
    const box = panel.getBoundingClientRect();
    await expect(box.right).toBe(1512);
    await expect(box.height).toBe(window.innerHeight);
    const main = canvas.getByRole('main');
    await expect(Math.round(one(main, '.cd-app-shell__content').getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(box.left) - 40);
    // The owner's words, Claude's serif answer, and the offer card that leads into the review.
    const log = within(panel).getByRole('log');
    await expect(within(log).getByText(OWNER_WORDS)).toBeVisible();
    expectComputed(within(log).getByText(CLAUDE_WORDS), SPEC.reply);
    const review = within(log).getByRole('button', { name: 'Review and add' });
    expectComputed(review, SPEC.primary);
    await expect(within(panel).getByRole('textbox', { name: 'Ask Claude' })).toBeVisible();
    await expectFooter(canvasElement);

    // focus_order_is_logical: the page first, then the panel: Close, the card's review, its composer.
    await expectTabOrder(
      userEvent,
      [
        page.composer,
        ...page.chips,
        within(panel).getByRole('button', { name: 'Close' }),
        review,
        within(panel).getByRole('textbox', { name: 'Ask Claude' }),
      ],
      120,
    );
    for (const chip of some(canvasElement, '.cd-suggestion-chips button')) expectComputed(chip, { height: '28px' });
  },
};
