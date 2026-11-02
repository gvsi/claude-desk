/**
 * The Rules page in a real browser against the mock API: every rule on one page, "Across your Desk"
 * then tool by tool, Ask Claude beside the page, the presets and the payment limit, each change
 * through its proved review.
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
import { expectNoHorizontalScroll, expectScreenBasics, tokenColor } from '../../test/screen.ts';
import { watchTop } from '../../test/watch.ts';
import { REVIEWER_LINE, RULES_SUBTITLE, rulesVersionLine } from './copy.ts';

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
    title: row.querySelector('.cd-rule-sentence__meta')?.textContent?.split(' · ')[0] ?? '',
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
 * Once the change Claude drafted shows in the Ask Claude conversation `log`, its review's
 * "Confirm change" and "Keep my rules" are wholly in view, the one action that applies the change;
 * and the owner's `words` that asked for it are whole and in view too, never cut under the panel's
 * header, when the exchange fits. When it doesn't, the buttons win. `at` names the case.
 */
async function expectTurnOpensAtTheOwnersWords(log: Locator, words: string, at: string): Promise<void> {
  const confirm = log.getByRole('button', { name: 'Confirm change' });
  await expect.element(confirm, { message: at }).toBeEnabled();
  const port = log.element();
  for (const name of ['Confirm change', 'Keep my rules']) {
    await expect.poll(() => inView(log.getByRole('button', { name }).element(), port), { message: `${at}: ${name}` }).toBe(true);
  }
  const bubble = log.getByText(words, { exact: true }).element();
  const keep = log.getByRole('button', { name: 'Keep my rules' }).element();
  if (keep.getBoundingClientRect().bottom - bubble.getBoundingClientRect().top <= port.clientHeight) {
    expect(inView(bubble, port), at).toBe(true);
  }
}

/** A rule Mike's answers suggest: Dana's refunds up to $50 without asking. */
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

/** Turner's suggestions under Ask Claude, in order; a question about a hold may follow them. */
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

/** Turner's payment limit, in the money band atop Payments and Stripe. */
const LIMIT_500 = 'Claude asks you before any payment over $500, whatever the rules below say';

const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

/** The connector sections, in order, by their names. */
const SECTIONS = ['Quotes', 'Bookings', 'Leads and callbacks', 'Verification', 'Documents', 'Payments', 'Stripe'] as const;

/** The card of the Desk's own jobs, before the connectors. */
const JOBS = 'Your Desk’s jobs';

/** The rule sentences under `root`, in order. */
function sentencesIn(root: Element): string[] {
  return [...root.querySelectorAll('.cd-rule-sentence__sentence')].map((sentence) => sentence.textContent ?? '');
}

/** Each rule row under `root` as the owner reads it: its sentence, then " / " and the line under it when it has one. */
function ruleCells(root: Element): string[] {
  return [...root.querySelectorAll('.cd-house-rules__rule')].map((row) => {
    const sentence = row.querySelector('.cd-rule-sentence__sentence')?.textContent ?? '';
    const line = row.querySelector('.cd-house-rules__rule-line')?.textContent;
    return line === undefined ? sentence : `${sentence} / ${line}`;
  });
}

/** The rule cells of the tool named `name` on Rules, once its rules read as `words` says. */
async function expectRules(screen: Awaited<ReturnType<typeof renderRoute>>['screen'], name: string, words: (cells: string[]) => boolean): Promise<string[]> {
  const tool = () => screen.getByRole('region', { name }).elements()[0];
  await expect.poll(() => { const at = tool(); return at !== undefined && words(ruleCells(at)); }, { message: `${name}'s rules` }).toBe(true);
  return ruleCells(tool()!);
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

describe('rules page', () => {
  it.each(['desktop', 'phone'] as const)('rules_is_the_tools_view_under_ask_claude_at_%s', async (viewport) => {
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    await expect.element(tools.getByRole('region', { name: 'Stripe' })).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByText(RULES_SUBTITLE, { exact: true }).elements()).toHaveLength(1);
    await expect.element(screen.getByRole('textbox', { name: 'Ask Claude to change a rule' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Start from a preset' })).toBeVisible();
    // One page of rules: nothing links to another.
    expect(screen.getByRole('link', { name: 'See all rules' }).elements()).toEqual([]);
    expect(screen.container.querySelectorAll('a[href$="/rules/all"]')).toHaveLength(0);
    // Tool by tool: the Desk's own jobs first, then each connector, under the section's caption.
    await expect.element(tools.getByRole('heading', { level: 2, name: 'Tool by tool' })).toBeVisible();
    await expect.element(tools.getByText('Each connector’s tools, with your rules for each.', { exact: true })).toBeVisible();
    expect([...tools.element().querySelectorAll('.cd-card')].map((card) => card.getAttribute('aria-label'))).toEqual([JOBS, ...SECTIONS]);
    // Each tool lists the rules that cover it, with no effect tags beside its name.
    const link = tools.getByRole('region', { name: 'Payment link' });
    expect(sentencesIn(link.element())).toEqual(['Claude can send payment links up to $300']);
    expect(screen.container.querySelector('.cd-effect-tags')).toBeNull();
    const main = screen.getByRole('main').element();
    for (const tag of ['Money', 'Can’t be undone', "Can't be undone", 'Private data']) {
      expect([...main.querySelectorAll('.cd-pill')].map((pill) => pill.textContent), tag).not.toContain(tag);
    }
    // The payment limit isn't repeated under each tool that moves money.
    expect(main.textContent).not.toContain('Any payment over $500 asks you first');
    await expect.element(tools.getByText(rulesVersionLine(7), { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expectNoHorizontalScroll();
  });

  it('a_built_in_connector_wears_a_built_in_pill_as_a_mock_wears_its_own', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    await expect.element(tools.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const badge = (name: string) => tools.getByRole('region', { name }).element().querySelector('.cd-house-rules__connector-header .cd-pill')?.textContent;
    for (const name of SECTIONS.filter((section) => section !== 'Stripe')) expect(badge(name), name).toBe('Built in');
    expect(badge('Stripe')).toBe('Mock');
    expect(tools.element().querySelector('.cd-connector-name__built-in')).toBeNull();
  });

  it('anything_not_listed_keeps_the_whole_place_of_details_so_its_dot_lines_up', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const across = screen.getByRole('region', { name: 'Across your Desk' });
    await expect.element(across).toBeVisible();
    const row = across.element().querySelector<HTMLElement>('[data-fallback]')!;
    const actions = row.querySelector<HTMLElement>('.cd-house-rules__rule-actions')!;
    const slot = actions.querySelector<HTMLElement>('.cd-advanced-details__slot')!;
    const dot = actions.querySelector<HTMLElement>('.cd-status-dot')!;
    // Details' empty place keeps its whole box, as a row's Details does on the board, 2 px under the
    // row's top, so the row is as tall as the place and its dot sits at the place's middle.
    expect(getComputedStyle(slot).marginTop).toBe('0px');
    const style = getComputedStyle(row);
    const edges = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
    const inner = row.getBoundingClientRect().height - edges.reduce((sum, edge) => sum + Number.parseFloat(style[edge]), 0);
    const top = Number.parseFloat(getComputedStyle(actions).paddingTop);
    expect(top).toBeGreaterThan(0);
    expect(Math.round(inner)).toBe(Math.round(slot.getBoundingClientRect().height + top));
    const middle = (el: Element) => (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2;
    expect(Math.abs(middle(dot) - middle(slot))).toBeLessThan(1);
  });

  it('sets_every_apostrophe_it_writes_as_a_typographic_one', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' }).getByRole('region', { name: 'Stripe' })).toBeVisible();
    const straight: string[] = [];
    const walker = document.createTreeWalker(screen.getByRole('main').element(), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest('.cd-skeleton-screen__layer, [hidden]')) continue;
      if (node.textContent?.includes("'")) straight.push(node.textContent.trim());
    }
    expect(straight).toEqual([]);
    for (const words of ['Claude always says it’s an AI', 'Confirm it’s them', 'Lets a visiting agent pay from its owner’s signed limit.', 'Your customers’ charges and refunds. Test mode, no money moves.']) {
      expect(screen.getByText(words, { exact: true }).elements().length, words).toBeGreaterThan(0);
    }
  });

  it('a_rule_for_a_tool_this_version_cannot_name_shows_under_other_tools', async () => {
    // A stored rule whose target isn't on the Desk, nor in this version's catalog.
    mockStore.world.addActiveRules(desk(), [{ ...rivera.ruleCards['rv-quote'], card_id: 'future-rule', applies_to: 'native.teleport' }]);
    const { screen } = await renderRoute(`${DESK}/rules`);
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    const other = tools.getByRole('region', { name: 'Other tools' });
    await expect.element(other).toBeVisible();
    // The last card, after every connector.
    expect([...tools.element().querySelectorAll('.cd-card')].at(-1)).toBe(other.element());
    const row = other.element().querySelector<HTMLElement>('[data-rule-id="future-rule"]')!;
    expect(row.querySelector('.cd-rule-sentence__sentence')?.textContent).toBe("A rule for a tool this version can't name");
    expect(row.querySelector('.cd-status-dot--handled')).not.toBeNull();
    expect(row.querySelector('.cd-advanced-details__toggle:not(.cd-advanced-details__slot)')?.textContent).toBe('Details');
    expect(other.element().textContent).not.toContain('teleport');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('a_connected_tool_outside_the_catalog_shows_under_other_tools_with_its_rules', async () => {
    // A tool a connector lists that this version's catalog doesn't know, with a rule of its own.
    const like = desk().tools.find((tool) => tool.tool === 'payments.list_charges')!;
    desk().tools.push({ ...like, tool: 'mcp.secret_tool' as typeof like.tool, effects: ['read'], status: 'enabled', review_reason: null });
    mockStore.world.addActiveRules(desk(), [{ ...rivera.ruleCards['rv-quote'], card_id: 'secret-rule', applies_to: 'mcp.secret_tool' }]);
    const { screen } = await renderRoute(`${DESK}/rules`);
    const other = screen.getByRole('region', { name: 'Tool by tool' }).getByRole('region', { name: 'Other tools' });
    await expect.element(other).toBeVisible();
    const tool = other.getByRole('region', { name: 'A connected tool' });
    await expect.element(tool.getByRole('heading', { level: 3, name: 'A connected tool' })).toBeVisible();
    expect(ruleCells(tool.element())).toEqual(['Claude can use a connected tool / Anyone']);
    expect(other.element().textContent).not.toContain('mcp.secret_tool');
    // Its Details says where it comes from as its own row does: a connected tool, never "Built in".
    const toggle = tool.element().querySelector<HTMLElement>('.cd-house-rules__tool-header > .cd-advanced-details__toggle')!;
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const source = [...panel.querySelectorAll('.cd-advanced-details__field')].find((field) => field.querySelector('dt')?.textContent === 'Source');
    expect(source?.querySelector('dd')?.textContent).toBe('Connected tool');
  });

  it('turners_rules_have_no_other_tools_card', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' }).getByRole('region', { name: 'Stripe' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Other tools' }).elements()).toHaveLength(0);
  });

  it('all_rules_opens_rules_in_its_place', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules/all`);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' }).getByRole('region', { name: 'Stripe' })).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(router.state.location.pathname).toBe(`${DESK}/rules`);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(document.title).toBe('Rules · Claude Desk');
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

  it('rules_header_preset_menu_takes_the_phone_row_and_sits_beside_the_title_on_a_laptop', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const header = screen.container.querySelector('.cd-rules__header .cd-page-header')!;
    const actions = header.querySelector('.cd-page-header__actions')!;
    const preset = screen.getByRole('button', { name: 'Start from a preset' }).element();
    // The menu is the header's one action: no link beside it.
    expect(actions.querySelectorAll('a')).toHaveLength(0);
    expect(Math.round(preset.getBoundingClientRect().right)).toBe(Math.round(actions.getBoundingClientRect().right));
    expect(actions.scrollWidth).toBeLessThanOrEqual(actions.clientWidth);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    await page.viewport(1512, 982);
    const title = header.querySelector('h1')!;
    await expect.poll(() => preset.getBoundingClientRect().left > title.getBoundingClientRect().right).toBe(true);
    expect(Math.round(preset.getBoundingClientRect().right)).toBe(Math.round(actions.getBoundingClientRect().right));
    expectNoHorizontalScroll();
  });

  it('each_tool_lists_its_rules_with_who_they_are_for_and_their_qualifiers', async () => {
    // Refund's definition changed and waits for review.
    desk().tools = desk().tools.map((tool) =>
      tool.tool === 'payments.create_refund' ? { ...tool, status: 'needs_review', pending_sha256: 'b'.repeat(64), review_reason: 'changed' } : tool,
    );
    const { screen } = await renderRoute(`${DESK}/rules`);
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    await expect.element(tools.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // Each tool is a heading over its rules: each rule's sentence, then who it is for and its
    // qualifiers, never the tool's name again.
    expect(ruleCells(tools.getByRole('region', { name: 'Quote' }).element())).toEqual([
      'Claude can send quotes from your price list, at list price / Anyone',
    ]);
    expect(ruleCells(tools.getByRole('region', { name: 'Book a visit' }).element())).toEqual([
      'Claude can book visits on weekdays, 8:00 am to 6:00 pm / Anyone · Checked by the reviewer',
      'Claude can book visits on Saturdays, 9:00 am to 1:00 pm / Anyone · Checked by the reviewer',
    ]);
    // An automatic rule's limit is a qualifier, not a row of its own.
    expect(ruleCells(tools.getByRole('region', { name: 'Payment link' }).element())).toEqual([
      'Claude can send payment links up to $300 / Anyone · Checked by the reviewer · Over $300, it asks you first',
    ]);
    expect(ruleCells(tools.getByRole('region', { name: 'See charges' }).element())).toEqual([
      'Claude can show customers their own charges / The customer, once verified',
      'Claude never shows private data to anyone but its verified owner',
    ]);
    for (const name of ['Quote', 'Find open times', 'Book a visit', 'Payment link', 'Refund']) {
      const tool = tools.getByRole('region', { name });
      await expect.element(tool.getByRole('heading', { level: 3, name })).toBeVisible();
      expect(tool.element().querySelector('a'), name).toBeNull();
    }
    // A changed tool says so by its title, and its rules' dots don't say they run.
    const refund = tools.getByRole('region', { name: 'Refund' });
    await expect.element(refund.getByText('Needs your review', { exact: true })).toBeVisible();
    expect([...refund.element().querySelectorAll('.cd-house-rules__rule .cd-status-dot')].map((dot) => dot.className)).toEqual(['cd-status-dot cd-status-dot--held']);
    // No "Integrations", "Custom" or mode switch anywhere.
    const text = screen.container.querySelector('main')?.textContent ?? '';
    for (const word of [/Integrations/, /\bCustom\b/]) expect(text).not.toMatch(word);
    expect(screen.container.querySelector('[role="radiogroup"], .cd-segmented-control')).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
    expect(requests('rules').length).toBeGreaterThan(0);
  });

  it('tools_have_no_links_until_their_pages_are_built', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    await expect.element(tools.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // Turner's urgent job first, then the connectors' eleven tools, each named without a link.
    expect(tools.element().querySelectorAll('.cd-house-rules__tool-header')).toHaveLength(12);
    expect(tools.getByRole('link').elements()).toEqual([]);
    expect(screen.container.querySelectorAll('a[href*="/connectors"]')).toHaveLength(0);
    // Nor has the sidebar a Connectors row.
    expect(screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connectors' }).elements()).toEqual([]);
    // In the tools the owner's own controls are the payment limit's two "Change"; the rest is Details.
    const buttons = [...tools.element().querySelectorAll<HTMLElement>('button')];
    expect(buttons.filter((button) => !button.classList.contains('cd-advanced-details__toggle')).map((button) => button.textContent)).toEqual(['Change', 'Change']);
    await expect.element(tools.getByRole('region', { name: 'Payment link' }).getByText('Payment link', { exact: true })).toBeVisible();
  });

  it('tools_link_to_their_pages_once_built', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`, { connectorPages: true });
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    await expect.element(tools.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // Each connector's tool links its name to its page; the Desk's own job has none to open.
    const link = tools.getByRole('region', { name: 'Payment link' }).element().querySelector('a.cd-house-rules__tool-name');
    expect(link?.getAttribute('href')).toBe(`${DESK}/connectors/payments/native.payment_link`);
    expect(tools.getByRole('region', { name: 'Refund' }).element().querySelector('a.cd-house-rules__tool-name')?.getAttribute('href')).toBe(`${DESK}/connectors/stripe/payments.create_refund`);
    expect(tools.element().querySelectorAll('a.cd-house-rules__tool-name')).toHaveLength(11);
    // The sidebar's Connectors row comes with them.
    await expect.element(screen.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Connectors' })).toHaveAttribute('href', `${DESK}/connectors`);

    // On a Connectors page, the sidebar marks its row as the current one, and only that row.
    const connectors = await renderRoute(`${DESK}/connectors`, { connectorPages: true, routes: withConnectorsPage() });
    const nav = connectors.screen.getByRole('navigation', { name: 'Main' });
    await expect.element(nav.getByRole('link', { name: 'Connectors' })).toHaveAttribute('aria-current', 'page');
    expect([...nav.element().querySelectorAll('[aria-current="page"]')].map((row) => row.textContent)).toEqual(['Connectors']);
  });

  it.each(['Ask me first', 'Recommended rules'])('preset_review_%s_keeps_emergency_callbacks_automatic', async (label) => {
    await page.viewport(1440, 900);
    const urgent = desk().policy.cards.find((card) => card.card_id === 'rv-urgent');
    const { screen } = await renderRoute(`${DESK}/rules`);
    const jobs = screen.getByRole('region', { name: JOBS });
    const callback = () => jobs.element().querySelector('[data-rule-id="rv-urgent"]');
    await expect.element(jobs.getByText('Claude can take urgent callbacks, which alert you at once', { exact: true })).toBeVisible();
    expect(callback()?.querySelector('.cd-status-dot--handled')).not.toBeNull();
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: label }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: label })).toBeVisible();
    const rows = reviewRows(screen);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.title)).not.toContain('Emergency callback');
    for (const row of rows) {
      const words = (value: string | null) => value?.replace(/^(Before|After)/, '').replace(/\bChanged\b/g, '').replace(/\s+/g, ' ').trim();
      expect(words(row.after), row.title).not.toBe(words(row.before));
    }
    await expect.element(screen.getByText('Checked against the always-on rules and your other rules before you confirm.', { exact: true })).toBeVisible();
    expect(desk().drafts.get(desk().lastVersion)?.draft.cards).toContainEqual(urgent);
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    expect(desk().policy.cards).toContainEqual(urgent);
    await expect.element(jobs.getByText('Claude can take urgent callbacks, which alert you at once', { exact: true })).toBeVisible();
    expect(callback()?.querySelector('.cd-status-dot--handled')).not.toBeNull();
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
    // Quotes stay automatic: the preset's own quote rule is the same as Turner's, so no row names
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
    await expectRules(screen, 'Quote', (cells) => cells.includes('Claude can send quotes from your price list, at list price / Anyone'));
  });

  it('preset_review_lists_every_removed_rule', async () => {
    // Dana Whitfield's own booking rule, from an earlier "Allow only for Dana" answer.
    mockStore.world.addActiveRules(desk(), [EXTRA_RULES.danaBooking]);
    const owned = desk().policy.cards.filter((card) => !card.card_id.startsWith('preset-') && card.applies_to !== 'desk.emergency-callback');
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    await screen.getByRole('button', { name: 'Start from a preset' }).click();
    await screen.getByRole('menuitem', { name: 'Ask me first' }).click();

    await expect.element(screen.getByRole('heading', { level: 1, name: 'Ask me first' })).toBeVisible();
    expect(requests('draftPreset').map((r) => r.body)).toEqual([{ preset: 'ask_first' }]);
    // A removed row per rule the preset removes, personal ones included, with Before alone.
    const rows = reviewRows(screen);
    expect(rows).toHaveLength(owned.length);
    for (const row of rows) expect(row.after, row.title).toBeNull();
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
    expect(await expectRules(screen, 'Book a visit', (cells) => cells.length === 3)).toContain('Claude can book visits / Dana Whitfield');
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
    await expect.element(changes.getByRole('group', { name: 'After' }).getByText('Quote', { exact: true })).toBeVisible();
    await expect.element(changes.getByRole('group', { name: 'After' }).getByText(/weekdays, all day/)).toBeVisible();
    await expect.element(log.getByText('Checked against the always-on rules and your other rules before you confirm.', { exact: true })).toBeVisible();
    // The review's buttons in view, and the owner's words too when both fit.
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
    // From a suggestion beside the page: the review's buttons after Claude's answer show whole, and
    // the owner's words that open the turn too when both fit.
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

    // Another question from the panel's own composer goes on in the same conversation, sent once
    // the answer before it has come in.
    const box = screen.getByRole('textbox', { name: 'Ask Claude' });
    const send = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('button', { name: 'Send', exact: true });
    await box.fill('What can you do?');
    await expect.element(send).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(/^I can explain what a rule does/)).toBeVisible();
    expect(log.getByText('Why was this quote held?', { exact: true }).elements()).toHaveLength(1);
    expect(desk().drafts.size).toBe(0);

    // Words past Plan 02's 2,000 characters aren't sent: the line says so, and the words stay in
    // the conversation to shorten.
    const long = `Stop quoting on weekends ${'and holidays '.repeat(160)}`.trim();
    expect(long.length).toBeGreaterThan(2000);
    await box.fill(long);
    await expect.element(send).toBeEnabled();
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
    // The answer streams in as Markdown; its final form is checked once it has replaced the growing one.
    await expect.element(log.getByText(items[1] ?? '', { exact: true })).toBeVisible();
    await expect.poll(() => log.element().querySelector('.cd-rule-chat__growing')).toBeNull();
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
    expect(rows[0]?.after).toContain('Allow');
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
    // rule the change landed on, under Refund: to its first control, its Details.
    // Rules shows its reading state until its read has the new version, so the tool may not be drawn yet.
    const dana = () =>
      [...(screen.getByRole('region', { name: 'Refund' }).elements()[0]?.querySelectorAll<HTMLElement>('.cd-house-rules__rule') ?? [])].find(
        (row) => row.querySelector('.cd-house-rules__rule-line')?.textContent?.startsWith('Dana Whitfield'),
      );
    await expect.poll(() => dana()?.querySelector('.cd-pill')?.textContent).toBe('Updated');
    await expect.poll(() => document.activeElement === dana()?.querySelector('.cd-advanced-details__toggle')).toBe(true);
    // Tab goes on from there.
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('unset_limit_copy_names_the_next_step', async () => {
    desk().policy = { ...desk().policy, auto_money_cap_cents: 0 };
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' }).getByText('Claude asks you before any payment', { exact: true })).toBeVisible();
    // Once in each money band.
    expect(screen.getByText('Claude asks you before any payment', { exact: true }).elements()).toHaveLength(2);
    await screen.getByRole('button', { name: 'Draft this rule' }).click();
    await expect.element(screen.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true })).toBeVisible();
    expect(requests('draftSuggestion')).toHaveLength(1);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it('rules_show_limits_and_what_asks_by_default', async () => {
    // Payment links up to $400, refunds never, and no rule of Mike's on quotes.
    desk().policy = {
      ...desk().policy,
      cards: desk()
        .policy.cards.filter((card) => card.applies_to !== 'native.quote')
        .map((card) =>
          card.card_id === 'rv-link' ? { ...card, max_amount_cents: 40_000 } : card.card_id === 'rv-refund' ? { ...card, mode: 'never' as const, reason: 'Refunds never go through here.' } : card,
        ),
    };
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    expect(ruleCells(screen.getByRole('region', { name: 'Payment link' }).element())).toEqual([
      'Claude can send payment links up to $400 / Anyone · Checked by the reviewer · Over $400, it asks you first',
    ]);
    await expect.element(screen.getByRole('region', { name: 'Refund' }).getByText('Claude never sends refunds', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Find open times' }).getByText('Claude can show the times you have open', { exact: true })).toBeVisible();
    // A tool no rule covers asks.
    const quote = screen.getByRole('region', { name: 'Quote' });
    await expect.element(quote.getByText('Claude asks you before any quote', { exact: true })).toBeVisible();
    expect(quote.element().querySelector('.cd-status-dot--held')).not.toBeNull();
    // Read-only, in the outcomes' own words.
    const main = screen.container.querySelector('main');
    expect(main?.querySelectorAll('.cd-outcome-menu__button')).toHaveLength(0);
    expect(main?.textContent).not.toMatch(/Do it|Ask me(?! first)/);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('rules_has_two_sections_and_no_reviewer_note', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const across = screen.getByRole('region', { name: 'Across your Desk' });
    await expect.element(across).toBeVisible();
    await expect.element(across.getByRole('heading', { level: 2, name: 'Across your Desk' })).toBeVisible();
    await expect.element(across.getByText('These cover everything Claude does, whatever the tool.', { exact: true })).toBeVisible();
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    expect(across.element().compareDocumentPosition(tools.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.container.textContent).not.toContain(REVIEWER_LINE);
    expect(screen.container.textContent).not.toContain('Each connector brings tools');
  });

  it('across_your_desk_holds_the_ai_and_log_rules_and_what_asks_by_default', async () => {
    const { screen } = await renderRoute(`${DESK}/rules`);
    const across = screen.getByRole('region', { name: 'Across your Desk' });
    await expect.element(across).toBeVisible();
    expect(ruleCells(across.element())).toEqual([
      'Claude always says it’s an AI / In every reply',
      'Claude logs every request, allowed or not, and shows it to you in Safety',
      'Anything not listed here, Claude asks you first',
    ]);
    // The two always-on rules carry a lock and "Always on", with no dot and no Details; the default asks.
    const rows = [...across.element().querySelectorAll('.cd-house-rules__rule')];
    expect(rows.map((row) => row.querySelector('.cd-house-rules__always-on')?.textContent ?? null)).toEqual(['Always on', 'Always on', null]);
    expect(rows.map((row) => row.querySelector('.cd-status-dot')?.className ?? null)).toEqual([null, null, 'cd-status-dot cd-status-dot--held']);
    expect(across.element().querySelectorAll('button')).toHaveLength(0);
    // The always-on rules for one tool sit in its list.
    const tools = screen.getByRole('region', { name: 'Tool by tool' });
    for (const [name, sentence] of [
      ['Confirm it’s them', 'Claude never sends a code anywhere but the contact on record'],
      ['Share a document', 'Claude never shows private data to anyone but its verified owner'],
      ['See charges', 'Claude never shows private data to anyone but its verified owner'],
    ] as const) {
      const tool = tools.getByRole('region', { name });
      const row = [...tool.element().querySelectorAll('.cd-house-rules__rule')].at(-1)!;
      expect(row.querySelector('.cd-rule-sentence__sentence')?.textContent, name).toBe(sentence);
      expect(row.querySelector('.cd-house-rules__always-on')?.textContent, name).toBe('Always on');
      expect(row.querySelectorAll('.cd-status-dot, button'), name).toHaveLength(0);
    }
    // "Always on" ends flush right, where Details ends on the rows that have it.
    const right = (el: Element | null) => Math.round(el!.getBoundingClientRect().right);
    const details = tools.getByRole('region', { name: 'See charges' }).element().querySelector('.cd-house-rules__rule .cd-advanced-details__toggle');
    const always = tools.getByRole('region', { name: 'See charges' }).element().querySelector('.cd-house-rules__always-on');
    expect(right(always)).toBe(right(details));
    expect(right(rows[0]!.querySelector('.cd-house-rules__always-on'))).toBe(right(rows[2]!.querySelector('.cd-advanced-details__slot')));
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
    await expect.element(payments.getByRole('textbox', { name: 'Most a payment can be without asking you, in dollars' })).not.toBeInTheDocument();
    await expect.element(payments.getByRole('button', { name: 'Change' })).toHaveFocus();
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
    expect(lowered[0]?.before).toContain('Allow');
    expect(lowered[0]?.before).toContain('Claude can send payment links up to $300');
    expect(lowered[0]?.after).toContain('Allow');
    expect(lowered[0]?.after).toContain('Claude can send payment links up to $100');
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
    const limit100 = 'Claude asks you before any payment over $100, whatever the rules below say';
    for (const name of ['Payments', 'Stripe']) {
      const band = screen.getByRole('region', { name });
      await expect.element(band.getByText(limit100, { exact: true })).toBeVisible();
      await expect.poll(() => band.element().querySelector('[data-money-limit] .cd-pill')?.textContent, { message: name }).toBe('Updated');
    }
    // No rule beside it still takes more on its own.
    await expectRules(screen, 'Payment link', (cells) => cells[0]?.startsWith('Claude can send payment links up to $100 / ') === true);
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
    const askSentences: Record<string, string> = {
      'Payment link': 'Claude asks you before sending payment links',
      'Charge within a signed limit': 'Claude asks you before any agent payment within its signed limit',
    };
    for (const row of asks) {
      expect(row.after, row.title).toContain('Ask me first');
      expect(row.after, row.title).toContain(askSentences[row.title]);
    }
    await screen.getByRole('button', { name: 'Confirm change' }).click();
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    for (const name of ['Payments', 'Stripe']) {
      const band = screen.getByRole('region', { name });
      await expect.element(band.getByText('Claude asks you before any payment', { exact: true })).toBeVisible();
      await expect.poll(() => band.element().querySelector('[data-money-limit] .cd-pill')?.textContent, { message: name }).toBe('Updated');
    }
    await expectRules(screen, 'Payment link', (cells) => cells[0]?.startsWith('Claude asks you before sending payment links') === true);
    await expectRules(screen, 'Charge within a signed limit', (cells) => cells[0]?.startsWith('Claude asks you before any agent payment within its signed limit') === true);
    expect(screen.container.querySelector('main')?.textContent).not.toContain('$0');
  });

  it.each(['Turner Plumbing', 'Acme Accounting'])('going_back_returns_to_the_place_on_rules_for_%s', async (business) => {
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

    // From the end of Rules, a fresh visit to another page still opens at its top, and Back from it
    // returns to the end of Rules. The place is kept as the scroll is heard: wait for it before leaving.
    const heard = new Promise((resolve) => main.addEventListener('scroll', resolve, { once: true }));
    main.scrollTop = main.scrollHeight;
    await heard;
    const end = main.scrollTop;
    expect(end).toBeGreaterThan(0);
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    expect(main.scrollTop).toBe(0);
    await router.navigate(-1);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
    await expect.poll(() => main.scrollTop).toBe(end);
  });

  it.each(['before', 'after'] as const)('going_back_keeps_the_place_when_the_hold_question_comes_in_above_it_%s_the_shapes_show', async (when) => {
    // Acme's Rules waits for Needs you, whose held quote puts a question under Ask Claude, above the
    // connectors. A short window, with Payments' limit in its middle: a place halfway down Rules,
    // which its shapes can hold while it reads.
    renameBusiness('Acme Accounting');
    const { screen, router } = await renderRoute(`${DESK}/rules`, { viewport: { width: 1440, height: 600 } });
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const main = screen.getByRole('main').element();
    const limit = () => screen.getByRole('region', { name: 'Payments' }).getByText(LIMIT_500, { exact: true }).element();
    // The place is kept as the scroll is heard, which comes after the scroll itself: wait for it, as
    // the owner's own scrolling would be heard before they leave.
    const heard = new Promise((resolve) => main.addEventListener('scroll', resolve, { once: true }));
    limit().scrollIntoView({ block: 'center' });
    await heard;
    const place = main.scrollTop;
    expect(place).toBeGreaterThan(0);
    const shows = limit().getBoundingClientRect().top;
    expect(place).toBeLessThan(main.scrollHeight - main.clientHeight - 300);

    // Back from another page: the question comes in with the page, above the place, at once or once
    // Needs you, held, comes after the shapes have shown. Rules reads Needs you as it opens, and a
    // read already out when it opens is the one it waits for; tests poll often, so one may be. So
    // every read is held from while Rules is still open: once one is held, none sent before it is
    // still out (a query has one read out at a time), and the read Rules waits for on Back is held.
    const reads = when === 'after' ? holdNeedsYou() : null;
    if (reads !== null) await expect.poll(reads.held, { timeout: 2_000 }).toBeGreaterThan(0);
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    await router.navigate(-1);
    if (reads !== null) {
      const layer = () => document.querySelector('.cd-rules__region > .cd-skeleton-screen__body > .cd-skeleton-screen__layer');
      await vi.waitFor(() => expect(layer()?.getAttribute('data-state'), "Rules' shapes").toBe('shown'), { timeout: 2_000 });
      reads.release();
    }
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    await settled(screen.container);
    expect(main.scrollTop).toBe(place);
    expect(limit().getBoundingClientRect().top, "Payments' limit where the owner left it").toBe(shows);
  });

  it.each(['at once', 'after its shapes show'] as const)('rules_page_matches_its_board_drawn_%s', async (when) => {
    // Rules waits for its suggestions: held until its shapes have shown, they fade as the page draws,
    // here for as long as a busy browser can keep them (the fade's one-second fallback).
    let releaseSuggestions = () => {};
    if (when === 'after its shapes show') {
      const until = new Promise<void>((resolve) => {
        releaseSuggestions = resolve;
      });
      onTestFinished(() => releaseSuggestions());
      mockStore.inject({ route: 'suggestions', status: 200, body: desk().suggestions, until });
      const slowFade = document.createElement('style');
      slowFade.textContent = ".cd-skeleton-screen__layer[data-state='leaving'] { animation-duration: 10s !important; }";
      document.head.append(slowFade);
      onTestFinished(() => slowFade.remove());
    }
    const { screen } = await renderRoute(`${DESK}/rules`);
    if (when === 'after its shapes show') {
      const layer = () => document.querySelector('.cd-rules__region > .cd-skeleton-screen__body > .cd-skeleton-screen__layer');
      await vi.waitFor(() => expect(layer()?.getAttribute('data-state'), "Rules' shapes").toBe('shown'), { timeout: 2_000 });
      releaseSuggestions();
    }
    await expect.element(screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    const main = screen.getByRole('main').element() as HTMLElement;
    const menu = screen.getByRole('button', { name: 'Start from a preset' }).element() as HTMLElement;
    const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).element() as HTMLElement;
    const group = screen.getByRole('group', { name: 'Suggestions' });
    // The third is the seed's hold, once Needs you is read.
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const chips = group.getByRole('button').elements() as HTMLElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
    // Then, in the tools, each money band's "Change", in order, among the Details: the tools
    // aren't links until their pages are built.
    const changes = [...main.querySelectorAll<HTMLElement>('[data-money-limit] .cd-house-rules__rule-actions > .cd-button')];
    expect(changes).toHaveLength(2);
    await expectOwnerBoard(screen.container, { current: 'Rules' });
    const reached = await expectTabOrderFromTop([menu, composer, ...chips, ...changes]);
    expect(reached.filter((el) => el.closest('.cd-rules__region') !== null && !el.classList.contains('cd-advanced-details__toggle'))).toEqual(changes);

    // As the board spaces them: the composer 20 px under the header, its suggestions 10 px under
    // it; the menu at the right of the title's line.
    const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
    const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);
    const box = composer.closest('.cd-composer__box') as HTMLElement;
    const header = main.querySelector('.cd-page-header') as HTMLElement;
    const row = main.querySelector('.cd-suggestion-chips') as HTMLElement;
    expect(top(box) - bottom(header)).toBe(20);
    expect(top(row) - bottom(box)).toBe(10);
    // Then "Across your Desk" 20 px under them, its card 12 px under its header, and "Tool by tool"
    // 32 px under that card, its first card, the Desk's own jobs, 12 px under its header.
    const [across, tools] = [...main.querySelectorAll<HTMLElement>('.cd-rules__section')].filter((section) => section.closest('.cd-skeleton-screen__layer') === null);
    expect(top(across!) - bottom(row)).toBe(20);
    const acrossCard = across!.querySelector('.cd-card')!;
    expect(top(acrossCard) - bottom(across!.querySelector('.cd-section-header')!)).toBe(12);
    expect(top(tools!) - bottom(acrossCard)).toBe(32);
    expect(top(tools!.querySelector('.cd-card')!) - bottom(tools!.querySelector('.cd-section-header')!)).toBe(12);
    expect(tools!.querySelector('.cd-card')?.getAttribute('aria-label')).toBe(JOBS);
    const title = screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(menu.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right);
    expect(top(menu) - top(title)).toBe(4);
    await expect.element(screen.getByText('Claude shows you the change before anything applies.', { exact: true })).toBeVisible();
  });

  it('rules_have_no_jargon', async () => {
    mockStore.world.addActiveRules(desk(), [EXTRA_RULES.agentCharges, EXTRA_RULES.danaBooking]);
    desk().suggestions.push(DANA_REFUNDS);
    const { screen } = await renderRoute(`${DESK}/rules`);
    await expectRules(screen, 'Payment link', (cells) => cells.length === 2);
    await expectScreenBasics(screen.container, { owner: true });

    // With the panel open and a change drafted in it.
    await screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Stop quoting on weekends' }).click();
    const log = screen.getByRole('complementary', { name: 'Ask Claude' }).getByRole('log');
    await expect.element(log.getByRole('button', { name: 'Confirm change' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // The Rules page at a phone's width, unbroken.
    const phone = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
    await expect.element(phone.screen.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // Under 640 px the header actions share a line under the title.
    const menu = phone.screen.getByRole('button', { name: 'Start from a preset' }).element();
    const title = phone.screen.getByRole('heading', { level: 1, name: 'Rules' }).element();
    expect(Math.round(menu.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(16);
    expect(phone.screen.getByText(RULES_SUBTITLE).element()).not.toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(phone.screen.container, { owner: true });

    // Ask Claude as a sheet over the page: the drafted change's buttons in view.
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
    const connectorTops = watchTop(() => pagePart('.cd-rules__tool-cards'));
    let bodyDrawnAt = 0;
    const observer = new MutationObserver(() => {
      if (bodyDrawnAt === 0 && pagePart('.cd-rules__tool-cards') !== null) bodyDrawnAt = performance.now();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const { screen, router } = await renderRoute(`${DESK}/rules`, { viewport: 'desktop', pollScale: 100 });
    await expect.poll(() => rulesReadAt > 0 && requests('suggestions').length > 0 && reads.held() > 0).toBe(true);
    expect(pagePart('.cd-rules__tool-cards', screen.container)).toBeNull();
    // Two waits in a row would take at least 6 s; the ceiling leaves a busy runner room under that.
    await expect.element(screen.getByRole('region', { name: 'Stripe' }), { timeout: 5_000 }).toBeVisible();
    const elapsed = bodyDrawnAt - rulesReadAt;
    expect(elapsed, 'one three-second cap, measured from the Rules response').toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(5_000);
    expect(pagePart('.cd-suggestion-chips', screen.container)).toBeNull();
    expect(pagePart('.cd-rules__suggestions', screen.container)).toBeNull();
    expect(pagePart('.cd-rules__version', screen.container)).not.toBeNull();
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

    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
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
    const tops = watchTop(() => pagePart('.cd-rules__tool-cards'));
    const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'desktop', pollScale: 100, retryScale: 0 });
    await expect.poll(() => requests('suggestions').length).toBeGreaterThan(0);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' }), { timeout: 5_000 }).toBeVisible();
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
    const connectorTops = watchTop(() => pagePart('.cd-rules__tool-cards'));
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
    // Rules' read is kept from a visit before this one.
    const { screen, router } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    const reads = holdNeedsYou();
    mockStore.inject({ route: 'rules', status: 503, times: 10_000 });
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules', exact: true })).toBeVisible();
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByText(OWNER_ERROR_COPY.unavailable, { exact: true }), { timeout: 2_000 }).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(pagePart('.cd-rules__tool-cards', screen.container)).toBeNull();
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
    expect(pagePart('.cd-rules__tool-cards', screen.container)).toBeNull();
  });

  it('another_business_keeps_the_hold_question_beside_a_failed_rules_read', async () => {
    renameBusiness('Acme Accounting');
    mockStore.inject({ route: 'rules', status: 503, times: 2 });
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100, retryScale: 0 });
    await expect.element(screen.getByRole('alert')).toBeVisible();
    await expect.element(screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);
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
    // Each step may take a moment longer on a loaded runner; what they show, and their order, stay the same.
    // The Rules read has landed while Needs you's read is still held.
    await vi.waitFor(() => expect(rulesRead && reads.held() > 0).toBe(true), { timeout: 4_000 });
    // Rules says it's still reading, and draws neither the body nor the hold question yet.
    await expect.element(screen.getByText('Reading your rules', { exact: true }), { timeout: 4_000 }).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Draft this rule' }).elements()).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);

    // Observe every committed DOM state, so separate renders cannot pass merely by finishing fast.
    const mismatches: boolean[] = [];
    const observer = new MutationObserver(() => {
      const body = pagePart('.cd-rules__tool-cards', screen.container) !== null;
      const chip = pagePart('.cd-suggestion-chips', screen.container) !== null;
      if (body !== chip) mismatches.push(true);
    });
    observer.observe(screen.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    reads.release();
    // Once Needs you lands, the hold question joins the chips.
    await vi.waitFor(() => expect(pagePart('.cd-suggestion-chips', screen.container)?.textContent).toContain('Why was this quote held?'), { timeout: 4_000 });
    // The question shows, drawn in the same render as the body.
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' }), { timeout: 4_000 }).toBeVisible();
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(1);
    // The suggested rule's draft button shows with them.
    await expect.element(screen.getByRole('button', { name: 'Draft this rule' }), { timeout: 4_000 }).toBeVisible();
    expect(mismatches).toEqual([]);
    // And the reading note is gone.
    await expect.element(screen.getByText('Reading your rules', { exact: true }), { timeout: 4_000 }).not.toBeInTheDocument();
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
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);
    await expect.element(screen.getByText('Reading your rules', { exact: true })).not.toBeInTheDocument();
  });

  it('rivera_draws_the_body_and_fixed_chips_while_needs_you_is_still_reading', async () => {
    const reads = holdNeedsYou();
    const { screen } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
    const group = screen.getByRole('group', { name: 'Suggestions' });
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
    reads.release();
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this quote held?']);
  });

  it('another_business_opens_on_an_offline_pause_and_stays_open_on_reconnect', async () => {
    renameBusiness('Acme Accounting');
    // Rules' read is kept from a visit before this one.
    const { screen, router } = await renderRoute(`${DESK}/rules`, { pollScale: 100 });
    await expect.element(screen.getByRole('region', { name: 'Payment link' })).toBeVisible();
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    const reads = holdNeedsYou();
    onTestFinished(() => onlineManager.setOnline(true));
    onlineManager.setOnline(false);
    await router.navigate(`${DESK}/rules`);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Suggestions' }).elements()).toHaveLength(0);

    onlineManager.setOnline(true);
    await expect.poll(() => reads.held()).toBeGreaterThan(0);
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
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
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);

    releaseRules();
    await rulesRead;
    await vi.advanceTimersByTimeAsync(0);
    await new Promise(requestAnimationFrame);
    await vi.advanceTimersByTimeAsync(2_999);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(1);
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

    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
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
    // the first one's answer), only Turner's fixed suggestions remain.
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
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
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

  it('hold_question_does_not_reuse_a_read_started_before_leaving', async () => {
    const { screen, router } = await renderRoute(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    const answer = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    mockStore.inject({ route: 'needsYou', status: 200, body: (answer as { body: unknown }).body, until });
    const before = requests('needsYou').length;
    await expect.poll(() => requests('needsYou').length).toBeGreaterThan(before);
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held');
    if (!held) throw new Error('the seed holds a quote');
    mockStore.world.answer(held, 'deny_once');

    const current = holdNeedsYou();
    await router.navigate(`${DESK}/rules`);
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[0] })).toBeVisible();
    release();
    await expect.poll(() => current.held()).toBeGreaterThan(0);
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
    current.release();
    await expect.poll(() => requests('needsYou').length).toBeGreaterThan(before + 1);
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);
  });

  it('hold_question_does_not_use_a_read_sent_on_today', async () => {
    // A poll on Today is still out as the owner moves to Rules. Meanwhile the quote is answered and
    // Dana's refund held. When the poll comes back, its answer, from before Rules opened, asks
    // nothing about the quote; Rules' own read, once it comes back, asks about the refund.
    const { screen, router } = await renderRoute(`${DESK}/today`);
    await expect.element(screen.getByRole('region', { name: 'Needs you' })).toBeVisible();
    const answer = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    mockStore.inject({ route: 'needsYou', status: 200, body: (answer as { body: unknown }).body, until });
    const before = requests('needsYou').length;
    await expect.poll(() => requests('needsYou').length).toBeGreaterThan(before);
    const held = [...mockStore.world.decisions.values()].find((record) => record.decision.state === 'held');
    if (!held) throw new Error('the seed holds a quote');
    mockStore.world.answer(held, 'deny_once');
    mockStore.world.addHeldRefund();

    const current = holdNeedsYou();
    let answered = 0;
    onTestFinished(observeRequests(({ key, ok }) => { if (key === 'needsYou' && ok) answered += 1; }));
    await router.navigate(`${DESK}/rules`);
    const group = screen.getByRole('group', { name: 'Suggestions' });
    await expect.element(group.getByRole('button', { name: FIXED_CHIPS[0] })).toBeVisible();
    release();
    await expect.poll(() => answered).toBe(1);
    // Time for the poll's answer to be drawn, had Rules taken it as its own.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chipWords(group)).toEqual([...FIXED_CHIPS]);

    current.release();
    await expect.element(group.getByRole('button', { name: 'Why was this refund held?' })).toBeVisible();
    expect(chipWords(group)).toEqual([...FIXED_CHIPS, 'Why was this refund held?']);
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

describe("Turner's fixed suggestions", () => {
  type Screen = Awaited<ReturnType<typeof renderRoute>>['screen'];

  /**
   * On Rules, presses Turner's suggestion `words`, confirms the change Claude drafts from it in Ask
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
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);
    // Turner's rules have neither change, so both stay once they are drawn.
    releaseRules();
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
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

  /** Turner's active rules with both suggestions' changes in effect: quotes on their own only on weekdays, and water heater installs up to $600. */
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
    // The rules leave no suggestion of Turner's own, so the page waits for Needs you, as another business's does.
    await expect.element(group).not.toBeInTheDocument();
    expect(pagePart('.cd-rules__tool-cards', screen.container)).toBeNull();
    await expect.element(screen.getByText('Reading your rules', { exact: true })).toBeInTheDocument();

    const drawnWithoutQuestion: boolean[] = [];
    const observer = new MutationObserver(() => {
      const body = pagePart('.cd-rules__tool-cards', screen.container) !== null;
      const question = pagePart('.cd-suggestion-chips', screen.container)?.textContent?.includes('Why was this quote held?') === true;
      if (body && !question) drawnWithoutQuestion.push(true);
    });
    observer.observe(screen.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    reads.release();
    await expect.element(screen.getByRole('button', { name: 'Why was this quote held?' })).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Tool by tool' })).toBeVisible();
    expect(chipWords(screen.getByRole('group', { name: 'Suggestions' }))).toEqual(['Why was this quote held?']);
    expect(drawnWithoutQuestion, 'the body and its hold question land together').toEqual([]);
  });

  it('with_both_changes_in_effect_a_cold_load_caps_the_wait_and_a_later_hold_does_not_move_the_connectors', async () => {
    bothChangesInEffect();
    const reads = holdNeedsYou();
    const rules = holdRules();
    const finished = finishedReads();
    const connectorTops = watchTop(() => pagePart('.cd-rules__tool-cards'));
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
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(0);
    expect(screen.getByText('Reading your rules', { exact: true }).elements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole('region', { name: 'Tool by tool' }).elements()).toHaveLength(1);
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
    // The place is kept as the scroll is heard, which comes after the scroll itself: wait for it, as
    // the owner's own scrolling would be heard before they leave.
    const heard = new Promise((resolve) => main.addEventListener('scroll', resolve, { once: true }));
    main.scrollTop = main.scrollHeight;
    await heard;
    const end = main.scrollTop;
    expect(end).toBeGreaterThan(0);
    await router.navigate(`${DESK}/profile`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();

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
