/**
 * The Rules page in a real browser against the mock API: outcomes by connector, Ask Claude beside
 * the page, the presets and the payment limit, each change through its proved review, and the
 * house rules.
 */
import { onlineManager } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { RouteObject } from 'react-router';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';

import { observeRequests, OWNER_ERROR_COPY, RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import { ROUTES } from '../../api/routes.ts';
import type { RuleCard } from '../../api/contracts.ts';
import type { Suggestion } from '../../api/views.ts';
import { routes } from '../../app/routes.tsx';
import { rivera } from '../../ds/fixtures/index.ts';
import { lineWords } from '../../ds/test/lineWords.ts';
import { settled } from '../../ds/test/settled.ts';
import { worker } from '../../mocks/browser.ts';
import { businessOut } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { EXTRA_RULES, type DeskRecord } from '../../mocks/world.ts';
import { expectOwnerBoard, expectTabOrderFromTop } from '../../test/boards.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';
import { watchTop } from '../../test/watch.ts';
import { REVIEWER_LINE } from './copy.ts';

const DESK = `/app/${RIVERA.deskId}`;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** The loaded page's part, excluding the same layout classes inside a hidden loading layer. */
function pagePart(selector: string, root: ParentNode = document): Element | null {
  return [...root.querySelectorAll(selector)].find((element) => element.closest('.cd-skeleton-screen__layer') === null) ?? null;
}

/** Successful reads whose responses have completed, rather than requests only sent. */
function finishedReads(): Set<string> {
  const finished = new Set<string>();
  onTestFinished(observeRequests(({ key, ok }) => { if (ok) finished.add(key); }));
  return finished;
}

/** The mock's main Desk. */
function desk(): DeskRecord {
  const found = mockStore.world.desk(RIVERA.deskId);
  if (!found) throw new Error('the mock has the main Desk');
  return found;
}

/** Renames both the business read and its Desk summary, as the API keeps them together. */
function renameBusiness(name: string): void {
  desk().summary.business_name = name;
  worker.use(http.get(ROUTES.desks.path, () => HttpResponse.json([{ ...businessOut(mockStore.world), name }])));
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

/**
 * Once the change Claude drafted shows in the Ask Claude conversation `log`, the owner's `words`
 * that asked for it are whole, at the conversation's top or below it, never cut under the panel's
 * header; and the review's "Confirm change" and "Keep my rules" are reachable by scrolling the
 * conversation to its end. `at` names the case.
 */
async function expectTurnOpensAtTheOwnersWords(log: Locator, words: string, at: string): Promise<void> {
  const confirm = log.getByRole('button', { name: 'Confirm change' });
  await expect.element(confirm, { message: at }).toBeEnabled();
  const port = log.element();
  const bubble = log.getByText(words, { exact: true }).element();
  expect(Math.round(bubble.getBoundingClientRect().top), at).toBeGreaterThanOrEqual(Math.round(port.getBoundingClientRect().top));
  expect(inView(bubble, port), at).toBe(true);
  port.scrollTop = port.scrollHeight;
  for (const name of ['Confirm change', 'Keep my rules']) {
    await expect.poll(() => inView(log.getByRole('button', { name }).element(), port), { message: `${at}: ${name}` }).toBe(true);
  }
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

/** Rivera's suggestions under Ask Claude, in order; a question about a hold may follow them. */
const FIXED_CHIPS = ['Stop quoting on weekends', 'Quote water heater installs up to $600'] as const;

/** The words of each suggestion in `group`, in order. */
function chipWords(group: Locator): string[] {
  return group.getByRole('button').elements().map((chip) => chip.textContent ?? '');
}

/** The main Desk's Needs you, as the app reads it. */
const NEEDS_YOU_PATH = ROUTES.needsYou.path.replace('{desk_id}', RIVERA.deskId);

/** Holds every read of the main Desk's Needs you until `release()` lets them through to the mock; `held()` counts them. */
function holdNeedsYou(): { held: () => number; release: () => void } {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  worker.use(
    http.get(NEEDS_YOU_PATH, async () => {
      waiting += 1;
      await released;
      return undefined;
    }),
  );
  return { held: () => waiting, release };
}

/** Every read of the main Desk's Needs you fails until `recover()`, then goes through to the mock; `failed()` counts the failures. */
function failNeedsYou(): { failed: () => number; recover: () => void } {
  let failing = true;
  let failures = 0;
  worker.use(
    http.get(NEEDS_YOU_PATH, () => {
      if (!failing) return undefined;
      failures += 1;
      return HttpResponse.json({ error: 'unavailable' }, { status: 503 });
    }),
  );
  return {
    failed: () => failures,
    recover: () => {
      failing = false;
    },
  };
}

/** Rivera's payment limit, atop Payments and Stripe. */
const LIMIT_500 = 'No payment over $500 goes through without asking you, whatever the rules below say.';

const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

/** The connector sections, in order, by their names. */
const SECTIONS = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'] as const;

/** Each section's connector, in the same order: its page is `connectors/{key}`. */
const SECTION_KEYS = ['quotes', 'bookings', 'leads', 'verification', 'documents', 'payments', 'stripe'] as const;

/** A tool's row on Rules in the owner's words: "{name}: {rule words}, {outcome}". */
function toolRowWords(row: Element): string {
  const part = (selector: string) => row.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return `${part('.cd-connector-section__tool-name')}: ${part('.cd-connector-section__tool-summary')}, ${part('.cd-connector-section__tool-outcome')}`;
}

/**
 * The app's routes with a stand-in page where the Connectors page will be, under the Desk, so a
 * test can open it with the Connectors pages switched on.
 */
function withConnectorsPage(): RouteObject[] {
  return routes.map((route) => {
    if (route.path !== '/app/:deskId' || route.index === true) return route;
    return { ...route, children: [...(route.children ?? []), { path: 'connectors', element: <h1>Connectors</h1> }] };
  });
}

/**
 * The tool row on Rules whose words (`toolRowWords`) match `words`, once it shows, linked to its
 * page or not.
 */
async function expectToolRow(root: HTMLElement, words: RegExp): Promise<HTMLElement> {
  const find = () => [...root.querySelectorAll<HTMLElement>('.cd-connector-section__tool')].find((row) => words.test(toolRowWords(row)));
  await expect.poll(() => find() !== undefined, { message: `a tool row reading ${words}` }).toBe(true);
  const row = find() as HTMLElement;
  await expect(row).toBeVisible();
  return row;
}

describe('rules page', () => {
  it('rules_header_links_to_all_rules_before_the_preset_and_keeps_the_lower_link', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const header = screen.container.querySelector('.cd-rules__header');
    const all = header?.querySelector<HTMLAnchorElement>('a');
    expect(all, 'See all rules in the header').not.toBeNull();
    expect(all?.textContent).toBe('See all rules');
    const actions = all?.closest('.cd-page-header__actions');
    const preset = screen.getByRole('button', { name: 'Start from a preset' }).element();
    expect(actions?.contains(preset)).toBe(true);
    expect(all!.compareDocumentPosition(preset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all rules' }).elements()).toHaveLength(2);
    const lower = screen.container.querySelector('.cd-rules__all .cd-text-link');
    expect(lower?.getAttribute('href')).toBe(`${DESK}/rules/all`);
    await expectScreenBasics(screen.container, { owner: true });

    await userEvent.click(all!);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules/all`);
  });

  it('rules_phone_preset_menu_spans_the_actions_row_and_keeps_keyboard_navigation', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const actions = screen.container.querySelector('.cd-rules__header .cd-page-header__actions')!;
    const button = screen.getByRole('button', { name: 'Start from a preset' });
    await button.click();
    const menu = screen.getByRole('menu', { name: 'Start from a preset' });
    await expect.element(menu).toBeVisible();
    const rowBox = actions.getBoundingClientRect();
    const menuBox = menu.element().getBoundingClientRect();
    expect(Math.round(menuBox.width), 'the menu spans the full actions row').toBe(Math.round(rowBox.width));
    expect(menuBox.left).toBe(rowBox.left);
    expect(menuBox.top - rowBox.bottom, 'the menu opens 6 px under the row').toBe(6);
    expectNoHorizontalScroll();
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(menu.getByRole('menuitem', { name: 'Recommended rules' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(menu).not.toBeInTheDocument();
    await expect.element(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(menu.getByRole('menuitem', { name: 'Ask me first' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(button).toHaveFocus();
  });

  it('rules_header_link_has_a_rounded_keyboard_focus_ring', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const link = screen.container.querySelector<HTMLElement>('.cd-rules__header .cd-text-link')!;
    await expectTabOrderFromTop([link]);
    link.focus();
    expect(link.matches(':focus-visible')).toBe(true);
    expect(getComputedStyle(link).outlineStyle).toBe('solid');
    expect(getComputedStyle(link).borderRadius).toBe('8px');
  });

  it('rules_header_actions_share_the_phone_row_with_a_full_height_link', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const header = screen.container.querySelector('.cd-rules__header .cd-page-header')!;
    const actions = header.querySelector('.cd-page-header__actions')!;
    const all = actions.querySelector('a')!;
    const preset = screen.getByRole('button', { name: 'Start from a preset' }).element();
    const linkBox = all.getBoundingClientRect();
    const presetBox = preset.getBoundingClientRect();
    expect(linkBox.height, 'a 40 px link hit area').toBeGreaterThanOrEqual(40);
    expect(presetBox.top).toBe(linkBox.top);
    expect(presetBox.left - linkBox.right).toBe(16);
    expect(Math.round(presetBox.right)).toBe(Math.round(actions.getBoundingClientRect().right));
    expect(actions.scrollWidth).toBeLessThanOrEqual(actions.clientWidth);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    await page.viewport(1512, 982);
    expect(header.getBoundingClientRect().height).toBe(56);
    expect(preset.getBoundingClientRect().left - all.getBoundingClientRect().right).toBe(16);
    expectNoHorizontalScroll();
  });

  it('rules_page_groups_outcomes_by_connector', async () => {
    // Refund's definition changed and waits for review.
    desk().tools = desk().tools.map((tool) =>
      tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review', pending_sha256: 'b'.repeat(64), review_reason: 'changed' } : tool,
    );
    const { screen } = await renderRoute(`${DESK}/rules`);

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const list = screen.getByRole('list', { name: 'Connectors' });
    await expect.element(list).toBeVisible();
    const sections = [...list.element().querySelectorAll<HTMLElement>(':scope > li > section')];
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([...SECTIONS]);
    // Each header names its connector without a link: the connectors' pages aren't built yet.
    sections.forEach((section, i) => {
      const header = section.querySelector('.cd-connector-section__header');
      expect(header?.tagName, SECTIONS[i]).toBe('DIV');
      expect(header?.textContent, SECTIONS[i]).toContain(SECTIONS[i]);
    });

    // Each tool names its outcome in words, without a link.
    const root = screen.container;
    for (const words of [
      /^Quote: Anyone · No discounts, Automatic$/,
      /^Payment link: Anyone · Up to \$300 · Checked by the reviewer, Automatic up to \$300; over \$300, ask me first$/,
      /^See charges: .*, Automatic$/,
      // A changed tool needs the owner's review before its outcome counts.
      /^Refund: .*, Needs your review$/,
      /^Book a visit: 2 rules, Automatic$/,
    ]) {
      const row = await expectToolRow(root, words);
      expect(row.querySelector('a'), String(words)).toBeNull();
    }

    // No "Built in", "Integrations", "Custom" or mode switch anywhere; the always-on rules close the page.
    const text = screen.container.querySelector('main')?.textContent ?? '';
    for (const word of [/Built in/, /Integrations/, /\bCustom\b/]) expect(text).not.toMatch(word);
    expect(screen.container.querySelector('[role="radiogroup"], .cd-segmented-control')).toBeNull();
    await expect.element(screen.getByRole('region', { name: 'Always on' })).toBeVisible();
    await expect.element(screen.getByText('No money moves without your rule or a signed limit', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expect(requests('rules').length).toBeGreaterThan(0);
  });

  it('connector_rows_have_no_links_until_their_pages_are_built', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const list = screen.getByRole('list', { name: 'Connectors' });
    const sections = list.element();

    // No connector header or tool row is a link, has a chevron, or links anywhere under Connectors.
    expect(sections.querySelectorAll('.cd-connector-section__header')).toHaveLength(SECTIONS.length);
    expect(sections.querySelectorAll('.cd-connector-section__tool')).toHaveLength(11);
    expect(list.getByRole('link').elements()).toEqual([]);
    expect(sections.querySelectorAll('a, .cd-connector-section__chevron')).toHaveLength(0);
    expect(screen.container.querySelectorAll('a[href*="/connectors"]')).toHaveLength(0);
    // Nor has the sidebar a Connectors row; "See all rules" still links to every rule.
    expect(screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connectors' }).elements()).toEqual([]);
    const all = screen.getByRole('link', { name: 'See all rules' }).last();
    await expect.element(all).toHaveAttribute('href', `${DESK}/rules/all`);

    // Tab passes them by: in the connectors it stops only on the payment limit's two "Change".
    const changes = [...sections.querySelectorAll<HTMLElement>('.cd-money-limit button')];
    expect(changes.map((button) => button.textContent)).toEqual(['Change', 'Change']);
    const reached = await expectTabOrderFromTop([...changes, all.element() as HTMLElement]);
    expect(reached.filter((el) => sections.contains(el))).toEqual(changes);

    // All rules draws each tool's name and line without a link too.
    const house = await renderRoute(`${DESK}/rules/all`);
    await expect.element(house.screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    const main = house.screen.getByRole('main').element();
    expect(main.querySelectorAll('.cd-tool-rules__tool')).toHaveLength(11);
    expect(main.querySelectorAll('a.cd-tool-rules__tool, .cd-tool-rules__chevron')).toHaveLength(0);
    expect(house.screen.container.querySelectorAll('a[href*="/connectors"]')).toHaveLength(0);
    await expect.element(house.screen.getByRole('region', { name: 'Payment link' }).getByText('Payment link', { exact: true })).toBeVisible();
  });

  it('connector_rows_link_to_their_pages_once_built', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { connectorPages: true });
    const list = screen.getByRole('list', { name: 'Connectors' });
    await expect.element(list).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();

    // Each header links to its connector's page, and each tool to its own, naming its outcome.
    const sections = [...list.element().querySelectorAll<HTMLElement>(':scope > li > section')];
    expect(sections.map((section) => section.querySelector('a.cd-connector-section__header')?.getAttribute('href'))).toEqual(
      SECTION_KEYS.map((key) => `${DESK}/connectors/${key}`),
    );
    expect(list.element().querySelectorAll('a.cd-connector-section__tool-link')).toHaveLength(11);
    await expect.element(screen.getByRole('link', { name: /^Quote: Anyone · No discounts, Automatic\. Open$/ })).toHaveAttribute('href', `${DESK}/connectors/quotes/native.quote`);
    await expect.element(screen.getByRole('link', { name: /^Payment link: .*\. Open$/ })).toHaveAttribute('href', `${DESK}/connectors/payments/native.payment_link`);
    await expect.element(screen.getByRole('link', { name: /^Refund: .*\. Open$/ })).toHaveAttribute('href', `${DESK}/connectors/stripe/payments.create_refund`);
    // The sidebar's Connectors row comes with them.
    await expect.element(screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connectors' })).toHaveAttribute('href', `${DESK}/connectors`);

    // All rules links each tool's name and line to its page.
    const house = await renderRoute(`${DESK}/rules/all`, { connectorPages: true });
    await expect.element(house.screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    const link = house.screen.getByRole('region', { name: 'Payment link' }).element().querySelector('a.cd-tool-rules__tool');
    expect(link?.getAttribute('href')).toBe(`${DESK}/connectors/payments/native.payment_link`);
    expect(house.screen.getByRole('main').element().querySelectorAll('a.cd-tool-rules__tool')).toHaveLength(11);

    // On a Connectors page, the sidebar marks its row as the current one, and only that row.
    const connectors = await renderRoute(`${DESK}/connectors`, { connectorPages: true, routes: withConnectorsPage() });
    const nav = connectors.screen.getByRole('navigation', { name: 'Main' });
    await expect.element(nav.getByRole('link', { name: 'Connectors' })).toHaveAttribute('aria-current', 'page');
    expect([...nav.element().querySelectorAll('[aria-current="page"]')].map((row) => row.textContent)).toEqual(['Connectors']);
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
    // Quotes stay automatic: the preset's own quote rule is the same as Rivera's, so no row names
    // Quote, alone or among the tools a shared rule covers, and none moves it to "Ask me first".
    const rows = reviewRows(screen);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.title)).not.toContain('');
    expect(rows.filter((r) => /\bQuote\b/.test(r.title))).toEqual([]);
    // Nothing changes until it is confirmed.
    expect(desk().policy.version).toBe(7);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    // Confirmed, it goes back to Rules, where the change lands; quotes are still automatic.
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version }]);
    expect(desk().policy.version).toBe(version);
    expect(screen.container.textContent).not.toMatch(/\bCustom\b/);
    await expectToolRow(screen.container, /^Quote: Anyone · No discounts, Automatic$/);
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
    await expectToolRow(screen.container, /^Book a visit: 3 rules, Automatic$/);
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
    // The owner's words whole at the top, and the review's buttons reachable by scrolling.
    await expectTurnOpensAtTheOwnersWords(log, 'Stop quoting on weekends', 'from the page');
    // The page beside it keeps its header: "Start from a preset" stays at the right of the title's line (N-Conn-12-Chat).
    const preset = screen.getByRole('button', { name: 'Start from a preset' }).element().getBoundingClientRect();
    const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element().getBoundingClientRect();
    expect(preset.left).toBeGreaterThan(title.right);
    expect(Math.round(preset.top - title.top)).toBe(4);
    // The review inside the panel has no title of its own, so the tab stays the page's.
    expect(document.title).toBe('Rules · Claude Desk');
    // Nothing applied yet.
    expect(desk().policy.version).toBe(7);

    // Escape closes it, and focus goes back to the composer that opened it.
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(panel).not.toBeInTheDocument();
    await expect.element(composer).toHaveFocus();
    expect(desk().policy.version).toBe(7);
  });

  it('rule_chat_opens_each_turn_at_the_owners_words', async () => {
    // From a suggestion beside the page: the owner's words open the turn, whole, and the review's
    // buttons after Claude's answer are reachable by scrolling.
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Stop quoting on weekends' }).click();
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expectTurnOpensAtTheOwnersWords(log, 'Stop quoting on weekends', 'from a suggestion');

    // With the conversation at its end, the next change opens at the owner's new words too.
    await log.getByRole('button', { name: 'Keep my rules' }).click();
    await expect.element(log.getByText('Nothing changed. Your rules stay as they are.', { exact: true })).toBeVisible();
    await screen.getByRole('textbox', { name: 'Ask Claude' }).fill('Quote water heater installs up to $600');
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(/^Here's a rule for that: I quote water heater installs/)).toBeVisible();
    await expectTurnOpensAtTheOwnersWords(log, 'Quote water heater installs up to $600', 'the next change');
  });

  it('rule_chat_returns_focus_to_a_suggestion_the_click_did_not_focus', async () => {
    // Safari focuses no button a click presses, so when a suggestion opens Ask Claude beside the
    // page (1440 px), focus is still on the page's body. Closing the panel still returns focus to
    // the suggestion that opened it.
    const { screen } = await renderRoute(`${DESK}/rules`);
    const chip = screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Stop quoting on weekends' });
    await expect.element(chip).toBeVisible();
    const chipEl = chip.element();
    // What Safari does: the press moves no focus to the button.
    chipEl.addEventListener('mousedown', (event) => event.preventDefault());
    const opened: { focus: Element | null } = { focus: null };
    chipEl.addEventListener('click', () => {
      opened.focus = document.activeElement;
    });
    (document.activeElement as HTMLElement | null)?.blur();

    await userEvent.click(chip);
    expect(opened.focus, 'the click left focus on the body').toBe(document.body);
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await expect.element(panel).not.toBeInTheDocument();
    await expect.element(chip).toHaveFocus();
  });

  it('rules_header_keeps_its_title_whole_beside_ask_claude', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Why was this quote held?' }).click();
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    await expect.element(panel.getByRole('log').getByText(/^A visitor not on record asked for a drain clearing quote/)).toBeVisible();
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
      // Measured at rest: the panel has slid in and the page has glided beside it.
      await settled(screen.container);
      const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
      const header = title.closest('.cd-page-header') as HTMLElement;
      // From 1024 px up the panel stays beside the page.
      expect(box(panel.element()).left, `${width}`).toBeGreaterThan(box(header).right);
      return { title, header, text: title.closest('.cd-page-header__text') as HTMLElement, menu: screen.getByRole('button', { name: 'Start from a preset' }).element() };
    };

    // With room beside the panel, the menu stays at the right of the title's line (N-Conn-12-Chat).
    // Beside both actions the subtitle may take a third line, but never leaves its last word alone
    // (`text-wrap: pretty`; where the lone word falls depends on the platform's text, so the rule is
    // checked as well as the lines).
    for (const width of [1440, 1280]) {
      const { title, header, menu } = await at(width);
      expect(lines(title), `${width}`).toBe(1);
      expect(box(menu).left, `${width}`).toBeGreaterThan(box(title).right);
      expect(Math.round(box(menu).top - box(title).top), `${width}`).toBe(4);
      const subtitle = header.querySelector<HTMLElement>('.cd-page-header__subtitle')!;
      expect(getComputedStyle(subtitle).textWrapStyle, `${width}`).toBe('pretty');
      const words = lineWords(subtitle);
      expect(words.at(-1)?.length ?? 0, `${width}: ${JSON.stringify(words)}`).toBeGreaterThan(1);
    }
    // In the narrowest column beside the panel, 360 px at 1024 px, the actions go under the title and
    // its subtitle, which keep the column's whole width, and the title stays on one line.
    {
      const { title, header, text, menu } = await at(1024);
      expect(lines(title)).toBe(1);
      expect(Math.round(box(text).width)).toBe(Math.round(box(header).width));
      expect(Math.round(box(menu).top - box(text).bottom)).toBe(16);
    }
    // Under 1024 px the page beside the panel would be under 360 px, so the panel is a modal sheet,
    // docked at the window's right edge over the page from 640 px. The page keeps its own width
    // behind it, its title on one line, and nothing scrolls sideways.
    for (const width of [960, 940, 660, 640]) {
      await page.viewport(width, 900);
      await expect.poll(() => window.innerWidth).toBe(width);
      await expect.poll(() => screen.container.querySelector('.cd-app-shell')?.classList.contains('cd-app-shell--compact')).toBe(width < 768);
      const sheet = screen.container.querySelector<HTMLElement>('.cd-ask-claude');
      await expect.poll(() => sheet?.getAttribute('role')).toBe('dialog');
      expect(Math.round(box(sheet as HTMLElement).left), `${width}`).toBe(width - 400);
      const title = screen.container.querySelector('h1') as HTMLElement;
      expect(title.textContent).toBe('Rules');
      expect(lines(title), `${width}`).toBe(1);
      expectNoHorizontalScroll();
    }
  });

  it('rule_chat_without_change_drafts_nothing', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    // A question from the suggestions, about the seed's held quote: Claude answers about that
    // quote, and drafts nothing.
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Why was this quote held?' }).click();
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect
      .element(
        log.getByText(
          /^A visitor not on record asked for a drain clearing quote at 15% off, \$153\.00 instead of \$180\.00\. It was held by your rule: Quotes from your price list, at list price\./,
        ),
      )
      .toBeVisible();
    expect(requests('ruleChat').map((r) => r.body)).toEqual([{ text: 'Why was this quote held?' }]);
    expect(log.getByRole('region', { name: 'Changes' }).elements()).toHaveLength(0);
    expect(log.getByRole('button', { name: 'Confirm change' }).elements()).toHaveLength(0);
    expect(desk().drafts.size).toBe(0);

    // Another question from the panel's own composer goes on in the same conversation.
    const box = screen.getByRole('textbox', { name: 'Ask Claude' });
    await box.fill('What can you do?');
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(/^I can explain what a rule does/)).toBeVisible();
    expect(log.getByText('Why was this quote held?', { exact: true }).elements()).toHaveLength(1);
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

  it('an_answer_in_markdown_shows_bold_and_a_list', async () => {
    // Claude's answer in Ask Claude, in Markdown: bold as bold and the list as a list.
    const items = ['Quotes wait until Monday morning', 'Bookings for the weekend still go through'];
    const answer = `Here is how that would work. **Two things** change:\n\n${items.map((item) => `- ${item}`).join('\n')}`;
    mockStore.inject({ route: 'ruleChat', status: 200, body: { answer, draft: null } });
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('What if I stop quoting on weekends?');
    await userEvent.keyboard('{Enter}');
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    const bold = log.getByText('Two things', { exact: true });
    await expect.element(bold).toBeVisible();
    expect(bold.element().tagName).toBe('STRONG');
    const message = bold.element().closest('.cd-claude-message') as HTMLElement;
    expect([...message.querySelectorAll('li')].map((el) => el.textContent)).toEqual(items);
    expect(message.textContent).not.toMatch(/\*|^- /m);
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

  it('confirming_a_suggested_rule_leaves_focus_on_the_row_it_landed_on', async () => {
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    const card = screen.getByRole('region', { name: 'Suggested rule' });
    await expect.element(card.getByText(DANA_REFUNDS.text, { exact: true })).toBeVisible();
    card.getByRole('button', { name: 'Draft this rule' }).element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Review the change' })).toBeVisible();
    screen.getByRole('button', { name: 'Confirm change' }).element().focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();

    // Its rule confirmed, the suggestion that opened the review is done with, so focus goes to the
    // row the change landed on: Refund, which has no control of its own while the Connectors pages
    // aren't built, so the row itself takes focus, from a script only, never as a Tab stop.
    const refund = () =>
      [...screen.container.querySelectorAll<HTMLElement>('.cd-connector-section__tool')].find(
        (row) => row.querySelector('.cd-connector-section__tool-name')?.textContent === 'Refund',
      );
    await expect.poll(() => refund()?.querySelector('.cd-pill')?.textContent).toBe('Updated');
    await expect.poll(() => document.activeElement === refund()).toBe(true);
    expect(refund()?.getAttribute('tabindex')).toBe('-1');
    // Tab goes on from there, and the row stops taking focus.
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(refund());
    expect(refund()?.hasAttribute('tabindex')).toBe(false);
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
    // The lower "See all rules" stays at the end of Rules, so scroll down to reach it.
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const scroller = screen.getByRole('main').element();
    scroller.scrollTop = scroller.scrollHeight;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await screen.getByRole('link', { name: 'See all rules' }).last().click();
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

  it('all_rules_says_once_under_its_subtitle_what_the_reviewer_is', async () => {
    const { screen } = await renderRoute(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    // Under the subtitle, in the header's text: one quieter line.
    const lines = [...screen.container.querySelectorAll<HTMLElement>('.cd-house-rules__header .cd-page-header__text > p')];
    expect(lines.map((line) => line.textContent)).toEqual(['Every rule on this Desk, by connector and tool. To change one, ask Claude on Rules.', REVIEWER_LINE]);
    const line = lines[1]!;
    expect(line.classList.contains('cd-type-meta')).toBe(true);
    const style = getComputedStyle(line);
    expect(style.color).toBe(getComputedStyle(lines[0]!).color);
    expect(style.marginTop).toBe('8px');
    expect(parseFloat(style.maxWidth)).toBeGreaterThan(0);
    // Once on the page.
    expect(screen.container.textContent?.split(REVIEWER_LINE)).toHaveLength(2);
  });

  it('always_on_ends_with_a_link_to_safety_where_every_attempt_is_shown', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const always = screen.getByRole('region', { name: 'Always on' });
    await expect.element(always).toBeVisible();
    const link = screen.getByRole('link', { name: 'Open Safety' });
    await expect.element(link).toHaveAttribute('href', `${DESK}/safety`);
    // Under Always on's rules, in meta type, as the lower "See all rules" is above them.
    const line = link.element().closest('p');
    expect(line?.classList.contains('cd-type-meta')).toBe(true);
    expect(always.element().compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const list = always.element().querySelector('.cd-always-on__list')!;
    expect(Math.round(line!.getBoundingClientRect().top - list.getBoundingClientRect().bottom)).toBe(12);
    // It opens this Desk's Safety.
    await userEvent.click(link.element());
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Safety' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/safety`);
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
    // Under "Rules / Change your payment limit", the owner's choice over N-Conn-20's "Rules" alone.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await expect.element(trail.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', `${DESK}/rules`);
    expect(trail.element().textContent).toBe('Rules/Change your payment limit');
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
    // Payment link's own $300 comes down to the new limit in the draft, and the review shows it,
    // with the API's sentence for the new limit in place of the reason that quoted $300; the
    // agents' $20 deposit already fits, so it is the one change.
    const lowered = reviewRows(screen);
    expect(lowered.map((row) => row.title)).toEqual(['Payment link']);
    expect(lowered[0]?.before).toContain('Automatic up to $300; over $300, ask me first');
    expect(lowered[0]?.before).toContain('Payment links up to $300, checked by the reviewer.');
    expect(lowered[0]?.after).toContain('Automatic up to $100; over $100, ask me first');
    expect(lowered[0]?.after).toContain('Up to $100, your payment limit.');
    expect(lowered[0]?.after).not.toContain('$300');
    expect(screen.getByText('Your rules stay the same.', { exact: true }).elements()).toHaveLength(0);
    expect(desk().policy.auto_money_cap_cents).toBe(50_000);
    expect(desk().policy.cards.find((card) => card.card_id === 'rv-link')?.max_amount_cents).toBe(30_000);

    // Keeping her rules keeps $500.
    await screen.getByRole('button', { name: 'Keep my rules' }).click();
    await expect.element(screen.getByRole('region', { name: 'Payments' }).getByText(LIMIT_500, { exact: true })).toBeVisible();
    expect(requests('confirmRules')).toEqual([]);

    // Again, confirmed: back on Rules, $100 in both groups, each saying it was updated.
    await lower();
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(requests('confirmRules')).toHaveLength(1);
    expect(desk().policy.auto_money_cap_cents).toBe(10_000);
    const limit100 = 'No payment over $100 goes through without asking you, whatever the rules below say.';
    for (const name of ['Payments', 'Stripe']) await expect.element(screen.getByRole('region', { name }).getByText(`${limit100}Updated`, { exact: true })).toBeVisible();
    // No rule beside it still takes more on its own.
    await expectToolRow(screen.container, /^Payment link: .*, Automatic up to \$100; over \$100, ask me first$/);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$300');

    // At 0, every payment asks, and no "$0" anywhere.
    const payments = screen.getByRole('region', { name: 'Payments' });
    await payments.getByRole('button', { name: 'Change' }).click();
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('0');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByText('New limit: every payment asks you first.', { exact: true })).toBeVisible();
    // Each rule that took money on its own now asks first, in the review, and says why in the API's
    // sentence for a $0 limit.
    const asks = reviewRows(screen);
    expect(asks.map((row) => row.title).sort()).toEqual(['Charge within a signed limit', 'Payment link']);
    for (const row of asks) {
      expect(row.after, row.title).toContain('Ask me first');
      expect(row.after, row.title).toContain('Your payment limit is $0.');
    }
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    for (const name of ['Payments', 'Stripe']) {
      await expect.element(screen.getByRole('region', { name }).getByText('Every payment asks you first.Updated', { exact: true })).toBeVisible();
    }
    await expectToolRow(screen.container, /^Payment link: .*, Ask me first$/);
    await expectToolRow(screen.container, /^Charge within a signed limit: .*, Ask me first$/);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it.each(['Rivera Plumbing', 'Acme Accounting'])('going_back_returns_to_the_place_on_rules_for_%s', async (business) => {
    renameBusiness(business);
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const payments = screen.getByRole('region', { name: 'Payments' });
    const limit = () => payments.getByText(LIMIT_500, { exact: true }).element();
    await expect.element(payments.getByText(LIMIT_500, { exact: true })).toBeVisible();
    // The shell's main area, once the Desk has opened, which scrolls on its own.
    const main = screen.getByRole('main').element();
    // Rules scrolled down to Payments' limit.
    limit().scrollIntoView({ block: 'center' });
    await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
    expect(inView(limit(), main)).toBe(true);

    // A new limit's review opens at its top; "Keep my rules" goes back to Rules where it was, the
    // limit still in view.
    await payments.getByRole('button', { name: 'Change' }).click();
    await payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' }).fill('5000');
    await payments.getByRole('button', { name: 'Review change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Change your payment limit' })).toBeVisible();
    expect(main.scrollTop).toBe(0);
    await screen.getByRole('button', { name: 'Keep my rules' }).click();
    await expect.element(payments.getByText(LIMIT_500, { exact: true })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
    expect(inView(limit(), main)).toBe(true);

    // From the end of Rules, a fresh visit to All rules still opens at its top, and Back from it
    // returns to the end of Rules.
    main.scrollTop = main.scrollHeight;
    const end = main.scrollTop;
    expect(end).toBeGreaterThan(0);
    await screen.getByRole('link', { name: 'See all rules' }).last().click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    expect(main.scrollTop).toBe(0);
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => main.scrollTop).toBe(end);
  });

  it('rules_page_matches_its_board', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const main = screen.getByRole('main').element() as HTMLElement;
    const menu = screen.getByRole('button', { name: 'Start from a preset' }).element() as HTMLElement;
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).element() as HTMLElement;
    const group = screen.getByRole('group', { name: 'Suggestions' });
    // The third is the seed's hold, once Needs you is read.
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const chips = group.getByRole('button').elements() as HTMLElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
    // Then each payment limit's "Change", in order, and nothing else in the connectors: their
    // headers and tools aren't links until their pages are built.
    const changes = [...main.querySelectorAll<HTMLElement>('.cd-connector-section .cd-money-limit button')];
    expect(changes).toHaveLength(2);
    await expectOwnerBoard(screen.container, { current: 'Rules' });
    const headerLink = main.querySelector<HTMLElement>('.cd-rules__header .cd-text-link')!;
    const reached = await expectTabOrderFromTop([headerLink, menu, composer, ...chips, ...changes]);
    expect(reached.filter((el) => el.closest('.cd-connector-section') !== null)).toEqual(changes);

    // As the board spaces them: the composer 20 px under the header, its suggestions 10 px under
    // it, the connectors' summary 20 px under them; the menu at the right of the title's line.
    const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
    const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);
    const box = composer.closest('.cd-composer__box') as HTMLElement;
    const header = main.querySelector('.cd-page-header') as HTMLElement;
    const row = main.querySelector('.cd-suggestion-chips') as HTMLElement;
    expect(top(box) - bottom(header)).toBe(20);
    expect(top(row) - bottom(box)).toBe(10);
    expect(top(main.querySelector('.cd-connector-list__summary') as HTMLElement) - bottom(row)).toBe(20);
    const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(menu.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    expect(top(menu) - top(title)).toBe(4);
    await expect.element(screen.getByText('Claude shows you the change and example situations before anything applies.', { exact: true })).toBeVisible();
  });

  it('rules_have_no_jargon', async () => {
    mockStore.world.addActiveRules(desk(), [EXTRA_RULES.agentCharges, EXTRA_RULES.danaBooking]);
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expectToolRow(screen.container, /^Payment link: 2 rules · 1 shared, Automatic up to \$300; over \$300, ask me first$/);
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
    // Under 640 px the header actions share a line under the title.
    const menu = phone.screen.getByRole('button', { name: 'Start from a preset' }).element();
    const title = phone.screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(Math.round(menu.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(16);
    expect(phone.screen.getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.').element()).not.toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(phone.screen.container, { owner: true });

    // Ask Claude as a sheet over the page: the owner's words whole, the drafted change's buttons reachable.
    await phone.screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const sheet = phone.screen.getByRole('dialog', { name: 'Ask Claude' }).getByRole('log');
    await expectTurnOpensAtTheOwnersWords(sheet, 'Stop quoting on weekends', 'as a sheet');
    expectNoHorizontalScroll();
  });
});

describe("Ask Claude's question about a hold", () => {
  it('both_opening_reads_share_one_cap_and_cannot_move_sections_when_they_land', async () => {
    renameBusiness('Acme Accounting');
    const reads = holdNeedsYou();
    const finished = finishedReads();
    let rulesReadAt = 0;
    onTestFinished(observeRequests(({ key, ok }) => {
      if (key === 'rules' && ok) rulesReadAt = performance.now();
    }));
    let releaseSuggestions!: () => void;
    const until = new Promise<void>((resolve) => { releaseSuggestions = resolve; });
    onTestFinished(() => releaseSuggestions());
    mockStore.inject({ route: 'suggestions', status: 200, body: [DANA_REFUNDS], until, times: 10_000 });
    const connectorTops = watchTop(() => pagePart('.cd-connector-list'));
    let bodyDrawnAt = 0;
    const observer = new MutationObserver(() => {
      if (bodyDrawnAt === 0 && pagePart('.cd-connector-list') !== null) bodyDrawnAt = performance.now();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const { screen, router } = await renderRoute(`${DESK}/rules`, { viewport: 'desktop', pollScale: 100 });
    await expect.poll(() => rulesReadAt > 0 && requests('suggestions').length > 0 && reads.held() > 0).toBe(true);
    expect(pagePart('.cd-connector-list', screen.container)).toBeNull();
    // Two waits in a row would take at least 6 s; the ceiling leaves a busy runner room under that.
    await expect.element(screen.getByRole('region', { name: 'Stripe' }), { timeout: 5_000 }).toBeVisible();
    const elapsed = bodyDrawnAt - rulesReadAt;
    expect(elapsed, 'one three-second cap, measured from the Rules response').toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(5_000);
    expect(pagePart('.cd-suggestion-chips', screen.container)).toBeNull();
    expect(pagePart('.cd-rules__suggestions', screen.container)).toBeNull();
    expect(pagePart('.cd-always-on', screen.container)).not.toBeNull();
    await settled(screen.container);
    const before = connectorTops();
    expect(before).toHaveLength(1);

    reads.release();
    releaseSuggestions();
    await expect.poll(() => finished.has('needsYou') && finished.has('suggestions')).toBe(true);
    await settled(screen.container);
    expect(pagePart('.cd-suggestion-chips', screen.container)).toBeNull();
    expect(pagePart('.cd-rules__suggestions', screen.container)).toBeNull();
    expect(connectorTops(), 'neither late read moves the connectors').toEqual(before);

    await router.navigate(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Draft this rule' })).toBeVisible();
  });

  it('a_suggestions_failure_after_the_opening_cap_stays_silent_and_keeps_connectors_in_place', async () => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    mockStore.inject({ route: 'suggestions', status: 503, until, times: 10_000 });
    let failures = 0;
    onTestFinished(observeRequests(({ key, ok }) => { if (key === 'suggestions' && !ok) failures += 1; }));
    const tops = watchTop(() => pagePart('.cd-connector-list'));
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'desktop', pollScale: 100, retryScale: 0 });
    await expect.poll(() => requests('suggestions').length).toBeGreaterThan(0);
    await expect.element(screen.getByRole('list', { name: 'Connectors' }), { timeout: 5_000 }).toBeVisible();
    await settled(screen.container);
    const before = tops();
    expect(before).toHaveLength(1);
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
    release();
    await expect.poll(() => failures).toBe(2);
    await settled(screen.container);
    expect(screen.getByRole('alert').elements(), 'optional suggestions fail silently').toHaveLength(0);
    expect(tops(), 'a late optional failure never moves landed connectors').toEqual(before);
  });

  it.each(['desktop', 'phone'] as const)('suggested_rules_and_connectors_land_together_when_suggestions_are_held at %s', async (viewport) => {
    const finished = finishedReads();
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    mockStore.inject({ route: 'suggestions', status: 200, body: [DANA_REFUNDS], until });
    const connectorTops = watchTop(() => pagePart('.cd-connector-list'));
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, viewport });
    await expect.poll(() => finished.has('needsYou')).toBe(true);
    await expect.poll(() => finished.has('rules')).toBe(true);
    await settled(screen.container);
    const before = connectorTops();
    release();
    await expect.element(screen.getByRole('button', { name: 'Draft this rule' })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    await settled(screen.container);
    expect(before, 'connectors wait for suggested-rule cards above them').toEqual([]);
    expect(connectorTops(), 'the connector list lands at one top').toHaveLength(1);
  });

  it('a_phone_does_not_wait_for_the_hidden_chips_row', async () => {
    renameBusiness('Acme Accounting');
    const reads = holdNeedsYou();
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: { width: 390, height: 844 }, pollScale: 100 });
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules', exact: true })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByRole('region', { name: 'Stripe' }), { timeout: 2_000 }).toBeVisible();
    await expect.element(screen.getByText('Reading your rules', { exact: true })).not.toBeInTheDocument();
    expect(pagePart('.cd-suggestion-chips', screen.container)).toBeNull();
  });

  it('a_failed_suggestions_read_settles_opening_without_waiting_for_the_cap', async () => {
    mockStore.inject({ route: 'suggestions', status: 503, times: 10_000 });
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules', exact: true })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Stripe' }), { timeout: 2_000 }).toBeVisible();
    expect(requests('suggestions').length).toBeGreaterThanOrEqual(2);
    expect(pagePart('.cd-rules__suggestions', screen.container)).toBeNull();
  });

  it('a_kept_rules_read_error_shows_while_needs_you_is_still_reading', async () => {
    renameBusiness('Acme Accounting');
    const { screen, router } = await renderRoute(`${DESK}/rules/all`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    const reads = holdNeedsYou();
    mockStore.inject({ route: 'rules', status: 503, times: 10_000 });
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules', exact: true })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByText(OWNER_ERROR_COPY.unavailable, { exact: true }), { timeout: 2_000 }).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(pagePart('.cd-connector-list', screen.container)).toBeNull();
  });

  it('a_rules_read_error_shows_while_needs_you_is_still_reading', async () => {
    renameBusiness('Acme Accounting');
    const reads = holdNeedsYou();
    mockStore.inject({ route: 'rules', status: 503, times: 10_000 });
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules', exact: true })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByText(OWNER_ERROR_COPY.unavailable, { exact: true }), { timeout: 2_000 }).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(pagePart('.cd-connector-list', screen.container)).toBeNull();
  });

  it('another_business_keeps_the_hold_question_beside_a_failed_rules_read', async () => {
    renameBusiness('Acme Accounting');
    mockStore.inject({ route: 'rules', status: 503, times: 2 });
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('alert')).toBeVisible();
    await expect.element(screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(0);
  });

  it('another_business_draws_the_body_and_delayed_hold_question_together', async () => {
    renameBusiness('Acme Accounting');
    const reads = holdNeedsYou();
    mockStore.inject({ route: 'suggestions', status: 200, body: [DANA_REFUNDS] });
    let rulesRead = false;
    onTestFinished(observeRequests((outcome) => {
      if (outcome.key === 'rules' && outcome.ok) rulesRead = true;
    }));
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, strict: true, viewport: 'desktop' });
    await expect.poll(() => rulesRead && reads.held() > 0).toBe(true);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Draft this rule' }).elements()).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);

    // Observe every committed DOM state, so separate renders cannot pass merely by finishing fast.
    const mismatches: boolean[] = [];
    const observer = new MutationObserver(() => {
      const body = pagePart('.cd-connector-list', screen.container) !== null;
      const chip = pagePart('.cd-suggestion-chips', screen.container) !== null;
      if (body !== chip) mismatches.push(true);
    });
    observer.observe(screen.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    reads.release();
    await expect.poll(() => pagePart('.cd-suggestion-chips', screen.container)?.textContent).toContain('Why was this quote held?');
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(1);
    await expect.element(screen.getByRole('button', { name: 'Draft this rule' })).toBeVisible();
    expect(mismatches).toEqual([]);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).not.toBeInTheDocument();
    expectNoHorizontalScroll();
  });

  it('another_business_opens_the_body_without_chips_after_needs_you_fails', async () => {
    renameBusiness('Acme Accounting');
    const failures = failNeedsYou();
    const reads = holdNeedsYou();
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();
    reads.release();
    await expect.poll(() => failures.failed()).toBe(2);
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).not.toBeInTheDocument();
  });

  it('rivera_draws_the_body_and_fixed_chips_while_needs_you_is_still_reading', async () => {
    const reads = holdNeedsYou();
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    const group = screen.getByRole('group', { name: 'Suggestions' });
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
    reads.release();
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
  });

  it('another_business_opens_on_an_offline_pause_and_stays_open_on_reconnect', async () => {
    renameBusiness('Acme Accounting');
    const { screen, router } = await renderRoute(`${DESK}/rules/all`, { pollScale: 100 });
    await expect.element(screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    const reads = holdNeedsYou();
    onTestFinished(() => onlineManager.setOnline(true));
    onlineManager.setOnline(false);
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);

    onlineManager.setOnline(true);
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(0);
    reads.release();
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
  });

  it('another_business_caps_the_needs_you_wait_at_three_seconds_after_rules_settle', async () => {
    renameBusiness('Acme Accounting');
    const reads = holdNeedsYou();
    const finished = finishedReads();
    mockStore.inject({ route: 'suggestions', status: 200, body: [DANA_REFUNDS] });
    const sectionTops = watchTop(() => pagePart('.cd-rules__suggestions'));
    let releaseRules!: () => void;
    const rulesHeld = new Promise<void>((resolve) => { releaseRules = resolve; });
    onTestFinished(() => releaseRules());
    worker.use(http.get(ROUTES.rules.path.replace('{desk_id}', RIVERA.deskId), async () => {
      await rulesHeld;
      return undefined;
    }));
    const rulesRead = new Promise<void>((resolve) => {
      onTestFinished(observeRequests((outcome) => {
        if (outcome.key === 'rules' && outcome.ok) resolve();
      }));
    });
    const { screen, router } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);

    releaseRules();
    await rulesRead;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise(requestAnimationFrame);
    await vi.advanceTimersByTimeAsync(2_999);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(0);

    vi.useRealTimers();
    await settled(screen.container);
    const before = sectionTops();
    expect(before).toHaveLength(1);
    reads.release();
    await expect.poll(() => finished.has('needsYou')).toBe(true);
    await settled(screen.container);
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);
    expect(sectionTops(), 'late Needs you cannot move the first section').toEqual(before);

    await router.navigate(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
  });

  it('rivera_keeps_both_fixed_chips_without_a_hold', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[0], exact: true })).toBeVisible();
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[1], exact: true })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
  });

  it('another_business_without_a_hold_has_no_chips_row', async () => {
    mockStore.reset('rivera_quiet');
    renameBusiness('Acme Accounting');
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    await expect.poll(() => requests('needsYou').length).toBeGreaterThanOrEqual(2);
    await expect.element(screen.getByRole('group', { name: 'Suggestions' })).not.toBeInTheDocument();
    expect(pagePart('.cd-suggestion-chips', screen.container)).toBeNull();
  });

  it('another_business_has_only_the_hold_question', async () => {
    renameBusiness('Acme Accounting');
    const { screen } = await renderRoute(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual(['Why was this quote held?']);
  });

  it('hold_question_names_a_held_refund', async () => {
    // Dana's refund, held a minute ago, after the seed's quote: the newest hold is asked about.
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this refund held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this refund held?']);
  });

  it('hold_question_names_a_held_quote', async () => {
    // The seed's hold: a visitor's quote at 15% off.
    const { screen } = await renderRoute(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
  });

  it('hold_question_only_while_a_request_is_held', async () => {
    // A copy with no hold: once Needs you has been read and drawn (a second read starts only after
    // the first one's answer), only Rivera's fixed suggestions remain.
    const quiet = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const none = quiet.screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(none.getByRole('button', { name: FIXED_CHIPS[0] })).toBeVisible();
    await expect.poll(() => requests('needsYou').length).toBeGreaterThanOrEqual(2);
    expect(chipWords(none)).toEqual([...FIXED_CHIPS]);

    // The seed's quote, held and then answered elsewhere: its question goes with it, and the others stay.
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera' });
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held');
    if (!held) throw new Error('the seed holds a quote');
    mockStore.world.answer(held, 'deny_once');
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).not.toBeInTheDocument();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
  });

  it('hold_question_never_shows_a_hold_from_an_earlier_read', async () => {
    // The seed's quote, held and read, so the app keeps it. Polls are far apart (a minute), so the
    // only read after the count below is the one Rules sends as it opens: an earlier poll held open
    // would be reused by it and never counted again.
    const { screen, router } = await renderRoute(`${DESK}/rules`, { pollScale: 20 });
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();

    // Answered elsewhere while Needs you's reads are slow to come back: on Rules again, the kept
    // read still holds the quote, and no chip asks about it while the page's own read is on its way.
    const reads = holdNeedsYou();
    const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held');
    if (!held) throw new Error('the seed holds a quote');
    mockStore.world.answer(held, 'deny_once');
    await router.navigate(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();
    // Counted before Rules opens again: the page's own read may reach the server before or after
    // the page draws, and once it's out no other read is sent until it comes back.
    const before = reads.held();
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const again = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(again.getByRole('button', { name: FIXED_CHIPS[0] })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(before);
    expect(chipWords(again)).toEqual([...FIXED_CHIPS]);

    // Dana's refund is held meanwhile: once the reads come back, the chip asks about it.
    mockStore.world.addHeldRefund();
    reads.release();
    await expect.element(again.getByRole('button', { name: 'Why was this refund held?' })).toBeVisible();
    expect(chipWords(again)).toEqual([...FIXED_CHIPS, 'Why was this refund held?']);
  });

  it('hold_question_goes_while_needs_you_cannot_be_read', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { retryScale: 0.05 });
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();

    // A read of Needs you fails, its retry too: what was read before may be out of date, so no
    // chip asks about it, and the others stay.
    const reads = failNeedsYou();
    await expect.poll(() => reads.failed()).toBeGreaterThanOrEqual(2);
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).not.toBeInTheDocument();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);

    // Once a read works again, the quote, still held, is asked about again.
    reads.recover();
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
  });

  it('hold_question_goes_while_needs_you_waits_for_the_network', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();

    // Offline, the next poll waits for the network: what was read before may be out of date, so
    // no chip asks about it, and the others stay.
    onTestFinished(() => onlineManager.setOnline(true));
    onlineManager.setOnline(false);
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).not.toBeInTheDocument();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);

    // Online again, the read goes out and the quote, still held, is asked about again.
    onlineManager.setOnline(true);
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
  });

  it('hold_question_reads_needs_you_as_rules_opens', async () => {
    // From Today, which has just read Needs you, with polls far apart (a minute): Rules reads it
    // again as it opens, so the chip comes with that one read, not the first poll.
    const { screen, router } = await renderRoute(`${DESK}/today`, { pollScale: 20 });
    await expect.element(screen.getByRole('button', { name: 'Deny this time' })).toBeVisible();
    const before = requests('needsYou').length;
    await router.navigate(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(requests('needsYou')).toHaveLength(before + 1);
  });

  it('hold_question_reaches_ask_claude_as_typed', async () => {
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Why was this refund held?' }).click();

    // The owner's words, as the chip has them, are her question to Claude; Claude answers about
    // that refund, the request and the rule that held it, and drafts nothing.
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect
      .element(
        log.getByText(
          /^Dana Whitfield, verified with a code, asked for a refund of her \$180\.00 payment from Monday, October 12\. It was held by your rule: Refunds to a customer wait for your answer\./,
        ),
      )
      .toBeVisible();
    expect(requests('ruleChat').map((r) => r.body)).toEqual([{ text: 'Why was this refund held?' }]);
    expect(log.getByText('Why was this refund held?', { exact: true }).elements()).toHaveLength(1);
    expect(desk().drafts.size).toBe(0);
  });
});

describe("Rivera's fixed suggestions", () => {
  type Screen = Awaited<ReturnType<typeof renderRoute>>['screen'];

  /**
   * On Rules, presses Rivera's suggestion `words`, confirms the change Claude drafts from it in Ask
   * Claude beside the page, and waits for the receipt; returns the suggestions and the panel.
   */
  async function confirmSuggestion(screen: Screen, words: string) {
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await group.getByRole('button', { name: words, exact: true }).click();
    const panel = screen.getByRole('complementary', { name: 'Ask Claude' });
    const log = panel.getByRole('log');
    const confirm = log.getByRole('button', { name: 'Confirm change' });
    await expect.element(confirm).toBeEnabled();
    const version = desk().lastVersion;
    await confirm.click();
    await expect.element(log.getByText(`Confirmed. Version ${version} of your rules, checked against the always-on rules.`, { exact: true })).toBeVisible();
    expect(desk().policy.version).toBe(version);
    return { group, panel };
  }

  /** Closes Ask Claude: focus can't go back to the suggestion that opened it, so the composer above the suggestions takes it. */
  async function closeToTheComposer(screen: Screen, panel: Locator) {
    await userEvent.keyboard('{Escape}');
    await expect.element(panel).not.toBeInTheDocument();
    await expect.element(screen.getByRole('textbox', { name: 'Ask Claude to change a rule' })).toHaveFocus();
  }

  /**
   * Rules with "Stop quoting on weekends" confirmed in Ask Claude, its suggestion gone, and the page
   * scrolled down to Payments, the composer above out of view.
   */
  async function weekendsConfirmedAndScrolledDown() {
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const { group, panel } = await confirmSuggestion(screen, 'Stop quoting on weekends');
    await expect.poll(() => chipWords(group)).toEqual(['Quote water heater installs up to $600']);
    // The change has landed on its row before the page moves.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const main = screen.getByRole('main').element();
    screen.getByRole('region', { name: 'Payments' }).element().scrollIntoView({ block: 'start' });
    await expect.poll(() => main.scrollTop).toBeGreaterThan(0);
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
    expect(inView(composer.element(), main)).toBe(false);
    return { panel, main, composer };
  }

  /**
   * Holds every animation frame from here until `nextFrames()`, so a test can act before one runs.
   * Until then the test waits with `until`: `expect.poll` and `expect.element` would advance the
   * held frames as they poll.
   */
  function holdFrames(): { nextFrames: () => void } {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    onTestFinished(() => { vi.useRealTimers(); });
    return {
      nextFrames: () => {
        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();
      },
    };
  }

  /** Waits in real time, without running held frames, until `check` holds. */
  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + 5_000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Ask Claude open beside the page, not the one sliding out as it closes. */
  const openPanel = () => document.querySelector('.cd-app-shell__panel:not(.cd-app-shell__panel--leaving)');

  it('the_weekends_suggestion_goes_once_its_change_is_in_effect', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const { group, panel } = await confirmSuggestion(screen, 'Stop quoting on weekends');
    // Quotes no longer go out on their own at weekends, so it isn't offered again; the other stays.
    await expect.poll(() => chipWords(group)).toEqual(['Quote water heater installs up to $600']);
    // Focus stays in Ask Claude, where the receipt landed.
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();
    await closeToTheComposer(screen, panel);
  });

  it('the_water_heater_suggestion_goes_once_its_change_is_in_effect', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const { group, panel } = await confirmSuggestion(screen, 'Quote water heater installs up to $600');
    await expect.poll(() => chipWords(group)).toEqual(['Stop quoting on weekends']);
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' })).toHaveFocus();
    await closeToTheComposer(screen, panel);
  });

  it('a_weekend_quote_rule_added_since_brings_the_weekends_suggestion_back_with_a_change_to_draft', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const { group } = await confirmSuggestion(screen, 'Stop quoting on weekends');
    await expect.poll(() => chipWords(group)).toEqual(['Quote water heater installs up to $600']);
    // The water heater rule quotes on its own every day, weekends too, so stopping that is on offer again.
    await confirmSuggestion(screen, 'Quote water heater installs up to $600');
    await expect.poll(() => chipWords(group)).toEqual(['Stop quoting on weekends']);
    // It drafts a change to that rule, not "No rules change"; once confirmed, both changes are in effect.
    await confirmSuggestion(screen, 'Stop quoting on weekends');
    await expect.element(group).not.toBeInTheDocument();
    const quotes = desk().policy.cards.filter((card) => card.applies_to === 'native.quote' && card.mode === 'auto' && card.who === 'anyone');
    expect(quotes.map((card) => [card.max_amount_cents ?? null, card.hours?.days])).toEqual([
      [null, ['mon', 'tue', 'wed', 'thu', 'fri']],
      [60_000, ['mon', 'tue', 'wed', 'thu', 'fri']],
    ]);
  });

  it('both_show_on_first_load_while_the_rules_are_read_and_after', async () => {
    let releaseRules!: () => void;
    const rulesHeld = new Promise<void>((resolve) => { releaseRules = resolve; });
    onTestFinished(() => releaseRules());
    worker.use(http.get(ROUTES.rules.path.replace('{desk_id}', RIVERA.deskId), async () => {
      await rulesHeld;
      return undefined;
    }));
    const { screen } = await renderRoute(`${DESK}/rules`, { seed: 'rivera_quiet' });
    const group = screen.getByRole('group', { name: 'Suggestions' });
    // While the rules are read, both are offered, in order, as before.
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[1], exact: true })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);
    // Rivera's rules have neither change, so both stay once they are drawn.
    releaseRules();
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
  });

  it('the_composer_takes_focus_where_the_page_is', async () => {
    const { main, composer } = await weekendsConfirmedAndScrolledDown();
    const frames = holdFrames();
    await userEvent.keyboard('{Escape}');
    await until(() => openPanel() === null, 'Ask Claude to close');
    const place = main.scrollTop;
    frames.nextFrames();
    expect(document.activeElement, 'the composer above the suggestions').toBe(composer.element());
    expect(main.scrollTop, 'the page stays where the owner left it').toBe(place);
  });

  it('focus_the_owner_moved_before_the_fallback_stays_where_they_put_it', async () => {
    const { main } = await weekendsConfirmedAndScrolledDown();
    const frames = holdFrames();
    await userEvent.keyboard('{Escape}');
    await until(() => openPanel() === null, 'Ask Claude to close');
    // A sidebar link takes focus before the frame in which the composer would.
    const today = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Today' }).element() as HTMLElement;
    today.focus();
    const place = main.scrollTop;
    frames.nextFrames();
    expect(document.activeElement, 'the sidebar link keeps focus').toBe(today);
    expect(main.scrollTop).toBe(place);
  });

  it('ask_claude_opened_again_before_the_fallback_keeps_focus', async () => {
    const { main } = await weekendsConfirmedAndScrolledDown();
    const frames = holdFrames();
    await userEvent.keyboard('{Escape}');
    await until(() => openPanel() === null, 'Ask Claude to close');
    // The suggestion still on offer opens it again before the frame in which the composer would take focus.
    const chip = page.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Quote water heater installs up to $600', exact: true });
    (chip.element() as HTMLElement).click();
    await until(() => document.activeElement instanceof HTMLTextAreaElement && openPanel()?.contains(document.activeElement) === true, "focus in Ask Claude's own composer");
    const focused = document.activeElement;
    const place = main.scrollTop;
    frames.nextFrames();
    expect(document.activeElement, "Ask Claude's composer keeps focus").toBe(focused);
    expect(main.scrollTop).toBe(place);
  });

  /** Rivera's active rules with both suggestions' changes in effect: quotes on their own only on weekdays, and water heater installs up to $600. */
  function bothChangesInEffect(): void {
    const main = desk();
    const weekdays: RuleCard['hours'] = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '00:00:00', end: '00:00:00' };
    main.policy = { ...main.policy, cards: main.policy.cards.map((card) => (card.card_id === 'rv-quote' ? { ...card, hours: weekdays } : card)) };
    const waterHeaters = { ...rivera.ruleCards['rv-quote'], card_id: 'card-water-heater-quotes', max_amount_cents: 60_000, hours: weekdays, reason: 'Water heater installs quoted up to $600, on weekdays.' };
    mockStore.world.addActiveRules(main, [waterHeaters]);
  }

  /** Holds every read of the main Desk's rules until `release()`. */
  function holdRules(): { release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    worker.use(http.get(ROUTES.rules.path.replace('{desk_id}', RIVERA.deskId), async () => {
      await held;
      return undefined;
    }));
    return { release };
  }

  it('with_both_changes_in_effect_a_cold_load_waits_for_needs_you_and_draws_its_question_with_the_body', async () => {
    bothChangesInEffect();
    const reads = holdNeedsYou();
    const rules = holdRules();
    const finished = finishedReads();
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    // Suggestions are read first, while the rules and Needs you are still being read: both
    // suggestions show meanwhile, but they can't end the opening wait.
    await expect.poll(() => finished.has('suggestions') && reads.held() > 0).toBe(true);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[0], exact: true })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);

    rules.release();
    await expect.poll(() => finished.has('rules')).toBe(true);
    // The rules leave no suggestion of Rivera's own, so the page waits for Needs you, as another business's does.
    await expect.element(group).not.toBeInTheDocument();
    expect(pagePart('.cd-connector-list', screen.container)).toBeNull();
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();

    const drawnWithoutQuestion: boolean[] = [];
    const observer = new MutationObserver(() => {
      const body = pagePart('.cd-connector-list', screen.container) !== null;
      const question = pagePart('.cd-suggestion-chips', screen.container)?.textContent?.includes('Why was this quote held?') === true;
      if (body && !question) drawnWithoutQuestion.push(true);
    });
    observer.observe(screen.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    reads.release();
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    await expect.element(screen.getByRole('list', { name: 'Connectors' })).toBeVisible();
    expect(chipWords(screen.getByRole('group', { name: 'Suggestions' }))).toEqual(['Why was this quote held?']);
    expect(drawnWithoutQuestion, 'the body and its hold question land together').toEqual([]);
  });

  it('with_both_changes_in_effect_a_cold_load_caps_the_wait_and_a_later_hold_does_not_move_the_connectors', async () => {
    bothChangesInEffect();
    const reads = holdNeedsYou();
    const rules = holdRules();
    const finished = finishedReads();
    const connectorTops = watchTop(() => pagePart('.cd-connector-list'));
    const rulesRead = new Promise<void>((resolve) => {
      onTestFinished(observeRequests((outcome) => {
        if (outcome.key === 'rules' && outcome.ok) resolve();
      }));
    });
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    await expect.poll(() => finished.has('suggestions') && reads.held() > 0).toBe(true);
    expect(chipWords(screen.getByRole('group', { name: 'Suggestions' }))).toEqual([...FIXED_CHIPS]);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    rules.release();
    await rulesRead;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise(requestAnimationFrame);
    await vi.advanceTimersByTimeAsync(2_999);
    await new Promise(requestAnimationFrame);
    // Three seconds after the rules, less a millisecond: still waiting for Needs you.
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('list', { name: 'Connectors' }).elements()).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);

    vi.useRealTimers();
    await settled(screen.container);
    const before = connectorTops();
    expect(before).toHaveLength(1);
    reads.release();
    await expect.poll(() => finished.has('needsYou')).toBe(true);
    await settled(screen.container);
    // The hold that came after the cap waits for the next visit, so the connectors stay put.
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);
    expect(connectorTops(), 'a late hold cannot move the connectors').toEqual(before);
  });

  it('with_both_changes_in_effect_back_returns_to_the_place_once_drawn', async () => {
    bothChangesInEffect();
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const main = screen.getByRole('main').element();
    main.scrollTop = main.scrollHeight;
    const end = main.scrollTop;
    expect(end).toBeGreaterThan(0);
    await router.navigate(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'All rules' })).toBeVisible();

    // Back while Needs you is read again: the page waits for it, drawn short, then returns to its place.
    const reads = holdNeedsYou();
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    reads.release();
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    await expect.poll(() => main.scrollTop).toBe(end);
  });
});
