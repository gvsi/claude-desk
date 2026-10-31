/**
 * The Rules page in a real browser against the mock API: outcomes by connector, Ask Claude beside
 * the page, the presets and the payment limit, each change through its proved review, and the
 * house rules.
 */
import { onlineManager } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { RouteObject } from 'react-router';
import { describe, expect, it, onTestFinished } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';

import { RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import { ROUTES } from '../../api/routes.ts';
import type { Suggestion } from '../../api/views.ts';
import { routes } from '../../app/routes.tsx';
import { rivera } from '../../ds/fixtures/index.ts';
import { worker } from '../../mocks/browser.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { EXTRA_RULES, type DeskRecord } from '../../mocks/world.ts';
import { expectOwnerBoard, expectTabOrderFromTop } from '../../test/boards.ts';
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

/** The suggestions under Ask Claude that every Desk has, in order; a question about a hold may follow them. */
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
    const all = screen.getByRole('link', { name: 'See all rules' });
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
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    expect(requests('confirmRules').map((r) => r.body)).toEqual([{ version }]);
    expect(desk().policy.version).toBe(version);
    expect(screen.container.textContent).not.toMatch(/\bCustom\b/);
    // Back on Rules, quotes are still automatic.
    await screen.getByRole('link', { name: 'See your rules' }).click();
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
      const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
      const header = title.closest('.cd-page-header') as HTMLElement;
      // From 1024 px up the panel stays beside the page.
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
    // In the narrowest column beside the panel, 360 px at 1024 px, the menu goes under the title and
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
    await expect.element(screen.getByText('Your rules are updated.', { exact: true })).toBeVisible();
    await screen.getByRole('link', { name: 'See your rules' }).click();
    for (const name of ['Payments', 'Stripe']) {
      await expect.element(screen.getByRole('region', { name }).getByText('Every payment asks you first.', { exact: true })).toBeVisible();
    }
    await expectToolRow(screen.container, /^Payment link: .*, Ask me first$/);
    await expectToolRow(screen.container, /^Charge within a signed limit: .*, Ask me first$/);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it('going_back_returns_to_the_place_on_rules', async () => {
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
    await screen.getByRole('link', { name: 'See all rules' }).click();
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
    const reached = await expectTabOrderFromTop([menu, composer, ...chips, ...changes]);
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
    // Under 640 px the preset menu takes a line of its own under the title.
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
    // the first one's answer), only the suggestions every Desk has.
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
    // The seed's quote, held and read, so the app keeps it.
    const { screen, router } = await renderRoute(`${DESK}/rules`);
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
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    const again = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(again.getByRole('button', { name: FIXED_CHIPS[0] })).toBeVisible();
    const waiting = reads.held();
    await expect.poll(() => reads.held()).toBeGreaterThan(waiting);
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
