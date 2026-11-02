/**
 * The board spec (design system screens plan, Task 4) as computed-style checks, shared by every
 * `Boards/*` story. Where a signed render differs from the plan's table, the render's value is the
 * one here, and `reference/README.md` records both and why.
 */
import { expect, within } from 'storybook/test';

import { expectComputed, type ComputedExpectation } from '../test/expectComputed.ts';

import { factsInProse } from './factInProse.ts';

const SERIF = /^"Source Serif 4"/;
const SANS = /^"Hanken Grotesk"/;

/** Each spec row, as computed styles. Rows that differ by board say which boards they are for. */
export const SPEC = {
  /** Every owner page (owner decision 2026-10-29): the sidebar on the panel, a hairline seam at its right. */
  sidebar: {
    width: '264px',
    backgroundColor: 'rgb(34, 34, 32)',
    borderRightWidth: '1px',
    borderRightColor: 'rgba(250, 249, 245, 0.12)',
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
  /** Today's "Last 7 days" (N-Today-Run1): the booked total, then the smaller stopped count, with tabular figures. */
  figure: { fontFamily: SANS, fontSize: '32px', lineHeight: '40px', fontWeight: '500', letterSpacing: '-0.3px', fontVariantNumeric: 'tabular-nums' },
  figureSmall: { fontFamily: SANS, fontSize: '24px', lineHeight: '32px', fontWeight: '420', letterSpacing: 'normal', fontVariantNumeric: 'tabular-nums' },
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
  /** Share's More channels: four rows in one card, separated by hairlines. */
  shareChannelRow: { paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px' },
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
  /** The Recorded tag (RecordedTag): caption type in secondary ink, the icon 4 px before the word, on one line. */
  recordedTag: { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)', columnGap: '4px', whiteSpace: 'nowrap' },
  /** The line on an opened replayed item (RecordedNote): caption type in secondary ink, the words 6 px after the icon. */
  recordedNote: { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)', columnGap: '6px' },
  /** "Includes recorded history" (RecordedHistoryLink): caption type in secondary ink, underlined in line-control 3 px down. */
  recordedLink: {
    fontSize: '12px',
    lineHeight: '17px',
    color: 'rgba(250, 249, 245, 0.64)',
    textDecorationLine: 'underline',
    textDecorationColor: 'rgba(250, 249, 245, 0.22)',
    textUnderlineOffset: '3px',
  },
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
 * The owner app's frame: the sidebar column in its one look on every page, its current row, and
 * the page: padded, or with `fill` filling the main area, as the conversation pages do.
 */
export async function expectOwnerFrame(root: HTMLElement, current: string, { fill = false } = {}): Promise<void> {
  const column = within(root).getByRole('complementary', { name: 'Claude Desk' });
  expectComputed(column, SPEC.sidebar);
  // The Answering switch and the owner sit at the column's foot, inside the sidebar's 12 px.
  const foot = one(column, '.cd-sidebar__footer');
  await expect(column.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom, 'the sidebar foot at the bottom').toBe(12);
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

/** The words of the line on an opened replayed item, word for word. */
export const RECORDED_NOTE = 'Recorded history, replayed into your copy. It happened before you arrived.';

/**
 * recorded_rows_are_tagged: each of `rows` carries the Recorded tag exactly when `recorded` says so,
 * in its look, with the 14 px history icon hidden from screen readers. Returns the tags, in order.
 */
export async function expectRecordedTags(rows: HTMLElement[], recorded: (row: HTMLElement) => boolean): Promise<HTMLElement[]> {
  const tags: HTMLElement[] = [];
  for (const row of rows) {
    const found = [...row.querySelectorAll<HTMLElement>('.cd-recorded-tag')];
    await expect(found, `${describe(row)}: its Recorded tag`).toHaveLength(recorded(row) ? 1 : 0);
    for (const tag of found) {
      await expect(tag).toHaveTextContent(/^Recorded$/);
      expectComputed(tag, SPEC.recordedTag);
      const icon = one<SVGSVGElement>(tag, 'svg');
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon.getBoundingClientRect().height).toBe(14);
      tags.push(tag);
    }
  }
  return tags;
}

/** The line on an opened replayed item: there once, word for word, in its look, its icon hidden. */
export async function expectRecordedNote(root: HTMLElement): Promise<HTMLElement> {
  const note = one(root, '.cd-recorded-note');
  await expect(note).toHaveTextContent(RECORDED_NOTE);
  expectComputed(note, SPEC.recordedNote);
  await expect(one(note, 'svg')).toHaveAttribute('aria-hidden', 'true');
  return note;
}

/** "Includes recorded history": a link to the ledger's explanation, in its quiet look. */
export async function expectRecordedLink(link: HTMLElement, href: string): Promise<void> {
  await expect(link).toHaveAccessibleName('Includes recorded history');
  await expect(link).toHaveAttribute('href', href);
  expectComputed(link, SPEC.recordedLink);
}

/** Owner columns carry the line under About; other short pages keep it 20 px above the window foot. */
export async function expectFooterAtFoot(root: HTMLElement): Promise<void> {
  const footer = one(root, '[data-ds="concept-footer"]');
  const sidebar = footer.closest('.cd-sidebar');
  if (sidebar) {
    const about = one(sidebar, '.cd-sidebar__about');
    const answering = one(sidebar, '.cd-sidebar__footer');
    await expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(about.getBoundingClientRect().bottom);
    await expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(answering.getBoundingClientRect().top);
    return;
  }
  await expect(Math.round(window.innerHeight - footer.getBoundingClientRect().bottom), 'the footer 20 px over the window foot').toBe(20);
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

/** The footer's one link, the author's name, under `root`. */
export function footerLink(root: ParentNode): HTMLElement {
  const link = root.querySelector<HTMLElement>('[data-ds="concept-footer"] a');
  if (!link) throw new Error('the footer draws the author\'s name as a link');
  return link;
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
  /** A third-party connector's mark: the same box, with no tile behind it (owner, 2026-10-30). */
  brandTile: { width: '36px', height: '36px', borderTopLeftRadius: '8px', backgroundColor: 'rgba(0, 0, 0, 0)' },
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
      expectComputed(one(row, '.cd-connector-section__tool-name'), CONNECTORS_SPEC.toolName);
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
  await expect(within(root).getByText('Claude shows you the change before anything applies.')).toBeVisible();
  const group = within(root).getByRole('group', { name: 'Suggestions' });
  const buttons = within(group).getAllByRole('button');
  await expect(buttons.map((chip) => chip.textContent)).toEqual([...chips]);
  return { composer, chips: buttons };
}

/**
 * A Rules page: the serif title and its line; the composer and its chips right under them; each
 * connector's section; the always-on rules, with no controls. Connectors are added from the
 * Connectors page, so the Rules page has no "Add a connector".
 */
export async function expectRulesPage(root: HTMLElement, chips: readonly string[]): Promise<{ composer: HTMLElement; chips: HTMLElement[] }> {
  const main = within(root).getByRole('main');
  expectComputed(within(main).getByRole('heading', { level: 1, name: 'Rules' }), SPEC.pageTitle);
  await expect(within(main).getByText('What Claude can do on this Desk, where each tool comes from, and your rules for it.')).toBeVisible();
  await expect(within(main).queryByRole('button', { name: 'Add a connector' })).toBeNull();
  const ask = await expectRulesComposer(main, 'Ask Claude to change a rule', chips);
  // As the board spaces them: the composer 20 px under the header (or the notice under it), its
  // suggestions 10 px under it, and the connectors' summary 20 px under them.
  const top = (el: Element) => Math.round(el.getBoundingClientRect().top);
  const bottom = (el: Element) => Math.round(el.getBoundingClientRect().bottom);
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

/** Settings' sections, in SubNav's order. */
export const SETTINGS_SECTION_NAMES = ['General', 'Notifications', 'Channels', 'Billing'] as const;

/**
 * A Settings board on a laptop: the owner frame with the sidebar's Connectors row after Rules and
 * Settings current; the serif title at the top of the page; SubNav, 200 px wide, 24 px under it,
 * with `current` marked; and the content column 40 px to its right, 720 px wide, level with SubNav.
 * Returns the content column.
 */
export async function expectSettingsPage(root: HTMLElement, current: (typeof SETTINGS_SECTION_NAMES)[number]): Promise<HTMLElement> {
  await expectOwnerFrame(root, 'Settings', { fill: true });
  const sidebar = within(root).getByRole('complementary', { name: 'Claude Desk' });
  const rows = within(sidebar)
    .getAllByRole('link')
    .map((link) => link.textContent?.replace(/\d+$/, '').trim());
  await expect(rows.indexOf('Connectors'), 'the Connectors row after Rules').toBe(rows.indexOf('Rules') + 1);

  const main = within(root).getByRole('main');
  const title = within(main).getByRole('heading', { level: 1, name: 'Settings' });
  expectComputed(title, SPEC.pageTitle);
  const nav = within(main).getByRole('navigation', { name: 'Settings' });
  const links = within(nav).getAllByRole('link');
  await expect(links.map((link) => link.textContent)).toEqual([...SETTINGS_SECTION_NAMES]);
  await expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual([current]);

  const content = one(main, '.board-settings__content');
  const titleBox = title.getBoundingClientRect();
  const navBox = nav.getBoundingClientRect();
  const contentBox = content.getBoundingClientRect();
  // From the top of the main area, so a banner over the app (the vision bar) moves it down with the page.
  await expect(Math.round(titleBox.top - main.getBoundingClientRect().top), 'the title at the top of the page').toBe(24);
  await expect(Math.round(navBox.top - titleBox.bottom), 'SubNav under the title').toBe(24);
  await expect(Math.round(navBox.width)).toBe(200);
  await expect(Math.round(contentBox.left - navBox.right), 'the content beside SubNav').toBe(40);
  await expect(Math.round(contentBox.width)).toBe(720);
  await expect(Math.round(contentBox.top)).toBe(Math.round(navBox.top));
  return content;
}

/**
 * The agents page's AI disclosure under its title: `DisclosureLine`'s sentence for Turner
 * Plumbing, once, in its meta type and the secondary ink, 16 px under the title.
 */
export async function expectAgentsDisclosure(root: HTMLElement): Promise<void> {
  const line = one(root, '.cd-disclosure-line');
  await expect(line.textContent).toBe('Turner Plumbing answers with Claude, an AI.');
  await expect(line).toHaveAttribute('lang', 'en');
  expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
  const title = within(root).getByRole('heading', { level: 1 });
  await expect(Math.round(line.getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(16);
}

/** The vision bar's line, word for word, as every vision board writes it. */
export const VISION_BAR_LINE = 'Vision, not in the prototype. Nothing here is live.';

/**
 * vision_page_is_labelled: the vision bar before all but AppShell's skip link, across the window's width at its top,
 * 40 px tall on the panel, with the "Vision" pill, its line, and "Back to Vision" to `backHref`.
 */
export async function expectVisionBar(root: HTMLElement, backHref: string): Promise<HTMLElement> {
  const bar = within(root).getByRole('note', { name: 'Vision' });
  const box = bar.getBoundingClientRect();
  await expect([box.top, box.left, box.width]).toEqual([0, 0, document.documentElement.clientWidth]);
  expectComputed(bar, { height: '40px', backgroundColor: 'rgb(34, 34, 32)', borderBottomColor: 'rgba(250, 249, 245, 0.12)' });
  await expect(bar).toHaveTextContent(`Vision${VISION_BAR_LINE}Back to Vision`);
  await expect(within(bar).getByRole('link', { name: 'Back to Vision' })).toHaveAttribute('href', backHref);
  const elements = Array.from(root.querySelectorAll('[role="note"], a[href], button, h1, h2, main, nav, aside, header'));
  const shell = bar.closest<HTMLElement>('.cd-app-shell');
  if (shell) {
    // Only the shell's single skip link may precede the bar, and it must target this shell's main.
    const skip = within(shell).getByRole('link', { name: /^Skip to content$/ });
    const main = within(shell).getByRole('main');
    await expect(main.id).not.toBe('');
    await expect(skip).toHaveAttribute('href', `#${main.id}`);
    await expect(root.ownerDocument.getElementById(main.id)).toBe(main);
    await expect(elements.shift()).toBe(skip);
  }
  // The bar still precedes every other link, control, heading and landmark on the page.
  await expect(bar.contains(elements[0] ?? null)).toBe(true);
  return bar;
}

/**
 * Settings › Channels' content (N-Run2-Settings-Channels), the same under the vision bar: the lead
 * in secondary body type, the channels 20 px under it in the 720 px column, in the board's order and
 * row heights, with nothing to press.
 */
export async function expectChannelsContent(content: HTMLElement, lead: string): Promise<void> {
  const line = within(content).getByText(lead);
  expectComputed(line, { fontSize: '14px', lineHeight: '20px', color: 'rgba(250, 249, 245, 0.64)' });
  const channels = within(content).getByRole('region', { name: 'Channels' });
  await expect(Math.round(channels.getBoundingClientRect().top - line.getBoundingClientRect().bottom)).toBe(20);
  await expect(Math.round(channels.getBoundingClientRect().width)).toBe(720);
  const rows = within(channels).getAllByRole('listitem');
  await expect(rows.map((row) => one(row, '.cd-channel-list__name').textContent)).toEqual([
    'Public link',
    'Email',
    'Website embed',
    'WhatsApp and iMessage',
    'Slack',
    'Voice',
  ]);
  await expect(within(rows[0] as HTMLElement).getByText('On')).toBeVisible();
  await expect(within(channels).getAllByText('Coming later')).toHaveLength(5);
  // The board's rows: 68 px for one line under the name, 86 px where it wraps (Email, WhatsApp), and
  // a 1 px hairline over every row but the first.
  await expect(rows.map((row) => Math.round(row.getBoundingClientRect().height))).toEqual([68, 87, 69, 87, 69, 69]);
  await expect(within(content).queryByRole('button')).toBeNull();
  await expect(within(content).queryByRole('switch')).toBeNull();
}

export { factsInProse } from './factInProse.ts';

/** A booking card (the kernel's `booking_confirmed`, labelled "Booked" or "Reservado") inside `root`. */
function carriesBookingCard(root: Element | null): boolean {
  return root?.querySelector('.cd-reply-card [aria-label="Booked"], .cd-reply-card [aria-label="Reservado"]') != null;
}

/**
 * vision_prose_states_no_facts: Claude's words under `root` pass the kernel's prose check as
 * `factsInProse` mirrors it, and so does every receipt line under them. The kernel scans only a
 * reply's prose, since a real receipt is its own fixed line; a vision page's receipts are free text,
 * so the vision pages hold them to the same check themselves. A booking claim passes in a message that
 * carries its booking card, as the kernel decides; a receipt goes with its message's card. Returns
 * how many lines of Claude's words and how many receipt lines it checked.
 */
export async function expectNoFactsInProse(root: HTMLElement): Promise<{ prose: number; receipts: number }> {
  const check = async (lines: HTMLElement[], what: string, message: (line: HTMLElement) => Element | null) => {
    for (const line of lines) {
      const text = line.textContent ?? '';
      const hits = factsInProse(text, { bookingCard: carriesBookingCard(message(line)) });
      await expect(hits, `${what} the kernel would block: "${text}"`).toEqual([]);
    }
  };
  const prose = [...root.querySelectorAll<HTMLElement>('.cd-claude-message__prose')];
  await check(prose, 'Claude’s words state something', (line) => line.closest('.cd-claude-message'));
  const receipts = [...root.querySelectorAll<HTMLElement>('.cd-margin-line')];
  await check(receipts, 'A receipt states something', (line) => line.closest('.cd-transcript-row'));
  return { prose: prose.length, receipts: receipts.length };
}
