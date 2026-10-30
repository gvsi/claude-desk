/**
 * The board spec (design system screens plan, Task 4) as computed-style checks, shared by every
 * `Boards/*` story. Where a signed render differs from the plan's table, the render's value is the
 * one here, and `reference/README.md` records both and why.
 */
import { expect, within } from 'storybook/test';

import { expectComputed, type ComputedExpectation } from '../test/expectComputed.ts';

const SERIF = /^"Source Serif 4"/;

/** Each spec row, as computed styles. Rows that differ by board say which boards they are for. */
export const SPEC = {
  /** Today, Safety, the switcher and the take-over: the sidebar on the panel, a hairline seam at its right. */
  sidebar: {
    width: '264px',
    backgroundColor: 'rgb(34, 34, 32)',
    borderRightWidth: '1px',
    borderRightColor: 'rgba(250, 249, 245, 0.12)',
  },
  /** The signed conversation boards (N-Conv-Run1, N-Conv-Agent-Run1): the sidebar on the app ground, no seam. */
  sidebarFilled: {
    width: '264px',
    backgroundColor: 'rgb(28, 27, 25)',
    borderRightWidth: '0px',
  },
  activeNavRow: {
    height: '36px',
    backgroundColor: 'rgb(60, 57, 47)',
    borderTopLeftRadius: '8px',
    fontSize: '14px',
    lineHeight: '20px',
    fontWeight: '420',
  },
  pageTitle: { fontFamily: SERIF, fontSize: '24px', lineHeight: '32px', fontWeight: '460' },
  greeting: { fontFamily: SERIF, fontSize: '36px', lineHeight: '44px', fontWeight: '300' },
  main: { paddingTop: '24px', paddingRight: '40px', paddingBottom: '20px', paddingLeft: '40px' },
  content: { maxWidth: '960px' },
  /** The conversation boards: the page fills the main area, so its list starts at the sidebar's seam. */
  mainFilled: { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' },
  contentFilled: { maxWidth: 'none' },
  reply: { fontFamily: SERIF, fontSize: '15px', lineHeight: '23px', fontWeight: '360', color: 'rgba(250, 249, 245, 0.92)' },
  bubble: {
    backgroundColor: 'rgba(250, 249, 245, 0.06)',
    borderTopLeftRadius: '12px',
    paddingTop: '8px',
    paddingRight: '14px',
    paddingBottom: '8px',
    paddingLeft: '14px',
    fontSize: '15px',
    lineHeight: '21px',
  },
  receipt: { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' },
  dot: { width: '6px', height: '6px' },
  card: {
    backgroundColor: 'rgba(250, 249, 245, 0.03)',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.14)',
    borderTopLeftRadius: '12px',
    paddingTop: '20px',
    paddingLeft: '20px',
  },
  secondaryMain: {
    height: '40px',
    borderTopLeftRadius: '8px',
    backgroundColor: 'rgba(250, 249, 245, 0.1)',
    fontSize: '14px',
    lineHeight: '20px',
    fontWeight: '420',
  },
  primary: { backgroundColor: 'rgb(239, 236, 228)', color: 'rgb(28, 27, 25)' },
  composer: { backgroundColor: 'rgb(42, 41, 39)', borderTopLeftRadius: '16px', boxShadow: /0px 4px 20px/ },
  footer: { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' },
} as const satisfies Record<string, ComputedExpectation>;

/** The concept footer, word for word. */
export const FOOTER = 'Concept prototype by Giovanni Alcantara, not an Anthropic product';

/** The one element `selector` finds under `root`, or a thrown error naming the selector. */
export function one<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelectorAll<T & Element>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0] as T;
}

/** Every element `selector` finds under `root`, at least one. */
export function some<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  const found = [...root.querySelectorAll<T & Element>(selector)];
  if (found.length === 0) throw new Error(`expected at least one ${selector}`);
  return found;
}

/**
 * The owner app's frame: the sidebar column, its current row, and the padded page; or, with
 * `fill`, as the signed conversation boards draw it: the page filling the main area, and the
 * sidebar on the app ground at its own height, its Answering switch 4 px under the pages.
 */
export async function expectOwnerFrame(root: HTMLElement, current: string, { fill = false } = {}): Promise<void> {
  const column = within(root).getByRole('complementary', { name: 'Claude Desk' });
  expectComputed(column, fill ? SPEC.sidebarFilled : SPEC.sidebar);
  if (fill) {
    const nav = within(column).getByRole('navigation', { name: 'Main' });
    const foot = one(column, '.cd-sidebar__footer');
    await expect(foot.getBoundingClientRect().top - nav.getBoundingClientRect().bottom, 'the sidebar foot under the pages').toBe(4);
  }
  const row = within(column).getByRole('link', { name: new RegExp(`^${current}`) });
  await expect(row).toHaveAttribute('aria-current', 'page');
  expectComputed(row, SPEC.activeNavRow);
  const main = within(root).getByRole('main');
  expectComputed(main, fill ? SPEC.mainFilled : SPEC.main);
  expectComputed(one(main, '.cd-app-shell__content'), fill ? SPEC.contentFilled : SPEC.content);
}

/** The concept footer: there once, word for word, in caption type. */
export async function expectFooter(root: HTMLElement): Promise<void> {
  const footer = one(root, '[data-ds="concept-footer"]');
  await expect(footer.textContent?.replace(/\s+/g, ' ').trim()).toBe(FOOTER);
  expectComputed(footer, SPEC.footer);
}

/** Claude's words in serif, every visitor bubble in its fill, every card in its look. */
export function expectConversationType(root: HTMLElement): void {
  for (const prose of root.querySelectorAll<HTMLElement>('.cd-claude-message__prose')) expectComputed(prose, SPEC.reply);
  for (const bubble of root.querySelectorAll<HTMLElement>('.cd-visitor-message__bubble')) expectComputed(bubble, SPEC.bubble);
}

/** Every `Card` on the board, in the card look. */
export function expectCards(root: HTMLElement): void {
  for (const card of some(root, '.cd-card')) expectComputed(card, SPEC.card);
}

/**
 * receipts_sit_under_their_message: every receipt or note is attached space-8 under the message it
 * belongs to, on its side: from the left edge of Claude's or a person's words, or ending at the
 * right edge of a visitor's or an agent's bubble. Its line is caption type in text-secondary, and
 * its dot is 6 px. Returns how many rows carry receipts.
 */
export async function expectReceiptsUnderMessages(root: HTMLElement): Promise<number> {
  const rows = [...root.querySelectorAll<HTMLElement>('.cd-transcript-row:not(.cd-transcript-header)')].filter((row) =>
    row.querySelector(':scope > .cd-transcript-row__margin'),
  );
  for (const row of rows) {
    const main = one(row, ':scope > .cd-transcript-row__main');
    const margin = one(row, ':scope > .cd-transcript-row__margin');
    const mainBox = main.getBoundingClientRect();
    const marginBox = margin.getBoundingClientRect();
    await expect(Math.round(marginBox.top - mainBox.bottom), 'space between a message and its receipts').toBe(8);
    const bubble = main.querySelector<HTMLElement>('.cd-visitor-message__bubble, .cd-agent-message__bubble');
    if (bubble) {
      await expect(Math.round(marginBox.right), 'receipts end at the bubble').toBe(Math.round(bubble.getBoundingClientRect().right));
    } else {
      const words = main.firstElementChild as HTMLElement;
      await expect(Math.round(marginBox.left), 'receipts start under the words').toBe(Math.round(words.getBoundingClientRect().left));
    }
    for (const line of margin.querySelectorAll<HTMLElement>('.cd-margin-line')) {
      expectComputed(line, SPEC.receipt);
    }
    for (const dot of margin.querySelectorAll<HTMLElement>('.cd-status-dot')) expectComputed(dot, SPEC.dot);
  }
  return rows.length;
}

/**
 * focus_order_is_logical: Tab from the top of the page reaches each of `stops` in this order
 * (other stops may come between them). Returns every stop Tab reached, in order.
 */
export async function expectTabOrder(user: { tab: () => Promise<void> }, stops: HTMLElement[], maxPresses = 80): Promise<HTMLElement[]> {
  (document.activeElement as HTMLElement | null)?.blur();
  const reached: HTMLElement[] = [];
  for (let i = 0; i < maxPresses; i += 1) {
    await user.tab();
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || reached.includes(active)) break;
    reached.push(active);
  }
  const positions = stops.map((stop) => reached.indexOf(stop));
  const missing = stops.filter((_, index) => positions[index] === -1).map(describe);
  await expect(missing, 'stops Tab never reached').toEqual([]);
  const sorted = [...positions].sort((a, b) => a - b);
  await expect(positions, `Tab order: ${stops.map(describe).join(', ')}`).toEqual(sorted);
  return reached;
}

function describe(el: HTMLElement): string {
  return el.getAttribute('aria-label') ?? el.textContent?.replace(/\s+/g, ' ').trim() ?? el.tagName;
}

/**
 * The connectors board spec (design system screens plan, Task 6b): the Connectors and rules boards'
 * own rows, read off their renders, with the rows above.
 */
export const CONNECTORS_SPEC = {
  /** A connector's section: the card's look, with no padding of its own. */
  section: {
    backgroundColor: 'rgba(250, 249, 245, 0.03)',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.14)',
    borderTopLeftRadius: '12px',
    paddingTop: '0px',
    paddingLeft: '0px',
  },
  sectionHeader: { paddingTop: '14px', paddingRight: '16px', paddingBottom: '14px', paddingLeft: '16px' },
  iconTile: { width: '36px', height: '36px', borderTopLeftRadius: '8px', backgroundColor: 'rgba(250, 249, 245, 0.1)' },
  brandTile: { width: '36px', height: '36px', borderTopLeftRadius: '8px', backgroundColor: 'rgb(255, 255, 255)' },
  toolRow: {
    paddingTop: '12px',
    paddingRight: '16px',
    paddingBottom: '12px',
    paddingLeft: '16px',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.12)',
  },
  toolName: { fontWeight: '520' },
  outcomeMenu: {
    height: '32px',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.22)',
    borderTopLeftRadius: '8px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  },
  changeTag: { width: '64px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.22)', borderTopLeftRadius: '999px' },
  stepCircle: { width: '22px', height: '22px' },
  currentStep: { backgroundColor: 'rgb(239, 236, 228)' },
  quotedDefinition: {
    paddingTop: '10px',
    paddingRight: '12px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    borderTopWidth: '1px',
    borderTopColor: 'rgba(250, 249, 245, 0.12)',
    borderTopLeftRadius: '8px',
    backgroundColor: 'rgb(28, 27, 25)',
  },
  quotedDefinitionText: { fontSize: '12px', lineHeight: '18px', fontFamily: /mono/i, whiteSpace: 'pre-wrap' },
  askClaudePanel: { width: '400px', borderLeftWidth: '1px', borderLeftColor: 'rgba(250, 249, 245, 0.12)' },
} as const satisfies Record<string, ComputedExpectation>;

/** Every connector section on the page in its look: the card, its header link and its icon tile, and each tool row. */
export function expectConnectorSections(root: HTMLElement): void {
  for (const section of some(root, '.cd-connector-section')) {
    expectComputed(section.closest<HTMLElement>('.cd-card') as HTMLElement, CONNECTORS_SPEC.section);
    expectComputed(one(section, ':scope > .cd-connector-section__header'), CONNECTORS_SPEC.sectionHeader);
    const tile = one(section, '.cd-connector-icon');
    expectComputed(tile, tile.classList.contains('cd-connector-icon--brand') ? CONNECTORS_SPEC.brandTile : CONNECTORS_SPEC.iconTile);
    for (const row of section.querySelectorAll<HTMLElement>('.cd-connector-section__tool')) {
      expectComputed(row, CONNECTORS_SPEC.toolRow);
      expectComputed(one(row, '.cd-connector-section__tool-link'), CONNECTORS_SPEC.toolName);
    }
  }
}

/** Every outcome menu button on the page, in its look. */
export function expectOutcomeMenus(root: HTMLElement): HTMLElement[] {
  const buttons = some(root, '.cd-outcome-menu__button');
  for (const button of buttons) expectComputed(button, CONNECTORS_SPEC.outcomeMenu);
  return buttons;
}

/** The owner composer of a Rules page or a tool's page, in the composer's look, with its helper and its chips. */
export async function expectRulesComposer(
  root: HTMLElement,
  placeholder: string,
  chips: readonly string[],
): Promise<{ composer: HTMLElement; chips: HTMLElement[] }> {
  const composer = within(root).getByRole('textbox', { name: placeholder });
  await expect(composer).toHaveAttribute('placeholder', placeholder);
  expectComputed(composer.closest<HTMLElement>('.cd-composer__box') as HTMLElement, SPEC.composer);
  await expect(within(root).getByText('Claude shows you the change and example situations before anything applies.')).toBeVisible();
  const group = within(root).getByRole('group', { name: 'Suggestions' });
  const buttons = within(group).getAllByRole('button');
  await expect(buttons.map((chip) => chip.textContent)).toEqual([...chips]);
  return { composer, chips: buttons };
}

/**
 * A Rules page: the serif title, its line and "Add a connector"; the composer and its chips; each
 * connector's section; the always-on rules, with no controls.
 */
export async function expectRulesPage(root: HTMLElement, chips: readonly string[]): Promise<{ composer: HTMLElement; chips: HTMLElement[] }> {
  const main = within(root).getByRole('main');
  expectComputed(within(main).getByRole('heading', { level: 1, name: 'Rules' }), SPEC.pageTitle);
  await expect(within(main).getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.')).toBeVisible();
  const [add] = within(main).getAllByRole('button', { name: 'Add a connector' });
  expectComputed(add as HTMLElement, SPEC.secondaryMain);
  const ask = await expectRulesComposer(main, 'Ask Claude to change a rule or a connector', chips);
  // As the board spaces them: the button 4 px under the top of the title's line, the composer 20 px
  // under the header (or the notice under it), its suggestions 10 px under it, and the connectors'
  // summary 20 px under them.
  const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
  const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);
  const header = one(main, '.cd-page-header');
  await expect(top(add as HTMLElement) - top(header), 'the button under the title line').toBe(4);
  const box = ask.composer.closest('.cd-composer__box') as HTMLElement;
  const above = one(main, '.board-ask').previousElementSibling as HTMLElement;
  await expect(top(box) - bottom(above), 'the composer under the header').toBe(20);
  const group = one(main, '.cd-suggestion-chips');
  await expect(top(group) - bottom(box), 'the suggestions under the composer').toBe(10);
  await expect(top(one(main, '.cd-connector-list__summary')) - bottom(group), 'the summary under the suggestions').toBe(20);
  expectConnectorSections(main);
  const alwaysOn = one(main, '.cd-always-on');
  await expect(alwaysOn.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
  return ask;
}
