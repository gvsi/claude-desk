import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ChangeReview, type ChangeReviewProps } from '../components/ChangeReview/ChangeReview.tsx';
import { LimitChange } from '../components/LimitChange/LimitChange.tsx';
import { MoneyLimit } from '../components/MoneyLimit/MoneyLimit.tsx';
import { PRESET_WORDS } from '../components/OutcomeMenu/outcomeWords.ts';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { PresetMenu } from '../components/PresetMenu/PresetMenu.tsx';
import { RecentRequests } from '../components/RecentRequests/RecentRequests.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { ToolPageHeader } from '../components/ToolPageHeader/ToolPageHeader.tsx';
import { ToolRulesCard } from '../components/ToolRulesCard/ToolRulesCard.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import {
  AskAboutRules,
  BoardPage,
  PageSection,
  RiveraFrame,
  RulesPage,
  type RulesHub,
  SIDEBAR_NOTE,
  SIDEBAR_ROW_NOTE,
  Trail,
  riveraRulesFor,
} from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOwnerFrame, expectRulesPage, expectTabOrder, one, some } from './spec.ts';

const COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };

/** The Rules page's suggestions on Turner Plumbing's Desk, as the presets board words them. */
const RIVERA_CHIPS = ['Stop quoting on weekends', 'Quote water heater installs up to $600', 'Why was this quote held?'];

/** Turner Plumbing's Rules page: its six built-in connectors and Stripe. */
const RIVERA_HUB: RulesHub = { summary: 'Version 7 of your rules, checked against the always-on rules', sections: rivera.connectors.sections };

/** A review page's line under its title. */
const REVIEW_LINE = 'Here’s exactly what changes on your Desk. Nothing changes until you confirm.';

/** What the proofs found for the Ask me first preset, as the board words it. */
/** The Ask me first review as the board lists it: Turner's rules, with the board's illustrative shared rule after Payment link. */
const ASK_FIRST_ROWS = rivera.askFirstReview.flatMap((row) => (row.key === 'rv-link' ? [row, rivera.sharedChargeReviewRow] : [row]));

const ASK_FIRST_CHECKS = {
  status: 'checked',
  lines: ['Checked against the always-on rules and your other rules.', 'Open times, leads, callbacks and identity checks still run on their own.'],
} as const satisfies ChangeReviewProps['checks'];

/** The suggestions on Refund's page, in the owner's words. */
const REFUND_CHIPS = ['Let Dana get refunds up to $50 without asking', 'Why was Dana’s refund held?'];

/** Turner's payment limit as a group's line above its tools: reading, or open on "1000". */
function limit(editing = false) {
  return (
    <MoneyLimit
      line={rivera.paymentLimit.line}
      editing={editing}
      value={editing ? '1000' : ''}
      hint={rivera.paymentLimit.hint}
      onEdit={fn()}
      onChange={fn()}
      onReview={fn()}
      onCancel={fn()}
    />
  );
}

/** The Rules header's two actions, in the same order and type as the app. */
function headerActions() {
  return (
    <>
      <span className="cd-type-control">
        <TextLink href="#rules/all">See all rules</TextLink>
      </span>
      <PresetMenu onPick={fn()} />
    </>
  );
}

const meta = {
  title: 'Boards/Rules presets and payment limit',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** A connector's section on the Rules page, by its name. */
function section(root: HTMLElement, name: string): HTMLElement {
  return within(root).getByRole('region', { name: new RegExp(`^${name}`) });
}

/** The payment limit's line in a section: the limit and "Change", in the section's line above its tools. */
async function expectLimitLine(group: HTMLElement): Promise<HTMLElement> {
  const line = one(group, '.cd-connector-section__above');
  await expect(within(line).getByText(rivera.paymentLimit.line)).toBeVisible();
  expectComputed(line, { paddingTop: '12px', paddingLeft: '16px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
  // It sits between the section's head and its first tool.
  const head = one(group, '.cd-connector-section__header');
  await expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(head.getBoundingClientRect().bottom);
  const [firstTool] = some(group, '.cd-connector-section__tool');
  await expect(line.getBoundingClientRect().bottom).toBeLessThanOrEqual((firstTool as HTMLElement).getBoundingClientRect().top);
  return line;
}

export const Presets: Story = {
  name: 'Rules, with the preset menu',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} actions={headerActions()} aboveTools={{ payments: limit(), stripe: limit() }} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-17-Presets',
    canvasNote: [
      'The page layout is the web app’s (plan 04): the "See all rules" link before "Start from a preset" in the header’s actions and the payment limit in the Payments and Stripe sections’ line above their tools.',
      'The play opens the menu by keyboard, as the board draws it open; the board draws the button’s ring with the first item’s hover.',
      SIDEBAR_ROW_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const page = await expectRulesPage(canvasElement, RIVERA_CHIPS);
    await expect(page.chips[2]).toHaveTextContent('Why was this quote held?');
    const main = within(canvasElement).getByRole('main');
    // The menu button in the header, at a screen's main height.
    const header = one(main, '.cd-page-header');
    const menuButton = within(header).getByRole('button', { name: 'Start from a preset' });
    expectComputed(menuButton, { ...SPEC.secondaryMain, height: '40px' });
    // The payment limit in Payments and in Stripe, and in no other section.
    const payments = await expectLimitLine(section(main, 'Payments'));
    await expectLimitLine(section(main, 'Stripe'));
    await expect(some(main, '.cd-connector-section__above')).toHaveLength(2);
    // focus_order_is_logical: the header link, the menu, the composer and its chips, then the sections, the limit's
    // Change after its section's head.
    const change = within(payments).getByRole('button', { name: 'Change' });
    await expectTabOrder(userEvent, [within(header).getByRole('link', { name: 'See all rules' }), menuButton, page.composer, ...page.chips, one(section(main, 'Payments'), '.cd-connector-section__header'), change], 160);
    // Opened by keyboard, as the board draws it: two items, the first focused.
    menuButton.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(main).getByRole('menu', { name: 'Start from a preset' });
    await expect(within(menu).getAllByRole('menuitem').map((item) => item.querySelector('.cd-preset-menu__title')?.textContent)).toEqual(
      PRESET_WORDS.map((item) => item.label),
    );
    await expect(within(menu).getByRole('menuitem', { name: 'Ask me first' })).toHaveFocus();
    await expectFooter(canvasElement);
  },
};

export const PresetReview: Story = {
  name: 'Ask me first, the review',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Rules', 'Ask me first']} />
        <PageHeader title="Ask me first" subtitle={REVIEW_LINE} />
        <ChangeReview rows={ASK_FIRST_ROWS} checks={ASK_FIRST_CHECKS} cancelsLinks onConfirm={fn()} onCancel={fn()} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-18-Preset-Review',
    canvasNote: [
      'The rows add Dana Whitfield’s personal booking rule, which a preset replaces too and the board doesn’t draw; the shared rule for Alex Kim’s assistant is the board’s illustrative card, which isn’t in Turner’s seed.',
      SIDEBAR_ROW_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = within(canvasElement).getByRole('main');
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expect(crumbs.map((link) => link.textContent)).toEqual(['Rules']);
    expectComputed(within(main).getByRole('heading', { level: 1, name: 'Ask me first' }), SPEC.pageTitle);
    // Every row is a rule that goes: tagged "Changed", its Before beside the refused bar, the
    // default ask beside the handled bar.
    const tags = some(main, '.cd-change-review__tag');
    await expect(tags.map((tag) => tag.textContent)).toEqual(Array(ASK_FIRST_ROWS.length).fill('Changed'));
    // The board's shared rule for Alex Kim's assistant, right after Payment link: its connector,
    // then "Shared rule".
    const rows = some(main, '.cd-change-review__row');
    const titles = rows.map((row) => one(row, '.cd-change-review__title').textContent);
    const shared = titles.indexOf('Payment link and Charge within a signed limit');
    await expect(shared).toBe(titles.indexOf('Payment link') + 1);
    await expect(one(rows[shared] as HTMLElement, '.cd-change-review__body > .cd-change-review__meta')).toHaveTextContent(/^Payments · Shared rule$/);
    const { width: _width, ...tagLook } = CONNECTORS_SPEC.changeTag;
    for (const tag of tags) expectComputed(tag, tagLook);
    for (const before of some(main, '.cd-change-review__side--before')) expectComputed(before, { borderLeftWidth: '2px', borderLeftColor: 'rgb(220, 130, 144)' });
    for (const after of some(main, '.cd-change-review__side--after')) expectComputed(after, { borderLeftWidth: '2px', borderLeftColor: 'rgb(111, 168, 89)' });
    // The line about cancelled payment links, then the buttons.
    await expect(within(main).getByText("Open payment links I made on my own that the new rules don't allow will be cancelled.")).toBeVisible();
    const confirm = within(main).getByRole('button', { name: 'Confirm change' });
    expectComputed(confirm, SPEC.primary);
    const keep = within(main).getByRole('button', { name: 'Keep my rules' });
    await expectTabOrder(userEvent, [...crumbs, confirm, keep]);
    await expectFooter(canvasElement);
  },
};

export const PaymentLimit: Story = {
  name: 'Rules, the payment limit',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} actions={headerActions()} aboveTools={{ payments: limit(), stripe: limit() }} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-19-Ceiling',
    canvasNote: ['The board draws the page scrolled to Payments and Stripe; the story is the whole page.', SIDEBAR_ROW_NOTE].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = within(canvasElement).getByRole('main');
    const payments = section(main, 'Payments');
    const line = await expectLimitLine(payments);
    // 57 px with its hairline: the limit and "Change", centered on each other.
    await expect(line.getBoundingClientRect().height).toBe(57);
    const change = within(line).getByRole('button', { name: 'Change' });
    expectComputed(change, { height: '32px' });
    const stripeLine = await expectLimitLine(section(main, 'Stripe'));
    // The page's two "Change" buttons each point at their own group's limit line.
    const stripeChange = within(stripeLine).getByRole('button', { name: 'Change' });
    const described = [change, stripeChange].map((button) => button.getAttribute('aria-describedby'));
    await expect(new Set(described).size).toBe(2);
    for (const [i, button] of [change, stripeChange].entries()) {
      await expect(button).toHaveAccessibleDescription(rivera.paymentLimit.line);
      await expect([line, stripeLine][i]?.querySelector(`#${CSS.escape(described[i] ?? '')}`)).not.toBeNull();
    }
    const [head, ...tools] = within(payments).getAllByRole('link');
    await expectTabOrder(userEvent, [head as HTMLElement, change, ...tools], 160);
    payments.scrollIntoView({ block: 'start' });
  },
};

export const PaymentLimitEdit: Story = {
  name: 'Rules, changing the payment limit',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} actions={headerActions()} aboveTools={{ payments: limit(true), stripe: limit() }} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-19b-Ceiling-Edit',
    canvasNote: ['The board draws the page scrolled to Payments and Stripe; the story is the whole page.', SIDEBAR_ROW_NOTE].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = within(canvasElement).getByRole('main');
    const payments = section(main, 'Payments');
    const line = one(payments, '.cd-connector-section__above');
    // The field open in Payments, 163 px with its hairline; Stripe's limit still reads.
    await expect(line.getBoundingClientRect().height).toBe(163);
    const field = within(line).getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' });
    await expect(field).toHaveValue('1000');
    await expect(field).toHaveAccessibleDescription(rivera.paymentLimit.hint);
    await expect(field.getBoundingClientRect().width).toBe(360);
    const review = within(line).getByRole('button', { name: 'Review change' });
    expectComputed(review, { ...SPEC.primary, height: '32px' });
    const cancel = within(line).getByRole('button', { name: 'Cancel' });
    await expectLimitLine(section(main, 'Stripe'));
    const [head, ...tools] = within(payments).getAllByRole('link');
    await expectTabOrder(userEvent, [head as HTMLElement, field, review, cancel, ...tools], 160);
    payments.scrollIntoView({ block: 'start' });
  },
};

export const PaymentLimitReview: Story = {
  name: 'Change your payment limit',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Rules', 'Change your payment limit']} />
        <PageHeader title="Change your payment limit" subtitle={REVIEW_LINE} />
        <LimitChange {...rivera.limitRaise} />
        <ChangeReview
          rows={[]}
          hasOtherChanges
          checks={{ status: 'checked', lines: ['Checked against the always-on rules and your other rules.'] }}
          onConfirm={fn()}
          onCancel={fn()}
        />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-20-Ceiling-Review',
    canvasNote: [
      'The trail names the page by its title, "Rules / Change your payment limit" (owner decision 2026-10-30), as every review page’s does, where the board draws "Rules" alone.',
      'The new limit is set in the summary style, the serif at its optical size 20, about 2% narrower than the board’s.',
      SIDEBAR_ROW_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = within(canvasElement).getByRole('main');
    expectComputed(within(main).getByRole('heading', { level: 1, name: 'Change your payment limit' }), SPEC.pageTitle);
    const card = within(main).getByRole('region', { name: 'Payment limit' });
    await expect(card).toHaveTextContent(`${rivera.limitRaise.now}${rivera.limitRaise.was}`);
    await expect(within(main).getByText('Your rules stay the same.')).toBeVisible();
    // A raise cancels no payment link, so no line says so.
    await expect(main).not.toHaveTextContent('payment links I made on my own');
    const confirm = within(main).getByRole('button', { name: 'Confirm change' });
    expectComputed(confirm, SPEC.primary);
    await expect(confirm).toBeEnabled();
    // limit_review_trail_names_the_page: "Rules / Change your payment limit", the page by its title.
    const trail = within(main).getByRole('navigation', { name: 'Breadcrumb' });
    await expect(trail).toHaveTextContent(/^Rules\/Change your payment limit$/);
    await expect(within(trail).getByText('Change your payment limit')).toHaveAttribute('aria-current', 'page');
    const crumbs = within(trail).getAllByRole('link');
    await expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Rules']);
    await expectTabOrder(userEvent, [...crumbs, confirm, within(main).getByRole('button', { name: 'Keep my rules' })]);
    await expectFooter(canvasElement);
  },
};

export const SimulateChange: Story = {
  name: 'Refund, with the simulate strip',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Stripe', 'Refund']} />
        <ToolPageHeader {...rivera.toolPages.refund} status="enabled" onSimulateChange={fn()} />
        <PageSection title="Your rules for refund">
          <ToolRulesCard label="Your rules for refund" rules={riveraRulesFor('payments.create_refund', ['pay_out', 'private_data'])} onAddRule={fn()} />
        </PageSection>
        <AskAboutRules placeholder="Ask Claude to change a rule for refund" chips={REFUND_CHIPS} />
        <RecentRequests rows={rivera.recentRequests.refund.map((row) => ({ ...row, href: `#${row.key}` }))} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-21-Simulate',
    canvasNote: [
      'Refund’s page as on N-Conn-05-Refund, with the demo’s strip under its header; the recent requests are the fixture’s.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = within(canvasElement).getByRole('main');
    const header = one(main, '.cd-tool-page-header');
    const strip = one(header, '.cd-tool-page-header__simulate');
    await expect(strip).toHaveTextContent("Demo only. Changes this tool's definition on the mock Stripe server, so you can see what happens.");
    await expect(strip.getBoundingClientRect().top - one(header, '.cd-tool-page-header__source').getBoundingClientRect().bottom).toBe(20);
    const simulate = within(strip).getByRole('button', { name: 'Simulate a tool change' });
    await expect(simulate).toHaveClass('cd-button--ghost');
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    const rules = within(main).getByRole('region', { name: 'Your rules for refund' });
    await expectTabOrder(userEvent, [...crumbs, simulate, ...rules.querySelectorAll<HTMLElement>('button')], 120);
    await expectFooter(canvasElement);
  },
};

export const PhonePresets: Story = {
  name: 'Rules on a phone, with the preset menu',
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <RulesPage hub={RIVERA_HUB} chips={RIVERA_CHIPS} actions={headerActions()} aboveTools={{ payments: limit(), stripe: limit() }} />
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-22-Phone-Presets',
    canvasNote: [
      'The page as the web app composes it: PageHeader with See all rules before the preset menu, actionsBelowOnPhone and hideSubtitleOnPhone. On a phone both actions share the row under the title without a subtitle; the preset button fills the rest of the row and its open menu spans the column.',
      'The composer reads “Ask Claude to change a rule” at every width, as the board does.',
      'The play opens the menu by keyboard, as the board draws it open.',
    ].join(' '),
  },
  play: async ({ canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(390);
    const main = within(canvasElement).getByRole('main');
    const title = within(main).getByRole('heading', { level: 1, name: 'Rules' });
    const menuButton = within(main).getByRole('button', { name: 'Start from a preset' });
    // The actions share a row 16 px under the title; the preset fills the space after the link.
    const header = one(main, '.cd-page-header');
    const all = within(header).getByRole('link', { name: 'See all rules' });
    const actions = one(header, '.cd-page-header__actions');
    await expect(within(main).getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.')).not.toBeVisible();
    await expect(menuButton.getBoundingClientRect().top - title.getBoundingClientRect().bottom).toBe(16);
    const column = one(main, '.cd-app-shell__content');
    await expect(Math.round(actions.getBoundingClientRect().width)).toBe(Math.round(column.getBoundingClientRect().width));
    await expect(menuButton.getBoundingClientRect().top).toBe(all.getBoundingClientRect().top);
    await expect(menuButton.getBoundingClientRect().left - all.getBoundingClientRect().right).toBe(16);
    await expect(menuButton.getBoundingClientRect().right).toBe(actions.getBoundingClientRect().right);
    // The payment limit in Payments and Stripe, "Change" under the words.
    for (const name of ['Payments', 'Stripe']) {
      const line = one(section(main, name), '.cd-connector-section__above');
      expectComputed(line, { paddingTop: '12px', paddingLeft: '14px' });
      const words = within(line).getByText(rivera.paymentLimit.line);
      await expect(within(line).getByRole('button', { name: 'Change' }).getBoundingClientRect().top - words.getBoundingClientRect().bottom).toBe(10);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    // Opened by keyboard, 6 px under the actions row at the column's full width.
    menuButton.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(main).getByRole('menu', { name: 'Start from a preset' });
    await expect(Math.round(menu.getBoundingClientRect().width)).toBe(Math.round(column.getBoundingClientRect().width));
    await expect(menu.getBoundingClientRect().left).toBe(actions.getBoundingClientRect().left);
    await expect(menu.getBoundingClientRect().top - actions.getBoundingClientRect().bottom).toBe(6);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
