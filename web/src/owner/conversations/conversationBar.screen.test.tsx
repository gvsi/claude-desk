/**
 * The open conversation's bar in a real browser against the mock API (board REV-720 C): one bar
 * pinned to the top of the pane across its full width, which the chat scrolls under. It holds who
 * the chat is with and their level, then what happened last, cut short to keep to one line, and
 * Take over at its right; on a phone, two lines. The opening lines stay at the top of the
 * transcript, the owner's controls at the foot keep the whisper line, and the pane's loading shapes
 * draw the same bar.
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { ROUTES } from '../../api/routes.ts';
import type { OwnerTranscript } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { loadWebFonts } from '../../ds/test/fonts.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import type { SessionRecord } from '../../mocks/world.ts';
import { holdReads } from '../../test/holdReads.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectNoWindowScroll, expectScreenBasics, nextFrames, tokenColor } from '../../test/screen.ts';
import { SKELETON_TOLERANCE_PX } from '../../test/skeleton.ts';
import { TRANSCRIPT_NOTE } from './copy.ts';
import { CHANGED_WHILE_ACTING } from './useTakeOver.ts';

beforeAll(loadWebFonts);

const DESK = `/app/${RIVERA.deskId}`;
const LIST = `${DESK}/conversations`;
const conversation = (sessionId: string) => `${LIST}/${sessionId}`;
const conversationRead = (sessionId: string) => ROUTES.conversation.path.replace('{session_id}', sessionId);
const DANA = rivera.people.dana.name;
/** Dana's live chat, and the fresh copy's held one (what Today's "Open the request" opens). */
const DANA_LIVE = 'ses-dana-web';
const SEEDED_HOLD = 'ses-visitor-web';
const SIZES = [[1440, 900], [390, 844]] as const;
/** A line longer than the bar has room for, at every width. */
const LONG_LATEST =
  'Passed to Mike Turner to answer: the visitor asked for 15% off a drain clearing for paying cash, and for a time on Tuesday afternoon';

/** The requests a route got. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

function named(sessionId: string, name: string): SessionRecord {
  const found = mockStore.world.sessions.get(sessionId);
  if (!found) throw new Error(`the mock has no chat ${sessionId}`);
  found.displayName = name;
  return found;
}

/** Makes `chat` longer than the window: `count` more messages from the visitor. Returns the last. */
function lengthen(chat: SessionRecord, count = 30): string {
  let last = '';
  for (let i = 1; i <= count; i += 1) {
    last = `Message ${i} of ${count}: the water heater is still dripping.`;
    mockStore.world.visitorText(chat, last);
  }
  return last;
}

/** Every read of the seeded hold's chat says `words` happened last: its newest line of the kernel's. */
async function withLatest(words: string): Promise<void> {
  const answer = await mockStore.dispatch('conversation', { params: { session_id: SEEDED_HOLD } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads the held chat');
  const read = answer.body as OwnerTranscript;
  const newest = [...read.items].sort((a, b) => b.n - a.n).find((item) => item.event !== null && 'visitor_plain' in item.event);
  if (newest === undefined) throw new Error('the held chat has a line of the kernel\'s');
  const items = read.items.map((item) => (item === newest ? { ...item, event: { ...item.event!, visitor_plain: words } } : item));
  mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...read, items } });
}

/** The page's own part, never its loading shape: the shapes use the same classes. */
function landed(selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => !el.closest('.cd-skeleton-screen__layer'));
  if (!found) throw new Error(`the page has ${selector}`);
  return found;
}

/** The open chat once it has landed: its bar names `who`, and the pane's shapes have gone. */
async function opened(screen: RenderResult, who: string): Promise<HTMLElement> {
  await expect.element(screen.getByRole('heading', { level: 2, name: who, exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer')).toBeNull();
  return landed('.cd-conversation__bar');
}

/** The element whose scrolling moves `el`: the nearest that scrolls, `el` included, or the page. */
function scrollerOf(el: Element): Element {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

const rect = (el: Element) => el.getBoundingClientRect();
const middle = (el: Element) => (rect(el).top + rect(el).bottom) / 2;

/** The pane's inner box: its border box less its borders and any scroll bar. */
function inside(pane: HTMLElement) {
  const box = rect(pane);
  const left = box.left + pane.clientLeft;
  const top = box.top + pane.clientTop;
  return { left, top, right: left + pane.clientWidth };
}

/**
 * The bar's look: pinned (sticky), on the app's ground with a hairline under it and no other edge,
 * across the pane's whole width with the pane's gutter as its side padding, and nothing in it
 * reaching past its edges.
 */
function expectTheBarAcrossThePane(bar: HTMLElement, pane: HTMLElement): void {
  const style = getComputedStyle(bar);
  expect(style.position).toBe('sticky');
  expect(style.backgroundColor).toBe(tokenColor('--bg-app'));
  expect([style.borderBottomStyle, style.borderBottomWidth, style.borderBottomColor]).toEqual(['solid', '1px', tokenColor('--line-hairline')]);
  for (const side of ['top', 'right', 'left'] as const) expect(style.getPropertyValue(`border-${side}-style`), `no edge at the bar's ${side}`).toBe('none');
  const gutter = getComputedStyle(pane).paddingLeft;
  expect([style.paddingLeft, style.paddingRight], 'the bar pads its sides by the pane\'s gutter').toEqual([gutter, gutter]);
  const box = rect(bar);
  const area = inside(pane);
  expect(Math.abs(box.left - area.left), 'the bar starts at the pane\'s left edge').toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.right - area.right), 'the bar ends at the pane\'s right edge').toBeLessThanOrEqual(0.5);
  expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
}

/** "Latest: …" keeps to one line and ends in an ellipsis when its words don't fit. */
function expectCutShort(latest: HTMLElement): void {
  const style = getComputedStyle(latest);
  expect([style.whiteSpace, style.overflowX, style.textOverflow]).toEqual(['nowrap', 'hidden', 'ellipsis']);
  expect(latest.scrollWidth, 'its words are longer than its room').toBeGreaterThan(latest.clientWidth);
  expect(rect(latest).height).toBe(Number.parseFloat(style.lineHeight));
}

describe('the open conversation bar', () => {
  it.each(SIZES)('stays_at_the_top_of_the_pane_as_the_chat_scrolls_at_%sx%s', async (width, height) => {
    const last = lengthen(named(DANA_LIVE, DANA));
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const bar = await opened(screen, DANA);
    const pane = landed('.cd-conversations__open');
    const latest = screen.getByRole('log').getByText(last, { exact: true });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    expectTheBarAcrossThePane(bar, pane);
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    expect(bar.contains(takeOver.element()), 'Take over is in the bar').toBe(true);

    // Where the bar rests: the pane's top on a laptop, under the way back on a phone.
    const scroller = scrollerOf(latest.element());
    scroller.scrollTop = 0;
    await nextFrames();
    const rest = rect(bar).top;
    if (width >= 1024) expect(Math.abs(rest - inside(pane).top), 'the bar is the first thing in the pane').toBeLessThanOrEqual(0.5);
    else expect(rest).toBeGreaterThanOrEqual(rect(screen.getByRole('link', { name: 'All conversations' }).element()).bottom);

    // Read through to the end, the bar's top stays put; if the pane itself scrolls, the bar stays
    // at its top once the pane has scrolled past where it rests.
    for (const to of [scroller.scrollHeight / 2, scroller.scrollHeight]) {
      scroller.scrollTop = to;
      await nextFrames();
      const expected = scroller === pane ? Math.max(inside(pane).top, rest - pane.scrollTop) : rest;
      expect(Math.abs(rect(bar).top - expected), `the bar's top with the chat scrolled ${scroller.scrollTop} px`).toBeLessThanOrEqual(0.5);
    }
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(takeOver).toBeInViewport({ ratio: 1 });
    expectNoHorizontalScroll();
    expectNoWindowScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  // A short laptop window and a phone with little height, where the open conversation scrolls as one.
  it.each([[1440, 560], [390, 500]] as const)('pins_over_the_chat_where_the_pane_scrolls_as_one_at_%sx%s', async (width, height) => {
    const last = lengthen(named(DANA_LIVE, DANA));
    const { screen, router } = await renderRoute(LIST, { viewport: width < 1024 ? 'phone' : 'desktop' });
    await page.viewport(width, height);
    await router.navigate(conversation(DANA_LIVE));
    const bar = await opened(screen, DANA);
    const pane = landed('.cd-conversations__open');
    const latest = screen.getByRole('log').getByText(last, { exact: true });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    expect(scrollerOf(latest.element()), 'the pane scrolls the chat').toBe(pane);
    expect(pane.scrollTop).toBeGreaterThan(0);

    // At the end of the chat, the bar is pinned at the pane's top, under the app's own bar on a
    // phone, and the chat scrolls under it: the bar is what shows there.
    expect(Math.abs(rect(bar).top - inside(pane).top)).toBeLessThanOrEqual(0.5);
    if (width < 1024) {
      const appBar = document.querySelector('.cd-app-shell__topbar');
      expect(appBar).not.toBeNull();
      expect(Math.abs(rect(bar).top - rect(appBar!).bottom), 'the bar sits under the app bar').toBeLessThanOrEqual(0.5);
    }
    expectTheBarAcrossThePane(bar, pane);
    const box = rect(bar);
    const at = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
    expect(at !== null && bar.contains(at), 'the bar paints over the chat under it').toBe(true);
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeInViewport({ ratio: 1 });

    // Back at the top, the bar is where it rests, and the chat's opening lines are under it.
    pane.scrollTop = 0;
    await nextFrames();
    const header = screen.getByRole('log').element().querySelector('.cd-transcript-header')!;
    expect(rect(header).top).toBeGreaterThanOrEqual(rect(bar).bottom);
    expectNoWindowScroll();
  });

  it('keeps_to_one_line_with_latest_cut_short_at_1440x900', async () => {
    await withLatest(LONG_LATEST);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { viewport: { width: 1440, height: 900 } });
    const bar = await opened(screen, 'Visitor');
    const pane = landed('.cd-conversations__open');
    expectTheBarAcrossThePane(bar, pane);
    // 56 px: the 32 px Take over with 12 px above and below it.
    expect(rect(bar).height).toBe(56);

    const name = screen.getByRole('heading', { level: 2, name: 'Visitor' }).element();
    const pill = bar.querySelector<HTMLElement>('.cd-pill')!;
    const dot = bar.querySelector<HTMLElement>('.cd-conversation__dot')!;
    const latest = bar.querySelector<HTMLElement>('.cd-conversation__latest')!;
    const takeOver = screen.getByRole('button', { name: 'Take over' }).element();
    expect(pill.textContent).toBe('Public');
    expect(dot.textContent).toBe('·');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(latest.textContent).toBe(`Latest: ${LONG_LATEST}`);

    // One line, left to right: the name, its pill, the dot, then Latest, with Take over at the
    // right; each centred on the bar's middle.
    const parts = [name, pill, dot, latest, takeOver];
    parts.slice(1).forEach((part, i) => expect(rect(part).left, `part ${i + 1} follows part ${i}`).toBeGreaterThanOrEqual(rect(parts[i]!).right));
    for (const part of parts) expect(Math.abs(middle(part) - middle(bar) + 0.5), `${part.textContent} on the bar's middle`).toBeLessThanOrEqual(1);
    const gutter = Number.parseFloat(getComputedStyle(pane).paddingLeft);
    expect(rect(name).left - rect(bar).left).toBe(gutter);
    expect(rect(bar).right - rect(takeOver).right).toBe(gutter);

    // The name in section type, Latest in meta type and secondary ink, the dot in tertiary ink.
    expect(getComputedStyle(name).fontSize).toBe('15px');
    expect([getComputedStyle(latest).fontSize, getComputedStyle(latest).color]).toEqual(['13px', tokenColor('--text-secondary')]);
    expect(getComputedStyle(dot).color).toBe(tokenColor('--text-tertiary'));
    expectCutShort(latest);
    expect(takeOver.classList.contains('cd-button--secondary')).toBe(true);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('takes_two_lines_on_a_phone_at_390x844', async () => {
    await withLatest(LONG_LATEST);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { viewport: { width: 390, height: 844 } });
    const bar = await opened(screen, 'Visitor');
    const pane = landed('.cd-conversations__open');
    expectTheBarAcrossThePane(bar, pane);
    const name = screen.getByRole('heading', { level: 2, name: 'Visitor' }).element();
    const pill = bar.querySelector<HTMLElement>('.cd-pill')!;
    const latest = bar.querySelector<HTMLElement>('.cd-conversation__latest')!;
    const takeOver = screen.getByRole('button', { name: 'Take over' }).element();
    const gutter = Number.parseFloat(getComputedStyle(pane).paddingLeft);

    // Line 1: the name and its pill, with Take over at the right, on one middle.
    for (const part of [pill, takeOver]) expect(Math.abs(middle(part) - middle(name)), `${part.textContent} beside the name`).toBeLessThanOrEqual(1);
    expect(rect(pill).left).toBeGreaterThanOrEqual(rect(name).right);
    expect(rect(bar).right - rect(takeOver).right).toBe(gutter);
    // No dot on a phone: Latest has its own line.
    expect(getComputedStyle(bar.querySelector('.cd-conversation__dot')!).display).toBe('none');

    // Line 2: Latest under them, across the bar's whole width inside its padding, cut short.
    expect(rect(latest).top).toBeGreaterThanOrEqual(Math.max(rect(name).bottom, rect(takeOver).bottom));
    expect(rect(latest).left - rect(bar).left).toBe(gutter);
    expect(Math.abs(rect(bar).right - gutter - rect(latest).right)).toBeLessThanOrEqual(0.5);
    expectCutShort(latest);
    // Two lines and no more: 8 px above the first and under the second.
    const style = getComputedStyle(bar);
    expect([style.paddingTop, style.paddingBottom]).toEqual(['8px', '8px']);
    expect(rect(bar).bottom - 1 - rect(latest).bottom).toBeCloseTo(8, 0);
    expect(Math.min(rect(name).top, rect(takeOver).top) - rect(bar).top).toBeCloseTo(8, 0);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(SIZES)('shows_the_verified_name_and_simulation_caption_in_full_at_%sx%s', async (width, height) => {
    const held = mockStore.world.addHeldRefund();
    const chat = mockStore.world.sessions.get(held.session_id)!;
    expect(chat.state.assurance).toBe('demo_code');
    lengthen(chat);
    const { screen } = await renderRoute(conversation(chat.state.session_id), { viewport: { width, height } });
    const bar = await opened(screen, DANA);
    const name = screen.getByRole('heading', { level: 2, name: DANA }).element();
    const quiet = bar.querySelector<HTMLElement>('.cd-conversation__quiet')!;
    const latest = bar.querySelector<HTMLElement>('.cd-conversation__latest')!;
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    expect(quiet.textContent).toBe('Simulated verification');
    expect(quiet.scrollWidth).toBeLessThanOrEqual(quiet.clientWidth);
    if (width < 1024) {
      expectCutShort(latest);
      expect(rect(bar).height).toBe(69);
      expect(rect(quiet).top).toBeGreaterThanOrEqual(rect(name).bottom);
      expect(Math.abs(middle(quiet) - middle(latest))).toBeLessThanOrEqual(1);
      const dot = bar.querySelector<HTMLElement>('.cd-conversation__dot')!;
      expect(dot.textContent).toBe('·');
      expect(rect(dot).left).toBeGreaterThanOrEqual(rect(quiet).right);
      expect(rect(latest).left).toBeGreaterThanOrEqual(rect(dot).right);
    }
    expectNoHorizontalScroll();
  });

  it.each(SIZES)('leaves_the_opening_lines_at_the_top_of_the_transcript_at_%sx%s', async (width, height) => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const bar = await opened(screen, DANA);
    const log = screen.getByRole('log').element();

    // The transcript starts with when and where the chat started and where the checks sit, and the
    // bar holds none of it.
    const header = log.firstElementChild;
    expect(header?.classList.contains('cd-transcript-header')).toBe(true);
    expect(header?.textContent).toMatch(/ at .+, web chat from /);
    expect(header?.textContent).toContain(TRANSCRIPT_NOTE);
    expect(bar.textContent).not.toContain('web chat from');
    expect(bar.textContent).not.toContain(TRANSCRIPT_NOTE);

    // The owner's controls keep the line about whispers and the whisper box, without Take over or
    // the line about what the visitor sees when the owner joins.
    const controls = landed('.cd-conversation__controls');
    expect(controls.textContent).toContain(`${DANA} never sees whispers. Whispers steer Claude, and your rules still apply.`);
    expect(controls.textContent).not.toContain('joined the chat');
    expect(controls.querySelector('.cd-take-over__action')).toBeNull();
    expect(controls.querySelectorAll('button:not([aria-label="Send whisper"])')).toHaveLength(0);
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over' }).elements()).toHaveLength(1);
  });

  it('takes_over_from_the_bar_and_hands_focus_to_the_owners_controls', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { generation } = chat.state;
    // The first take-over is answered when the test says, as a chat that moved on.
    let answer!: () => void;
    mockStore.inject({ route: 'takeover', status: 409, until: new Promise<void>((resolve) => { answer = resolve; }) });
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bar = await opened(screen, DANA);
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    const button = takeOver.element() as HTMLElement;

    // By keyboard: while it is sent, Take over spins and keeps focus, and the owner's controls wait.
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(takeOver).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('.cd-button__spinner')).not.toBeNull();
    expect(document.activeElement).toBe(button);
    expect(landed('.cd-take-over').getAttribute('aria-busy')).toBe('true');
    await userEvent.keyboard('{Enter}');

    // The chat moved on: the controls say so, and Take over can be pressed again.
    answer();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(CHANGED_WHILE_ACTING);
    await expect.element(takeOver).not.toHaveAttribute('aria-busy');
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }]);
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');

    // Taken over: the bar has no Take over, the owner's composer takes the whisper's place, and focus
    // moves from the button that went to the first line of the owner's controls.
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await expect.element(screen.getByText("You're in this chat", { exact: true })).toHaveFocus();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }, { generation }]);
    expect(bar.querySelector('button')).toBeNull();
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
    const handBack = screen.getByRole('button', { name: 'Hand back to Claude' });
    expect(landed('.cd-conversation__controls').contains(handBack.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });

    // Handed back by keyboard, Take over is back in the bar, and focus is on the line about whispers.
    (handBack.element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    expect(bar.contains(screen.getByRole('button', { name: 'Take over' }).element())).toBe(true);
    await expect.poll(() => document.activeElement?.textContent).toBe(`${DANA} never sees whispers. Whispers steer Claude, and your rules still apply.`);
  });

  it.each([[390, 844], [1440, 560]] as const)('shows_a_failed_bar_take_over_below_the_bar_without_moving_focus_at_%sx%s', async (width, height) => {
    const last = lengthen(named(DANA_LIVE, DANA));
    let answer!: () => void;
    mockStore.inject({ route: 'takeover', status: 409, until: new Promise<void>((resolve) => { answer = resolve; }) });
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const bar = await opened(screen, DANA);
    const pane = landed('.cd-conversations__open');
    await expect.element(screen.getByRole('log').getByText(last, { exact: true })).toBeInViewport({ ratio: 1 });
    expect(scrollerOf(screen.getByRole('log').element())).toBe(pane);
    pane.scrollTop = 0;
    await nextFrames();

    const takeOver = screen.getByRole('button', { name: 'Take over' });
    const button = takeOver.element() as HTMLElement;
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(takeOver).toHaveAttribute('aria-busy', 'true');
    expect(pane.scrollTop).toBe(0);
    answer();

    const alert = screen.getByRole('alert');
    await expect.element(alert).toHaveTextContent(CHANGED_WHILE_ACTING);
    await expect.element(takeOver).not.toHaveAttribute('aria-busy');
    await expect.poll(() => rect(alert.element()).bottom).toBeLessThanOrEqual(height);
    const box = rect(alert.element());
    expect(box.top).toBeGreaterThanOrEqual(rect(bar).bottom);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    await expect.element(takeOver).toBeInViewport({ ratio: 1 });
    expect(document.activeElement).toBe(button);
    expectNoWindowScroll();
  });

  it('shows_the_owners_controls_after_a_bar_click_without_button_focus_at_390x844', async () => {
    lengthen(named(DANA_LIVE, DANA));
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width: 390, height: 844 } });
    const bar = await opened(screen, DANA);
    const pane = landed('.cd-conversations__open');
    expect(scrollerOf(screen.getByRole('log').element())).toBe(pane);
    pane.scrollTop = 0;
    await nextFrames();
    const button = screen.getByRole('button', { name: 'Take over' }).element() as HTMLElement;
    button.blur();
    expect(document.activeElement).not.toBe(button);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await expect.poll(() => landed('.cd-take-over__first').textContent).toBe("You're in this chat");
    const first = landed('.cd-take-over__first');
    await expect.poll(() => landed('.cd-take-over').getAttribute('aria-busy')).toBeNull();
    await expect.poll(() => rect(first).bottom).toBeLessThanOrEqual(844);
    expect(rect(first).top).toBeGreaterThanOrEqual(rect(bar).bottom);
    // The whole foot comes into view, Hand back and the box the owner now writes in included.
    expect(rect(landed('.cd-conversation__controls')).bottom).toBeLessThanOrEqual(844);
    expect(document.activeElement).not.toBe(first);
    expectNoWindowScroll();
  });

  it('a_take_over_from_elsewhere_moves_no_focus', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    await opened(screen, DANA);
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    // The owner is reading the chat, on one of its receipts, when she takes it over from another tab.
    const receipt = screen.getByRole('log').getByRole('button', { name: /Open the full trace\.$/ }).first();
    (receipt.element() as HTMLElement).focus();
    const taken = await mockStore.dispatch('takeover', { params: { session_id: DANA_LIVE }, body: { generation: chat.state.generation } });
    expect('network' in taken ? 0 : taken.status).toBe(200);
    await expect.element(takeOver).not.toBeInTheDocument();
    // The bar says so; the list's row may say it too once the list reads the chat again, so look in the bar.
    await expect.poll(() => landed('.cd-conversation__bar').textContent).toContain("You're in this chat");
    // Take over went without focus on it, so focus stays where she was.
    expect(document.activeElement).toBe(receipt.element());
  });

  it('paused_keeps_both_answers_at_the_foot', async () => {
    const chat = named(DANA_LIVE, DANA);
    mockStore.world.pause(chat);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bar = await opened(screen, DANA);
    await expect.element(screen.getByText('Claude paused this chat after repeated blocked attempts.', { exact: true })).toBeVisible();
    // Resume Claude and Take over stay together under the paused line; the bar has neither.
    expect(bar.querySelector('button')).toBeNull();
    const controls = landed('.cd-conversation__controls');
    expect([...controls.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Resume Claude', 'Take over']);
    expect(rect(bar).height).toBe(56);
  });

  it('a_recorded_chat_has_no_take_over_and_keeps_its_note_under_the_bar', async () => {
    named(DANA_LIVE, DANA);
    const answer = await mockStore.dispatch('conversation', { params: { session_id: DANA_LIVE } });
    if ('network' in answer || answer.status !== 200) throw new Error("the mock reads Dana's chat");
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...(answer.body as OwnerTranscript), replayed: true } });
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bar = await opened(screen, DANA);
    expect(bar.querySelector('button')).toBeNull();
    expect(rect(bar).height).toBe(56);
    const note = landed('.cd-recorded-note');
    expect(bar.contains(note)).toBe(false);
    expect(rect(note).top - rect(bar).bottom).toBeCloseTo(8, 0);
  });

  // After Take over, the seeded held request's card fits whole in the transcript's own region, or
  // the open conversation scrolls as one under its bar: never a region too short for the card.
  it.each([
    [390, 780, true],
    [390, 860, false],
    [390, 890, false],
    [430, 858, false],
    [1024, 700, true],
    [1024, 740, false],
    [1440, 650, true],
    [1440, 740, false],
    [1440, 900, false],
  ] as const)('a_held_card_fits_after_take_over_at_%sx%s', async (width, height, wholeColumn) => {
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { viewport: { width, height } });
    const card = screen.getByRole('article', { name: `Held for you: ${rivera.decisions.held.reason_plain}`, exact: true });
    await expect.element(card).toBeInTheDocument();
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer')).toBeNull();
    const region = card.element().closest<HTMLElement>('.cd-conversation__scroll')!;
    const pane = region.closest<HTMLElement>('.cd-conversations__open')!;
    // Exactly one region moves the conversation. If the transcript has its own box, a whole held
    // card fits in it, with its focus ring, and the pane stays still around the bar and controls.
    const flat = getComputedStyle(region).overflowY === 'visible';
    expect(flat, `the column scrolls as one at ${width}x${height}`).toBe(wholeColumn);
    if (!flat) expect(region.clientHeight, `held card ${card.element().getBoundingClientRect().height}px in transcript ${region.clientHeight}px`).toBeGreaterThanOrEqual(card.element().getBoundingClientRect().height + 8);
    card.element().scrollIntoView({ block: 'start' });
    await expect.element(card).toBeInViewport({ ratio: 1 });
    if (flat) expect(region.scrollHeight).toBeLessThanOrEqual(region.clientHeight);
    else expect(pane.scrollHeight).toBeLessThanOrEqual(pane.clientHeight);
    expectNoWindowScroll();
    expectNoHorizontalScroll();
  });

  it.each(SIZES)('the_loading_shapes_draw_the_bar_where_it_lands_at_%sx%s', async (width, height) => {
    const chat = holdReads(conversationRead(SEEDED_HOLD));
    onTestFinished(chat.release);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { viewport: { width, height }, pollScale: 100 });
    const shapes = '.cd-conversation-pane .cd-conversation-skeleton';
    await vi.waitFor(() => expect(document.querySelector(`${shapes} .cd-conversation__bar`)).not.toBeNull());
    // The list lands first, so nothing beside the pane moves it while the bar is measured.
    await expect.poll(() => document.querySelector('.cd-conversations__region .cd-skeleton-screen__layer')).toBeNull();
    await expect.poll(() => document.querySelector('.cd-conversations__list .cd-conversation-item[aria-current="true"]')).not.toBeNull();
    await nextFrames();
    const shapeBar = document.querySelector<HTMLElement>(`${shapes} .cd-conversation__bar`)!;
    const shapeName = shapeBar.querySelector('[data-skeleton-anchor="conversation-name"]')!;
    const before = {
      bar: rect(shapeBar),
      name: rect(shapeName),
      latest: rect(shapeBar.querySelector('.cd-conversation__latest')!),
      style: getComputedStyle(shapeBar),
    };
    const look = [before.style.position, before.style.backgroundColor, before.style.borderBottom, before.style.paddingLeft];
    expect(shapeBar.querySelector('button'), 'the shapes draw no control').toBeNull();

    chat.release();
    const bar = await opened(screen, 'Visitor');
    const style = getComputedStyle(bar);
    expect([style.position, style.backgroundColor, style.borderBottom, style.paddingLeft], 'the shapes draw the bar\'s own look').toEqual(look);
    const real = rect(bar);
    for (const edge of ['top', 'left', 'width', 'height'] as const) {
      expect(Math.abs(real[edge] - before.bar[edge]), `bar ${edge}: shape ${before.bar[edge]}, page ${real[edge]}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
    const name = screen.getByRole('heading', { level: 2, name: 'Visitor' }).element();
    if (width >= 1024) {
      expect(Math.abs(rect(bar.querySelector('.cd-conversation__latest')!).left - before.latest.left), 'Latest lands on its shape').toBeLessThanOrEqual(1);
    }
    expect(Math.abs(rect(name).left - before.name.left), 'the name lands on its shape').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expect(Math.abs(middle(name) - (before.name.top + before.name.bottom) / 2), 'the name lands on its shape\'s line').toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    expectNoHorizontalScroll();
  });
});
