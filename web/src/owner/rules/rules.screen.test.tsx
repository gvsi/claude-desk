/**
 * The Rules page in a real browser against the mock API: outcomes by connector, Ask Claude beside
 * the page, the presets and the payment limit, each change through its proved review, and the
 * house rules.
 */
import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import type { Suggestion } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { EXTRA_RULES, type DeskRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The mock's main Desk. */
function desk(): DeskRecord {
  const found = mockStore.world.desk(RIVERA.deskId);
  if (!found) throw new Error('the mock has the main Desk');
  return found;
}

/** The change review's rows as the owner reads them, in order: each one's title and the words of its Before and After. */
function reviewRows(screen: { container: HTMLElement }): { title: string; before: string | null; after: string | null }[] {
  const words = (el: Element | null) => (el === null ? null : (el.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  return [...screen.container.querySelectorAll('.cd-change-review__row')].map((row) => ({
    title: row.querySelector('.cd-change-review__title')?.firstChild?.textContent?.trim() ?? '',
    before: words(row.querySelector('[role="group"][aria-label="Before"]')),
    after: words(row.querySelector('[role="group"][aria-label="After"]')),
  }));
}

/** Whether `el` is wholly inside the visible part of `scroller`. */
function inView(el: Element, scroller: Element): boolean {
  const box = el.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  return box.height > 0 && box.top >= port.top && box.bottom <= port.bottom;
}

/** A rule Maria's answers suggest: Dana's refunds up to $50 without asking. */
const DANA_REFUNDS: Suggestion = {
  tool: 'payments.create_refund',
  count: 3,
  text: 'You approved 3 refunds for Dana Whitfield under $50 this month. Let these go through without asking?',
  card: {
    card_id: 'card-dana-refunds',
    applies_to: 'payments.create_refund',
    mode: 'auto',
    who: 'person',
    person_id: rivera.people.dana.personId,
    agent_key_id: null,
    max_amount_cents: 5_000,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    reason: 'Refunds to Dana Whitfield up to $50 go through on their own.',
  },
};

/** Rivera's payment limit, atop Payments and Stripe. */
const LIMIT_500 = 'No payment over $500 goes through without asking you, whatever the rules below say.';

const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

/** The connector sections, in order, by their names. */
const SECTIONS = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'] as const;

describe('rules page', () => {
  it('rules_page_groups_outcomes_by_connector', async () => {
    // Refund's definition changed and waits for review.
    desk().tools = desk().tools.map((tool) => (tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review', pending_sha256: 'b'.repeat(64) } : tool));
    const { screen } = await renderRoute(`${DESK}/rules`);

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const list = screen.getByRole('list', { name: 'Connectors' });
    await expect.element(list).toBeVisible();
    const sections = [...list.element().querySelectorAll<HTMLElement>(':scope > li > section')];
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([...SECTIONS]);
    const keys = ['quotes', 'bookings', 'leads', 'verification', 'documents', 'payments', 'stripe'];
    sections.forEach((section, i) => {
      const header = section.querySelector('a.cd-connector-section__header');
      expect(header?.getAttribute('href'), SECTIONS[i]).toBe(`${DESK}/connectors/${keys[i]}`);
    });

    // Each tool links to its page, naming its outcome in words.
    const quote = screen.getByRole('link', { name: /^Quote: Anyone · No discounts, Automatic\. Open$/ });
    await expect.element(quote).toHaveAttribute('href', `${DESK}/connectors/quotes/native.quote`);
    await expect.element(screen.getByRole('link', { name: /^Payment link: Anyone · Up to \$300 · Checked by the reviewer, Automatic up to \$300; over \$300, ask me first\. Open$/ })).toHaveAttribute(
      'href',
      `${DESK}/connectors/payments/native.payment_link`,
    );
    await expect.element(screen.getByRole('link', { name: /^See charges: .*, Automatic\. Open$/ })).toBeVisible();
    // A changed tool needs the owner's review before its outcome counts.
    await expect.element(screen.getByRole('link', { name: /^Refund: .*, Needs your review\. Open$/ })).toHaveAttribute('href', `${DESK}/connectors/stripe/payments.create_refund`);
    await expect.element(screen.getByRole('link', { name: /^Book a visit: 2 rules, Automatic\. Open$/ })).toBeVisible();

    // No "Built in", "Integrations", "Custom" or mode switch anywhere; the always-on rules close the page.
    const text = screen.container.querySelector('main')?.textContent ?? '';
    for (const word of [/Built in/, /Integrations/, /\bCustom\b/]) expect(text).not.toMatch(word);
    expect(screen.container.querySelector('[role="radiogroup"], .cd-segmented-control')).toBeNull();
    await expect.element(screen.getByRole('region', { name: 'Always on' })).toBeVisible();
    await expect.element(screen.getByText('No money moves without your rule or a signed limit', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expect(requests('rules').length).toBeGreaterThan(0);
  });

  it('preset_menu_drafts_a_preset', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    const menu = screen.getByRole('menu', { name: 'Start from a preset' });
    expect(menu.getByRole('menuitem').elements().map((item) => item.querySelector('.cd-preset-menu__title')?.textContent)).toEqual(['Ask me first', 'Recommended rules']);
    expect(menu.element().textContent).not.toMatch(/\bCustom\b/);
    await menu.getByRole('menuitem', { name: 'Recommended rules' }).click();

    // One draft of the preset, then its review, titled by the preset.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Recommended rules' })).toBeVisible();
    expect(requests('draftPreset').map((r) => r.body)).toEqual([{ preset: 'auto' }]);
    const version = requests('draftPreset').length === 1 ? desk().lastVersion : -1;
    expect(router.state.location.pathname).toBe(`${DESK}/rules/drafts/${version}`);
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(trail.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    // Quotes stay automatic: any row of Quote's reads "Automatic", and none moves Quote to "Ask me first"
    // (the preset's own quote rule is the same as Rivera's, so it has none).
    const rows = reviewRows(screen);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.filter((r) => r.title === 'Quote')) {
      expect(row.after).toContain('Automatic');
      expect(row.after).not.toContain('Ask me first');
    }
    // Nothing changes until it is confirmed.
    expect(desk().policy.version).toBe(7);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version }]);
    expect(desk().policy.version).toBe(version);
    expect(screen.container.textContent).not.toMatch(/\bCustom\b/);
    // Back on Rules, quotes are still automatic.
    await screen.getByRole('link', { name: 'See your rules' }).click();
    await expect.element(screen.getByRole('link', { name: /^Quote: Anyone · No discounts, Automatic\. Open$/ })).toBeVisible();
  });

  it('preset_review_lists_every_removed_rule', async () => {
    // Dana Whitfield's own booking rule, from an earlier "Allow only for Dana" answer.
    mockStore.world.addActiveRules(desk(), [EXTRA_RULES.danaBooking]);
    const owned = desk().policy.cards.filter((card) => !card.card_id.startsWith('preset-'));
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    expect(requests('draftPreset').map((r) => r.body)).toEqual([{ preset: 'ask_first' }]);
    // A changed row per rule the preset removes, personal ones included, each to "Ask me first".
    const rows = reviewRows(screen);
    expect(rows).toHaveLength(owned.length);
    for (const row of rows) expect(row.after, row.title).toContain('Ask me first');
    const dana = rows.filter((row) => row.before?.includes('Dana Whitfield'));
    expect(dana).toHaveLength(1);
    expect(dana[0]?.title).toBe('Book a visit');
    // Open payment links may be cancelled, said above the buttons.
    const cancels = screen.getByText(CANCELS_LINKS, { exact: true });
    await expect.element(cancels).toBeVisible();
    const confirm = screen.getByRole('button', { name: 'Confirm change' }).element();
    expect(cancels.element().compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Keeping her rules goes back with nothing changed.
    await screen.getByRole('button', { name: 'Keep my rules' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    expect(requests('confirmRules')).toEqual([]);
    expect(desk().policy.version).toBe(7);
    expect(desk().policy.cards.map((card) => card.card_id)).toContain(EXTRA_RULES.danaBooking.card_id);
    await expect.element(screen.getByRole('link', { name: /^Book a visit: 3 rules, Automatic\. Open$/ })).toBeVisible();
  });

  it('rule_chat_shows_the_draft_inline', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    await composer.fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');

    // The panel beside the page, with the owner's words, Claude's reply and the change it drafted.
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel).toBeVisible();
    const log = panel.getByRole('log');
    await expect.element(log.getByText('Stop quoting on weekends', { exact: true })).toBeVisible();
    await expect.element(log.getByText(/^Here's that change: quotes stay automatic on weekdays/)).toBeVisible();
    expect(requests('ruleChat').map((r) => r.body)).toEqual([{ text: 'Stop quoting on weekends' }]);
    const changes = log.getByRole('region', { name: 'Changes' });
    await expect.element(changes.getByText('Quote', { exact: true })).toBeVisible();
    await expect.element(changes.getByRole('group', { name: 'After' }).getByText(/Weekdays, all day/)).toBeVisible();
    await expect.element(log.getByText('Checked against the always-on rules and your other rules.', { exact: true })).toBeVisible();
    await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    // The review's buttons are in view in the conversation, without scrolling it by hand.
    for (const name of ['Confirm change', 'Keep my rules']) {
      await expect.poll(() => inView(log.getByRole('button', { name }).element(), log.element()), { message: name }).toBe(true);
    }
    // The page beside it keeps its header: "Start from a preset" stays at the right of the title's line (N-Conn-12-Chat).
    const preset = screen.getByRole('button', { name: 'Start from a preset' }).element().getBoundingClientRect();
    const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element().getBoundingClientRect();
    expect(preset.left).toBeGreaterThan(title.right);
    expect(Math.round(preset.top - title.top)).toBe(4);
    // Nothing applied yet.
    expect(desk().policy.version).toBe(7);

    // Escape closes it, and focus goes back to the composer that opened it.
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(panel).not.toBeInTheDocument();
    await expect.element(composer).toHaveFocus();
    expect(desk().policy.version).toBe(7);
  });

  it('rules_header_keeps_its_title_whole_beside_ask_claude', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: "Why was Dana's refund held?" }).click();
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel.getByRole('log').getByText(/^Dana's refund waited for you/)).toBeVisible();
    const box = (el: Element) => el.getBoundingClientRect();
    /** How many lines an element's words run over. */
    const lines = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    };
    /** The window at `width`, once the shell has its layout for it (the top bar under 768 px), and the header's parts. */
    const at = async (width: number) => {
      await page.viewport(width, 900);
      await expect.poll(() => window.innerWidth).toBe(width);
      await expect.poll(() => screen.container.querySelector('.cd-app-shell')?.classList.contains('cd-app-shell--compact')).toBe(width < 768);
      const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
      const header = title.closest('.cd-page-header') as HTMLElement;
      // The panel stays beside the page at every width here.
      expect(box(panel.element()).left, `${width}`).toBeGreaterThan(box(header).right);
      return { title, header, text: title.closest('.cd-page-header__text') as HTMLElement, menu: screen.getByRole('button', { name: 'Start from a preset' }).element() };
    };

    // With room beside the panel, the menu stays at the right of the title's line (N-Conn-12-Chat).
    for (const width of [1440, 1280]) {
      const { title, menu } = await at(width);
      expect(lines(title), `${width}`).toBe(1);
      expect(box(menu).left, `${width}`).toBeGreaterThan(box(title).right);
      expect(Math.round(box(menu).top - box(title).top), `${width}`).toBe(4);
    }
    // In a narrower column the menu goes under the title and its subtitle, which keep the
    // column's whole width, and the title stays on one line.
    for (const width of [1024, 960, 940, 660, 640]) {
      const { title, header, text, menu } = await at(width);
      expect(lines(title), `${width}`).toBe(1);
      expect(Math.round(box(text).width), `${width}`).toBe(Math.round(box(header).width));
      expect(Math.round(box(menu).top - box(text).bottom), `${width}`).toBe(16);
    }
    expectNoHorizontalScroll();
  });

  it('rule_chat_without_change_drafts_nothing', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    // A question from the suggestions: Claude answers, and drafts nothing.
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: "Why was Dana's refund held?" }).click();
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByText(/^Dana's refund waited for you because refunds ask you first/)).toBeVisible();
    expect(requests('ruleChat').map((r) => r.body)).toEqual([{ text: "Why was Dana's refund held?" }]);
    expect(log.getByRole('region', { name: 'Changes' }).elements()).toHaveLength(0);
    expect(log.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(desk().drafts.size).toBe(0);

    // Another question from the panel's own composer goes on in the same conversation.
    const box = screen.getByRole('textbox', { name: 'Ask Claude' });
    await box.fill('What can you do?');
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(/^I can explain what a rule does/)).toBeVisible();
    expect(log.getByText("Why was Dana's refund held?", { exact: true }).elements()).toHaveLength(1);
    expect(desk().drafts.size).toBe(0);

    // Words past Plan 02's 2,000 characters aren't sent: the line says so, and the words stay in
    // the conversation to shorten.
    const long = `Stop quoting on weekends ${'and holidays '.repeat(160)}`.trim();
    expect(long.length).toBeGreaterThan(2000);
    await box.fill(long);
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText("That's over 2,000 characters. Shorten it and try again.", { exact: true })).toBeVisible();
    await expect.element(log.getByText(long, { exact: true })).toBeInTheDocument();
    expect(requests('ruleChat')).toHaveLength(2);
    expect(log.getByText("I couldn't draft that just now. Try again.", { exact: true }).elements()).toHaveLength(0);
  });

  it('rules_cannot_be_checked_on_rule_chat', async () => {
    mockStore.inject({ route: 'ruleChat', status: 409, body: { error: 'rules_cannot_be_checked' } });
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByText(RULES_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
    expect(log.getByRole('region', { name: 'Changes' }).elements()).toHaveLength(0);
    expect(log.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(screen.container.textContent).not.toMatch(/didn't pass|proven/);
  });

  it('card_above_the_money_cap_says_raise_the_limit_first', async () => {
    mockStore.inject({ route: 'ruleChat', status: 422, body: { error: 'above_money_cap', cap_cents: 50_000 } });
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Let payment links go up to $800 on their own');
    await userEvent.keyboard('{Enter}');
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByText("That's above your limit of $500. Raise the limit first.", { exact: true })).toBeVisible();
    expect(log.getByRole('region', { name: 'Changes' }).elements()).toHaveLength(0);

    // Anything else that fails says to try again, in Claude's words.
    mockStore.inject({ route: 'ruleChat', status: 500 });
    await screen.getByRole('textbox', { name: 'Ask Claude' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText("I couldn't draft that just now. Try again.", { exact: true })).toBeVisible();
  });

  it('suggestion_drafts_a_rule', async () => {
    desk().suggestions.push(DANA_REFUNDS);
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const card = screen.getByRole('region', { name: 'Suggested rule' });
    await expect.element(card.getByText(DANA_REFUNDS.text, { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Draft this rule' }).click();

    // One draft of the suggestion, then its review; nothing applies before "Confirm change".
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    expect(requests('draftSuggestion').map((r) => r.path)).toEqual([`/api/owner/policy/${RIVERA.deskId}/suggestions/payments.create_refund`]);
    expect(router.state.location.pathname).toBe(`${DESK}/rules/drafts/${desk().lastVersion}`);
    const rows = reviewRows(screen);
    expect(rows.map((row) => row.title)).toEqual(['Refund']);
    expect(rows[0]?.after).toContain('Dana Whitfield');
    expect(rows[0]?.after).toContain('Automatic up to $50; over $50, ask me first');
    expect(desk().policy.version).toBe(7);
  });

  it('unset_limit_copy_names_the_next_step', async () => {
    desk().policy = { ...desk().policy, auto_money_cap_cents: 0 };
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' }).getByText('Every payment asks you first.', { exact: true })).toBeVisible();
    expect(screen.getByText('Every payment asks you first.', { exact: true }).elements()).toHaveLength(2);
    await screen.getByRole('button', { name: 'Draft this rule' }).click();
    await expect.element(screen.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true })).toBeVisible();
    expect(requests('draftSuggestion')).toHaveLength(1);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it('house_rules_show_limits', async () => {
    // Payment links up to $400, refunds never, and no rule of Maria's on quotes.
    desk().policy = {
      ...desk().policy,
      cards: desk()
        .policy.cards.filter((card) => card.applies_to !== 'native.quote')
        .map((card) =>
          card.card_id === 'rv-link' ? { ...card, max_amount_cents: 40_000 } : card.card_id === 'rv-refund' ? { ...card, mode: 'never' as const, reason: 'Refunds never go through here.' } : card,
        ),
    };
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    // "See all rules" sits at the end of Rules, so the page is scrolled down to reach it.
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const scroller = screen.getByRole('main').element();
    scroller.scrollTop = scroller.scrollHeight;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await screen.getByRole('link', { name: 'See all rules' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules/all`);
    // All rules opens at its top, its trail and title in view.
    expect(screen.getByRole('main').element().scrollTop).toBe(0);
    expect(inView(screen.getByRole('heading', { level: 1, name: 'All rules' }).element(), screen.getByRole('main').element())).toBe(true);

    const link = screen.getByRole('region', { name: 'Payment link' });
    await expect.element(link.getByText('Anyone · Up to $400 · Checked by the reviewer', { exact: true })).toBeVisible();
    await expect.element(link.getByText('Automatic up to $400; over $400, ask me first', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Refund' }).getByText('Never', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Find open times' }).getByText('Automatic', { exact: true })).toBeVisible();
    // A tool no rule covers asks.
    const quote = screen.getByRole('region', { name: 'Quote' });
    await expect.element(quote.getByText('Not covered by a rule you set, so I ask you.', { exact: true })).toBeVisible();
    await expect.element(quote.getByText('Ask me first', { exact: true })).toBeVisible();
    // Read-only, in the outcomes' own words.
    const main = screen.container.querySelector('main');
    expect(main?.querySelectorAll('.cd-outcome-menu__button')).toHaveLength(0);
    expect(main?.textContent).not.toMatch(/Do it|Ask me(?! first)/);
    await expect.element(screen.getByRole('region', { name: 'Always on' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('money_cap_shows_and_changes_through_a_draft', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const payments = screen.getByRole('region', { name: 'Payments' });
    const stripe = screen.getByRole('region', { name: 'Stripe' });
    for (const group of [payments, stripe]) await expect.element(group.getByText(LIMIT_500, { exact: true })).toBeVisible();

    // "Change" opens the field, focus in it, with what it is now.
    await payments.getByRole('button', { name: 'Change' }).click();
    const field = payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' });
    await expect.element(field).toHaveFocus();
    await expect.element(payments.getByText('Whole dollars, from 0 to 10,000. Now $500.', { exact: true })).toBeVisible();
    // One field open at a time: Stripe's still reads.
    await expect.element(stripe.getByText(LIMIT_500, { exact: true })).toBeVisible();

    // Above the ceiling: said in the field, and nothing is sent.
    await field.fill('10001');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(payments.getByText('No single payment can be above $10,000.', { exact: true })).toBeVisible();
    // The amount it is already: the field closes with no request.
    await field.fill('500');
    await userEvent.keyboard('{Enter}');
    await expect.element(payments.getByText(LIMIT_500, { exact: true })).toBeVisible();
    expect(requests('draftMoneyCap')).toEqual([]);

    // The API's own refusal above the platform's ceiling says the same, in the field.
    mockStore.inject({ route: 'draftMoneyCap', status: 422, body: { error: 'above_platform_ceiling' } });
    await payments.getByRole('button', { name: 'Change' }).click();
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('9000');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(payments.getByText('No single payment can be above $10,000.', { exact: true })).toBeVisible();
    expect(requests('draftMoneyCap').map((r) => r.body)).toEqual([{ auto_money_cap_cents: 900_000 }]);

    // A new amount drafts it, and its review says it in words.
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('5000');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    expect(requests('draftMoneyCap').map((r) => r.body)).toEqual([{ auto_money_cap_cents: 900_000 }, { auto_money_cap_cents: 500_000 }]);
    await expect.element(screen.getByText('New limit: no payment over $5,000 without asking you.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Was $500', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Your rules stay the same.', { exact: true })).toBeVisible();
    expect(screen.getByText(CANCELS_LINKS, { exact: true }).elements()).toHaveLength(0);
    // Under "Rules" alone, as the board draws it.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.element().textContent).toBe('Rules');
    expect(desk().policy.auto_money_cap_cents).toBe(50_000);
  });

  it('money_limit_changes_only_at_confirm', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const lower = async () => {
      const payments = screen.getByRole('region', { name: 'Payments' });
      await payments.getByRole('button', { name: 'Change' }).click();
      await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('100');
      await payments.getByRole('button', { name: 'Review change' }).click();
      await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    };

    // A lower limit: drafted, and reviewed with the links it may cancel.
    await lower();
    expect(requests('draftMoneyCap').map((r) => r.body)).toEqual([{ auto_money_cap_cents: 10_000 }]);
    await expect.element(screen.getByText('New limit: no payment over $100 without asking you.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Was $500', { exact: true })).toBeVisible();
    await expect.element(screen.getByText(CANCELS_LINKS, { exact: true })).toBeVisible();
    // Payment link's own $300 comes down to the new limit in the draft, and the review shows it;
    // the agents' $20 deposit already fits, so it is the one change.
    const lowered = reviewRows(screen);
    expect(lowered.map((row) => row.title)).toEqual(['Payment link']);
    expect(lowered[0]?.before).toContain('Automatic up to $300; over $300, ask me first');
    expect(lowered[0]?.after).toContain('Automatic up to $100; over $100, ask me first');
    expect(screen.getByText('Your rules stay the same.', { exact: true }).elements()).toHaveLength(0);
    expect(desk().policy.auto_money_cap_cents).toBe(50_000);
    expect(desk().policy.cards.find((card) => card.card_id === 'rv-link')?.max_amount_cents).toBe(30_000);

    // Keeping her rules keeps $500.
    await screen.getByRole('button', { name: 'Keep my rules' }).click();
    await expect.element(screen.getByRole('region', { name: 'Payments' }).getByText(LIMIT_500, { exact: true })).toBeVisible();
    expect(requests('confirmRules')).toEqual([]);

    // Again, confirmed: $100 in both groups.
    await lower();
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules')).toHaveLength(1);
    expect(desk().policy.auto_money_cap_cents).toBe(10_000);
    await screen.getByRole('link', { name: 'See your rules' }).click();
    const limit100 = 'No payment over $100 goes through without asking you, whatever the rules below say.';
    for (const name of ['Payments', 'Stripe']) await expect.element(screen.getByRole('region', { name }).getByText(limit100, { exact: true })).toBeVisible();
    // No rule beside it still takes more on its own.
    await expect.element(screen.getByRole('link', { name: /^Payment link: .*, Automatic up to \$100; over \$100, ask me first\. Open$/ })).toBeVisible();
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$300');

    // At 0, every payment asks, and no "$0" anywhere.
    const payments = screen.getByRole('region', { name: 'Payments' });
    await payments.getByRole('button', { name: 'Change' }).click();
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('0');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByText('New limit: every payment asks you first.', { exact: true })).toBeVisible();
    // Each rule that took money on its own now asks first, in the review.
    const asks = reviewRows(screen);
    expect(asks.map((row) => row.title).sort()).toEqual(['Charge within a signed limit', 'Payment link']);
    for (const row of asks) expect(row.after, row.title).toContain('Ask me first');
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    await screen.getByRole('link', { name: 'See your rules' }).click();
    for (const name of ['Payments', 'Stripe']) {
      await expect.element(screen.getByRole('region', { name }).getByText('Every payment asks you first.', { exact: true })).toBeVisible();
    }
    await expect.element(screen.getByRole('link', { name: /^Payment link: .*, Ask me first\. Open$/ })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: /^Charge within a signed limit: .*, Ask me first\. Open$/ })).toBeVisible();
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it('rules_page_matches_its_board', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const main = screen.getByRole('main').element() as HTMLElement;
    const menu = screen.getByRole('button', { name: 'Start from a preset' }).element() as HTMLElement;
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).element() as HTMLElement;
    const chips = screen.getByRole('group', { name: 'Suggestions' }).getByRole('button').elements() as HTMLElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual(['Stop quoting on weekends', 'Quote water heater installs up to $600', "Why was Dana's refund held?"]);
    // Each section's header, its payment limit's "Change", then its tools, in order.
    const sections = [...main.querySelectorAll<HTMLElement>('.cd-connector-section')].flatMap((section) => [
      ...section.querySelectorAll<HTMLElement>('.cd-connector-section__header, .cd-money-limit button, .cd-connector-section__tool-link'),
    ]);
    expect(sections).toHaveLength(7 + 2 + 11);
    await expectOwnerBoard(screen.container, { current: 'Rules', tabStops: [menu, composer, ...chips, ...sections] });

    // As the board spaces them: the composer 20 px under the header, its suggestions 10 px under
    // it, the connectors' summary 20 px under them; the menu at the right of the title's line.
    const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
    const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);
    const box = composer.closest('.cd-composer__box') as HTMLElement;
    const header = main.querySelector('.cd-page-header') as HTMLElement;
    const group = main.querySelector('.cd-suggestion-chips') as HTMLElement;
    expect(top(box) - bottom(header)).toBe(20);
    expect(top(group) - bottom(box)).toBe(10);
    expect(top(main.querySelector('.cd-connector-list__summary') as HTMLElement) - bottom(group)).toBe(20);
    const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(menu.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    expect(top(menu) - top(title)).toBe(4);
    await expect.element(screen.getByText('Claude shows you the change and example situations before anything applies.', { exact: true })).toBeVisible();
  });

  it('rules_have_no_jargon', async () => {
    mockStore.world.addActiveRules(desk(), [EXTRA_RULES.agentCharges, EXTRA_RULES.danaBooking]);
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('link', { name: /^Payment link: 2 rules · 1 shared, Automatic up to \$300; over \$300, ask me first\. Open$/ })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // With the panel open and a change drafted in it.
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Stop quoting on weekends' }).click();
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // The house rules, and the Rules page at a phone's width, unbroken.
    const all = await renderRoute(`${DESK}/rules/all`);
    await expect.element(all.screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    await expectScreenBasics(all.screen.container, { owner: true });
    const phone = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // Under 640 px the preset menu takes a line of its own under the title.
    const menu = phone.screen.getByRole('button', { name: 'Start from a preset' }).element();
    const title = phone.screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(Math.round(menu.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(16);
    expect(phone.screen.getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.').element()).not.toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(phone.screen.container, { owner: true });

    // Ask Claude as a sheet over the page: the drafted change's buttons are in view.
    await phone.screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const sheet = phone.screen.getByRole('dialog', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(sheet.getByRole('button', { name: 'Confirm change' })).toBeEnabled();
    for (const name of ['Confirm change', 'Keep my rules']) {
      await expect.poll(() => inView(sheet.getByRole('button', { name }).element(), sheet.element()), { message: name }).toBe(true);
    }
    expectNoHorizontalScroll();
  });
});

