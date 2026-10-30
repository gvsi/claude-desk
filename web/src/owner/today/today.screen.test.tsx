/**
 * Today in a real browser against the mock API: what needs the owner (held requests answered in
 * place, callbacks to join), who is live now, what happened since last night with its full list,
 * and the last 7 days, every figure as the API reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult } from 'vitest-browser-react';

import type { Decision } from '../../api/contracts.ts';
import type { BriefingItem, BriefingList, NeedsYouItem, ThisWeek, Today } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { CALLBACK_REASON } from '../../mocks/script.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectScreenBasics } from '../../test/screen.ts';

const TODAY = `/app/${RIVERA.deskId}/today`;
const DESK = `/app/${RIVERA.deskId}`;
const LA = 'America/Los_Angeles';

const SEEDED_REASON = rivera.decisions.held.reason_plain;
const SEEDED_RULE = 'Quotes from your price list, at list price.';
const REFUND_REASON = rivera.heldRefund.reason_plain;

const DRAFTED = 'Your answer also drafted a rule. Review it before it applies.';
const UNCERTAIN = "I couldn't confirm your answer went through. Try again; it can't run twice.";
const LIMIT_LINE = "That's above your limit for taking money without asking. Allow it this time, or change the limit on Rules.";
const NOT_OFFERED = "That answer isn't available for this request.";

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Today as the mock reads it now, changed by `patch`, answering every read of it from here on. */
async function injectToday(patch: (today: Today) => Today): Promise<void> {
  const answer = await mockStore.dispatch('today', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Today');
  mockStore.inject({ route: 'today', status: 200, times: 10_000, body: patch(answer.body as Today) });
}

/** The held requests the mock has for the main Desk now. */
async function heldItems(): Promise<NeedsYouItem[]> {
  const answer = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
  if ('network' in answer || answer.status !== 200) throw new Error('the mock reads Needs you');
  return (answer.body as NeedsYouItem[]).filter((item) => item.decision !== undefined);
}

/** The seeded hold as the kernel has it now. */
function seededHold(): Decision {
  const held = [...mockStore.world.decisions.values()].find((d) => d.decision.reason_plain === SEEDED_REASON);
  if (!held) throw new Error('the seed holds the 15% quote');
  return held.decision;
}

/** A visitor's chat on the public page, as a new tab would send it. */
async function visitorSays(text: string): Promise<void> {
  await mockStore.dispatch('openSession', { params: { slug: RIVERA.slug } });
  await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text } });
}

function region(screen: RenderResult, name: string) {
  return screen.getByRole('region', { name, exact: true });
}

/** A held request's card, by what was asked. */
function heldCard(screen: RenderResult, reason: string) {
  return screen.getByRole('article', { name: `Held for you: ${reason}`, exact: true });
}

/** Waits for `key` to be read `n` more times than now. */
async function readsMore(key: string, n: number): Promise<void> {
  const from = requests(key).length;
  await expect.poll(() => requests(key).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(from + n);
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const REFUSAL: BriefingItem = {
  kind: 'blocked',
  at: minutesAgo(30),
  session_id: 'ses-agent-1',
  display_name: null,
  ref_id: 'dec-refused-1',
  line: 'An agent tried to book without a signed limit. Nothing was booked.',
};
const BOOKING: BriefingItem = {
  kind: 'booking',
  at: minutesAgo(60),
  session_id: 'ses-dana-web',
  display_name: 'Dana Whitfield',
  ref_id: 'dec-dana-book',
  line: 'A visitor booked Tuesday, November 3 at 2:00 pm, inside your weekday hours.',
};
const ANSWER: BriefingItem = {
  kind: 'answer',
  at: minutesAgo(90),
  session_id: 'ses-dana-verified',
  display_name: 'Dana Whitfield',
  ref_id: 'ses-dana-verified',
  line: null,
};

const ZERO_DAYS = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((date) => ({
  date,
  conversations: 0,
  bookings: 0,
  stopped: 0,
}));

function week(fields: Partial<ThisWeek>): ThisWeek {
  return {
    timezone: LA,
    start: '2026-10-23',
    end: '2026-10-29',
    bookings: 0,
    booked_cents: 0,
    conversations: 0,
    handled: 0,
    stepped_in: 0,
    stopped: 0,
    days: ZERO_DAYS,
    ...fields,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Today', () => {
  it('sections_show_in_order', async () => {
    const { screen } = await renderRoute(TODAY);
    const needs = region(screen, 'Needs you');
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Live now')).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();

    const order = screen
      .getByRole('heading', { level: 2 })
      .elements()
      .map((h) => h.textContent)
      .filter((text) => ['Needs you', 'Live now', 'Since last night'].includes(text ?? ''));
    expect(order).toEqual(['Needs you', 'Live now', 'Since last night']);

    // One held request, with the rule that held it and what was asked.
    await expect.element(needs.getByRole('img', { name: '1 needs you' })).toBeVisible();
    const card = heldCard(screen, SEEDED_REASON);
    await expect.element(card.getByText(`Held by your rule: ${SEEDED_RULE}`, { exact: true })).toBeVisible();
    // A limit hold offers the two one-time answers, each its own plain button.
    const answers = card.getByRole('group', { name: 'Your answer' }).getByRole('button');
    expect(answers.elements().map((b) => b.textContent)).toEqual(['Allow this time', 'Deny this time']);
    expect(answers.elements().some((b) => b.hasAttribute('aria-haspopup'))).toBe(false);
    await expectScreenBasics(screen.container, { owner: true });

    // "Open the request" brings that card into focus.
    const things = region(screen, 'Things to try');
    await things.getByRole('button', { name: 'Open the request' }).click();
    expect(document.activeElement?.contains(card.element())).toBe(true);

    // A newer hold the API lists first still comes after the oldest one, here and in Things to try.
    const [seeded] = await heldItems();
    if (!seeded?.decision) throw new Error('the seed holds a request');
    const newer: NeedsYouItem = {
      ...seeded,
      decision: { ...seeded.decision, decision_id: 'dec-newer', reason_plain: 'A visitor asked to book Sunday at 10:00 pm.' },
      held_by: 'Bookings in your weekday hours.',
      held_at: new Date().toISOString(),
    };
    mockStore.inject({ route: 'needsYou', status: 200, times: 10_000, body: [newer, seeded] });
    await expect.element(heldCard(screen, 'A visitor asked to book Sunday at 10:00 pm.')).toBeVisible();
    await expect.element(needs.getByRole('img', { name: '2 need you' })).toBeVisible();
    const cards = needs.getByRole('article').elements().map((a) => a.getAttribute('aria-label'));
    expect(cards).toEqual([`Held for you: ${SEEDED_REASON}`, 'Held for you: A visitor asked to book Sunday at 10:00 pm.']);
    await expect
      .element(things.getByText(`A request is waiting for your answer. Held by your rule: ${SEEDED_RULE}`, { exact: true }))
      .toBeVisible();
    (document.activeElement as HTMLElement | null)?.blur();
    await things.getByRole('button', { name: 'Open the request' }).click();
    expect(document.activeElement?.contains(heldCard(screen, SEEDED_REASON).element())).toBe(true);
  });

  it('quiet_today_leaves_out_empty_sections', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText('A quiet night', { exact: true })).toBeVisible();
    await expect.element(since.getByText('Nothing new since 6:00 pm yesterday.', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Quiet right now.', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Last 7 days' })).toBeVisible();
    // Polls come and go, and the empty sections stay away.
    await readsMore('today', 2);
    await readsMore('needsYou', 2);
    expect(screen.getByRole('heading', { name: 'Needs you' }).elements()).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Live now' }).elements()).toHaveLength(0);
    expect(since.getByRole('link', { name: /^See all/ }).elements()).toHaveLength(0);
  });

  it('no_ask_claude_composer_on_today', async () => {
    const { screen } = await renderRoute(TODAY);
    await expect.element(heldCard(screen, SEEDED_REASON)).toBeVisible();
    await expect.element(region(screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    expect(document.querySelectorAll('textarea, input[type="text"], [role="textbox"], .cd-composer')).toHaveLength(0);
    expect(screen.getByRole('textbox').elements()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Ask Claude/i);
    expect(document.querySelectorAll('[aria-label*="Ask Claude" i], [placeholder*="Ask Claude" i]')).toHaveLength(0);
  });

  it('briefing_shows_one_row_per_kind', async () => {
    await injectToday((t) => ({ ...t, briefing: { ...t.briefing, total: 3, newest: { blocked: REFUSAL, booking: BOOKING, lead_or_answer: ANSWER } } }));
    const { screen } = await renderRoute(TODAY);
    const since = region(screen, 'Since last night');
    await expect.element(since.getByText(REFUSAL.line ?? '', { exact: true })).toBeVisible();
    const rows = since.getByRole('listitem');
    expect(rows.elements()).toHaveLength(3);
    const now = new Date();
    const [blocked, booked, answered] = rows.elements();

    expect(blocked?.textContent).toContain('Blocked');
    expect(blocked?.textContent).toContain(formatWhen(REFUSAL.at, LA, now));
    const refusal = since.getByRole('link', { name: new RegExp(REFUSAL.line ?? '') });
    await expect.element(refusal).toHaveAttribute('href', `${DESK}/safety/dec-refused-1`);

    expect(booked?.textContent).toContain('Booked');
    expect(booked?.textContent).toContain('Dana Whitfield');
    expect(booked?.textContent).toContain(BOOKING.line);
    expect(booked?.textContent).toContain(formatWhen(BOOKING.at, LA, now));
    expect(booked?.querySelector('a')?.getAttribute('href')).toBe(`${DESK}/conversations/ses-dana-web`);

    expect(answered?.textContent).toContain('Answered');
    expect(answered?.textContent).toContain('Claude answered Dana Whitfield.');
    expect(answered?.textContent).toContain(formatWhen(ANSWER.at, LA, now));
    expect(answered?.querySelector('a')?.getAttribute('href')).toBe(`${DESK}/conversations/ses-dana-verified`);

    // Names may come from a visitor: each is their own text.
    for (const row of [booked, answered]) {
      const name = [...(row?.querySelectorAll('[data-copy="user"]') ?? [])].map((el) => el.textContent);
      expect(name).toContain('Dana Whitfield');
    }
    await expect.element(since.getByRole('link', { name: 'See all 3' })).toBeVisible();

    // A blocked reply has no line of its own, and a night with no booking leaves its row out.
    mockStore.reset('rivera');
    await injectToday((t) => ({
      ...t,
      briefing: { ...t.briefing, total: 2, newest: { blocked: { ...REFUSAL, ref_id: '41', line: null }, booking: null, lead_or_answer: ANSWER } },
    }));
    const again = await renderRoute(TODAY);
    const night = region(again.screen, 'Since last night');
    await expect.element(night.getByText('A reply was stopped before it was shown.', { exact: true })).toBeVisible();
    const kinds = night.getByRole('listitem').elements().map((row) => (row.textContent?.includes('Blocked') ? 'Blocked' : 'Answered'));
    expect(kinds).toEqual(['Blocked', 'Answered']);
    expect(night.getByText('Booked').elements()).toHaveLength(0);
    await expect.element(night.getByRole('link', { name: /A reply was stopped/ })).toHaveAttribute('href', `${DESK}/safety/41`);
  });

  it('see_all_opens_the_full_briefing', async () => {
    const items: BriefingItem[] = [
      { ...REFUSAL, at: minutesAgo(10) },
      { ...ANSWER, at: minutesAgo(20), ref_id: 'ses-a', session_id: 'ses-a', display_name: null },
      { ...BOOKING, at: minutesAgo(30) },
      { kind: 'lead', at: minutesAgo(40), session_id: 'ses-b', display_name: 'Dana Wells', ref_id: 'lead-1', line: '(503) 555-0142 · Leaking water heater' },
      { ...REFUSAL, at: minutesAgo(50), ref_id: 'dec-refused-2' },
      { ...ANSWER, at: minutesAgo(60), ref_id: 'ses-c', session_id: 'ses-c', display_name: null },
    ];
    await injectToday((t) => ({
      ...t,
      briefing: { ...t.briefing, total: 6, newest: { blocked: items[0] ?? null, booking: items[2] ?? null, lead_or_answer: items[1] ?? null } },
    }));
    const list: BriefingList = { since: '2026-10-28T18:00:00-07:00', items };
    mockStore.inject({ route: 'briefing', status: 200, times: 10_000, body: list });
    const { screen, router } = await renderRoute(TODAY);

    await region(screen, 'Since last night').getByRole('link', { name: 'See all 6' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/today/briefing`);
    await expect.element(screen.getByRole('heading', { level: 1, name: 'Since last night' })).toBeVisible();
    const rows = screen.getByRole('list', { name: 'Since last night, newest first' }).getByRole('listitem');
    await expect.poll(() => rows.elements().length).toBe(6);
    const now = new Date();
    expect(rows.elements().map((row) => items.findIndex((item) => row.textContent?.includes(formatWhen(item.at, LA, now))))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    await expect.element(screen.getByText('Claude answered a visitor.').first()).toBeVisible();
    await expect.element(screen.getByText('New lead')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', TODAY);
    // The full list is read once, not polled.
    await readsMore('today', 2);
    expect(requests('briefing')).toHaveLength(1);
    await expectScreenBasics(screen.container, { owner: true });

    await screen.getByRole('link', { name: 'Back to Today' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(TODAY);
  });

  it('this_week_shows_the_api_figures', async () => {
    const days = ZERO_DAYS.map((d, i) => ({ ...d, conversations: i, bookings: i === 4 || i === 6 ? 1 : 0, stopped: i === 5 ? 2 : 0 }));
    await injectToday((t) => ({
      ...t,
      this_week: week({ bookings: 2, booked_cents: 37_800, conversations: 4, handled: 3, stepped_in: 1, stopped: 2, days }),
    }));
    const { screen } = await renderRoute(TODAY);
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('$378 booked', { exact: true })).toBeVisible();
    await expect.element(block.getByText('2 bookings, 1 so far today', { exact: true })).toBeVisible();

    const bars = block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem');
    expect(bars.elements()).toHaveLength(7);
    expect(bars.elements().map((bar) => bar.querySelector('.cd-sr-only')?.textContent)).toEqual([
      'Fri: no bookings',
      'Sat: no bookings',
      'Sun: no bookings',
      'Mon: no bookings',
      'Tue: 1 booking',
      'Wed: no bookings',
      'Thu: 1 booking',
    ]);
    expect(bars.elements().map((bar) => bar.querySelector('[aria-hidden="true"].cd-week__initial')?.textContent)).toEqual([
      'F',
      'S',
      'S',
      'M',
      'T',
      'W',
      'T',
    ]);
    // Today is the last bar, and the busiest days stand taller than the flat ones.
    expect(bars.elements().map((bar) => bar.getAttribute('aria-current'))).toEqual([null, null, null, null, null, null, 'date']);
    const height = (i: number) => bars.elements()[i]?.querySelector('.cd-week__bar')?.getBoundingClientRect().height ?? 0;
    expect(height(4)).toBeGreaterThan(height(0) * 4);
    expect(height(6)).toBe(height(4));

    await expect.element(block.getByText('Claude handled 3', { exact: true })).toBeVisible();
    await expect.element(block.getByText('You stepped in 1 time', { exact: true })).toBeVisible();
    await expect.element(block.getByText('2 stopped', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('link', { name: 'Open Safety' })).toHaveAttribute('href', `${DESK}/safety`);

    // The block shows the API's figures and adds none of its own.
    const heading = block.getByRole('heading', { level: 2 }).element();
    const text = [...block.element().childNodes].map((node) => (node.contains(heading) ? '' : node.textContent)).join(' ');
    const numbers = new Set(text.match(/\d+/g));
    expect([...numbers].sort()).toEqual(['1', '2', '3', '378']);
    await expectScreenBasics(screen.container, { owner: true });
  });

  it('this_week_empty_states', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    const block = region(screen, 'Last 7 days');
    await expect.element(block.getByText('No bookings in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
    const bars = block.getByRole('list', { name: 'Bookings per day' }).getByRole('listitem');
    expect(bars.elements()).toHaveLength(7);
    const heights = bars.elements().map((bar) => bar.querySelector('.cd-week__bar')?.getBoundingClientRect().height ?? -1);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[0]).toBeLessThanOrEqual(4);
    const bookings = block.getByRole('heading', { name: 'Bookings', exact: true }).element().closest('.cd-week__part');
    expect(bookings?.querySelector('a')).toBeNull();
    await expect.element(block.getByText('No conversations in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByText('No attempts in the last 7 days.', { exact: true })).toBeVisible();
    await expect.element(block.getByRole('link', { name: 'Open Safety' })).toHaveAttribute('href', `${DESK}/safety`);
    expect(block.getByText(/Claude handled/).elements()).toHaveLength(0);

    // Claude handled every conversation, and none needed the owner.
    mockStore.reset('rivera_quiet');
    await injectToday((t) => ({ ...t, this_week: week({ conversations: 3, handled: 3, stepped_in: 0 }) }));
    const handled = await renderRoute(TODAY);
    const again = region(handled.screen, 'Last 7 days');
    await expect.element(again.getByText('Claude handled 3', { exact: true })).toBeVisible();
    await expect.element(again.getByText('No one has needed you in the last 7 days.', { exact: true })).toBeVisible();
    expect(again.getByText(/You stepped in/).elements()).toHaveLength(0);
  });

  it('recorded_history_label', async () => {
    const label = 'Includes recorded history';
    await injectToday((t) => ({ ...t, recorded_history: { needs_you: true, briefing: true, this_week: false } }));
    const { screen } = await renderRoute(TODAY);
    const since = region(screen, 'Since last night');
    await expect.element(since.getByRole('link', { name: label })).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(screen.getByRole('link', { name: label }).elements()).toHaveLength(1);
    // Beside the heading, before the night's rows.
    const link = since.getByRole('link', { name: label }).element();
    const firstRow = since.getByRole('listitem').first().element();
    expect(link.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    mockStore.reset('rivera');
    await injectToday((t) => ({ ...t, recorded_history: { briefing: true, this_week: true } }));
    const both = await renderRoute(TODAY);
    await expect.element(region(both.screen, 'Last 7 days').getByRole('link', { name: label })).toHaveAttribute('href', `${DESK}/safety?view=entries`);
    expect(both.screen.getByRole('link', { name: label }).elements()).toHaveLength(2);

    const none = await renderRoute(TODAY, { seed: 'rivera' });
    await expect.element(region(none.screen, 'Since last night').getByRole('listitem').first()).toBeVisible();
    await expect.element(none.screen.getByRole('heading', { level: 2, name: 'Last 7 days' })).toBeVisible();
    expect(none.screen.getByRole('link', { name: label }).elements()).toHaveLength(0);
  });

  it('own_chat_shows_under_live_now', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await expect.element(screen.getByText('A quiet night', { exact: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Live now' }).elements()).toHaveLength(0);

    // The owner's new tab opens a preview of this Desk and writes in it.
    await mockStore.dispatch('openPreview', { params: { desk_id: RIVERA.deskId } });
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Do you work weekends?' } });
    const live = region(screen, 'Live now');
    await expect.element(live, { timeout: 2_000 }).toBeVisible();
    const row = live.getByRole('link', { name: /Your preview/ });
    await expect.element(row).toBeVisible();
    await expect.element(row.getByText('Your own preview', { exact: true })).toBeVisible();
    const preview = mockStore.visitorSession(RIVERA.slug);
    await expect.element(row).toHaveAttribute('href', `${DESK}/conversations/${preview?.state.session_id ?? ''}`);
    // It's the owner, so the greeting still says no one else is here.
    await expect.element(screen.getByText('Quiet right now.', { exact: true })).toBeVisible();
  });

  it('allow_once_executes_and_updates', async () => {
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_once' }]);
    // The visitor's chat hears the outcome.
    const decisionId = seededHold().decision_id;
    const visitor = mockStore.world.sessions.get(seededHold().session_id);
    await expect
      .poll(() => visitor?.events.some(({ ev }) => ev.type === 'resolved' && ev.decision_id === decisionId), { timeout: 2_000 })
      .toBe(true);
    // Nothing is held now, so Things to try no longer offers it.
    await expect.element(screen.getByRole('button', { name: 'Open the request' })).not.toBeInTheDocument();
  });

  it('answer_conflict_shows_final_state', async () => {
    const { screen } = await renderRoute(TODAY);
    const held = seededHold();
    mockStore.inject({ route: 'answer', status: 409, body: { error: 'already_resolved', decision: { ...held, state: 'expired', answers: [] } } });
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText('This request expired before you answered. Nothing was done.', { exact: true })).toBeVisible();
    expect(region(screen, 'Needs you').getByRole('alert').elements()).toHaveLength(0);
    expect(card.getByRole('button', { name: /Allow|Deny/ }).elements()).toHaveLength(0);
  });

  it('lost_answer_is_not_called_held', async () => {
    const { screen } = await renderRoute(TODAY);
    // The answer goes through, but its answer is lost on the way back.
    mockStore.inject({ route: 'answer', status: 'network', afterCommit: true });
    const card = heldCard(screen, SEEDED_REASON);
    const allow = card.getByRole('button', { name: 'Allow this time' });
    await allow.click();
    await expect.element(card.getByText(UNCERTAIN, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('still held');
    await expect.element(allow).not.toHaveAttribute('aria-disabled');
    // Needs you reads again and the request has gone from it; its card stays to be asked again.
    await readsMore('needsYou', 2);
    await expect.element(card.getByText(UNCERTAIN, { exact: true })).toBeVisible();

    // Asking again can't run it twice: the API answers with where it stands.
    await allow.click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    expect(requests('answer')).toHaveLength(2);
    expect(card.getByRole('alert').elements()).toHaveLength(0);
  });

  it('answered_card_survives_refetch', async () => {
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, SEEDED_REASON);
    await card.getByRole('button', { name: 'Allow this time' }).click();
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    await readsMore('needsYou', 2);
    await expect.element(card.getByText("You allowed this. It's done.", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Answered just now' })).toBeVisible();

    // Dismissed, it goes.
    await region(screen, 'Needs you').getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(card).not.toBeInTheDocument();
  });

  it('rule_draft_from_answer_links_to_review', async () => {
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);
    await card.getByRole('button', { name: 'Deny' }).click();
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText('You denied this.', { exact: true })).toBeVisible();
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'deny_always' }]);

    const notice = screen.getByText(DRAFTED, { exact: true });
    await expect.element(notice).toBeVisible();
    await screen.getByRole('button', { name: 'Review the rule' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/rules/drafts/8`);
    expect(requests('draftRules')).toHaveLength(1);
    const body = requests('draftRules')[0]?.body as { add: { mode: string; who: string; person_id: string; applies_to: string }[] };
    expect(body.add).toHaveLength(1);
    expect(body.add[0]).toMatchObject({ mode: 'never', who: 'person', person_id: rivera.people.dana.personId, applies_to: 'payments.create_refund' });
    expect(router.state.location.state).toMatchObject({ cardDiff: body.add, draft: { version: 8 } });
  });

  it('held_request_appears_without_reload', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await expect.element(screen.getByText('A quiet night', { exact: true })).toBeVisible();
    await visitorSays('50% off if I pay cash');
    await expect.element(screen.getByRole('article', { name: /^Held for you: / }), { timeout: 2_000 }).toBeVisible();
    await expect.element(region(screen, 'Needs you').getByRole('button', { name: 'Allow this time' })).toBeVisible();
  });

  it('handoff_offers_to_join', async () => {
    const { screen, router } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await visitorSays('Can you call me back?');
    const wants = screen.getByRole('article', { name: 'Wants you' });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    await expect.element(wants.first().getByText(CALLBACK_REASON, { exact: true })).toBeVisible();
    expect(wants.first().getByText(CALLBACK_REASON).element().closest('[data-copy="user"]')).not.toBeNull();
    await expect.element(wants.first().getByText("You'll call back on Monday, between 8:00 am and 9:00 am.", { exact: true })).toBeVisible();
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Please call me tonight' } });
    await expect.poll(() => wants.elements().length, { timeout: 2_000 }).toBe(2);
    await expect.element(wants.nth(1).getByText("You'll call back. No time was promised.", { exact: true })).toBeVisible();
    await expectScreenBasics(screen.container, { owner: true });

    // Joining reads the chat, takes it over at the generation read, and opens it.
    const session = mockStore.visitorSession(RIVERA.slug);
    const sessionId = session?.state.session_id ?? '';
    const generation = session?.state.generation;
    await wants.first().getByRole('button', { name: 'Join the chat' }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${DESK}/conversations/${sessionId}`);
    expect(requests('takeover').map((r) => r.body)).toEqual([{ generation }]);
    expect(requests('conversation').length).toBeGreaterThan(0);
    expect(router.state.location.state).toBeNull();

    // A take-over that fails still opens the chat, with the reason there.
    const again = await renderRoute(TODAY);
    mockStore.inject({ route: 'takeover', status: 503 });
    await again.screen.getByRole('article', { name: 'Wants you' }).first().getByRole('button', { name: 'Join the chat' }).click();
    await expect.poll(() => again.router.state.location.pathname).toBe(`${DESK}/conversations/${sessionId}`);
    expect(again.router.state.location.state).toEqual({ notice: 'Something went wrong on our side. Try again in a moment.' });
  });

  it('handoff_done_clears_the_card', async () => {
    const { screen } = await renderRoute(TODAY, { seed: 'rivera_quiet' });
    await visitorSays('Can you call me back?');
    const wants = screen.getByRole('article', { name: 'Wants you' });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    const [handoffId] = [...mockStore.world.handoffs.keys()];
    await wants.first().getByRole('button', { name: 'Mark done' }).click();
    await expect.element(wants.first()).not.toBeInTheDocument();
    expect(requests('handoffDone').map((r) => r.path)).toEqual([`/api/owner/handoffs/${handoffId ?? ''}/done`]);
    expect(screen.getByRole('heading', { name: 'Needs you' }).elements()).toHaveLength(0);

    // Someone else closed it first: Today reads again and says nothing went wrong.
    await mockStore.dispatch('sendMessage', { params: { slug: RIVERA.slug }, body: { text: 'Can you call me back?' } });
    await expect.element(wants.first(), { timeout: 2_000 }).toBeVisible();
    mockStore.inject({ route: 'handoffDone', status: 409, body: { error: 'kernel', code: 'conflict' } });
    const reads = requests('needsYou').length;
    await wants.first().getByRole('button', { name: 'Mark done' }).click();
    await expect.poll(() => requests('handoffDone').length).toBe(2);
    await expect.poll(() => requests('needsYou').length).toBeGreaterThan(reads);
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
  });

  it('allow_person_above_the_limit_says_so', async () => {
    mockStore.world.addHeldRefund();
    const { screen } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);

    // The limit was lowered after Today was read: the kernel no longer offers this answer.
    mockStore.inject({ route: 'answer', status: 422, body: { error: 'kernel', code: 'invalid' } });
    await card.getByRole('button', { name: 'Allow' }).click();
    await screen.getByRole('menuitem', { name: 'Only for Dana Whitfield, always' }).click();
    await expect.element(card.getByText(LIMIT_LINE, { exact: true })).toBeVisible();
    await expect.element(card.getByRole('button', { name: 'Allow' })).not.toHaveAttribute('aria-disabled');

    mockStore.inject({ route: 'answer', status: 422, body: { error: 'kernel', code: 'invalid' } });
    await card.getByRole('button', { name: 'Deny' }).click();
    await screen.getByRole('menuitem', { name: 'Always' }).click();
    await expect.element(card.getByText(NOT_OFFERED, { exact: true })).toBeVisible();
    expect(card.getByText(LIMIT_LINE).elements()).toHaveLength(0);
    await expect.element(card.getByRole('button', { name: 'Deny' })).not.toHaveAttribute('aria-disabled');
    expect(requests('answer').map((r) => r.body)).toEqual([{ answer: 'allow_person' }, { answer: 'deny_always' }]);
  });

  it('card_diff_above_the_limit_says_so', async () => {
    mockStore.world.addHeldRefund();
    const { screen, router } = await renderRoute(TODAY);
    const card = heldCard(screen, REFUND_REASON);
    await card.getByRole('button', { name: 'Allow' }).click();
    await screen.getByRole('menuitem', { name: 'Only for Dana Whitfield, always' }).click();
    await expect.element(screen.getByText(DRAFTED, { exact: true })).toBeVisible();

    mockStore.inject({ route: 'draftRules', status: 422, body: { error: 'above_money_cap', cap_cents: 0 } });
    await screen.getByRole('button', { name: 'Review the rule' }).click();
    await expect
      .element(screen.getByText("You haven't set a limit for taking money without asking. Set one first.", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("That didn't go through. Check it and try again.");
    expect(router.state.location.pathname).toBe(TODAY);
  });
});
