import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';

import { ConnectionPanel } from '../components/ConnectionPanel/ConnectionPanel.tsx';
import { ConnectorHeader } from '../components/ConnectorHeader/ConnectorHeader.tsx';
import { RecentRequests } from '../components/RecentRequests/RecentRequests.tsx';
import type { RuleRowProps } from '../components/RuleRow/RuleRow.tsx';
import { ToolPageHeader } from '../components/ToolPageHeader/ToolPageHeader.tsx';
import { ToolRulesCard } from '../components/ToolRulesCard/ToolRulesCard.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { AskAboutRules, BoardPage, PageSection, RiveraFrame, Trail, riveraRulesFor, SIDEBAR_NOTE } from './parts.tsx';
import { SPEC, expectFooter, expectOutcomeMenus, expectOwnerFrame, expectRulesComposer, expectTabOrder, one } from './spec.ts';

const COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };
const { views } = rivera.connectors;

/** The caption beside "Tools" on a built-in connector's page. */
const TOOLS_CAPTION = 'Each tool with every rule that covers it. Open a tool for its own page.';

/** Google Calendar's one rule once it works, as its page draws it: Claude checks busy times before offering open times. */
const CALENDAR_RULE: RuleRowProps = {
  rule: { card_id: 'rv-calendar', mode: 'auto', reason: rivera.googleCalendar.connection.stops.rules[0] ?? '' },
  words: [
    { field: 'who', text: 'Claude only' },
    { field: 'limits', text: 'Busy times only' },
  ],
  onChangeOutcome: fn(),
};

/** The suggestions on a tool's page, in the owner's words. */
const REFUND_CHIPS = ['Let Dana get refunds up to $50 without asking', 'Why was Dana’s refund held?'];
const QUOTE_CHIPS = ['Quote water heater installs up to $600', 'Why was the drain clearing discount held?'];

const meta = {
  title: 'Boards/Connector and tool pages',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * A connector's page in its frame and look: the trail, its header and the "Tools" heading, each
 * tool's card with its link and rules in the card look, and the footer. Returns the main area.
 */
async function expectConnectorPage(root: HTMLElement, trail: string[], name: string): Promise<HTMLElement> {
  await expect(window.innerWidth).toBe(1512);
  await expectOwnerFrame(root, 'Rules');
  const main = within(root).getByRole('main');
  const crumbs = within(main).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(within(crumbs).getAllByRole('link').map((link) => link.textContent)).toEqual(trail.slice(0, -1));
  await expect(within(crumbs).getByText(trail.at(-1) ?? '')).toHaveAttribute('aria-current', 'page');
  const title = within(main).getByRole('heading', { level: 1, name: new RegExp(`^${name}`) });
  expectComputed(one(title, '.cd-connector-name__name'), SPEC.pageTitle);
  // The connector is named with its badge in its header: "Built in", or "Mock" for an app.
  const header = one(main, '.cd-connector-header');
  if (name === 'Payments') await expect(within(header).getByText('Built in')).toBeVisible();
  else await expect(expectMockBesideExternalNames(header)).toBe(1);
  await expect(within(main).getByRole('heading', { level: 2, name: 'Tools' })).toBeVisible();
  for (const card of main.querySelectorAll<HTMLElement>('.cd-card:has(.cd-tool-rules__tool)')) expectComputed(card, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
  expectOutcomeMenus(main);
  await expectFooter(root);
  return main;
}

export const Payments: Story = {
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Payments']} />
        <ConnectorHeader connector={views.payments} status="on" />
        <PageSection title="Tools" caption={TOOLS_CAPTION}>
          <ToolRulesCard
            label="Payment link"
            tool={{ name: 'Payment link', description: "Makes a one-time link for a quote. Charges money. Can't be undone.", href: '#payment-link' }}
            rules={riveraRulesFor('native.payment_link', ['charge'])}
            onAddRule={fn()}
          />
          <ToolRulesCard
            label="Charge within a signed limit"
            tool={{
              name: 'Charge within a signed limit',
              description: "Lets a visiting agent pay from its owner's signed limit. Charges money. Can't be undone.",
              href: '#charge-within-a-signed-limit',
            }}
            rules={riveraRulesFor('native.charge_mandate', ['charge'])}
            onAddRule={fn()}
          />
        </PageSection>
        <ConnectionPanel connector={views.payments} off={{ kind: 'turn_off', ...rivera.paymentsConnection, onTurnOff: fn() }} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-02-Payments',
    canvasNote: [
      'The page layout is the web app’s (plan 04), composed from Breadcrumb, ConnectorHeader, SectionHeader, ToolRulesCard and ConnectionPanel.',
      'Signed after the board: the shared rule, Alex Kim’s assistant up to $20, is listed first under both tools, since a rule for one agent outranks each tool’s rule for anyone; every amount-limited rule reads its limit phrase.',
      'The turn-off line is the screen’s consequence and says the change shows first; the rules that stop applying are listed in the confirm, where the board lists them in the line.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const main = await expectConnectorPage(canvasElement, ['Connectors', 'Payments'], 'Payments');
    await expect(within(main).getByText(TOOLS_CAPTION)).toBeVisible();
    // Each tool's card lists the shared rule first, then the tool's own.
    const link = canvas.getByRole('region', { name: 'Payment link' });
    const charge = canvas.getByRole('region', { name: 'Charge within a signed limit' });
    for (const [card, own] of [
      [link, rivera.ruleCards['rv-link'].reason],
      [charge, rivera.ruleCards['rv-mandate'].reason],
    ] as const) {
      const rows = within(card).getAllByRole('listitem');
      await expect(rows.map((row) => row.querySelector('.cd-rule-row__reason')?.textContent)).toEqual([rivera.sharedChargeCard.reason, own]);
      await expect(within(rows[0] as HTMLElement).getByText(`Shared rule. ${rivera.sharedChargeAppliesTo}`)).toBeVisible();
    }
    await expect(within(link).getByRole('button', { name: /^Automatic up to \$300; over \$300, ask me first\. Change the outcome of: / })).toBeVisible();
    // The turn-off panel: its heading, its line and the button that asks first.
    const off = canvas.getByRole('button', { name: 'Turn off Payments' });
    expectComputed(off, SPEC.secondaryMain);

    // focus_order_is_logical: the trail, each tool's link, its outcome menus and Add a rule, then Turn off.
    const crumbs = within(canvas.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    const stops = [link, charge].flatMap((card) => [...card.querySelectorAll<HTMLElement>('a, button')]);
    await expectTabOrder(userEvent, [...crumbs, ...stops, off], 120);
    // Turning it off asks first, in a plain confirm that lists what stops.
    await userEvent.click(off);
    const dialog = await waitFor(() => canvas.getByRole('dialog', { name: 'Turn off Payments?' }));
    await expect(within(dialog).getByText('Charge within a signed limit')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it on' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
  },
};

export const Stripe: Story = {
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Stripe']} />
        <ConnectorHeader connector={views.stripe} status="connected" />
        <PageSection title="Tools">
          <ToolRulesCard
            label="See charges"
            tool={{ name: 'See charges', description: 'Shows customers their own charges. Touches private data.', href: '#see-charges' }}
            rules={riveraRulesFor('payments.list_charges', ['private_data'])}
            onAddRule={fn()}
          />
          <ToolRulesCard
            label="Refund"
            tool={{ name: 'Refund', description: rivera.toolPages.refund.description, href: '#refund' }}
            rules={riveraRulesFor('payments.create_refund', ['pay_out', 'private_data'])}
            onAddRule={fn()}
          />
        </PageSection>
        <ConnectionPanel
          connector={views.stripe}
          details={rivera.stripeConnection.details}
          off={{ kind: 'turn_off', consequence: rivera.stripeConnection.consequence, stops: rivera.stripeConnection.stops, onTurnOff: fn() }}
        />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-03-Stripe',
    canvasNote: [
      'Stripe is the mock payments server, so its Mock badge is beside its name in the header and in the disconnect confirm.',
      'The disconnect line says the change shows first, which the plain confirm does.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const main = await expectConnectorPage(canvasElement, ['Connectors', 'Stripe'], 'Stripe');
    // The connection's details as a description list, then Disconnect.
    const terms = [...main.querySelectorAll('dt')].map((term) => term.textContent);
    await expect(terms).toEqual(rivera.stripeConnection.details.map((detail) => detail.label));
    // Rows of 10 px under hairlines, each value 216 px from the panel's edge, as the board draws them.
    const panel = one(main, '.cd-connection-panel');
    for (const row of panel.querySelectorAll<HTMLElement>('.cd-connection-panel__detail')) {
      expectComputed(row, { paddingTop: '10px', paddingBottom: '10px', borderTopWidth: '1px' });
      const value = one(row, 'dd');
      await expect(Math.round(value.getBoundingClientRect().left - panel.getBoundingClientRect().left)).toBe(216);
    }
    const disconnect = canvas.getByRole('button', { name: 'Disconnect' });
    expectComputed(disconnect, SPEC.secondaryMain);
    const crumbs = within(canvas.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    const stops = within(main)
      .getAllByRole('region')
      .flatMap((card) => [...card.querySelectorAll<HTMLElement>('a, button')]);
    await expectTabOrder(userEvent, [...crumbs, ...stops, disconnect], 120);
    await userEvent.click(disconnect);
    const dialog = await waitFor(() => canvas.getByRole('dialog', { name: /^Disconnect Stripe\? Mock$/ }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  },
};

export const GoogleCalendar: Story = {
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Google Calendar']} />
        <ConnectorHeader connector={rivera.googleCalendar.view} status="connected" promise={rivera.googleCalendar.promise} />
        <PageSection title="Tools">
          <ToolRulesCard
            label="See when you're free"
            tool={{ name: "See when you're free", description: "Reads only when you're busy. Never sees what an event is.", href: '#see-when-youre-free' }}
            rules={[CALENDAR_RULE]}
            onAddRule={fn()}
          />
        </PageSection>
        <ConnectionPanel
          connector={rivera.googleCalendar.view}
          details={rivera.googleCalendar.connection.details}
          off={{ kind: 'turn_off', ...rivera.googleCalendar.connection, onTurnOff: fn() }}
        />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-04-GoogleCalendar',
    canvasNote: [
      'Google Calendar is catalog-only in the demo, so this shows what its page does once it works, with its rule at Automatic as the board draws it.',
      'The rule reads “before offering open times”, its words wherever it is listed, where the board says “offering times”.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const main = await expectConnectorPage(canvasElement, ['Connectors', 'Google Calendar'], 'Google Calendar');
    // Its promise under the header: Claude sees only when Mike is busy.
    await expect(within(main).getByText(rivera.googleCalendar.promise.title)).toBeVisible();
    const disconnect = canvas.getByRole('button', { name: 'Disconnect' });
    const crumbs = within(canvas.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    const card = canvas.getByRole('region', { name: "See when you're free" });
    await expectTabOrder(userEvent, [...crumbs, ...card.querySelectorAll<HTMLElement>('a, button'), disconnect], 120);
  },
};

/**
 * A tool's page in its frame and look: the trail, its header, its rules, the composer with the
 * tool's suggestions, and its recent requests, each a link to its record. Returns the main area.
 */
async function expectToolPage(root: HTMLElement, trail: string[], name: string, chips: readonly string[]) {
  await expect(window.innerWidth).toBe(1512);
  await expectOwnerFrame(root, 'Rules');
  const main = within(root).getByRole('main');
  const crumbs = within(main).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(within(crumbs).getAllByRole('link').map((link) => link.textContent)).toEqual(trail.slice(0, -1));
  expectComputed(within(main).getByRole('heading', { level: 1, name }), SPEC.pageTitle);
  await expect(within(main).getByRole('heading', { level: 2, name: `Your rules for ${name.toLowerCase()}` })).toBeVisible();
  const rules = within(main).getByRole('region', { name: `Your rules for ${name.toLowerCase()}` });
  expectComputed(rules, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
  const ask = await expectRulesComposer(main, `Ask Claude to change a rule for ${name.toLowerCase()}`, chips);
  const requests = within(main).getByRole('heading', { name: 'Recent requests under these rules' });
  await expect(requests).toBeVisible();
  await expectFooter(root);
  return { main, crumbs: within(crumbs).getAllByRole('link'), rules, ...ask };
}

export const Refund: Story = {
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Stripe', 'Refund']} />
        <ToolPageHeader {...rivera.toolPages.refund} status="enabled" />
        <PageSection title="Your rules for refund">
          <ToolRulesCard label="Your rules for refund" rules={riveraRulesFor('payments.create_refund', ['pay_out', 'private_data'])} onAddRule={fn()} />
        </PageSection>
        <AskAboutRules placeholder="Ask Claude to change a rule for refund" chips={REFUND_CHIPS} />
        <RecentRequests rows={rivera.recentRequests.refund.map((row) => ({ ...row, href: `#${row.key}` }))} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-05-Refund',
    canvasNote: [
      'The page layout is the web app’s (plan 04), composed from Breadcrumb, ToolPageHeader, ToolRulesCard, Composer, SuggestionChips and RecentRequests.',
      'The recent requests are the fixture’s: the refunded deposit was Lucía Herrera’s, where the board names Lucía Torres. Each time is the screen’s string.',
      'The tool page’s suggestion chips will follow the Rules page’s newest-held-request pattern once the tool pages are built.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const page = await expectToolPage(canvasElement, ['Connectors', 'Stripe', 'Refund'], 'Refund', REFUND_CHIPS);
    // The source line: from Stripe, with its Mock badge, on, and its definition unchanged.
    await expect(within(page.main).getByText('Definition unchanged', { exact: false })).toBeVisible();
    await expect(expectMockBesideExternalNames(one(page.main, '.cd-tool-page-header'))).toBe(1);
    const [menu] = expectOutcomeMenus(page.main);
    await expect(menu).toHaveAccessibleName('Ask me first. Change the outcome of: Refunds to a customer wait for your answer.');
    // Each recent request with its outcome in words, a link to its record.
    const rows = within(page.main).getAllByRole('link', { name: /asked/ });
    await expect(rows).toHaveLength(rivera.recentRequests.refund.length);
    for (const outcome of ['Waiting for your answer', 'Stopped', 'You allowed it']) await expect(within(page.main).getByText(outcome)).toBeVisible();
    // As the board sets them: why in caption type, under what was asked.
    for (const why of page.main.querySelectorAll<HTMLElement>('.cd-recent-requests__why')) {
      expectComputed(why, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    }
    // focus_order_is_logical: the trail, the rule's outcome and Add a rule, the composer and its chips, then the requests.
    await expectTabOrder(
      userEvent,
      [...page.crumbs, menu as HTMLElement, within(page.rules).getByRole('button', { name: 'Add a rule' }), page.composer, ...page.chips, ...rows],
      120,
    );
  },
};

export const Quote: Story = {
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Quotes', 'Quote']} />
        <ToolPageHeader {...rivera.toolPages.quote} status="enabled" />
        <PageSection title="Your rules for quote">
          <ToolRulesCard label="Your rules for quote" rules={riveraRulesFor('native.quote', ['change'])} onAddRule={fn()} />
        </PageSection>
        <AskAboutRules placeholder="Ask Claude to change a rule for quote" chips={QUOTE_CHIPS} />
        <RecentRequests rows={rivera.recentRequests.quote.map((row) => ({ ...row, href: `#${row.key}` }))} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-06-Quote',
    canvasNote: [
      'A built-in tool has no pinned definition, so its status reads “On” with no definition note, where the board shows “Definition unchanged”.',
      'The board’s suggestions repeat the Refund page’s, so these are the Quote page’s own.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    const page = await expectToolPage(canvasElement, ['Connectors', 'Quotes', 'Quote'], 'Quote', QUOTE_CHIPS);
    await expect(within(page.main).queryByText(/Definition/)).toBeNull();
    await expect(within(page.main).getByText('Built in')).toBeVisible();
    const [menu] = expectOutcomeMenus(page.main);
    await expect(menu).toHaveAccessibleName('Automatic. Change the outcome of: Quotes from your price list, at list price.');
    const rows = within(page.main).getAllByRole('link', { name: /asked/ });
    await expect(rows).toHaveLength(rivera.recentRequests.quote.length);
    await expectTabOrder(
      userEvent,
      [...page.crumbs, menu as HTMLElement, within(page.rules).getByRole('button', { name: 'Add a rule' }), page.composer, ...page.chips, ...rows],
      120,
    );
  },
};
