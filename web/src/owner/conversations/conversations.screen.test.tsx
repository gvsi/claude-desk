/**
 * Conversations in a real browser against the mock API: the list beside the open conversation,
 * receipts under each message that open the full trace, the owner's receipts in the owner's
 * words, held requests answered in place, take-over with the owner's own words, whispers, the
 * typing both ways, and recorded history.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision, StatusEvent } from '../../api/contracts.ts';
import type { Attempt, ConversationSummary, NeedsYouItem, OwnerTranscript } from '../../api/views.ts';
import { ROUTES } from '../../api/routes.ts';
import { proseBlock, rivera } from '../../ds/fixtures/index.ts';
import { typingPingMs } from '../../app/poll.ts';
import { formatClock } from '../../lib/format.ts';
import { AFTER_VERIFY, DECISIONS, DEMO_CODE, SCRIPT, VISITOR_PLAIN, matchRule, turnEnd, writing } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { MINUTE, type SessionRecord } from '../../mocks/world.ts';
import { expectOwnerBoard } from '../../test/boards.ts';
import { expectSettledInItsSlot, watchAnswerLanding } from '../../test/answerLanding.ts';
import { watchLandings } from '../../test/landings.ts';
import { expectRevealed, watchReveal, watchRevealing } from '../../test/reveal.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { holdReads } from '../../test/holdReads.ts';
import { expectNoHorizontalScroll, expectNoWindowScroll, expectScreenBasics, focusIsOn, tokenColor } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const LIST = `${DESK}/conversations`;
const LA = 'America/Los_Angeles';
const OWNER = rivera.business.ownerName;
const DANA = rivera.people.dana.name;
/** What the seeded hold and Dana's held refund asked, as the kernel's owner line says it. */
const SEEDED_REASON = rivera.decisions.held.reason_plain;
const REFUND_REASON = rivera.heldRefund.reason_plain;

/** The handoff card's AI-written line, before its note (owner decision, 2026-11-01). */
const NOTE = "Claude's note on what the Desk stopped";
/** The seeded chats: Dana's live one, and the visitor whose 15% discount is held. */
const DANA_LIVE = 'ses-dana-web';
const SEEDED_HOLD = 'ses-visitor-web';

const conversation = (sessionId: string) => `${LIST}/${sessionId}`;

const DRAFTED = 'Your answer also drafted a rule. Review it before it applies.';

/** A held card's slot in the conversation: the card and what follows it there. */
function slotOf(card: Element): Element {
  const slot = card.closest('.cd-conversation__held');
  if (!slot) throw new Error('the held card has its slot in the conversation');
  return slot;
}

/** The owner's line for a read the server failed. */
const UNAVAILABLE = 'Something went wrong on our side. Try again in a moment.';
/** The owner's line for an answer to a request that changed while they were looking. */
const CHANGED = 'This changed while you were looking. Reload to see where it stands.';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Waits for `key` to be read `n` more times than now. */
async function readsMore(key: string, n: number): Promise<void> {
  const from = requests(key).length;
  await expect.poll(() => requests(key).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + n);
}

function session(sessionId: string): SessionRecord {
  const found = mockStore.world.sessions.get(sessionId);
  if (!found) throw new Error(`the mock has no chat ${sessionId}`);
  return found;
}

/** Names a seeded chat, as a visitor who gave their name would have it. */
function named(sessionId: string, name: string): SessionRecord {
  const chat = session(sessionId);
  chat.displayName = name;
  return chat;
}

function log(screen: RenderResult) {
  return screen.getByRole('log');
}

/**
 * The scroll region around the conversation's transcript. When the first read is slow enough for
 * the pane's skeleton to show, its shapes fade over the conversation for a moment after it lands,
 * and their own region of this class comes first in the page until they go; so take the one that
 * holds the log.
 */
function transcriptRegion(screen: RenderResult): Element {
  const region = log(screen).element().closest('.cd-conversation__scroll');
  if (!region) throw new Error('the transcript scrolls in its own region');
  return region;
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

/** Makes the list longer than the window: `count` more chats, each with a visitor's message. Returns how many. */
function moreChats(count = 20): number {
  const desk = mockStore.world.desk(RIVERA.deskId);
  if (!desk) throw new Error("the copy has Turner's main Desk");
  for (let i = 1; i <= count; i += 1) mockStore.world.visitorText(mockStore.world.addSession(desk), `Hello, question ${i}.`);
  return count;
}

/** The element whose scrolling moves `el`: the nearest that scrolls, `el` included, or the page. */
function scrollerOf(el: Element): Element {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** A receipt in the conversation, by the words it shows. */
function receipt(screen: RenderResult, plain: string) {
  return log(screen).getByRole('button', { name: `${plain} Open the full trace.`, exact: true });
}

/** The reads of one decision. */
const decisionReads = (decisionId: string) => requests('decision').filter((r) => r.path.endsWith(`/${encodeURIComponent(decisionId)}`));

/** The signed status event for `decision` as it stands, as the API streams it. */
function statusOf(type: StatusEvent['type'], decision: Decision): StatusEvent {
  const { decision_id, state, visitor_plain, ledger_seq, signature } = decision;
  return { type, decision_id, state, visitor_plain, ledger_seq, signature } as StatusEvent;
}

/**
 * Dana's verified chat, with three decisions: her refund, held and then allowed (a held receipt,
 * then an executed one); a quote Claude ran on its own (one executed receipt, sent after it ran);
 * and a booking allowed but refused when it came to run, because the rules changed in between (one
 * `refused_at_execution` receipt). Each has a reply with its check under it.
 */
function danasChatWithThreeDecisions() {
  const world = mockStore.world;
  const refund = world.addHeldRefund();
  const chat = session(refund.session_id);
  let quote: Decision | null = null;
  let booking: Decision | null = null;
  world.replay(chat, world.now() - MINUTE / 2, [
    {
      text: 'How much is a drain clearing?',
      steps: [
        (ctx) => {
          quote = ctx.decide(DECISIONS.quote);
          return ctx.status('receipt', quote);
        },
        writing,
        (ctx) => ctx.reply([rivera.blocks.quote[ctx.language]]),
      ],
    },
    {
      text: 'Book the first one.',
      steps: [
        (ctx) => {
          const allowed = ctx.decide(DECISIONS.book);
          const record = world.decisions.get(allowed.decision_id);
          if (!record) throw new Error('the booking was recorded');
          record.decision = { ...allowed, state: 'refused_at_execution', visitor_plain: VISITOR_PLAIN.en.refused_at_execution };
          booking = record.decision;
          return ctx.status('receipt', booking);
        },
        writing,
        (ctx) => ctx.reply([rivera.blocks.handoff[ctx.language]]),
      ],
    },
  ], 10_000);
  // Mike allowed the refund: it ran, and its outcome came after the hold.
  const record = world.decisions.get(refund.decision_id);
  if (!record || quote === null || booking === null) throw new Error("Dana's chat has its three decisions");
  const refunded = world.answer(record, 'allow_once');
  world.emit(chat, statusOf('resolved', refunded));
  return { chat, refund, refunded, quote: quote as Decision, booking: booking as Decision };
}

/** Dana asks `question` in her chat, and Claude answers it with a quote: each event at once. */
function priceTurn(chat: SessionRecord, question: string): void {
  const world = mockStore.world;
  const price = SCRIPT.find((rule) => rule.name === 'price');
  if (!price) throw new Error('the script has its price row');
  world.visitorText(chat, question);
  const turn = world.context(chat, 'en', question);
  for (const step of [...price.steps, turnEnd]) world.emit(chat, step(turn));
}

/** The owner's reads of the Desk's conversations, of one chat and of Needs you, as the mock answers them now. */
async function served<T>(key: 'conversations' | 'conversation' | 'needsYou', params: Record<string, string>): Promise<T> {
  const answer = await mockStore.dispatch(key, { params });
  if ('network' in answer || answer.status !== 200) throw new Error(`the mock reads ${key}`);
  return answer.body as T;
}

/**
 * Alex Kim's assistant books the earliest visit, as the agents page sends it from a visitor's chat:
 * the agent's chat once its run is done.
 */
async function bookTheEarliestVisit(task = 'book_visit'): Promise<string> {
  const slug = RIVERA.slug;
  const opened = await mockStore.dispatch('openSession', { params: { slug } });
  if ('network' in opened || opened.status !== 200) throw new Error("the visitor's chat opens");
  const sent = await mockStore.dispatch('sendAgent', { params: { slug }, body: { task, idempotency_key: task } });
  if ('network' in sent || sent.status !== 202) throw new Error('the agent is sent');
  const runId = (sent.body as { run_id: string }).run_id;
  const runState = async () => {
    const run = await mockStore.dispatch('agentRun', { params: { slug, run_id: runId } });
    return 'network' in run ? null : (run.body as { state: string }).state;
  };
  await expect.poll(runState, { timeout: 5_000 }).toBe('done');
  const agent = [...mockStore.world.sessions.values()].filter((chat) => chat.state.kind === 'agent').at(-1);
  if (!agent) throw new Error('the run has its agent chat');
  return agent.state.session_id;
}

/** A held request's card, by what was asked. */
function heldCard(screen: RenderResult, reason: string) {
  return screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conversations', () => {
  it.each([[1512, 982], [390, 844]])('day_rules_and_visitor_previews_fit_at_%sx%s', async (width, height) => {
    // The rows below are a day apart from a fixed afternoon on the Desk's clock, so the list's day
    // groups never depend on when the test runs (near midnight, or on a 25-hour day as clocks go back).
    // Only Date is faked: the page's timers and polling stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T20:00:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const summaries = await served<ConversationSummary[]>('conversations', { desk_id: RIVERA.deskId });
    const base = summaries[0]!;
    const longName = DANA.repeat(16);
    const longPreview = '<b>Can someone come today?</b> '.repeat(12);
    const now = Date.now();
    const rows: ConversationSummary[] = [
      { ...base, session_id: 'preview-status', display_name: longName, latest_visitor_text: longPreview, outcome_counts: { held: 1 }, replayed: true, last_activity: new Date(now).toISOString() },
      { ...base, session_id: 'preview-only', display_name: null, verified: false, latest_visitor_text: 'Tuesday at 2 works.', outcome_counts: {}, last_activity: new Date(now - 1000).toISOString() },
      { ...base, session_id: 'no-message', latest_visitor_text: null, last_activity: new Date(now - 2000).toISOString() },
      { ...base, session_id: 'agent', kind: 'agent', latest_visitor_text: longPreview, last_activity: new Date(now - 3000).toISOString() },
      { ...base, session_id: 'owner-preview', owner_preview: true, latest_visitor_text: null, last_activity: new Date(now - 86_400_000).toISOString() },
    ];
    mockStore.inject({ route: 'conversations', status: 200, times: 10_000, body: rows });
    const { screen } = await renderRoute(LIST, { viewport: { width, height }, pollScale: 100 });
    await expect.element(screen.getByRole('link', { name: new RegExp(`^${DANA}`) }).first()).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
    const links = rows.map(row => document.querySelector<HTMLAnchorElement>(`.cd-conversations__items a[href="${conversation(row.session_id)}"]`)!);
    const preview = links[0]!.querySelector<HTMLElement>('.cd-conversation-item__quote');
    expect(preview, 'visitor preview remains above status and Recorded').not.toBeNull();
    expect(preview!.textContent).toBe(`“${longPreview}”`);
    expect(preview!.querySelector('b')).toBeNull();
    expect(preview!.dataset.copy).toBe('user');
    expect(getComputedStyle(preview!).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(preview!).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(preview!).fontSize).toBe('13px');
    expect(getComputedStyle(preview!).color).toBe(tokenColor('--text-secondary'));
    expect(preview!.scrollWidth).toBeGreaterThan(preview!.clientWidth);
    expect(preview!.getBoundingClientRect().height).toBe(18);
    const status = links[0]!.querySelector('.cd-conversation-item__status')!;
    expect(status.textContent).toContain('Needs you');
    expect(status.textContent).toContain('Recorded');
    expect(status.getBoundingClientRect().top).toBeGreaterThanOrEqual(preview!.getBoundingClientRect().bottom);
    expect(links[1]!.querySelector('.cd-conversation-item__quote')?.textContent).toBe('“Tuesday at 2 works.”');
    for (const link of links.slice(2)) expect(link.querySelector('.cd-conversation-item__quote')).toBeNull();
    const right = links[0]!.querySelector('.cd-conversation-item__time')!.getBoundingClientRect().right;
    for (const link of links) {
      expect(link.querySelector('.cd-conversation-item__time')!.getBoundingClientRect().right).toBe(right);
      expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
    }
    const groups = [...document.querySelectorAll<HTMLElement>('.cd-conversations__under > .cd-conversations__group')];
    expect(groups).toHaveLength(2);
    expect(getComputedStyle(groups[1]!).marginTop).toBe('8px');
    expect(groups[1]!.getBoundingClientRect().top - groups[0]!.getBoundingClientRect().bottom).toBe(24);
    for (const group of groups) {
      const day = group.querySelector<HTMLElement>('.cd-conversations__day')!;
      const style = getComputedStyle(day);
      const rule = getComputedStyle(day, '::after');
      expect(style.fontSize).toBe('12px');
      expect(style.fontWeight).toBe('520');
      expect(style.color).toBe(tokenColor('--text-tertiary'));
      expect(style.gap).toBe('8px');
      expect(style.paddingLeft).toBe('8px');
      expect(style.paddingRight).toBe('8px');
      expect(rule.content).toBe('""');
      expect(rule.height).toBe('1px');
      expect(rule.backgroundColor).toBe(tokenColor('--line-hairline'));
      expect(Number.parseFloat(rule.width)).toBeGreaterThan(40);
      expect(day.getBoundingClientRect().right).toBe(group.getBoundingClientRect().right);
      const ruleRight = day.firstElementChild!.getBoundingClientRect().right + 8 + Number.parseFloat(rule.width);
      expect(Math.abs(ruleRight - group.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    }
    expectNoHorizontalScroll();
  });

  it.each([[1440, 900], [390, 844]])('agent_rows_say_what_the_agent_did_at_%sx%s', async (width, height) => {
    const summaries = await served<ConversationSummary[]>('conversations', { desk_id: RIVERA.deskId });
    const base = summaries[0]!;
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    const facts = { latest_outcome: null, latest_outcome_starts_at: null, latest_outcome_cents: null, latest_outcome_cause: null };
    const agent: ConversationSummary = {
      ...base, ...facts, kind: 'agent', display_name: "Alex Kim's assistant", verified: false, mode: 'ai', owner_preview: false,
      latest_visitor_text: 'These are the agent’s own words.', outcome_counts: {}, replayed: false,
    };
    const rows: ConversationSummary[] = [
      { ...agent, session_id: 'agent-booked', last_activity: at(0), latest_outcome: 'visit_booked', latest_outcome_starts_at: '2026-11-02T18:00:00Z' },
      { ...agent, session_id: 'agent-paid', last_activity: at(1000), latest_outcome: 'deposit_paid', latest_outcome_cents: 2000 },
      { ...agent, session_id: 'agent-limit', last_activity: at(2000), latest_outcome: 'turned_down', latest_outcome_cause: 'agent_limit' },
      { ...agent, session_id: 'agent-refused', last_activity: at(3000), latest_outcome: 'turned_down', latest_outcome_cause: 'owner_rule' },
      { ...agent, session_id: 'agent-quiet', last_activity: at(4000) },
      { ...agent, session_id: 'agent-booking-missing', last_activity: at(4100), latest_outcome: 'visit_booked' },
      { ...agent, session_id: 'agent-payment-missing', last_activity: at(4200), latest_outcome: 'deposit_paid' },
      { ...base, ...facts, session_id: 'visitor', kind: 'visitor', display_name: null, verified: false, owner_preview: false, replayed: false,
        latest_visitor_text: 'Tuesday at 2 works.', outcome_counts: {}, last_activity: at(5000) },
    ];
    mockStore.inject({ route: 'conversations', status: 200, times: 10_000, body: rows });
    const { screen } = await renderRoute(LIST, { viewport: { width, height }, pollScale: 100 });
    await expect.element(screen.getByRole('link', { name: /^Alex Kim's assistant/ }).first()).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
    const row = (id: string) => document.querySelector<HTMLAnchorElement>(`.cd-conversations__items a[href="${conversation(id)}"]`)!;
    const lineOf = (id: string) => row(id).querySelector<HTMLElement>('.cd-conversation-item__quote');

    // What each agent did, from its outcome and the facts behind it, on the business's clock.
    expect(lineOf('agent-booked')?.textContent).toBe('Booked Mon, Nov 2, 10:00 am.');
    const bookedLine = lineOf('agent-booked')!;
    expect(bookedLine.scrollWidth).toBeLessThanOrEqual(bookedLine.clientWidth);
    expect(lineOf('agent-paid')?.textContent).toBe('Paid $20 up front.');
    expect(lineOf('agent-limit')?.textContent).toBe('Asked to pay more than its limit, and was turned down.');
    expect(lineOf('agent-refused')?.textContent).toBe('A request was turned down.');
    // An agent without an outcome or its required fact has no line, even if it wrote a message.
    for (const id of ['agent-quiet', 'agent-booking-missing', 'agent-payment-missing']) {
      expect(lineOf(id)).toBeNull();
    }

    // The app's words, unquoted, drawn where and as a visitor's quote is, above the status line.
    const visitor = lineOf('visitor')!;
    expect(visitor.textContent).toBe('“Tuesday at 2 works.”');
    expect(visitor.dataset.copy).toBe('user');
    for (const id of ['agent-booked', 'agent-paid', 'agent-limit', 'agent-refused']) {
      const line = lineOf(id)!;
      await expect.element(line).toBeVisible();
      expect(line.dataset.copy).toBeUndefined();
      expect(line.className).toBe(visitor.className);
      const style = getComputedStyle(line);
      expect(style.fontSize).toBe('13px');
      expect(style.fontStyle).toBe('normal');
      expect(style.color).toBe(tokenColor('--text-secondary'));
      expect(style.whiteSpace).toBe('nowrap');
      expect(style.textOverflow).toBe('ellipsis');
      expect(line.getBoundingClientRect().height).toBe(18);
      expect(line.getBoundingClientRect().left).toBe(visitor.getBoundingClientRect().left);
      const status = row(id).querySelector('.cd-conversation-item__status')!;
      expect(status.textContent).toContain('Agent');
      expect(status.getBoundingClientRect().top).toBeGreaterThanOrEqual(line.getBoundingClientRect().bottom);
      expect(row(id).scrollWidth).toBeLessThanOrEqual(row(id).clientWidth);
    }
    expectNoHorizontalScroll();
  });

  it('agent_rows_from_its_runs_say_what_it_did', async () => {
    const booked = await bookTheEarliestVisit();
    const paid = await bookTheEarliestVisit('quote_and_deposit');
    const refused = await bookTheEarliestVisit('push_the_limit');
    const { screen } = await renderRoute(LIST);
    const lineOf = (id: string) => document.querySelector(`a[href="${conversation(id)}"] .cd-conversation-item__quote`)?.textContent;
    await expect.poll(() => lineOf(booked)).toBe('Booked Tue, Nov 3, 2:00 pm.');
    expect(lineOf(paid)).toBe('Paid $20 up front.');
    expect(lineOf(refused)).toBe('Asked to pay more than its limit, and was turned down.');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each([[1440, 900], [1800, 1009], [390, 844]])('open_conversation_centres_its_reading_column_at_%sx%s', async (width, height) => {
    const { screen } = await renderRoute(conversation(DANA_LIVE), { viewport: { width, height } });
    const whisperBox = screen.getByRole('textbox', { name: 'Whisper to Claude' });
    await expect.element(whisperBox).toBeVisible();
    const chat = log(screen);
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(chat.getByText(first ?? '', { exact: true })).toBeVisible();
    await expect.poll(() => document.querySelector('.cd-skeleton-screen__layer')).toBeNull();
    const pane = document.querySelector<HTMLElement>('.cd-conversations__open');
    if (!pane) throw new Error('the conversation opens in its pane');
    const style = getComputedStyle(pane);
    const paneRect = pane.getBoundingClientRect();
    const columnWidth = Math.min(768, paneRect.width - 2 * Number.parseFloat(style.paddingLeft));
    const inner = {
      left: paneRect.left + (paneRect.width - columnWidth) / 2,
      right: paneRect.right - (paneRect.width - columnWidth) / 2,
    };
    const fills = (el: Element, name: string) => {
      const rect = el.getBoundingClientRect();
      expect(Math.abs(rect.width - columnWidth), `${name} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(rect.left - inner.left), `${name} left`).toBeLessThanOrEqual(1);
      expect(Math.abs(rect.right - inner.right), `${name} right`).toBeLessThanOrEqual(1);
      expect(Math.abs((rect.left - paneRect.left) - (paneRect.right - rect.right)), `${name} centred`).toBeLessThanOrEqual(1);
    };
    const transcript = chat.element();
    for (const selector of ['.cd-conversation__head', '.cd-transcript-row', '.cd-conversation__controls']) {
      fills(document.querySelector(selector)!, selector);
    }
    fills(transcript, 'transcript');
    fills(whisperBox.element().closest('.cd-composer') ?? whisperBox.element(), 'whisper box');
    const scroll = transcriptRegion(screen).getBoundingClientRect();
    expect(Math.abs(scroll.right - paneRect.right), 'scroll bar stays at the pane edge').toBeLessThanOrEqual(1);
    expect(inner.left - scroll.left, 'focus rings have side clearance').toBeGreaterThanOrEqual(16);
    // Her bubble ends at the transcript's right edge, at most 85% of its width.
    const bubble = chat.getByText(first ?? '', { exact: true }).element().getBoundingClientRect();
    expect(Math.abs(bubble.right - transcript.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    expect(bubble.width).toBeLessThanOrEqual(transcript.getBoundingClientRect().width * 0.85 + 1);
    // Claude's words keep to the reading width (640 px), from the transcript's left, so their lines
    // stay around 80 characters inside the wider conversation column.
    const prose = [...transcript.querySelectorAll<HTMLElement>('.cd-claude-message__prose')];
    expect(prose.length).toBeGreaterThan(0);
    if (width >= 1024) expect(prose.some((p) => p.getBoundingClientRect().width > 600), 'a reply long enough to reach the cap').toBe(true);
    for (const p of prose) {
      expect(p.getBoundingClientRect().width).toBeLessThanOrEqual(640);
      expect(Math.abs(p.getBoundingClientRect().left - transcript.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
    }
    // Take over stays at the left, under the note about whispers, with its own line under it.
    const takeOver = screen.getByRole('button', { name: 'Take over' }).element().getBoundingClientRect();
    const note = document.querySelector('.cd-conversation__controls .cd-take-over__lead')!.getBoundingClientRect();
    expect(Math.abs(takeOver.left - transcript.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
    expect(takeOver.top).toBeGreaterThanOrEqual(note.bottom);
    const line = document.querySelector('.cd-conversation__controls .cd-take-over__action .cd-take-over__line');
    if (line) expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(takeOver.bottom);
    expectNoHorizontalScroll();
  });

  it.each(['scroll', 'focus'] as const)('a_first_callback_on_a_later_poll_leaves_her_%s_in_place', async (place) => {
    const chat = named(DANA_LIVE, DANA);
    const last = lengthen(chat);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    await expect.element(log(screen).getByText(last, { exact: true })).toBeInTheDocument();
    const region = transcriptRegion(screen);
    // The long chat overflows its region first: until it has, the region's end reads as its latest
    // and a place 300 px down can't be set.
    await expect.poll(() => region.scrollHeight - region.clientHeight).toBeGreaterThan(300);
    await expect.poll(() => region.scrollHeight - region.clientHeight - region.scrollTop).toBeLessThanOrEqual(1);
    if (place === 'scroll') {
      region.scrollTop = 300;
      await expect.poll(() => region.scrollTop).toBe(300);
    } else {
      const trace = log(screen).element().querySelector<HTMLButtonElement>('button')!;
      trace.focus({ preventScroll: true });
      expect(document.activeElement).toBe(trace);
    }
    const focused = document.activeElement;
    const placeAt = region.scrollTop;
    mockStore.world.context(chat, 'en', '').openHandoff({ reason: 'Call Dana later', callbackWindow: null, lead: DANA });
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeInTheDocument();
    await readsMore('needsYou', 2);
    expect(region.scrollTop).toBeGreaterThan(0);
    expect(card.element().getBoundingClientRect().bottom).toBeLessThan(region.getBoundingClientRect().top);
    expect(region.scrollTop).toBe(placeAt);
    if (place === 'focus') expect(document.activeElement).toBe(focused);
  });

  it.each(['immediate', 'held'] as const)('late_callback_reveals_its_card_then_scrolling_to_the_end_follows_arrivals_after_%s_first_read', async (firstRead) => {
    // The chat opens once Needs you's first read is in, since it draws the requests held in it, so a
    // callback comes late on a later read: she is still where the chat opened, at its latest.
    const chat = named(DANA_LIVE, DANA);
    const last = lengthen(chat);
    const read = firstRead === 'held' ? holdReads(ROUTES.conversation.path.replace('{session_id}', DANA_LIVE)) : null;
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    if (read) {
      // Force the slow opening: the skeleton will fade over the real transcript after release.
      await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull();
      read.release();
    }
    await expect.element(log(screen).getByText(last, { exact: true })).toBeInTheDocument();
    const region = transcriptRegion(screen);
    const endGap = () => region.scrollHeight - region.clientHeight - region.scrollTop;
    // As above, the long chat overflows its region first; until then its end reads as its latest at 0.
    await expect.poll(() => region.scrollHeight - region.clientHeight).toBeGreaterThan(300);
    await expect.poll(endGap).toBeLessThanOrEqual(1);
    expect(region.scrollTop).toBeGreaterThan(0);
    mockStore.world.context(chat, 'en', '').openHandoff({ reason: 'Please call Dana', callbackWindow: null, lead: DANA });
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeInTheDocument();
    await expect.poll(() => card.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(region.getBoundingClientRect().top);
    expect(card.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(region.getBoundingClientRect().bottom);
    expect(region.scrollTop).toBe(0);
    // Following resumes on the scroll event, not on assigning scrollTop. Wait for that event
    // before a poll can append the next message, even though the handoff is still open.
    await new Promise<void>((resolve) => {
      region.addEventListener('scroll', () => resolve(), { once: true });
      region.scrollTop = region.scrollHeight;
    });
    await expect.poll(endGap).toBeLessThanOrEqual(1);
    mockStore.world.visitorText(chat, 'Please use the side gate.');
    await expect.element(log(screen).getByText('Please use the side gate.', { exact: true })).toBeInTheDocument();
    await expect.poll(endGap).toBeLessThanOrEqual(1);
    // A second card on a later poll doesn't pull her away from earlier words.
    region.scrollTop = 300;
    await expect.poll(() => region.scrollTop).toBe(300);
    const place = region.scrollTop;
    mockStore.world.context(chat, 'en', '').openHandoff({ reason: 'A second call-back', callbackWindow: null, lead: DANA });
    await expect.element(screen.getByText('A second call-back', { exact: true })).toBeInTheDocument();
    await readsMore('needsYou', 2);
    expect(region.scrollTop).toBe(place);
    expect(region.scrollTop).toBeLessThan(region.scrollHeight - region.clientHeight - 48);
  });

  it.each(['desktop', 'phone'] as const)('cached_callback_opens_at_its_card_on_%s', async (viewport) => {
    const chat = named(DANA_LIVE, DANA);
    lengthen(chat);
    mockStore.world.context(chat, 'en', '').openHandoff({ reason: 'Please call Dana', callbackWindow: null, lead: DANA });
    const { screen } = await renderRoute(LIST, { viewport, pollScale: 100 });
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    await row.click();
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeInTheDocument();
    const region = transcriptRegion(screen);
    await expect.poll(() => card.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(region.getBoundingClientRect().top);
    expect(card.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(region.getBoundingClientRect().bottom);
    expect(region.scrollHeight).toBeGreaterThan(region.clientHeight);
    expect(region.scrollTop).toBe(0);
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect.element(card).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: DANA }).element());
    expect(region.scrollTop).toBe(0);
  });

  it('callback_stays_after_takeover_and_fits_390px', async () => {
    const chat = named(DANA_LIVE, DANA);
    mockStore.world.context(chat, 'en', '').openHandoff({ reason: 'Dana Whitfield · (510) 555-0118 · Leaking water heater', callbackWindow: null, lead: DANA });
    const { screen } = await renderRoute(LIST, { viewport: 'phone', pollScale: 100 });
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expectNoHorizontalScroll();
    await row.click();
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeVisible();
    await screen.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await expect.element(card).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expectNoHorizontalScroll();
    for (const el of screen.container.querySelectorAll('.cd-conversation__scroll, .cd-conversations__open')) {
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    }
    await screen.getByRole('link', { name: 'All conversations', exact: true }).click();
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    expectNoHorizontalScroll();

    // Recorded history has nobody to answer, even if Needs you carries the same session id.
    const read = await served<OwnerTranscript>('conversation', { session_id: DANA_LIVE });
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...read, replayed: true } });
    const recorded = await renderRoute(conversation(DANA_LIVE), { viewport: 'phone', pollScale: 100 });
    await expect.element(recorded.screen.getByText('Recorded history, replayed into your copy. It happened before you arrived.', { exact: true })).toBeVisible();
    expect(recorded.screen.getByRole('article', { name: 'Wants you', exact: true }).elements()).toHaveLength(0);
  });

  it('owner_message_closes_the_card_handoff_and_refreshes_needs_you', async () => {
    const chat = named(DANA_LIVE, DANA);
    chat.state = { ...chat.state, mode: 'owner' };
    mockStore.world.reply(chat, [rivera.blocks.handoff.en], 'en');
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeVisible();
    const reads = requests('needsYou').length;
    await screen.getByRole('textbox', { name: 'Write to them' }).fill('I can help with that.');
    await screen.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.element(card).not.toBeInTheDocument();
    expect(requests('needsYou').length).toBeGreaterThan(reads);
    await expect.element(log(screen).getByText('I can help with that.', { exact: true })).toBeVisible();
  });

  it('denied_request_hands_off_with_claudes_summary', async () => {
    // The seeded chat's draft was stopped, so its triage is Safety's. Its held request shows no
    // summary; denied, the follow-up hands the chat to Mike, and the handoff's card carries that
    // summary as Claude's own words, under the visitor's.
    const safety = await mockStore.dispatch('safety', { params: { desk_id: RIVERA.deskId } });
    if ('network' in safety || safety.status !== 200) throw new Error('the mock reads Safety');
    const triage = (safety.body as Attempt[]).find((a) => a.kind === 'reply_blocked')?.triage;
    if (!triage) throw new Error("Safety triages the seeded chat's stopped draft");

    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const held = heldCard(screen, SEEDED_REASON);
    await expect.element(held).toBeVisible();
    expect(screen.container.textContent).not.toContain(NOTE);
    await held.getByRole('button', { name: 'Deny this time' }).click();

    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    const line = card.getByText(`${NOTE}: ${triage.summary}`, { exact: true });
    await expect.element(line, { timeout: 5_000 }).toBeVisible();
    expect(line.element().previousElementSibling?.textContent).toMatch(/^From the visitor: “.+”$/);
    expect(line.element().closest('[data-copy="user"]')).toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('handoff_note_waits_while_the_chat_has_a_request_held', async () => {
    // While this chat still has a request held, its handoff card leaves Claude's note out, so the
    // note never sits beside an approval it could sway (owner decision, 2026-11-01).
    // A handoff opened in Dana's chat, shown as this held chat's, with a note in it.
    mockStore.world.reply(named(DANA_LIVE, DANA), [rivera.blocks.handoff.en], 'en');
    const read = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
    if ('network' in read || read.status !== 200) throw new Error('the mock reads Needs you');
    const items = read.body as NeedsYouItem[];
    expect(items.some((item) => item.handoff != null)).toBe(true);
    const summary = 'Asked for a discount; the Desk stopped a draft.';
    mockStore.inject({
      route: 'needsYou', status: 200, times: 10_000,
      body: items.map((item) => (item.handoff == null ? item : {
        ...item, claude_summary: summary, handoff: { ...item.handoff, session_id: SEEDED_HOLD },
      })),
    });

    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const held = heldCard(screen, SEEDED_REASON);
    await expect.element(held).toBeVisible();
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeVisible();
    expect(card.element().textContent).not.toContain(NOTE);
    // Answered here, the request no longer waits on Mike, so the note shows, though this read still lists it.
    await held.getByRole('button', { name: 'Deny this time' }).click();
    await expect.element(card.getByText(`${NOTE}: ${summary}`, { exact: true })).toBeVisible();
  });

  it('takeover_closes_the_card_handoff_and_refreshes_needs_you', async () => {
    const chat = named(DANA_LIVE, DANA);
    mockStore.world.reply(chat, [rivera.blocks.handoff.en], 'en');
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeVisible();
    await expect.element(card.getByText('The Desk handed this to you.', { exact: true })).toBeVisible();
    expect(card.element().textContent).toContain('From the visitor:');
    expect(card.element().textContent).not.toMatch(/call back/i);
    const reads = requests('needsYou').length;
    await screen.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await expect.element(card).not.toBeInTheDocument();
    expect(requests('needsYou').length).toBeGreaterThan(reads);
    await expect.element(screen.getByRole('navigation', { name: 'Conversations' }).getByText("You're in this chat", { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('callback_keeps_its_mark_when_a_later_needs_you_read_fails', async () => {
    // A read that fails after one that worked leaves the handoff open: the row keeps "Wants you".
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('the visitor has a chat');
    chat.displayName = DANA;
    await expect.poll(() => [...mockStore.world.handoffs.values()].some((h) => h.handoff.session_id === chat.state.session_id)).toBe(true);
    // Needs you is read every 150 ms here, and a failed read is retried at once.
    const { screen } = await renderRoute(LIST, { retryScale: 0 });
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    const before = row.element().getBoundingClientRect().top;
    mockStore.inject({ route: 'needsYou', status: 500, times: 10_000 });
    // Several failed reads later.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(row.element().textContent).toContain('Wants you');
    expect(row.element().querySelector('.cd-status-dot--held')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Conversations' }).getByRole('alert').elements()).toHaveLength(0);
    expect(row.element().getBoundingClientRect().top).toBe(before);
  });

  it('callback_marks_the_list_and_closes_in_the_chat_with_focus_on_its_name', async () => {
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('the visitor has a chat');
    chat.displayName = DANA;
    await expect.poll(() => [...mockStore.world.handoffs.values()].some((h) => h.handoff.session_id === chat.state.session_id)).toBe(true);
    const { screen } = await renderRoute(LIST, { pollScale: 100 });
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    const row = list.getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    expect(row.element().querySelector('.cd-status-dot--held')).not.toBeNull();
    await row.click();
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    await expect.element(card).toBeVisible();
    expect(card.getByRole('button', { name: 'Join the chat' }).elements()).toHaveLength(0);
    expect(card.getByRole('button').elements()).toHaveLength(1);
    const header = log(screen).element().querySelector('.cd-transcript-header');
    expect(header).not.toBeNull();
    expect(card.element().compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.element().parentElement?.parentElement).toHaveClass('cd-conversation__scroll');
    await expectScreenBasics(screen.container, { owner: true });
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect.element(card).not.toBeInTheDocument();
    await expect.element(row.getByText('Mike called back', { exact: true })).toBeVisible();
    expect(row.element().querySelector('.cd-status-dot--handled')).not.toBeNull();
    const heading = screen.getByRole('heading', { level: 2, name: DANA });
    await expect.poll(() => document.activeElement).toBe(heading.element());
    expect(getComputedStyle(heading.element()).outlineStyle).toBe('none');
    expect(getComputedStyle(heading.element()).boxShadow).toBe('none');
  });

  it('mark_done_by_keyboard_moves_focus_to_the_name_with_nothing_drawn', async () => {
    // From the keyboard, Mark done moves focus to the conversation's name, which matches :focus-visible then.
    // The name isn't a control: it draws no edge, ring or outline around itself.
    await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('the visitor has a chat');
    chat.displayName = DANA;
    await expect.poll(() => [...mockStore.world.handoffs.values()].some((h) => h.handoff.session_id === chat.state.session_id)).toBe(true);
    const { screen } = await renderRoute(LIST, { pollScale: 100 });
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Wants you', { exact: true })).toBeVisible();
    await row.click();
    const card = screen.getByRole('article', { name: 'Wants you', exact: true });
    const done = card.getByRole('button', { name: 'Mark done' });
    await expect.element(done).toBeVisible();
    (done.element() as HTMLElement).blur();
    await userEvent.keyboard('{Shift}');
    (done.element() as HTMLElement).focus();
    expect(done.element().matches(':focus-visible'), 'Mark done has focus from the keyboard').toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect.element(card).not.toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 2, name: DANA });
    await expect.poll(() => document.activeElement).toBe(heading.element());
    expect(heading.element().matches(':focus-visible'), 'the name has focus from the keyboard').toBe(true);
    const style = getComputedStyle(heading.element());
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', 'none']);
  });

  it('conversation_matches_its_board', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const receipts = log(screen).getByRole('button', { name: /Open the full trace\.$/ });
    await expect.poll(() => receipts.elements().length).toBeGreaterThanOrEqual(6);
    // The list is its own read, which can land after the conversation's.
    const links = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link');
    await expect.poll(() => links.elements()).toHaveLength(3);
    const rows = links.elements() as HTMLElement[];

    // Dana's live conversation as N-Conv-Run1 and N-Conv-TakeOver draw it, at 1440 px: the page
    // fills the main area, and Tab goes through the list, then the receipts, then the take-over bar.
    await expectOwnerBoard(screen.container, {
      current: 'Conversations',
      fill: true,
      transcript: true,
      tabStops: [...rows, ...(receipts.elements() as HTMLElement[]), takeOver.element() as HTMLElement],
    });
  });

  it('unnamed_agent_row_shows_its_confirmed_outcome', async () => {
    const booked = await bookTheEarliestVisit();
    const agent = session(booked);
    agent.displayName = null;
    agent.state = { ...agent.state, verified: false };
    const { screen } = await renderRoute(LIST);
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Agent/ });
    await expect.element(row.getByText('Agent · Visit booked', { exact: true })).toBeVisible();
    expect(row.element().querySelector('.cd-status-dot--info')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('seeded_visitor_rows_show_the_booking_with_its_handled_dot', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(LIST);
    const row = screen.getByRole('navigation', { name: 'Conversations' })
      .getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Booked', { exact: true })).toBeVisible();
    expect(row.element().querySelector('.cd-status-dot--handled')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('agent_rows_show_confirmed_outcomes_and_attention_first', async () => {
    const booked = await bookTheEarliestVisit();
    const paid = await bookTheEarliestVisit('quote_and_deposit');
    const refused = await bookTheEarliestVisit('push_the_limit');
    const desk = mockStore.world.desk(RIVERA.deskId)!;
    const quiet = mockStore.world.addSession(desk, { agent: "Alex Kim's assistant" });
    mockStore.world.visitorText(quiet, 'Hello');
    const { screen } = await renderRoute(LIST);
    const status = (id: string) => document.querySelector(`a[href="${conversation(id)}"] .cd-conversation-item__status-text`)?.textContent;
    await expect.poll(() => status(booked)).toBe('Agent · Visit booked');
    expect(status(paid)).toBe('Agent · Deposit paid');
    expect(status(refused)).toBe('Agent · Turned down');
    expect(status(quiet.state.session_id)).toBe('Agent');

    const ctx = mockStore.world.context(session(booked), 'en', 'Ask Mike');
    ctx.decide({ ...DECISIONS.quote, outcome: 'hold', executed: false });
    mockStore.world.reply(session(paid), [rivera.blocks.handoff.en], 'en');
    await expect.poll(() => status(booked)).toBe('Needs you');
    await expect.poll(() => status(paid)).toBe('Wants you');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('list_and_detail', async () => {
    named(DANA_LIVE, DANA);
    const { screen, router } = await renderRoute(LIST);

    // Newest first: Dana's live chat, the visitor whose discount is held, then Alex Kim's assistant.
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) })).toBeVisible();
    const rows = list.getByRole('link').elements();
    expect(rows.map((row) => row.querySelector('[data-copy="user"]')?.textContent)).toEqual([DANA, 'Visitor', rivera.conversations.alexAgent.name]);
    expect(rows[1]?.textContent).toContain('Needs you');
    expect(rows[0]?.textContent).toContain(formatClock(new Date(session(DANA_LIVE).lastActivity).toISOString(), LA));
    await expectScreenBasics(screen.container, { owner: true });

    // Dana's conversation opens beside the list, at its own address.
    await list.getByRole('link', { name: new RegExp(DANA) }).click();
    await expect.poll(() => router.state.location.pathname).toBe(conversation(DANA_LIVE));
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeVisible();
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) })).toHaveAttribute('aria-current', 'true');

    // Her messages, Claude's replies with their checks under them, and Mike's whisper.
    const chat = log(screen);
    const [first, second] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(chat.getByText(first ?? '', { exact: true })).toBeVisible();
    await expect.element(chat.getByText(second ?? '', { exact: true })).toBeVisible();
    const receipts = chat.getByRole('button', { name: /Open the full trace\.$/ });
    await expect.poll(() => receipts.elements().length).toBeGreaterThanOrEqual(6);
    await expect.element(chat.getByRole('button', { name: "Reply checked against Mike Turner's rules Open the full trace." }).first()).toBeVisible();
    const whisper = session(DANA_LIVE).items.find((item) => item.kind === 'whisper');
    await expect
      .element(chat.getByText(`Your whisper, ${formatClock(whisper?.created_at ?? '', LA)}. Only Claude sees this.`, { exact: true }))
      .toBeVisible();
    await expect.element(chat.getByText('offer Thursday morning too', { exact: true })).toBeVisible();

    // While Claude answers: Take over, and whispers.
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // A copy with no chats yet says how one starts.
    const quiet = await renderRoute(LIST, { seed: 'rivera_quiet' });
    await expect.element(quiet.screen.getByText('No conversations yet', { exact: true })).toBeVisible();
    await expect.element(quiet.screen.getByText('When someone writes to your Desk, it shows up here.', { exact: true })).toBeVisible();
    expect(quiet.screen.getByText('Choose a conversation to read it.').elements()).toHaveLength(0);
    await expectScreenBasics(quiet.screen.container, { owner: true });
  });

  it.each(['desktop', 'phone'] as const)('the_head_says_what_got_done_on_%s', async (viewport) => {
    // Alex Kim's assistant booked the earliest visit: the head says so, where it said the reply was checked.
    const booked = await bookTheEarliestVisit();
    const { screen } = await renderRoute(conversation(booked), { viewport });
    await expect.element(screen.getByRole('heading', { level: 2, name: rivera.conversations.alexAgent.name })).toBeVisible();
    const latest = screen.getByText('Latest: Visit booked', { exact: true });
    await expect.element(latest).toBeVisible();
    // The same line in the same place: the head's meta line in the secondary text color.
    const line = latest.element();
    expect(line.tagName).toBe('P');
    expect(line.className).toBe('cd-conversation__latest cd-type-meta');
    expect(line.parentElement?.classList.contains('cd-conversation__head')).toBe(true);
    expect(getComputedStyle(line).color).toBe(tokenColor('--text-secondary'));
    // The booked card and its checks stay under their message.
    await expect.element(log(screen).getByRole('article', { name: 'Booked', exact: true })).toBeVisible();
    await expect.element(log(screen).getByRole('button', { name: "Reply checked against Mike Turner's rules Open the full trace." }).last()).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
    expectNoHorizontalScroll();

    // The seeded agent chat paid its deposit within its signed limit, and Dana's chat ended with her visit booked.
    for (const [sessionId, words] of [['ses-alex-agent', 'Latest: Deposit paid'], [DANA_LIVE, 'Latest: Visit booked']] as const) {
      const other = await renderRoute(conversation(sessionId), { viewport });
      await expect.element(other.screen.getByText(words, { exact: true })).toBeVisible();
      await expectScreenBasics(other.screen.container, { owner: true });
      expectNoHorizontalScroll();
    }
  });

  it('a_reply_in_markdown_shows_bold_and_a_list', async () => {
    // A reply of Claude's in Markdown, in Dana's chat: the owner reads it as she did.
    const items = ['Is the water heater leaking from the top or the bottom?', 'Is the pilot light still on?'];
    const chat = named(DANA_LIVE, DANA);
    const text = `We can look at that. **Two things** help me point you the right way:\n\n${items.map((item) => `- ${item}`).join('\n')}`;
    mockStore.world.emit(chat, mockStore.world.context(chat, 'en', '').reply([proseBlock(text)]));
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bold = log(screen).getByText('Two things', { exact: true });
    await expect.element(bold).toBeVisible();
    expect(bold.element().tagName).toBe('STRONG');
    const message = bold.element().closest('.cd-claude-message') as HTMLElement;
    expect([...message.querySelectorAll('li')].map((el) => el.textContent)).toEqual(items);
    expect(message.textContent).not.toMatch(/\*|^- /m);
  });

  it('agent_name_reads_as_its_own_words', async () => {
    // An agent's chat: the name it gave is its own words wherever the page shows it, the caption
    // over the transcript included.
    const name = 'Trip planner for Sam Ortiz';
    const chat = named(DANA_LIVE, name);
    chat.state = { ...chat.state, kind: 'agent' };
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    await expect.element(screen.getByRole('heading', { level: 2, name })).toBeVisible();
    const caption = screen.getByText(/, signed requests from /);
    await expect.element(caption).toBeVisible();
    expect(caption.element().textContent).toMatch(new RegExp(`, signed requests from ${name}$`));
    expect(caption.element().querySelector('[data-copy="user"]')?.textContent).toBe(name);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('unnamed_agent_head_says_agent_once', async () => {
    // An agent with no name on record: the title already says it's an agent, so the head doesn't say
    // it again in a pill, as the list leaves out its status line. The signed pill stays.
    const booked = await bookTheEarliestVisit();
    session(booked).displayName = null;
    const firstRead = holdReads(ROUTES.conversation.path.replace('{session_id}', booked));
    const { screen } = await renderRoute(conversation(booked));
    await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull();
    firstRead.release();
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Agent', exact: true })).toBeVisible();
    const head = screen.getByRole('heading', { level: 2, name: 'Agent', exact: true }).element().closest('.cd-conversation__head')!;
    expect([...head.querySelectorAll('.cd-pill')].map((pill) => pill.textContent)).toEqual(['Signed']);
    await expectScreenBasics(screen.container, { owner: true });

    // Named, the pill says what the name doesn't.
    session(booked).displayName = rivera.conversations.alexAgent.name;
    const namedRead = holdReads(ROUTES.conversation.path.replace('{session_id}', booked));
    const withName = await renderRoute(conversation(booked));
    await expect.poll(() => document.querySelector('.cd-conversation-pane .cd-skeleton-screen__layer[data-state="shown"]')).not.toBeNull();
    namedRead.release();
    await expect.element(withName.screen.getByRole('heading', { level: 2, name: rivera.conversations.alexAgent.name })).toBeVisible();
    const namedHead = withName.screen.getByRole('heading', { level: 2, name: rivera.conversations.alexAgent.name, exact: true }).element().closest('.cd-conversation__head')!;
    expect([...namedHead.querySelectorAll('.cd-pill')].map((pill) => pill.textContent)).toEqual(['Agent', 'Signed']);
  });

  it('receipt_opens_the_trace', async () => {
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const chat = log(screen);
    // The first receipt is the first reply's check, signed with its own ledger entry.
    const reply = session(DANA_LIVE).items.find((item) => item.kind === 'delivered');
    const seq = reply?.event?.type === 'message' ? reply.event.ledger_seq : 0;
    const receipt = chat.getByRole('button', { name: /Open the full trace\.$/ }).first();
    await expect.element(receipt).toBeVisible();

    // Enter on it opens the trace of that entry, with focus in it.
    (receipt.element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    const trace = screen.getByRole('region', { name: `Full trace of entry ${seq}`, exact: true });
    await expect.element(trace).toBeVisible();
    await expect.poll(() => trace.element().contains(document.activeElement)).toBe(true);
    await expect.element(trace.getByText(String(seq), { exact: true })).toBeVisible();
    expect(requests('ledger')).toHaveLength(1);

    // Escape closes it, and focus goes back to the receipt.
    await userEvent.keyboard('{Escape}');
    await expect.element(trace).not.toBeInTheDocument();
    expect(document.activeElement).toBe(receipt.element());
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('trace_that_cant_be_read_offers_try_again_and_close', async () => {
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const chat = log(screen);
    const reply = session(DANA_LIVE).items.find((item) => item.kind === 'delivered');
    const seq = reply?.event?.type === 'message' ? reply.event.ledger_seq : 0;
    const receipt = chat.getByRole('button', { name: /Open the full trace\.$/ }).first();
    await expect.element(receipt).toBeVisible();
    const tryAgain = chat.getByRole('button', { name: 'Try again', exact: true });
    const close = chat.getByRole('button', { name: 'Close', exact: true });

    // The record can't be read, nor on its one retry: the owner's line, with a way to read it
    // again and a way to close it, each a click away, and focus in it.
    mockStore.inject({ route: 'ledger', status: 500, times: 2 });
    await receipt.click();
    await expect.element(chat.getByRole('alert').getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(tryAgain).toBeVisible();
    await expect.element(close).toBeVisible();
    expect(document.activeElement?.closest('.cd-conversation__trace')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });

    // Close closes it, and focus goes back to the receipt.
    await close.click();
    await expect.element(tryAgain).not.toBeInTheDocument();
    expect(chat.getByRole('alert').elements()).toHaveLength(0);
    expect(document.activeElement).toBe(receipt.element());

    // Opened again, it still can't be read; Try again reads it, and the trace opens with focus in it.
    mockStore.inject({ route: 'ledger', status: 500, times: 2 });
    await receipt.click();
    await expect.poll(() => requests('ledger').length, { timeout: 5_000 }).toBe(4);
    await expect.element(tryAgain).toBeVisible();
    await tryAgain.click();
    const trace = screen.getByRole('region', { name: `Full trace of entry ${seq}`, exact: true });
    await expect.element(trace).toBeVisible();
    await expect.poll(() => trace.element().contains(document.activeElement)).toBe(true);
    expect(requests('ledger')).toHaveLength(5);
    expect(chat.getByRole('alert').elements()).toHaveLength(0);
  });

  it('take_over_then_say', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { generation } = chat.state;
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    // The kernel's line for the newest thing in the chat, under its title.
    const latest = () => document.querySelector('.cd-conversation__latest')?.textContent;
    await expect.poll(latest).toMatch(/^Latest: \S/);
    const before = latest();

    // Taking over posts the generation last read, and the owner's composer takes the whisper's place.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }]);
    const handBack = screen.getByRole('button', { name: 'Hand back to Claude' });
    await expect.element(handBack).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Whisper to Claude' }).elements()).toHaveLength(0);

    // The chat as read again ends where she joined, which has no line of the kernel's: the latest
    // line stays its newest receipt or message.
    await expect.poll(() => handBack.element().classList.contains('cd-button--waiting')).toBe(false);
    expect(session(DANA_LIVE).items.at(-1)?.kind).toBe('owner_joined');
    expect(latest()).toBe(before);

    // His words go to Dana exactly as he wrote them, and show here as his.
    const words = 'Hi Dana, it is Mike. I can come at 4 today.';
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    const mine = log(screen).getByText(words, { exact: true });
    await expect.element(mine).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'say' }]);
    const message = mine.element().closest('.cd-person-message');
    expect(message?.querySelector('.cd-person-message__name')?.textContent).toBe('You');
    expect(message?.querySelector('.cd-person-message__avatar')?.textContent).toBe('MT');

    // Dana's stream got Mike joining, then the words, as Mike's (with his typing between, which
    // carries no words: `owner_typing_reaches_the_visitor`).
    const sent = chat.events.map(({ ev }) => ev).filter((ev) => ev.type !== 'owner_typing').slice(-2);
    expect(sent[0]).toEqual({ type: 'owner_joined', name: OWNER });
    expect(sent[1]).toMatchObject({ type: 'message', author: 'owner' });
    expect(sent[1]?.type === 'message' && sent[1].blocks.map((b) => b.text)).toEqual([words]);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('a_long_chat_scrolls_on_its_own', async () => {
    // A chat and a list longer than the window, at 1440 by 900.
    const last = lengthen(named(DANA_LIVE, DANA));
    const added = moreChats();
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    const rows = list.getByRole('link');
    await expect.poll(() => rows.elements().length).toBe(3 + added);
    const head = screen.getByRole('heading', { level: 2, name: DANA });
    const latest = log(screen).getByText(last, { exact: true });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(latest).toBeInTheDocument();
    await expect.element(head).toBeInViewport({ ratio: 1 });

    // Read to its end, the chat scrolls on its own: the list's first row, the chat's head and the
    // owner's controls stay in view.
    latest.element().scrollIntoView({ block: 'end' });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(rows.first()).toBeInViewport({ ratio: 1 });
    await expect.element(head).toBeInViewport({ ratio: 1 });
    await expect.element(takeOver).toBeInViewport({ ratio: 1 });

    // The transcript is its own scroll region, apart from the head, the list and the controls; the
    // main area around the page and the window don't scroll.
    const transcript = scrollerOf(log(screen).element());
    expect(transcript.scrollTop).toBeGreaterThan(0);
    for (const other of [head.element(), list.element(), takeOver.element()]) expect(transcript.contains(other)).toBe(false);
    const main = screen.getByRole('main').element();
    expect(main.scrollHeight).toBeLessThanOrEqual(main.clientHeight);
    expectNoWindowScroll();

    // The list is its own scroll region too: read to its last row, the chat stays where it was.
    expect(scrollerOf(list.element())).toBe(list.element());
    const readTo = transcript.scrollTop;
    rows.last().element().scrollIntoView({ block: 'end' });
    await expect.element(rows.last()).toBeInViewport({ ratio: 1 });
    expect(list.element().scrollTop).toBeGreaterThan(0);
    await expect.element(head).toBeInViewport({ ratio: 1 });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    expect(transcript.scrollTop).toBe(readTo);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('a_long_chat_opens_at_its_latest', async () => {
    // A chat longer than the window opens at its end, as a chat does: Dana's latest message sits
    // over the owner's controls, where she would write next, under the chat's head.
    const last = lengthen(named(DANA_LIVE, DANA));
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const latest = log(screen).getByText(last, { exact: true });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeInViewport({ ratio: 1 });
    const transcript = scrollerOf(log(screen).element());
    expect(transcript.scrollTop).toBeGreaterThan(0);
    expect(transcript.scrollTop + transcript.clientHeight).toBeGreaterThanOrEqual(transcript.scrollHeight - 1);
  });

  it('take_over_keeps_the_list_and_the_head_in_place', async () => {
    const last = lengthen(named(DANA_LIVE, DANA));
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const firstRow = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link').first();
    const head = screen.getByRole('heading', { level: 2, name: DANA });
    const latest = log(screen).getByText(last, { exact: true });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    await expect.element(firstRow).toBeInViewport({ ratio: 1 });
    await expect.element(head).toBeInViewport({ ratio: 1 });
    // She has read the chat to its end.
    latest.element().scrollIntoView({ block: 'end' });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    const rowAt = firstRow.element().getBoundingClientRect().top;
    const headAt = head.element().getBoundingClientRect().top;

    // Take over, under a chat longer than the window: the owner's composer and Hand back come into
    // view in the whisper's place, the list's first row and the chat's head haven't moved, and the
    // end of the chat is still in view over the taller controls.
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('button', { name: 'Hand back to Claude' })).toBeInViewport({ ratio: 1 });
    await expect.element(firstRow).toBeInViewport({ ratio: 1 });
    await expect.element(head).toBeInViewport({ ratio: 1 });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    expect(firstRow.element().getBoundingClientRect().top).toBe(rowAt);
    expect(head.element().getBoundingClientRect().top).toBe(headAt);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('the_end_of_the_chat_stays_in_view', async () => {
    const chat = named(DANA_LIVE, DANA);
    const last = lengthen(chat);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const latest = log(screen).getByText(last, { exact: true });
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    const transcript = scrollerOf(log(screen).element());

    // At the end of the chat, her words and Dana's answer each come into view as they arrive.
    latest.element().scrollIntoView({ block: 'end' });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await box.fill('I can come at 4 today.');
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('I can come at 4 today.', { exact: true })).toBeInViewport({ ratio: 1 });
    mockStore.world.visitorText(chat, 'Four works, thank you.');
    await expect.element(log(screen).getByText('Four works, thank you.', { exact: true })).toBeInViewport({ ratio: 1 });

    // Scrolled back to read, she stays where she is while the chat moves on.
    transcript.scrollTop = 0;
    await expect.poll(() => transcript.scrollTop).toBe(0);
    mockStore.world.visitorText(chat, 'Should I leave the gate open?');
    const asked = log(screen).getByText('Should I leave the gate open?', { exact: true });
    await expect.element(asked).toBeInTheDocument();
    await readsMore('conversation', 2);
    expect(transcript.scrollTop).toBe(0);
    await expect.element(asked).not.toBeInViewport();

    // Sending brings the end back, with her words in view.
    await box.fill('Yes, please.');
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('Yes, please.', { exact: true })).toBeInViewport({ ratio: 1 });
    await expectScreenBasics(screen.container, { owner: true });
  });

  // A short laptop window and a phone with little height: too short to give the transcript a region
  // of its own between the head and the owner's controls after Take over. Each chat is opened from
  // the list once the window has that size, as the owner would open it.
  for (const [width, height] of [
    [1440, 560],
    [390, 500],
  ] as const) {
    const viewport = width < 1024 ? 'phone' : 'desktop';

    it(`a_long_chat_opens_at_its_latest_in_a_short_window_at_${width}x${height}`, async () => {
      const last = lengthen(named(DANA_LIVE, DANA));
      const { screen, router } = await renderRoute(LIST, { viewport });
      await page.viewport(width, height);
      await router.navigate(conversation(DANA_LIVE));
      // The head names Dana once the list has read the chat, which can answer after the chat.
      const head = screen.getByRole('heading', { level: 2, name: DANA });
      await expect.element(head).toBeInTheDocument();

      // Without her scrolling, Dana's latest message sits over the owner's controls, where she would
      // write next, in the open conversation that scrolls as one with its head.
      await expect.element(log(screen).getByText(last, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeInViewport({ ratio: 1 });
      await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeInViewport({ ratio: 1 });
      expect(scrollerOf(log(screen).element()).contains(head.element())).toBe(true);
      expectNoWindowScroll();
    });

    it(`a_short_window_scrolls_the_chat_as_one_at_${width}x${height}`, async () => {
      // Dana's refund held, in a chat longer than the window.
      const held = mockStore.world.addHeldRefund();
      const last = lengthen(named(held.session_id, DANA));
      const { screen, router } = await renderRoute(LIST, { viewport });
      await page.viewport(width, height);
      await router.navigate(conversation(held.session_id));
      const head = screen.getByRole('heading', { level: 2, name: DANA });
      const latest = log(screen).getByText(last, { exact: true });
      const heldHere = heldCard(screen, REFUND_REASON);
      await expect.element(latest).toBeInViewport({ ratio: 1 });
      // The head names Dana once the list has read the chat, and the held request's card comes with
      // Needs you: either can answer after the chat.
      await expect.element(head).toBeInTheDocument();
      await expect.element(heldHere).toBeInTheDocument();
      await screen.getByRole('button', { name: 'Take over' }).click();

      // Without her scrolling, the composer and Hand back come into view at the conversation's end,
      // under Dana's latest message.
      const box = screen.getByRole('textbox', { name: 'Write to them' });
      await expect.element(box).toBeInViewport({ ratio: 1 });
      await expect.element(screen.getByRole('button', { name: 'Hand back to Claude' })).toBeInViewport({ ratio: 1 });
      await expect.element(latest).toBeInViewport({ ratio: 1 });

      // The open conversation scrolls as one, its head, transcript and controls together: the
      // transcript doesn't scroll inside it, and the main area and the window don't scroll around it.
      const column = scrollerOf(log(screen).element());
      const main = screen.getByRole('main').element();
      expect(column).not.toBe(main);
      expect(main.contains(column)).toBe(true);
      expect(column.contains(head.element())).toBe(true);
      expect(scrollerOf(box.element())).toBe(column);
      expect(main.scrollHeight).toBeLessThanOrEqual(main.clientHeight);
      expectNoWindowScroll();

      // Scrolled back to it, the held request, further up the chat, shows whole.
      heldHere.element().scrollIntoView({ block: 'start' });
      await expect.element(heldHere).toBeInViewport({ ratio: 1 });
      expectNoWindowScroll();
    });
  }

  it('a_window_made_short_keeps_the_latest_in_view', async () => {
    // A long chat read at 1440 by 900, in the transcript's own region under the head.
    const last = lengthen(named(DANA_LIVE, DANA));
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const latest = log(screen).getByText(last, { exact: true });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    // The head names Dana once the list has read the chat, which can answer after the chat.
    const head = screen.getByRole('heading', { level: 2, name: DANA });
    await expect.element(head).toBeInTheDocument();
    const scrollsWithTheHead = () => scrollerOf(log(screen).element()).contains(head.element());
    await expect.poll(scrollsWithTheHead).toBe(false);

    // Made short, the open conversation scrolls as one, and Dana's latest message is still in view
    // over the owner's controls.
    await page.viewport(1440, 560);
    await expect.poll(scrollsWithTheHead).toBe(true);
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(takeOver).toBeInViewport({ ratio: 1 });

    // Made tall again, the transcript's region is back, still at its end.
    await page.viewport(1440, 900);
    await expect.poll(scrollsWithTheHead).toBe(false);
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(takeOver).toBeInViewport({ ratio: 1 });
  });

  it('in_a_short_window_the_end_of_the_chat_stays_in_view', async () => {
    // A phone with little height, 390 by 500, where the open conversation scrolls as one.
    const chat = named(DANA_LIVE, DANA);
    const last = lengthen(chat);
    const { screen, router } = await renderRoute(LIST, { viewport: 'phone' });
    await page.viewport(390, 500);
    await router.navigate(conversation(DANA_LIVE));
    await expect.element(log(screen).getByText(last, { exact: true })).toBeInViewport({ ratio: 1 });
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeInViewport({ ratio: 1 });
    const column = scrollerOf(log(screen).element());
    expect(column.contains(box.element())).toBe(true);

    // At the end of the chat, each of Dana's messages comes into view over the composer as it arrives.
    for (let i = 1; i <= 5; i += 1) {
      const words = `Update ${i}: it is still dripping.`;
      mockStore.world.visitorText(chat, words);
      await expect.element(log(screen).getByText(words, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect.element(box).toBeInViewport({ ratio: 1 });
    }

    // Scrolled back to read, she stays where she is while the chat moves on.
    column.scrollTop = 0;
    await expect.poll(() => column.scrollTop).toBe(0);
    mockStore.world.visitorText(chat, 'Should I leave the gate open?');
    const asked = log(screen).getByText('Should I leave the gate open?', { exact: true });
    await expect.element(asked).toBeInTheDocument();
    await readsMore('conversation', 2);
    expect(column.scrollTop).toBe(0);
    await expect.element(asked).not.toBeInViewport();

    // Writing back brings the end back, and once her words are sent they and the composer stay in
    // view as the chat grows under them.
    await box.fill('Yes, please.');
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('Yes, please.', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect.element(box).toBeInViewport({ ratio: 1 });
    expectNoWindowScroll();
  });

  it('in_a_short_window_focus_in_the_transcript_holds_it', async () => {
    // A long chat with Dana's refund held at its end, opened at 1440 by 560, where the open
    // conversation scrolls as one: it opens at its end, and the owner is on the last receipt.
    const first = mockStore.world.addHeldRefund();
    const chat = named(first.session_id, DANA);
    lengthen(chat);
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(LIST);
    await page.viewport(1440, 560);
    await router.navigate(conversation(first.session_id));
    await expect.poll(() => heldCard(screen, REFUND_REASON).elements().length).toBe(2);
    // The head names Dana once the list has read the chat, which can answer after the chat.
    const head = screen.getByRole('heading', { level: 2, name: DANA });
    await expect.element(head).toBeInTheDocument();
    const lastReceipt = log(screen).getByRole('button', { name: /Open the full trace\.$/ }).last();
    await expect.element(lastReceipt).toBeInViewport({ ratio: 1 });
    (lastReceipt.element() as HTMLElement).focus({ preventScroll: true });
    const column = scrollerOf(log(screen).element());
    expect(column.contains(head.element())).toBe(true);
    // Take her place once the opening has settled: the head's lines can still reflow after the
    // list's read names Dana, and the open-at-end scroll follows them.
    let seen = Number.NaN;
    await expect.poll(() => {
      const now = Math.round(lastReceipt.element().getBoundingClientRect().top);
      const settled = now === seen;
      seen = now;
      return settled;
    }, { interval: 100 }).toBe(true);
    const on = seen;

    // A message arrives while focus is in the transcript: nothing moves under her. The held cards
    // keep quoting the words that made each request, read again with the chat; the receipt she's on
    // stays where it was on screen.
    mockStore.world.visitorText(chat, 'Are you still there?');
    await expect.element(log(screen).getByText('Are you still there?', { exact: true })).toBeInTheDocument();
    await readsMore('needsYou', 1);
    expect(heldCard(screen, REFUND_REASON).first().element().textContent).not.toContain('Are you still there?');
    await readsMore('conversation', 2);
    expect(column.contains(lastReceipt.element())).toBe(true);
    await expect.poll(() => Math.round(lastReceipt.element().getBoundingClientRect().top)).toBe(on);
    expect(document.activeElement).toBe(lastReceipt.element());
  });

  it('focus_in_the_transcript_holds_it', async () => {
    // A long chat with Dana's refund held at its end: it opens there, and the owner is on the last
    // receipt, about to open its trace.
    const first = mockStore.world.addHeldRefund();
    const chat = session(first.session_id);
    lengthen(chat);
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(conversation(first.session_id));
    await expect.poll(() => heldCard(screen, REFUND_REASON).elements().length).toBe(2);
    const lastReceipt = log(screen).getByRole('button', { name: /Open the full trace\.$/ }).last();
    await expect.element(lastReceipt).toBeInViewport({ ratio: 1 });
    (lastReceipt.element() as HTMLElement).focus();
    const transcript = scrollerOf(log(screen).element());
    const at = transcript.scrollTop;

    // A message arrives while focus is in the transcript: nothing moves under her.
    mockStore.world.visitorText(chat, 'Are you still there?');
    await expect.element(log(screen).getByText('Are you still there?', { exact: true })).toBeInTheDocument();
    await readsMore('conversation', 2);
    expect(transcript.scrollTop).toBe(at);
    expect(document.activeElement).toBe(lastReceipt.element());
  });

  it('unsent_words_never_replace_newer_ones', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();

    // The reply check stops her words (a price in prose), after she tries typing while they send.
    let release!: () => void;
    const until = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(() => release());
    mockStore.inject({ route: 'ownerMessage', status: 200, until, body: { message_id: 'msg-stopped', verdict: { ok: false }, ledger_seq: 1 } });
    const stopped = 'The drain clearing is $89 today.';
    await box.fill(stopped);
    await userEvent.keyboard('{Enter}');

    // While they are on their way the box takes nothing new, so nothing typed meanwhile can be
    // overwritten when they come back.
    await expect.element(box).toBeDisabled();
    await userEvent.keyboard('Newer words');
    await expect.element(box).toBeDisabled();
    release();

    // They come back to the box, alone, with the line saying why, and the box has focus again.
    await expect
      .element(screen.getByRole('alert').getByText("That wasn't sent: the reply check stopped it. Your words are back in the box to change.", { exact: true }))
      .toBeVisible();
    await expect.element(box).toHaveValue(stopped);
    await expect.element(box).not.toBeDisabled();
    expect(document.activeElement).toBe(box.element());

    // Words that go through leave the box empty and ready for the next ones.
    await box.fill('I can come at 4 today.');
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('I can come at 4 today.', { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue('');
    await expect.poll(() => document.activeElement).toBe(box.element());
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('whisper_in_ai_mode', async () => {
    const chat = session(DANA_LIVE);
    const streamed = chat.events.length;
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // While Claude answers, the owner's words go to Claude only.
    const box = screen.getByRole('textbox', { name: 'Whisper to Claude' });
    await expect.element(box).toHaveAttribute('placeholder', "Whisper to Claude. They won't see it.");
    const words = 'mention the Thursday 8 am opening';
    await box.fill(words);
    await userEvent.keyboard('{Enter}');

    // A captioned whisper in the conversation, with its time on the business's clock.
    const shown = log(screen).getByText(words, { exact: true });
    await expect.element(shown).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'whisper' }]);
    const kept = chat.items.filter((item) => item.kind === 'whisper').at(-1);
    expect(kept?.text).toBe(words);
    await expect
      .element(log(screen).getByText(`Your whisper, ${formatClock(kept?.created_at ?? '', LA)}. Only Claude sees this.`, { exact: true }).last())
      .toBeVisible();
    await expect.element(box).toHaveValue('');

    // Nothing new reached Dana: no event on her stream, and no typing either.
    expect(chat.events.length).toBe(streamed);
    expect(requests('ownerTyping')).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('stale_generation_refetches', async () => {
    const chat = session(DANA_LIVE);
    const read = chat.state.generation;
    // No poll lands while the test counts reads.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();

    // The chat moves on after the owner read it: Claude's next turn, say.
    chat.state = { ...chat.state, generation: read + 1 };
    const reads = requests('conversation').length;
    await takeOver.click();

    // The take-over named the generation she read, the API turned it back, and the chat is read again.
    await expect
      .element(screen.getByRole('alert').getByText('This chat changed while you were acting. Check the latest and try again.', { exact: true }))
      .toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation: read }]);
    expect(requests('conversation').length).toBeGreaterThan(reads);
    expect(chat.state.mode).toBe('ai');

    // Trying again acts on the chat as it stands now.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation: read }, { generation: read + 1 }]);
    expect(chat.state.mode).toBe('owner');
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('say_needs_take_over', async () => {
    const chat = named(DANA_LIVE, DANA);
    // No poll lands while the test counts reads, and typing pings at most once in the test.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    // The take-over reads the chat again, and it is hers in that read.
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // She writes while the chat is hers: one typing ping, which the API takes.
    const words = 'I can come at 4 today.';
    await box.fill(words);
    await expect.poll(() => requests('ownerTyping').length).toBe(1);

    // The chat goes back to Claude from another tab before she sends.
    mockStore.world.handBack(chat);
    const streamed = chat.events.length;
    await userEvent.keyboard('{Enter}');

    // The API turns her words back, nothing reaches Dana, and the screen says what to do.
    await expect.element(screen.getByRole('alert').getByText('Take over first, then write to them.', { exact: true })).toBeVisible();
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: words, kind: 'say' }]);
    expect(chat.events.slice(streamed).filter(({ ev }) => ev.type === 'message')).toEqual([]);
    expect(log(screen).getByText(words, { exact: true }).elements()).toHaveLength(0);

    // The chat as read again is Claude's: Take over and the whisper box, never her words in it.
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toHaveValue('');

    // Her words wait for the box they were written in: taking over again gives them back, and
    // words the page puts back are not her typing.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toHaveValue(words);
    expect(requests('ownerTyping')).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('earlier_words_never_confirm_a_later_send', async () => {
    const chat = named(DANA_LIVE, DANA);
    const words = 'On my way';
    // No poll lands, so the only reads of the chat are the ones sending makes.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    // The page's first read is in before the count, so the take-over's read is the one awaited
    // below, and none is still out to take a fault planted for a later read.
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // Her words go to Dana, but the read after them fails (and its one retry), so the chat as last
    // read doesn't show them.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('alert').getByText(UNAVAILABLE, { exact: true }), { timeout: 5_000 }).toBeVisible();
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    await expect.element(box).toHaveValue('');
    expect(log(screen).getByText(words, { exact: true }).elements()).toHaveLength(0);

    // The same words again, and this answer is lost before they reach the API. The chat read
    // afterwards holds the first ones, which never pass for these.
    mockStore.inject({ route: 'ownerMessage', status: 'network' });
    await box.fill(words);
    await userEvent.keyboard('{Enter}');
    await expect
      .element(screen.getByRole('alert').getByText("We couldn't confirm that went through. Check the chat before you send it again.", { exact: true }))
      .toBeVisible();
    await expect.element(box).toHaveValue(words);
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([
      { text: words, kind: 'say' },
      { text: words, kind: 'say' },
    ]);
    const said = chat.events.filter(({ ev }) => ev.type === 'message' && ev.author === 'owner');
    expect(said).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('words_wait_for_a_read_of_the_chat_after_one_fails', async () => {
    named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    // The page's first read is in before the count, so the take-over's read is the one awaited
    // below, and none is still out to take a fault planted for a later read.
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    await expect.element(takeOver).toBeVisible();
    const reads = requests('conversation').length;
    await takeOver.click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    await expect.poll(() => requests('conversation').length, { timeout: 5_000 }).toBeGreaterThan(reads);

    // Her words go, and the read after them fails.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    await box.fill('On my way');
    await userEvent.keyboard('{Enter}');
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    await expect.element(box).toHaveValue('');

    // Her next words wait for a read of the chat; while it still can't be read, they don't go,
    // and they stay in the box with the owner's line for the failed read.
    mockStore.inject({ route: 'conversation', status: 500, times: 2 });
    const next = 'About 10 minutes out.';
    await box.fill(next);
    await userEvent.keyboard('{Enter}');
    await expect.element(box, { timeout: 5_000 }).toHaveValue(next);
    await expect.element(box, { timeout: 5_000 }).not.toBeDisabled();
    const controls = box.element().closest('.cd-conversation__controls');
    expect(controls?.querySelector('[role="alert"]')?.textContent).toBe(UNAVAILABLE);
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([{ text: 'On my way', kind: 'say' }]);

    // Once the chat can be read, they go, after the first ones.
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText(next, { exact: true })).toBeVisible();
    await expect.element(log(screen).getByText('On my way', { exact: true })).toBeVisible();
    await expect.element(box).toHaveValue('');
    expect(requests('ownerMessage').map((r) => r.body)).toEqual([
      { text: 'On my way', kind: 'say' },
      { text: next, kind: 'say' },
    ]);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_request_answerable_during_take_over', async () => {
    const chat = session(SEEDED_HOLD);
    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();

    // The card sits right after the row its hold's receipt is under.
    const heldReceipt = receipt(screen, 'Held for you');
    await expect.element(heldReceipt).toBeVisible();
    const row = heldReceipt.element().closest('.cd-transcript-row');
    expect(row?.nextElementSibling?.contains(card.element())).toBe(true);

    // Taking over leaves it to be answered, and answering it keeps the owner in the chat.
    await screen.getByRole('button', { name: 'Take over' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Write to them' })).toBeVisible();
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }]);
    expect(chat.state.mode).toBe('owner');
    await expect.element(screen.getByRole('button', { name: 'Hand back to Claude' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_request_settles_in_its_slot', async () => {
    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    await expect.element(allow).toBeVisible();
    const element = card.element();
    const slot = slotOf(element);

    const watching = watchAnswerLanding(element, slot);
    await allow.click();
    const frames = await watching;

    // The same card, settled in its slot right after the hold's row, with its final line.
    expect(heldCard(screen, SEEDED_REASON).element()).toBe(element);
    expect(element.closest('.cd-conversation__held')).toBe(slot);
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    const row = receipt(screen, 'Held for you').element().closest('.cd-transcript-row');
    expect(row?.nextElementSibling).toBe(slot);
    // The card eases, and its slot with it, to its answered height: shorter by the answers' row, in one direction, eased.
    expect(expectSettledInItsSlot(frames)).toBeGreaterThan(0);
  });

  it('always_answer_settles_in_its_slot_with_its_rule', async () => {
    const refund = mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(conversation(refund.session_id));
    const card = heldCard(screen, REFUND_REASON);
    const deny = card.getByRole('button', { name: 'Deny', exact: true });
    await expect.element(deny).toBeVisible();
    const element = card.element();
    const slot = slotOf(element);

    await deny.click();
    const watching = watchAnswerLanding(element, slot);
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    const frames = await watching;

    // The same card in its slot, with the rule the answer drafted under it.
    expect(heldCard(screen, REFUND_REASON).element()).toBe(element);
    expect(element.closest('.cd-conversation__held')).toBe(slot);
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    const notice = screen.getByText(DRAFTED, { exact: true }).element();
    expect(slot.contains(notice)).toBe(true);
    expect(element.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The card eases, and its slot settles one way only, eased, to the settled card and its rule.
    expectSettledInItsSlot(frames);
  });

  it('held_request_keeps_focus', async () => {
    // The kernel's own conflict: the request changed while the owner was looking. The chat reads
    // Needs you once, and that read no longer offers Allow. Polls stay out of the way.
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { pollScale: 100 });
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    const deny = card.getByRole('button', { name: 'Deny this time' });
    await expect.element(allow).toBeVisible();
    const items = await served<NeedsYouItem[]>('needsYou', { desk_id: RIVERA.deskId });
    const changed = items.map((item) => (item.decision != null ? { ...item, decision: { ...item.decision, answers: ['deny_once'] } } : item));
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'kernel', code: 'conflict' } });
    mockStore.inject({ route: 'needsYou', status: 200, body: changed });

    // Allow had focus, and it went with Allow: focus lands on the request, under the conflict's line.
    await allow.click();
    await expect.element(allow).not.toBeInTheDocument();
    await expect.element(screen.getByRole('alert').getByText(CHANGED, { exact: true })).toBeVisible();
    await expect.element(deny).not.toHaveAttribute('aria-disabled');
    expect(focusIsOn(card.element())).toBe(true);

    // Deny goes through: the answered request keeps focus as Deny leaves.
    await deny.click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }, { answer: 'deny_once' }]);
    await expect.poll(() => focusIsOn(heldCard(screen, SEEDED_REASON).element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('held_requests_that_cant_be_read_say_so', async () => {
    // What needs the owner can't be read (the read and its one retry fail): the chat says so, with
    // a way to read it again, rather than showing a hold with nothing to answer.
    mockStore.inject({ route: 'needsYou', status: 500, times: 2 });
    const { screen } = await renderRoute(conversation(SEEDED_HOLD), { pollScale: 100 });
    // With no card under it, the hold's receipt says why itself.
    await expect.element(receipt(screen, `Held for you. ${SEEDED_REASON}`)).toBeVisible();
    const pane = screen.getByRole('region', { name: 'Visitor', exact: true });
    const line = pane.getByRole('alert').getByText(UNAVAILABLE, { exact: true });
    await expect.element(line, { timeout: 4_000 }).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Conversations' }).getByRole('alert').elements()).toHaveLength(0);
    expect(screen.getByRole('alert').elements()).toHaveLength(1);
    expect(heldCard(screen, SEEDED_REASON).elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    // Reading again works: the request is there to answer, and the line goes.
    await pane.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(line).not.toBeInTheDocument();
    // The card says why now, so the receipt over it names only the state.
    await expect.element(receipt(screen, 'Held for you')).toBeVisible();
  });

  it('paused_offers_resume', async () => {
    // Claude paused the chat after repeated blocked attempts: nobody answers until the owner acts.
    const chat = named(DANA_LIVE, DANA);
    mockStore.world.pause(chat);
    mockStore.world.reply(chat, [rivera.blocks.handoff.en], 'en');
    const { generation } = chat.state;
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const row = screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(DANA) });
    await expect.element(row.getByText('Paused after blocked attempts', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('article', { name: 'Wants you', exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText('Claude paused this chat after repeated blocked attempts.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    // No composer while paused: whispers steer no one, and her words need a take-over first.
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    // Resume Claude posts the generation she read, and Claude answers again, with whispers.
    await screen.getByRole('button', { name: 'Resume Claude' }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Whisper to Claude' })).toBeVisible();
    expect(requests('resume').map((r) => r.body)).toEqual([{ generation }]);
    expect(chat.state.mode).toBe('ai');
    await expect.element(screen.getByRole('button', { name: 'Resume Claude' })).not.toBeInTheDocument();
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('visitor_text_is_literal', async () => {
    mockStore.world.visitorText(session(DANA_LIVE), '<b>hi</b> <img src=x onerror=alert(1)>');
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const words = log(screen).getByText('<b>hi</b> <img src=x onerror=alert(1)>', { exact: true });
    await expect.element(words).toBeVisible();
    // Her words as she typed them: text, never markup, and marked as someone's own words.
    expect(log(screen).element().querySelector('b, img')).toBeNull();
    expect(words.element().closest('[data-copy="user"]')).not.toBeNull();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('translation_is_labelled', async () => {
    const chat = session(DANA_LIVE);
    mockStore.world.visitorText(chat, '¿Pueden venir el jueves por la tarde?');
    const item = chat.items.at(-1);
    if (item) item.owner_translation = 'Can you come Thursday afternoon?';
    const { screen } = await renderRoute(conversation(DANA_LIVE));

    // Her own words, then Claude's translation for the owner, labelled as Claude's.
    await expect.element(log(screen).getByText('¿Pueden venir el jueves por la tarde?', { exact: true })).toBeVisible();
    const translation = log(screen).getByText('Can you come Thursday afternoon?', { exact: true });
    await expect.element(translation).toBeVisible();
    expect(translation.element().closest('[data-copy="user"]')).not.toBeNull();
    expect(translation.element().parentElement?.textContent).toBe('Translated by Claude: Can you come Thursday afternoon?');
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('passed_handoff_card_shows_its_held_receipt_in_the_owner_transcript', async () => {
    const chat = session(DANA_LIVE);
    const ctx = mockStore.world.context(chat, 'en', 'Talk to Mike');
    const rule = SCRIPT.find((rule) => rule.name === 'talk');
    if (!rule) throw new Error('the script has its handoff row');
    for (const step of [...rule.steps, turnEnd]) mockStore.world.emit(chat, step(ctx));
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const line = receipt(screen, VISITOR_PLAIN.en.reply_handed_off);
    await expect.element(line).toBeVisible();
    expect(line.element().querySelector('.cd-status-dot--held')).not.toBeNull();
  });

  it('cards_only_failure_shows_its_handled_check_in_the_owner_transcript', async () => {
    const world = mockStore.world;
    const desk = world.desk(RIVERA.deskId);
    if (!desk) throw new Error('the copy has its Desk');
    const chat = world.addSession(desk);
    const text = 'cards-only';
    world.visitorText(chat, text);
    const ctx = world.context(chat, 'en', text);
    for (const step of [...matchRule(text).steps, turnEnd]) world.emit(chat, step(ctx));
    const { screen } = await renderRoute(conversation(chat.state.session_id));
    const card = log(screen).getByRole('article', { name: 'Quote', exact: true });
    await expect.element(card).toBeVisible();
    const line = receipt(screen, VISITOR_PLAIN.en.reply_checked);
    await expect.element(line).toBeVisible();
    expect(line.element().querySelector('.cd-status-dot--handled')).not.toBeNull();
    expect(log(screen).getByRole('article', { name: 'Handed to a person', exact: true }).elements()).toHaveLength(0);
    const row = line.element().closest('.cd-transcript-row');
    await expect.element(receipt(screen, `Automatic. ${DECISIONS.quote.reasonPlain}`)).toBeVisible();
    expect([...row!.querySelectorAll('.cd-margin-receipt')].map((receipt) => receipt.textContent)).toEqual([
      `${VISITOR_PLAIN.en.reply_checked} Open the full trace.`, `Automatic. ${DECISIONS.quote.reasonPlain} Open the full trace.`,
    ]);
  });

  it('kept_cards_with_drafted_handoff_show_the_held_line_in_the_owner_transcript', async () => {
    const world = mockStore.world;
    const desk = world.desk(RIVERA.deskId);
    if (!desk) throw new Error('the copy has its Desk');
    const chat = world.addSession(desk);
    const text = 'cards-kept-handoff';
    world.visitorText(chat, text);
    const ctx = world.context(chat, 'en', text);
    for (const step of [...matchRule(text).steps, turnEnd]) world.emit(chat, step(ctx));
    const { screen } = await renderRoute(conversation(chat.state.session_id));
    const quote = log(screen).getByRole('article', { name: 'Quote', exact: true });
    await expect.element(quote).toBeVisible();
    const line = receipt(screen, VISITOR_PLAIN.en.reply_handed_off);
    await expect.element(line).toBeVisible();
    const row = line.element().closest('.cd-transcript-row');
    expect(row?.contains(quote.element())).toBe(true);
    expect([...row!.querySelectorAll('article')].map((card) => card.getAttribute('aria-label'))).toEqual(['Quote', 'Handed to a person']);
    expect(line.element().querySelector('.cd-status-dot--held')).not.toBeNull();
    await expect.element(screen.getByRole('article', { name: 'Wants you', exact: true })).toBeVisible();
    await expect.element(receipt(screen, `Automatic. ${DECISIONS.quote.reasonPlain}`)).toBeVisible();
    expect([...row!.querySelectorAll('.cd-margin-receipt')].map((receipt) => receipt.textContent)).toEqual([
      `${VISITOR_PLAIN.en.reply_handed_off} Open the full trace.`, `Automatic. ${DECISIONS.quote.reasonPlain} Open the full trace.`,
    ]);
  });

  it('owner_receipts_show_the_kernel_reason', async () => {
    const { chat, refund, refunded, quote, booking } = danasChatWithThreeDecisions();
    const replyChecked = VISITOR_PLAIN.en.reply_checked;
    // Every receipt has words of its own, so each line below can only be the one it names.
    const words = [refund.visitor_plain, refund.reason_plain, refunded.visitor_plain, quote.visitor_plain, quote.reason_plain, booking.visitor_plain, booking.reason_plain, replyChecked];
    expect(new Set(words).size).toBe(words.length);

    const { screen } = await renderRoute(conversation(chat.state.session_id));

    // The hold, answered so no card is under it, and the quote Claude ran on its own name their
    // state in the owner's words, then say why: the kernel's reason, read once by each decision.
    await expect.element(receipt(screen, `Held for you. ${REFUND_REASON}`)).toBeVisible();
    await expect.element(receipt(screen, `Automatic. ${quote.reason_plain}`)).toBeVisible();
    expect(decisionReads(refund.decision_id)).toHaveLength(1);
    expect(decisionReads(quote.decision_id)).toHaveLength(1);

    // The refund's outcome keeps its own words, never the hold's, and reads nothing.
    await expect.element(receipt(screen, refunded.visitor_plain)).toBeVisible();
    // The booking refused when it came to run keeps its words, never the reason it was allowed.
    await expect.element(receipt(screen, booking.visitor_plain)).toBeVisible();
    expect(log(screen).getByText(booking.reason_plain, { exact: false }).elements()).toHaveLength(0);
    expect(decisionReads(booking.decision_id)).toHaveLength(0);
    // The quote's reply keeps its checked line; the refund and booking replies show a handoff.
    await expect.poll(() => receipt(screen, replyChecked).elements().length).toBe(1);
    const handedOff = receipt(screen, VISITOR_PLAIN.en.reply_handed_off);
    expect(handedOff.elements()).toHaveLength(2);
    for (const line of handedOff.elements()) expect(line.querySelector('.cd-status-dot--held')).not.toBeNull();
    // The visitor's words for the hold and the quote show nowhere: the owner's replace them.
    expect(log(screen).getByText(refund.visitor_plain, { exact: true }).elements()).toHaveLength(0);
    expect(log(screen).getByText(quote.visitor_plain, { exact: true }).elements()).toHaveLength(0);

    // Two more polls of the conversation read no decision again.
    await readsMore('conversation', 2);
    expect(requests('decision')).toHaveLength(2);
    await expectScreenBasics(screen.container, { owner: true });

    // A hold still waiting, its card right under the row, reads "Held for you" alone: the card's
    // headline already says why.
    const waiting = await renderRoute(conversation(SEEDED_HOLD));
    const card = heldCard(waiting.screen, SEEDED_REASON);
    await expect.element(card).toBeVisible();
    const held = receipt(waiting.screen, 'Held for you');
    await expect.element(held).toBeVisible();
    expect(held.element().closest('.cd-transcript-row')?.nextElementSibling?.contains(card.element())).toBe(true);
    expect(held.element().textContent).not.toContain(SEEDED_REASON);
    await expectScreenBasics(waiting.screen.container, { owner: true });

    // When the reason can't be read, the hold shows the visitor's words: never nothing.
    mockStore.inject({ route: 'decision', status: 500, times: 10 });
    const again = await renderRoute(conversation(chat.state.session_id));
    await expect.element(receipt(again.screen, refund.visitor_plain)).toBeVisible();
    await expect.element(receipt(again.screen, quote.visitor_plain)).toBeVisible();
    expect(log(again.screen).getByText(REFUND_REASON, { exact: false }).elements()).toHaveLength(0);
  });
  it('a_turn_claude_starts_explains_its_reply', async () => {
    // Dana asked for her invoice and got the verify card; she then confirmed it's her with the demo
    // code, and the API woke Claude, which released the invoice. No words of hers began that turn.
    const world = mockStore.world;
    const desk = world.desk(RIVERA.deskId);
    const invoiceRule = SCRIPT.find((rule) => rule.name === 'invoice');
    if (!desk || !invoiceRule) throw new Error("the copy has Turner's main Desk and the script its invoice row");
    const chat = world.addSession(desk);
    world.replay(chat, world.now() - MINUTE, [{ text: 'Can you send my invoice?', steps: invoiceRule.steps }]);
    expect(world.checkCode(chat, DEMO_CODE)).toBe(true);
    const woke = world.context(chat, 'en', '');
    for (const step of [...AFTER_VERIFY, turnEnd]) world.emit(chat, step(woke));

    const { screen } = await renderRoute(conversation(chat.state.session_id));
    const verifyCard = log(screen).getByRole('article', { name: "Confirm it's you" });
    const invoice = log(screen).getByRole('article', { name: 'Document, only for you' });
    await expect.element(invoice).toBeVisible();
    const rowOf = (card: typeof invoice) => card.element().closest('.cd-transcript-row');

    // The release's receipt, in the owner's words, sits under the invoice it explains, never under
    // the card that asked for the code, which keeps the receipt of the code it sent.
    const released = receipt(screen, `Automatic. ${DECISIONS.releaseInvoice.reasonPlain}`);
    const started = receipt(screen, `Automatic. ${DECISIONS.startVerification.reasonPlain}`);
    await expect.element(released).toBeVisible();
    await expect.element(started).toBeVisible();
    expect(rowOf(invoice)?.contains(released.element())).toBe(true);
    expect(rowOf(verifyCard)?.contains(released.element())).toBe(false);
    expect(rowOf(verifyCard)?.contains(started.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('a_reply_that_arrives_while_open_lands', async () => {
    const chat = named(DANA_LIVE, DANA);
    const landed = watchLandings();
    const { screen, router } = await renderRoute(conversation(DANA_LIVE));
    const quotes = () => log(screen).getByRole('article', { name: 'Quote' }).elements();
    const rowOf = (el: Element | undefined) => el?.closest('.cd-transcript-row') ?? null;

    // Opening a chat reads what happened so far: every row draws still, through the reads that follow.
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    const before = quotes().length;
    await readsMore('conversation', 2);
    expect(landed.rows()).toEqual([]);

    // Dana asks while the owner watches, and Claude answers: her words show as they come, and
    // Claude's reply lands, with its receipts.
    const world = mockStore.world;
    const price = SCRIPT.find((rule) => rule.name === 'price');
    if (!price) throw new Error('the script has its price row');
    const question = 'How much is drain clearing?';
    world.visitorText(chat, question);
    const turn = world.context(chat, 'en', question);
    for (const step of [...price.steps, turnEnd]) world.emit(chat, step(turn));
    await expect.poll(() => quotes().length).toBe(before + 1);
    const reply = rowOf(quotes().at(-1));
    expect(landed.rows()).toEqual([reply]);
    expect(reply?.querySelectorAll('.cd-margin-receipt')).toHaveLength(2);

    // It lands once: coming back to the chat draws it still.
    await router.navigate(LIST);
    await expect.element(screen.getByText('Choose a conversation to read it.', { exact: true })).toBeVisible();
    expect(log(screen).elements()).toHaveLength(0);
    await router.navigate(conversation(DANA_LIVE));
    await expect.poll(() => quotes().length).toBe(before + 1);
    await readsMore('conversation', 2);
    expect(landed.rows()).toHaveLength(1);
  });

  it('the_owners_live_view_reveals_a_new_reply_and_draws_what_happened_whole', async () => {
    const chat = named(DANA_LIVE, DANA);
    const revealed = watchRevealing();
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    await readsMore('conversation', 2);
    // What happened so far is drawn whole: none of Claude's replies in it is revealed.
    expect(log(screen).element().querySelectorAll('.cd-claude-message').length).toBeGreaterThan(0);
    expect(revealed()).toEqual([]);

    // Dana asks while the owner watches, and Claude's reply comes in as Dana sees it: its words, then
    // its quote card a beat after them, then its two receipts a beat apart.
    const reply = watchReveal();
    priceTurn(chat, 'How much is drain clearing?');
    expectRevealed(await reply, { cards: [0.12], lines: [0.24, 0.36] });
    expect(revealed()).toHaveLength(1);
  });

  it('a_reply_that_came_while_away_draws_still', async () => {
    const chat = named(DANA_LIVE, DANA);
    const landed = watchLandings();
    const { screen, router } = await renderRoute(conversation(DANA_LIVE));
    const quotes = () => log(screen).getByRole('article', { name: 'Quote' }).elements();
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    const before = quotes().length;

    // The owner goes back to the list, and Dana asks and gets her answer meanwhile. Back on the
    // chat, the page shows the read it had first, then the reply where it belongs, drawn still: it
    // came while the owner was away.
    await router.navigate(LIST);
    await expect.element(screen.getByText('Choose a conversation to read it.', { exact: true })).toBeVisible();
    priceTurn(chat, 'How much is drain clearing?');
    await router.navigate(conversation(DANA_LIVE));
    await expect.poll(() => quotes().length).toBe(before + 1);
    await readsMore('conversation', 1);
    expect(landed.rows()).toEqual([]);

    // A reply that arrives while the owner reads lands.
    priceTurn(chat, 'And for two drains?');
    await expect.poll(() => quotes().length).toBe(before + 2);
    expect(landed.rows()).toEqual([quotes().at(-1)?.closest('.cd-transcript-row')]);
  });

  it('a_receipt_shown_before_its_reply_doesnt_land_again', async () => {
    const chat = named(DANA_LIVE, DANA);
    const landed = watchLandings();
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const quotes = () => log(screen).getByRole('article', { name: 'Quote' }).elements();
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    const before = quotes().length;

    // Dana asks, and Claude's turn starts as the API's do: it writes, then runs the quote. A read
    // before the reply shows the quote's receipt under her question.
    const world = mockStore.world;
    const price = SCRIPT.find((rule) => rule.name === 'price');
    if (!price) throw new Error('the script has its price row');
    const question = 'How much is drain clearing?';
    world.visitorText(chat, question);
    const turn = world.context(chat, 'en', question);
    const rest = [...price.steps];
    let quoted = false;
    while (!quoted) {
      const step = rest.shift();
      if (!step) throw new Error('the price row runs the quote before its reply');
      const ev = step(turn);
      world.emit(chat, ev);
      quoted = ev.type === 'receipt';
    }
    const asked = () => log(screen).getByText(question, { exact: true }).element().closest('.cd-transcript-row');
    await expect.poll(() => asked()?.querySelectorAll('.cd-margin-receipt').length ?? 0).toBe(1);
    // It shows the kernel's short line until the owner's read of its decision answers, then the
    // decision's state and reason: the line the owner reads.
    const shown = () => asked()?.querySelector('.cd-margin-receipt')?.textContent ?? '';
    await expect.poll(shown).toMatch(/^Automatic\. /);
    const read = shown();

    // The reply comes, and the receipt moves under it, after the reply's own check. The reply is
    // revealed, and its own check waits for its words, then follows its quote card; the receipt the
    // owner has already read shows at once, and never waits.
    const revealed = watchReveal();
    for (const step of [...rest, turnEnd]) world.emit(chat, step(turn));
    const frames = await revealed;
    await expect.poll(() => quotes().length).toBe(before + 1);
    const reply = quotes().at(-1)?.closest('.cd-transcript-row');
    if (!reply) throw new Error('the reply has its row');
    expect(landed.rows()).toEqual([reply]);
    const lines = [...reply.querySelectorAll('.cd-margin-receipt')];
    expect(lines).toHaveLength(2);
    expect(lines[1]?.textContent).toBe(read);
    const waiting = frames.filter((frame) => frame.revealing);
    expect(waiting.length).toBeGreaterThan(0);
    for (const frame of waiting) expect(frame.lines.map((line) => line.visibility)).toEqual(['hidden', 'visible']);
    expect(frames.find((frame) => !frame.revealing)?.lines).toEqual([
      { visibility: 'visible', name: 'cd-transcript-row-follow', delay: '0.24s' },
      { visibility: 'visible', name: 'none', delay: '0s' },
    ]);
  });

  it('the_owners_own_words_never_land', async () => {
    const chat = named(DANA_LIVE, DANA);
    const landed = watchLandings();
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    await readsMore('conversation', 1);

    // The owner takes over and writes: her words show in her own view as she sent them, still.
    const words = 'I can come by at four today.';
    mockStore.world.takeOver(chat);
    mockStore.world.say(chat, words);
    await expect.element(log(screen).getByText(words, { exact: true })).toBeVisible();
    expect(landed.rows()).toEqual([]);
  });

  it('a_recorded_chat_never_lands', async () => {
    // The seeded visitor's chat, replayed from the recorded history, whose next read has one more reply.
    const read = await served<OwnerTranscript>('conversation', { session_id: SEEDED_HOLD });
    const delivered = read.items.findLast((item) => item.kind === 'delivered' && item.event?.type === 'message');
    if (delivered?.event?.type !== 'message') throw new Error("the seeded visitor's chat has a reply");
    const n = Math.max(...read.items.map((item) => item.n)) + 1;
    const later = { ...delivered, n, event: { ...delivered.event, message_id: 'msg-recorded-later' } };
    mockStore.inject({ route: 'conversation', status: 200, times: 1, body: { ...read, replayed: true } });
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...read, replayed: true, items: [...read.items, later] } });

    const landed = watchLandings();
    const { screen } = await renderRoute(conversation(SEEDED_HOLD));
    const rows = () => log(screen).element().querySelectorAll('.cd-transcript-row:not(.cd-transcript-header)');
    await expect.element(screen.getByText('Recorded history, replayed into your copy. It happened before you arrived.', { exact: true })).toBeVisible();
    const shownFirst = rows().length;
    // The reply the next read adds shows where it belongs, and draws still: nothing in a recorded chat arrives live.
    await expect.poll(() => rows().length).toBe(shownFirst + 1);
    expect(landed.rows()).toEqual([]);
  });

  it('answer_row_follows_the_decided_look', async () => {
    // The seeded 15% hold, from a visitor not on record, held by a limit: two plain answers.
    const seeded = await renderRoute(conversation(SEEDED_HOLD));
    const limitHold = heldCard(seeded.screen, SEEDED_REASON);
    await expect.element(limitHold).toBeVisible();
    const plain = limitHold.getByRole('group', { name: 'Your answer' }).getByRole('button');
    expect(plain.elements().map((b) => b.textContent)).toEqual(['Allow this time', 'Deny this time']);
    expect(plain.elements().some((b) => b.hasAttribute('aria-haspopup'))).toBe(false);
    expect(plain.elements()[1]?.classList.contains('cd-button--danger')).toBe(true);
    expect(seeded.screen.container.textContent).not.toContain('Or save a rule');
    await expectScreenBasics(seeded.screen.container, { owner: true });

    // Dana's refund, verified, held by an ask card: all four answers, two in each menu.
    const refund = mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(conversation(refund.session_id));
    const card = heldCard(screen, REFUND_REASON);
    await expect.element(card).toBeVisible();
    const allow = card.getByRole('button', { name: 'Allow', exact: true });
    const deny = card.getByRole('button', { name: 'Deny', exact: true });
    await expect.element(allow).toHaveAttribute('aria-haspopup', 'menu');
    await expect.element(deny).toHaveAttribute('aria-haspopup', 'menu');
    expect(deny.element().classList.contains('cd-button--danger')).toBe(true);

    await allow.click();
    const allowMenu = screen.getByRole('menu', { name: 'Allow' });
    expect(allowMenu.getByRole('menuitem').elements().map((item) => item.firstElementChild?.textContent)).toEqual([
      'This time',
      `Only for ${DANA}, always`,
    ]);
    await userEvent.keyboard('{Escape}');

    await deny.click();
    const denyMenu = screen.getByRole('menu', { name: 'Deny' });
    expect(denyMenu.getByRole('menuitem').elements().map((item) => item.firstElementChild?.textContent)).toEqual(['This time', 'Always']);
    await denyMenu.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'deny_always' }]);
    expect(screen.container.textContent).not.toContain('Or save a rule');
    // "Always" saved nothing yet: as on Today, the rule it drafted waits for her review.
    await expect.element(screen.getByText('Your answer also drafted a rule. Review it before it applies.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Review the rule' })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });
  });
  it('answer_menus_open_whole_at_the_end_of_a_long_chat', async () => {
    // Dana's refund held, a chat longer than the window after it, then a second refund held near
    // its end, where an answer menu reaches past the foot of the transcript's scroll region.
    const first = mockStore.world.addHeldRefund();
    lengthen(session(first.session_id));
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(conversation(first.session_id));
    const cards = heldCard(screen, REFUND_REASON);
    await expect.poll(() => cards.elements().length).toBe(2);
    const transcript = scrollerOf(log(screen).element());
    transcript.scrollTop = transcript.scrollHeight;
    await expect.poll(() => transcript.scrollTop + transcript.clientHeight).toBeGreaterThanOrEqual(transcript.scrollHeight - 1);

    // Each menu opens with both of its answers in view, the second as well as the one focus lands on.
    for (const side of ['Allow', 'Deny'] as const) {
      await cards.last().getByRole('button', { name: side, exact: true }).click();
      const items = screen.getByRole('menu', { name: side }).getByRole('menuitem');
      await expect.poll(() => items.elements().length).toBe(2);
      await expect.element(items.first()).toBeInViewport({ ratio: 1 });
      await expect.element(items.last()).toBeInViewport({ ratio: 1 });
      await userEvent.keyboard('{Escape}');
      await expect.element(items.first()).not.toBeInTheDocument();
    }
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('visitor_typing_shows_a_bubble', async () => {
    const chat = named(DANA_LIVE, DANA);
    const { screen } = await renderRoute(conversation(DANA_LIVE));
    const bubble = log(screen).getByRole('status').filter({ hasText: `${DANA} is typing` });
    const [first] = rivera.conversations.danaLive.turns.flatMap((t) => (t.kind === 'visitor' ? [t.text] : []));
    await expect.element(log(screen).getByText(first ?? '', { exact: true })).toBeVisible();
    // Nobody is typing: no dots, and the screen never guesses.
    expect(bubble.elements()).toHaveLength(0);

    // A read that says she is typing: one bubble at the end of the chat, on her side, with no words.
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble).toBeInTheDocument();
    expect(bubble.elements()).toHaveLength(1);
    expect(bubble.element().classList.contains('cd-writing-indicator--bubble')).toBe(true);
    expect(bubble.element().textContent?.replace(/\s+/g, ' ').trim()).toBe(`${DANA} is typing`);
    const rows = log(screen).element().querySelectorAll('.cd-transcript-row');
    expect(rows[rows.length - 1]?.contains(bubble.element())).toBe(true);
    await expectScreenBasics(screen.container, { owner: true });

    // The next read says she isn't: gone within a poll.
    chat.typingUntil = null;
    await expect.poll(() => bubble.elements().length, { timeout: 1_000 }).toBe(0);

    // She types again, then sends: her message takes the bubble's place, even while the API still
    // reports the signal she sent before it.
    chat.visitorTypedAt = null;
    mockStore.world.visitorTyping(chat);
    await expect.element(bubble, { timeout: 1_000 }).toBeInTheDocument();
    const until = chat.typingUntil;
    mockStore.world.visitorText(chat, 'Thursday works too.');
    chat.typingUntil = until;
    await expect.element(log(screen).getByText('Thursday works too.', { exact: true })).toBeVisible();
    await expect.poll(() => bubble.elements().length, { timeout: 1_000 }).toBe(0);

    // The API's word stands, never this browser's clock: a signal whose time this clock has
    // already passed (it may run ahead of the API's) still shows while the read carries it.
    chat.typingUntil = null;
    const read = await served<OwnerTranscript>('conversation', { session_id: DANA_LIVE });
    const behind = new Date(Date.now() - 60_000).toISOString();
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...read, typing_until: behind } });
    await expect.element(bubble, { timeout: 1_000 }).toBeInTheDocument();
    await readsMore('conversation', 2);
    expect(bubble.elements()).toHaveLength(1);
  });

  it('owner_typing_is_sent_after_take_over', async () => {
    const chat = named(DANA_LIVE, DANA);
    // Pings go at most every 2 s, scaled. No poll lands, and the clock the pings are timed by moves
    // only when the test moves it, so how long typing takes in the browser never changes how many go.
    const { screen } = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    /** Moves the clock past the interval between pings. */
    const intervalPasses = () => vi.advanceTimersByTime(typingPingMs());
    const pings = () => requests('ownerTyping');
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // A whisper is for Claude: typing one tells Dana nothing.
    await screen.getByRole('textbox', { name: 'Whisper to Claude' }).fill('offer Thursday');
    await wait(200);
    expect(pings()).toHaveLength(0);

    // In the chat she took over, her typing reaches Dana as her name and dots, never her words.
    await screen.getByRole('button', { name: 'Take over' }).click();
    const box = screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(box).toBeVisible();
    const streamed = chat.events.length;
    await userEvent.type(box, 'On my');
    await expect.poll(() => pings().length).toBe(1);
    expect(pings().map((r) => r.body)).toEqual([{ generation: chat.state.generation }]);
    expect(chat.events.slice(streamed).map(({ ev }) => ev)).toEqual([{ type: 'owner_typing', name: OWNER, until: expect.any(String) as string }]);

    // More keystrokes within the interval send no more; after it, one more.
    await userEvent.type(box, ' way');
    expect(pings()).toHaveLength(1);
    intervalPasses();
    await userEvent.type(box, ' now');
    await expect.poll(() => pings().length).toBe(2);
    await wait(200);
    expect(pings()).toHaveLength(2);

    // An emptied composer sends nothing.
    intervalPasses();
    await box.clear();
    await wait(200);
    expect(pings()).toHaveLength(2);

    // Sending ends it: nothing more goes once her words have.
    await userEvent.type(box, 'Be there soon');
    await expect.poll(() => pings().length).toBe(3);
    await userEvent.keyboard('{Enter}');
    await expect.element(log(screen).getByText('Be there soon', { exact: true })).toBeVisible();
    intervalPasses();
    await wait(200);
    expect(pings()).toHaveLength(3);

    // Words the screen puts back in the box (the reply check stopped them) aren't typing.
    mockStore.inject({ route: 'ownerMessage', status: 200, body: { message_id: 'msg-stopped', verdict: { ok: false }, ledger_seq: 1 } });
    await userEvent.type(box, 'It is $89.');
    await expect.poll(() => pings().length).toBe(4);
    await userEvent.keyboard('{Enter}');
    await expect.element(box).toHaveValue('It is $89.');
    intervalPasses();
    await wait(300);
    expect(pings()).toHaveLength(4);
    await box.clear();

    // The API turns a ping back (take over first): no line, one read of the chat, and no more
    // pings for the chat as it was read. Polls stay out of the way while the reads are counted.
    const again = await renderRoute(conversation(DANA_LIVE), { pollScale: 100 });
    const write = again.screen.getByRole('textbox', { name: 'Write to them' });
    await expect.element(write).toBeVisible();
    mockStore.inject({ route: 'ownerTyping', status: 409, body: { error: 'take_over_first' } });
    const reads = requests('conversation').length;
    await userEvent.type(write, 'Still');
    await expect.poll(() => pings().length).toBe(5);
    await expect.poll(() => requests('conversation').length).toBe(reads + 1);
    intervalPasses();
    await userEvent.type(write, ' there');
    await wait(300);
    expect(pings()).toHaveLength(5);
    expect(requests('conversation')).toHaveLength(reads + 1);
    expect(again.screen.getByRole('alert').elements()).toHaveLength(0);
    await expectScreenBasics(again.screen.container, { owner: true });
  });

  it('recorded_conversations_are_tagged', async () => {
    const label = 'Includes recorded history';
    const note = 'Recorded history, replayed into your copy. It happened before you arrived.';
    /** The list's rows, newest first: Dana's live chat, the seeded visitor's, then Alex Kim's assistant's. */
    const rowsOf = (screen: RenderResult) => screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^(?!Includes)/ });
    const tagsIn = (row: Element) => [...row.querySelectorAll('span')].filter((span) => span.textContent?.trim() === 'Recorded');
    named(DANA_LIVE, DANA);

    // A copy with no recorded history says nothing of it: no caption, no tag, no note.
    const plain = await renderRoute(conversation(SEEDED_HOLD));
    await expect.element(plain.screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
    await expect.poll(() => rowsOf(plain.screen).elements()).toHaveLength(3);
    expect(plain.screen.getByRole('link', { name: label }).elements()).toHaveLength(0);
    expect(rowsOf(plain.screen).elements().flatMap(tagsIn)).toHaveLength(0);
    expect(plain.screen.getByText(/^Recorded history/).elements()).toHaveLength(0);

    // The seeded visitor's chat replayed from the recorded history into this copy; Dana's is live.
    const list = await served<ConversationSummary[]>('conversations', { desk_id: RIVERA.deskId });
    const chat = await served<OwnerTranscript>('conversation', { session_id: SEEDED_HOLD });
    mockStore.inject({
      route: 'conversations',
      status: 200,
      times: 10_000,
      body: list.map((s) => (s.session_id === SEEDED_HOLD ? { ...s, replayed: true } : s)),
    });
    mockStore.inject({ route: 'conversation', status: 200, times: 10_000, body: { ...chat, replayed: true } });
    const { screen, router } = await renderRoute(conversation(SEEDED_HOLD));

    // "Recorded", with its history icon, at the end of the replayed row's status line only.
    await expect.poll(() => rowsOf(screen).elements()).toHaveLength(3);
    const [live, replayed] = rowsOf(screen).elements();
    expect(live?.textContent).toContain(DANA);
    expect(tagsIn(live as Element)).toHaveLength(0);
    const tags = tagsIn(replayed as Element);
    expect(tags).toHaveLength(1);
    const tag = tags[0] as HTMLElement;
    expect(tag.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(tag.parentElement?.lastElementChild).toBe(tag);

    // The page says so under its title, linking to the record where each replayed entry says so.
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const link = nav.getByRole('link', { name: label });
    await expect.element(link).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(getComputedStyle(link.element()).textDecorationLine).toBe('underline');
    const title = nav.getByRole('heading', { level: 1, name: 'Conversations' }).element();
    expect(title.compareDocumentPosition(link.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The open chat says it happened before she arrived, with the history icon, between its head
    // and the transcript.
    const line = screen.getByText(note, { exact: true });
    await expect.element(line).toBeVisible();
    const noteLine = line.element().closest('p');
    expect(noteLine).not.toBeNull();
    expect((noteLine as HTMLElement).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const head = screen.getByRole('heading', { level: 2, name: 'Visitor' }).element();
    expect(head.compareDocumentPosition(noteLine as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((noteLine as HTMLElement).compareDocumentPosition(log(screen).element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No one is on the other side of a recorded chat: nothing to take over, whisper or write.
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Visitor' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over' }).elements()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Resume Claude' }).elements()).toHaveLength(0);
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: true });

    await link.click();
    await expect.poll(() => `${router.state.location.pathname}${router.state.location.search}`).toBe(`${DESK}/safety?view=entries`);
  });

  it('conversations_fit_a_phone', async () => {
    const last = lengthen(named(DANA_LIVE, DANA));
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(LIST, { viewport: 'phone' });

    // The list has the page to itself.
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    await expect.element(list.getByRole('link', { name: new RegExp(DANA) }).first()).toBeVisible();
    expect(screen.getByText('Choose a conversation to read it.').elements().every((el) => el.getClientRects().length === 0)).toBe(true);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    // A conversation, with its held request and the owner's controls, then has it, with a way back.
    await list.getByRole('link', { name: new RegExp(`^${DANA}`) }).first().click();
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeVisible();
    // The list steps aside: hidden from sight and from the accessibility tree alike.
    expect(list.elements()).toHaveLength(0);
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    // Read to its end, the chat scrolls on its own there too: the way back and the chat's head stay
    // in view above it, and the owner's controls under it.
    const latest = log(screen).getByText(last, { exact: true });
    latest.element().scrollIntoView({ block: 'end' });
    await expect.element(latest).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('link', { name: 'All conversations' })).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('heading', { level: 2, name: DANA })).toBeInViewport({ ratio: 1 });
    await expect.element(screen.getByRole('button', { name: 'Take over' })).toBeInViewport({ ratio: 1 });
    const main = screen.getByRole('main').element();
    expect(scrollerOf(latest.element())).not.toBe(main);
    expect(main.scrollHeight).toBeLessThanOrEqual(main.clientHeight);
    expectNoWindowScroll();
    await screen.getByRole('link', { name: 'All conversations' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(LIST);
    await expect.element(list).toBeVisible();
  });
});
