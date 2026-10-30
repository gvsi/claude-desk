import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { AskClaudePanel } from '../components/AskClaudePanel/AskClaudePanel.tsx';
import { ConnectorOfferCard } from '../components/ConnectorOfferCard/ConnectorOfferCard.tsx';
import { Notice } from '../components/Notice/Notice.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { chen, proseBlock, rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { ChenFrame, RiveraFrame, RulesPage, type RulesHub } from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOwnerFrame, expectRulesPage, expectTabOrder, one, some } from './spec.ts';

/** The Rules page's suggestions on Rivera's Desk, as the board words them. */
const RIVERA_CHIPS = ['Turn off Payments', 'Quote water heater installs up to $600', 'Why was Dana’s refund held?'];
/** And on Chen & Co. CPA's, where Payments is the connector to add. */
const CHEN_CHIPS = ['Add Payments', 'Let verified clients book without asking', 'Why was the consultation held?'];

const RIVERA_COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };
const CHEN_COUNTS = { conversations: { n: 1, label: '1 live conversation' } };

const RIVERA_HUB: RulesHub = rivera.connectors;

/** Google Calendar's one tool, as its review names it. */
const [FREE_BUSY] = rivera.googleCalendar.review.tools;
if (!FREE_BUSY) throw new Error('the Google Calendar fixture has no tool');

/** Rivera's hub right after Google Calendar was added: its section last, with its note. */
const GCAL_ADDED_HUB: RulesHub = {
  summary: '6 built-in connectors and 2 you connected · Version 7, checked against the always-on rules',
  sections: [
    ...rivera.connectors.sections,
    {
      connector: rivera.googleCalendar.view,
      href: '/rules/google-calendar',
      addedNote: 'Added just now',
      tools: [
        {
          key: 'calendar.free_busy',
          name: FREE_BUSY.name,
          description: FREE_BUSY.description,
          summary: 'Claude only · Busy times only',
          mode: 'ask',
          status: 'enabled',
          href: '/rules/google-calendar/see-when-youre-free',
        },
      ],
    },
  ],
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

/** The hub's names in order, Rivera's six built-in connectors and Stripe. */
const RIVERA_NAMES = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'];

export const Hub: Story = {
  name: 'Rules and connectors',
  globals: { viewport: { value: 'board', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-01-Rules',
    canvasNote: [
      'The page layout is the web app’s (plan 04), composed from PageHeader, Composer, SuggestionChips, ConnectorList, ConnectorSection and AlwaysOnList.',
      'Rivera keeps Documents, so the hub has six built-in connectors and Stripe, as the board draws it. Apostrophes are the components’ and fixtures’ straight ones.',
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectRulesPage(canvasElement, RIVERA_CHIPS);
    const list = canvas.getByRole('list', { name: 'Connectors' });
    const sections = [...list.children].map((item) => one(item, 'section'));
    await expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual(RIVERA_NAMES);
    // mock_badge_always_beside_external_names: Stripe is named with its Mock badge.
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // Payment link and Charge within a signed limit read their limit phrase.
    await expect(canvas.getByRole('link', { name: /^Payment link: 2 rules · 1 shared, Automatic up to \$300; over \$300, ask me first\. Open$/ })).toBeVisible();
    await expect(canvas.getByRole('link', { name: /^Charge within a signed limit: 2 rules · 1 shared, Automatic up to \$20; over \$20, ask me first\. Open$/ })).toBeVisible();
    await expectFooter(canvasElement);

    // focus_order_is_logical: the page's "Add a connector", the composer, its chips, each section's
    // header and rows in order, then the last "Add a connector".
    const [top, bottom] = canvas.getAllByRole('button', { name: 'Add a connector' });
    const links = sections.flatMap((section) => within(section).getAllByRole('link'));
    await expectTabOrder(userEvent, [top as HTMLElement, page.composer, ...page.chips, ...links, bottom as HTMLElement], 120);
  },
};

export const Phone: Story = {
  name: 'Rules on a phone',
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-16-Phone-Rules',
    canvasNote: [
      'The board’s placeholder is shorter, “Ask Claude to change a rule”; the composer keeps one placeholder at every width.',
      'Signed after the board: each tool’s outcome sits on its own line under its words.',
      'The subtitle, the helper and the suggestions go on a phone, as the board draws it; the top bar’s menu button is its icon alone, its name kept for screen readers.',
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // The top bar replaces the sidebar, 56 px high, its menu button the icon alone.
    await expect(canvas.queryByRole('complementary', { name: 'Claude Desk' })).toBeNull();
    const menu = canvas.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    expectComputed(menu, { width: '32px', height: '32px' });
    expectComputed(one(canvasElement, '.cd-app-shell__topbar'), { height: '56px' });
    // The title with "Add a connector" at control height beside it, and no subtitle.
    const title = canvas.getByRole('heading', { level: 1, name: 'Rules' });
    expectComputed(title, SPEC.pageTitle);
    await expect(canvas.getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.')).not.toBeVisible();
    const add = canvas.getByRole('button', { name: 'Add a connector' });
    expectComputed(add, { height: '32px' });
    await expect(add.getBoundingClientRect().top).toBe(title.getBoundingClientRect().top);
    // The composer alone, on top: no helper, no chips, no summary and no second "Add a connector".
    const composer = canvas.getByRole('textbox', { name: 'Ask Claude to change a rule or a connector' });
    await expect(canvas.getByText('Claude shows you the change and example situations before anything applies.')).not.toBeVisible();
    await expect(one(canvasElement, '.cd-suggestion-chips')).not.toBeVisible();
    await expect(canvas.getByText(rivera.connectors.summary)).not.toBeVisible();
    // phone_hides_descriptions: names and summaries stay, descriptions go, each outcome under its words.
    for (const section of rivera.connectors.sections) {
      await expect(canvas.getByText(section.connector.description)).not.toBeVisible();
      for (const tool of section.tools) {
        const row = canvas.getByRole('link', { name: new RegExp(`^${tool.name}: `) }).closest('li') as HTMLElement;
        const name = within(row).getByText(tool.name);
        const summary = within(row).getByText(tool.summary);
        await expect(summary.getBoundingClientRect().top).toBeGreaterThanOrEqual(name.getBoundingClientRect().bottom - 1);
        await expect(within(row).getByText(tool.description)).not.toBeVisible();
        const outcome = one(row, '.cd-status-label');
        await expect(outcome.getBoundingClientRect().top).toBeGreaterThanOrEqual(summary.getBoundingClientRect().bottom - 1);
      }
    }
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectFooter(canvasElement);
    // Nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5);
    await expect(tooWide).toEqual([]);

    // focus_order_is_logical: Menu, "Add a connector", the composer, then each section in order.
    const list = canvas.getByRole('list', { name: 'Connectors' });
    const links = within(list).getAllByRole('link');
    await expectTabOrder(userEvent, [canvas.getByRole('button', { name: 'Menu' }), add, composer, ...links], 120);
  },
};

export const GoogleCalendarAdded: Story = {
  name: 'Google Calendar added',
  globals: { viewport: { value: 'board', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={RIVERA_COUNTS}>
      <RulesPage
        hub={GCAL_ADDED_HUB}
        chips={RIVERA_CHIPS}
        notice={<Notice tone="info">Google Calendar is on. Claude asks you first before it checks when you’re busy, and never sees what an event is.</Notice>}
      />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-11-GCal-Done',
    canvasNote: [
      'Google Calendar is catalog-only in the demo, so this shows what the Rules page does once it works: its section last, “Added just now”, its tool at Ask me first.',
      'The notice follows the board, which says the tool asks first, where an earlier note said Claude now checks before offering times.',
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectRulesPage(canvasElement, RIVERA_CHIPS);
    // The notice under the title, before the composer.
    const notice = canvas.getByRole('status');
    await expect(notice).toHaveTextContent('Google Calendar is on. Claude asks you first before it checks when you’re busy, and never sees what an event is.');
    await expect(notice.compareDocumentPosition(page.composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Google Calendar's section is last, with its note and its Mock badge.
    const list = canvas.getByRole('list', { name: 'Connectors' });
    const last = one(list.lastElementChild as HTMLElement, 'section');
    await expect(last).toHaveAttribute('aria-label', 'Google Calendar');
    await expect(within(last).getByText('Added just now')).toBeVisible();
    await expect(within(last).getByRole('link', { name: /^See when you're free: Claude only · Busy times only, Ask me first\. Open$/ })).toBeVisible();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(2);
    await expectFooter(canvasElement);
    const [top, bottom] = canvas.getAllByRole('button', { name: 'Add a connector' });
    const links = [...list.querySelectorAll<HTMLElement>('a')];
    await expectTabOrder(userEvent, [top as HTMLElement, page.composer, ...page.chips, ...links, bottom as HTMLElement], 120);
  },
};

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
  globals: { viewport: { value: 'board', isRotated: false } },
  render: () => (
    <ChenFrame current="rules" counts={CHEN_COUNTS}>
      <div className="board-with-panel">
        <RulesPage hub={chen.connectors} chips={CHEN_CHIPS} />
        <div className="board-with-panel__panel">
          <AskClaudePanel onClose={fn()} onSend={fn()}>
            <AskClaudeConversation />
          </AskClaudePanel>
        </div>
      </div>
    </ChenFrame>
  ),
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote: [
      'The panel beside the page is the web app’s layout (plan 04): the page narrows to make room.',
      'Chen & Co. CPA’s hub has the five built-in connectors its seed uses (its quotes and leads), where the board draws three.',
      'The offer card says what already covers Payments, the always-on money rule, where the board says no rule covers it yet.',
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules', { panel: true });
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
    const [top] = canvas.getAllByRole('button', { name: 'Add a connector' });
    await expectTabOrder(
      userEvent,
      [
        top as HTMLElement,
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
