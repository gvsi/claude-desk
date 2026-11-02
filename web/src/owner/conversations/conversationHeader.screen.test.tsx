/**
 * The open conversation's head in a real browser against the mock API, at a laptop's size and a
 * phone's: who the chat is with and its latest line, then the lines that say where the chat came
 * from (the recorded-history note on a replayed chat, when and where it started, and where the
 * checks sit), closed by a hairline, so the transcript starts with the conversation itself. The
 * pane's loading shapes draw the same lines and hairline.
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import { ROUTES } from '../../api/routes.ts';
import type { ConversationSummary, OwnerTranscript } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { loadWebFonts } from '../../ds/test/fonts.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import type { SessionRecord } from '../../mocks/world.ts';
import { holdReads } from '../../test/holdReads.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics, tokenColor } from '../../test/screen.ts';
import { SKELETON_TOLERANCE_PX } from '../../test/skeleton.ts';
import { publicLink } from '../customerLink.ts';
import { TRANSCRIPT_NOTE } from './copy.ts';

beforeAll(loadWebFonts);

const DESK = `/app/${RIVERA.deskId}`;
const conversation = (sessionId: string) => `${DESK}/conversations/${sessionId}`;
const conversationRead = (sessionId: string) => ROUTES.conversation.path.replace('{session_id}', sessionId);
const DANA = rivera.people.dana.name;
/** Dana's live chat, and the fresh copy's held one (what Today's "Open the request" opens). */
const DANA_LIVE = 'ses-dana-web';
const SEEDED_HOLD = 'ses-visitor-web';
const RECORDED = 'Recorded history, replayed into your copy. It happened before you arrived.';
/** Where a web chat came from, as its start line ends. */
const WEB_CHAT_FROM = `, web chat from ${publicLink(RIVERA.slug).replace(/^https?:\/\//, '')}`;
const SIZES = [[1440, 900], [390, 844]] as const;

function session(sessionId: string): SessionRecord {
  const found = mockStore.world.sessions.get(sessionId);
  if (!found) throw new Error(`the mock has no chat ${sessionId}`);
  return found;
}

/** The page's own part, never its loading shape: the shapes use the same classes. */
function landed(selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => !el.closest('.cd-skeleton-screen__layer'));
  if (!found) throw new Error(`the page has ${selector}`);
  return found;
}

/** The open chat once it has landed: its head names `who`, and the pane's shapes have gone. */
async function opened(screen: RenderResult, who: string): Promise<HTMLElement> {
  await expect.element(screen.getByRole('heading', { level: 2, name: who, exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer')).toBeNull();
  return landed('.cd-conversation__head');
}

/** The head's lines under its name and latest line, in order. */
function linesOf(head: HTMLElement): HTMLElement[] {
  const about = head.querySelector<HTMLElement>(':scope > .cd-conversation__about');
  if (!about) throw new Error('the head has its lines');
  return [...about.children] as HTMLElement[];
}

/** Where the name's row ends: the foot of the name, its pills, "Simulated verification" and "Latest". */
function rowFoot(head: HTMLElement): number {
  const row = [...head.children].filter((el) => !el.classList.contains('cd-conversation__about'));
  return Math.max(...row.map((el) => el.getBoundingClientRect().bottom));
}

/**
 * The head's lines start 12 px under its name's row, each on its own line at the head's left edge,
 * in caption type and secondary ink; a 1 px hairline closes the head 16 px under the last of them,
 * across the conversation's column, centred in the pane.
 */
function expectHeadGeometry(head: HTMLElement, lines: HTMLElement[]): void {
  const box = head.getBoundingClientRect();
  expect(lines[0]!.getBoundingClientRect().top - rowFoot(head), 'the lines start 12 px under the name and Latest').toBeCloseTo(12, 0);
  lines.forEach((line, i) => {
    const rect = line.getBoundingClientRect();
    const style = getComputedStyle(line);
    expect(Math.abs(rect.left - box.left), `line ${i} starts at the head's left`).toBeLessThanOrEqual(0.5);
    expect(style.fontSize, `line ${i} is a caption`).toBe('12px');
    expect(style.lineHeight, `line ${i} is a caption`).toBe('17px');
    expect(style.color, `line ${i} is in secondary ink`).toBe(tokenColor('--text-secondary'));
    if (i > 0) expect(rect.top, `line ${i} is under the one before it`).toBeGreaterThanOrEqual(lines[i - 1]!.getBoundingClientRect().bottom - 0.5);
  });
  const style = getComputedStyle(head);
  expect([style.borderBottomStyle, style.borderBottomWidth, style.borderBottomColor]).toEqual(['solid', '1px', tokenColor('--line-hairline')]);
  for (const side of ['Top', 'Right', 'Left'] as const) expect(style.getPropertyValue(`border-${side.toLowerCase()}-style`), `no edge at the head's ${side}`).toBe('none');
  expect(box.bottom - 1 - lines.at(-1)!.getBoundingClientRect().bottom, 'the hairline is 16 px under the last line').toBeCloseTo(16, 0);
  const pane = landed('.cd-conversations__open');
  const paneBox = pane.getBoundingClientRect();
  const gutter = Number.parseFloat(getComputedStyle(pane).paddingLeft);
  expect(Math.abs(box.width - Math.min(768, paneBox.width - 2 * gutter)), 'the hairline runs across the conversation column').toBeLessThanOrEqual(1);
  expect(Math.abs((box.left - paneBox.left) - (paneBox.right - box.right)), 'the head is centred in the pane').toBeLessThanOrEqual(1);
  expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth);
}

/** The transcript has no header row of its own: it starts with the chat's first message. */
function expectTranscriptStartsWithTheChat(screen: RenderResult, first: string): void {
  const log = screen.getByRole('log').element();
  expect(log.querySelector('.cd-transcript-header')).toBeNull();
  expect(log.textContent).not.toContain(TRANSCRIPT_NOTE);
  expect(log.textContent).not.toContain('web chat from');
  const row = log.firstElementChild;
  expect(row?.classList.contains('cd-transcript-row')).toBe(true);
  expect(row?.querySelector('.cd-visitor-message')?.textContent).toContain(first);
}

describe('the open conversation head', () => {
  it.each(SIZES)('holds_the_name_latest_then_where_the_chat_started_and_the_checks_note_at_%sx%s', async (width, height) => {
    session(DANA_LIVE).displayName = DANA;
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const head = await opened(screen, DANA);
    const name = screen.getByRole('heading', { level: 2, name: DANA }).element();
    const latest = screen.getByText('Latest: Visit booked', { exact: true }).element();
    const lines = linesOf(head);

    // In order: the name and its pill, then Latest, then the lines, all in the head.
    expect(lines.map((line) => line.textContent)).toEqual([expect.stringMatching(/^\S.* at .+, web chat from /), TRANSCRIPT_NOTE]);
    expect(lines[0]!.textContent!.endsWith(WEB_CHAT_FROM), 'the start line ends with where the chat came from').toBe(true);
    const order = [name, head.querySelector('.cd-pill'), latest, ...lines];
    expect(order.every((el) => el !== null && head.contains(el))).toBe(true);
    order.slice(1).forEach((el, i) => {
      expect(order[i]!.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${i + 1} follows part ${i}`).toBeTruthy();
    });
    expect(latest.getBoundingClientRect().top).toBeGreaterThanOrEqual(name.getBoundingClientRect().top - 1);
    expect(head.querySelector('.cd-recorded-note'), 'a live chat has no recorded-history note').toBeNull();
    expect(document.querySelector('.cd-recorded-note')).toBeNull();
    expectHeadGeometry(head, lines);

    const [first] = rivera.conversations.danaLive.turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []));
    expectTranscriptStartsWithTheChat(screen, first ?? '');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(SIZES)('a_replayed_chat_heads_its_lines_with_the_recorded_note_at_%sx%s', async (width, height) => {
    session(DANA_LIVE).displayName = DANA;
    const answer = await mockStore.dispatch('conversation', { params: { session_id: DANA_LIVE } });
    if ('network' in answer || answer.status !== 200) throw new Error("the mock reads Dana's chat");
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...(answer.body as OwnerTranscript), replayed: true } });
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const head = await opened(screen, DANA);
    const lines = linesOf(head);

    expect(lines.map((line) => line.textContent)).toEqual([RECORDED, expect.stringContaining(WEB_CHAT_FROM), TRANSCRIPT_NOTE]);
    expect(lines[0]!.classList.contains('cd-recorded-note')).toBe(true);
    expect(lines[0]!.querySelector('svg'), 'the note keeps its history icon').not.toBeNull();
    // The note is in the head, and nowhere else in the pane.
    expect(document.querySelectorAll('.cd-conversation .cd-recorded-note')).toHaveLength(1);
    const latest = screen.getByText('Latest: Visit booked', { exact: true }).element();
    expect(latest.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectHeadGeometry(head, lines);

    const [first] = rivera.conversations.danaLive.turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []));
    expectTranscriptStartsWithTheChat(screen, first ?? '');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(SIZES)('a_chat_with_no_messages_says_so_in_the_head_at_%sx%s', async (width, height) => {
    const desk = mockStore.world.desk(RIVERA.deskId);
    if (!desk) throw new Error("the copy has Turner's main Desk");
    const quiet = mockStore.world.addSession(desk);
    const { screen } = await renderRoute(conversation(quiet.state.session_id), { viewport: { width, height } });
    const head = await opened(screen, 'Visitor');
    const lines = linesOf(head);

    expect(lines.map((line) => line.textContent)).toEqual(['No messages yet.', TRANSCRIPT_NOTE]);
    // Nothing has happened yet, so there is no Latest: the lines start 12 px under the name's row.
    expect(head.querySelector('.cd-conversation__latest')).toBeNull();
    expectHeadGeometry(head, lines);
    const log = screen.getByRole('log').element();
    expect(log.querySelector('.cd-transcript-row')).toBeNull();
    expect(log.textContent).toBe('');
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(SIZES.flatMap(([width, height]) => [
    [width, height, false] as const,
    [width, height, true] as const,
  ]))('the_loading_shapes_draw_the_same_lines_and_hairline_at_%sx%s_recorded_%s', async (width, height, recorded) => {
    if (recorded) {
      const list = await mockStore.dispatch('conversations', { params: { desk_id: RIVERA.deskId } });
      const read = await mockStore.dispatch('conversation', { params: { session_id: SEEDED_HOLD } });
      if ('network' in list || list.status !== 200 || 'network' in read || read.status !== 200) throw new Error('the mock reads the held chat and its summary');
      mockStore.inject({ route: 'conversations', status: 200, times: 10_000, body: (list.body as ConversationSummary[]).map((s) => s.session_id === SEEDED_HOLD ? { ...s, replayed: true } : s) });
      mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...(read.body as OwnerTranscript), replayed: true } });
    }
    const chat = holdReads(conversationRead(SEEDED_HOLD));
    onTestFinished(chat.release);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { viewport: { width, height }, pollScale: 100 });
    const shape = '.cd-conversation-pane .cd-conversation-skeleton';
    await vi.waitFor(() => expect(document.querySelector(`${shape} .cd-conversation__about`)).not.toBeNull());
    // The list read supplies replayed before the held detail read is released.
    await expect.poll(() => document.querySelector('.cd-conversations__list .cd-conversation-item[aria-current="true"]')).not.toBeNull();
    await expect.poll(() => document.querySelector('.cd-conversations__region .cd-skeleton-screen__layer')).toBeNull();
    const shapeHead = document.querySelector<HTMLElement>(`${shape} .cd-conversation__head`)!;
    const shapeLines = [...shapeHead.querySelectorAll<HTMLElement>(':scope > .cd-conversation__about > *')];
    // Each line's shape is as many caption lines as its words take here, once the fonts have loaded.
    await expect.poll(() => shapeLines.map((line) => line.getBoundingClientRect().height)).toEqual(
      shapeLines.map((line) => line.querySelectorAll('.cd-skeleton-line--caption').length * 17),
    );
    const before = {
      head: shapeHead.getBoundingClientRect(),
      lines: shapeLines.map((line) => line.getBoundingClientRect()),
      hairline: getComputedStyle(shapeHead).borderBottom,
    };
    expect(before.lines).toHaveLength(recorded ? 3 : 2);
    expect(document.querySelector(`${shape} .cd-conversation__controls`) === null).toBe(recorded);
    if (recorded) {
      const note = shapeLines[0]!;
      const icon = note.querySelector<HTMLElement>('.cd-skeleton--block')!;
      const text = note.querySelector<HTMLElement>('.cd-recorded-note__text')!;
      expect(icon, 'the recorded note reserves its icon').not.toBeNull();
      expect(icon.getBoundingClientRect().width).toBe(14);
      expect(icon.getBoundingClientRect().height).toBe(14);
      expect(text.getBoundingClientRect().left - icon.getBoundingClientRect().right).toBe(6);
    }

    chat.release();
    const head = await opened(screen, 'Visitor');
    const lines = linesOf(head);
    expect(lines.map((line) => line.textContent)).toEqual([...(recorded ? [RECORDED] : []), expect.stringContaining(WEB_CHAT_FROM), TRANSCRIPT_NOTE]);
    expect(head.closest('.cd-conversation')!.querySelector('.cd-conversation__controls') === null).toBe(recorded);
    const real = head.getBoundingClientRect();
    expect(getComputedStyle(head).borderBottom, 'the shapes draw the head\'s hairline').toBe(before.hairline);
    for (const edge of ['top', 'left', 'width', 'bottom'] as const) {
      expect(Math.abs(real[edge] - before.head[edge]), `head ${edge}: shape ${before.head[edge]}, page ${real[edge]}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
    }
    lines.forEach((line, i) => {
      const rect = line.getBoundingClientRect();
      for (const edge of ['top', 'left', 'height'] as const) {
        expect(Math.abs(rect[edge] - before.lines[i]![edge]), `line ${i} ${edge}: shape ${before.lines[i]![edge]}, page ${rect[edge]}`).toBeLessThanOrEqual(SKELETON_TOLERANCE_PX);
      }
    });
    expectNoHorizontalScroll();
  });
});
