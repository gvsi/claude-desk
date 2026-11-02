/**
 * The demo visitor in a real browser against the mock API: Today's "Watch a demo visitor" card that
 * starts one and opens its conversation, its start error, the five cards' layout, the "Demo
 * visitor" pill on its row, its conversation's head and wherever Needs you names it, the note over
 * its conversation with Stop, and how the note says it ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent, type Locator } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import { SCRIPT } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const TODAY = `/app/${RIVERA.deskId}/today`;
const CARD_TITLE = 'Watch a demo visitor';
const CARD_DETAIL = 'An AI plays a customer on your Desk. Take over or whisper to Claude while it chats.';
const START_FAILED = 'The demo visitor couldn’t start. Try again in a few minutes.';
const NOTE = 'A demo visitor, played by an AI. Take over or whisper to see how Claude responds.';
const STOP = 'Stop the demo visitor';
const FINISHED = 'The demo visitor finished.';
const STOPPED = 'You stopped the demo visitor.';
const LIST = `/app/${RIVERA.deskId}/conversations`;

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

function region(screen: RenderResult, name: string) {
  return screen.getByRole('region', { name, exact: true });
}

/** What starts the demo visitor: from 640 px the card's own button; on a phone the whole row, named by its title. */
function startControl(things: Locator, viewport: Viewport): Locator {
  return viewport === 'phone'
    ? things.getByRole('button', { name: CARD_TITLE, exact: true })
    : things.getByRole('button', { name: 'Start a demo visitor', exact: true });
}

/** Starts the demo visitor through the owner's route, as a click on the card would: its start answer. */
async function startOne(key: string): Promise<{ run_id: string; desk_id: string; session_id: string }> {
  const started = await mockStore.dispatch('startDemoVisitor', { params: { desk_id: RIVERA.deskId }, body: { idempotency_key: key } });
  if ('network' in started || started.status !== 202) throw new Error('the demo visitor starts');
  return started.body as { run_id: string; desk_id: string; session_id: string };
}

/** The note over the open conversation that says it's a demo visitor's. */
function demoNote(screen: RenderResult): Locator {
  return screen.getByRole('status').filter({ hasText: /demo visitor/ });
}

/** The demo visitor's chats in the mock copy, newest last. */
function demoChats() {
  return [...mockStore.world.sessions.values()].filter((chat) => chat.demoVisitor != null);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Demo visitor', () => {
  it.each(['desktop', 'phone'] as const)('the_card_starts_a_demo_visitor_and_opens_its_conversation_on_%s', async (viewport: Viewport) => {
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const things = region(screen, 'Things to try');
    const title = things.getByRole('heading', { level: 3, name: CARD_TITLE });
    await expect.element(title).toBeVisible();
    // The second card, after "Chat as a customer", with its line.
    const items = [...things.element().querySelectorAll('.cd-things__item')];
    expect(items.map((item) => item.querySelector('h3')?.textContent)).toEqual([
      'Chat as a customer',
      CARD_TITLE,
      'Try to break it',
      'Answer a held request',
      'Create your own Desk',
    ]);
    await expect.element(things.getByText(CARD_DETAIL, { exact: true })).toBeVisible();
    expectNoHorizontalScroll();

    // From 640 px the card's own button starts it; on a phone the whole row does, named by its title.
    await startControl(things, viewport).click();

    await expect.poll(() => demoChats().length).toBe(1);
    const chat = demoChats()[0]!;
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/conversations/${chat.state.session_id}`);
    const [sent] = requests('startDemoVisitor');
    expect(sent?.body).toEqual({ idempotency_key: expect.any(String) });
    expect(requests('startDemoVisitor')).toHaveLength(1);
  });

  it.each(['desktop', 'phone'] as const)('a_start_that_fails_says_so_as_an_alert_and_the_button_stays_on_%s', async (viewport: Viewport) => {
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    // Too many starts this hour, today's budget spent, a run that couldn't open its chat, or anything
    // else: each says the same line, after a refused dot, read out as an alert.
    const failures = [
      { status: 429, body: { error: 'rate_limited', retry_after: 1200 } },
      { status: 503, body: { error: 'demo_budget' } },
      { status: 503, body: { error: 'demo_visitor_unavailable' } },
      { status: 500, body: { error: 'internal' } },
    ];
    for (const [i, failure] of failures.entries()) {
      mockStore.inject({ route: 'startDemoVisitor', ...failure });
      await startControl(things, viewport).click();
      await expect.poll(() => requests('startDemoVisitor').length).toBe(i + 1);
      const alert = things.getByRole('alert');
      await expect.element(alert).toHaveTextContent(START_FAILED);
      expect(alert.element().querySelector('.cd-status-dot--refused'), 'its refused dot').not.toBeNull();
      // The line stands where the card's own line was, and the button stays to try again.
      await expect.element(things.getByText(CARD_DETAIL, { exact: true })).not.toBeInTheDocument();
      await expect.element(startControl(things, viewport)).toBeVisible();
    }
    expect(router.state.location.pathname).toBe(TODAY);
    expect(demoChats()).toHaveLength(0);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });

    // The next try goes through.
    await startControl(things, viewport).click();
    await expect.poll(() => demoChats().length).toBe(1);
    await expect.poll(() => router.state.location.pathname).toBe(`/app/${RIVERA.deskId}/conversations/${demoChats()[0]!.state.session_id}`);
  });

  it.each([
    [1440, 900, 3],
    [1280, 800, 3],
    [1279, 800, 2],
    [800, 900, 2],
    [640, 900, 2],
    [390, 844, 1],
  ])('the_five_things_lay_out_at_%sx%s_%s_across', async (width, height, across) => {
    const { screen } = await renderRoute(TODAY, { viewport: { width, height } });
    const things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    const items = [...things.element().querySelectorAll('.cd-things__item')];
    expect(items).toHaveLength(5);
    const tops = items.map((item) => Math.round(item.getBoundingClientRect().top));
    const lefts = items.map((item) => Math.round(item.getBoundingClientRect().left));
    // Rows of `across`: each row's cards share a top, and each starts a new one under the last.
    const rows = Math.ceil(5 / across);
    for (let row = 0; row < rows; row += 1) {
      const inRow = tops.slice(row * across, row * across + across);
      expect(new Set(inRow).size, `row ${row + 1} shares its top`).toBe(1);
      if (row > 0) expect(inRow[0]!, `row ${row + 1} is under row ${row}`).toBeGreaterThan(tops[(row - 1) * across]!);
    }
    expect(new Set(lefts).size, 'columns').toBe(across);
    expectNoHorizontalScroll();
  });

  it('the_card_is_done_once_a_demo_visitor_has_run', async () => {
    const { screen, router } = await renderRoute(TODAY);
    let things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    await expect.element(things.getByText('About 10 minutes. No real customer sees any of it.', { exact: true })).toBeVisible();
    await startControl(things, 'desktop').click();
    await expect.poll(() => demoChats().length).toBe(1);
    await expect.poll(() => router.state.location.pathname).not.toBe(TODAY);

    // Back on Today, it is ticked off like the others: its check, its own line kept, and a Done pill read out.
    await router.navigate(TODAY);
    things = region(screen, 'Things to try');
    await expect.element(things.getByText('1 of 5 done. No real customer sees any of it.', { exact: true })).toBeVisible();
    const card = things.getByRole('heading', { level: 3, name: CARD_TITLE }).element().closest('.cd-things__item')!;
    expect(card.querySelector('.cd-things__done')?.textContent).toBe('Done');
    expect(card.querySelector('.cd-things__done')?.getAttribute('aria-hidden')).toBeNull();
    expect(card.textContent).toContain(CARD_DETAIL);
    expect(card.querySelector('button, a'), 'no next step once done').toBeNull();
  });

  it('a_demo_visitor_started_from_a_second_desk_ticks_the_card', async () => {
    const second = `/app/${RIVERA.emergenciesDeskId}/today`;
    const { screen, router } = await renderRoute(second, { seed: 'rivera_two_desks' });
    let things = region(screen, 'Things to try');
    await expect.element(things.getByRole('heading', { level: 3, name: CARD_TITLE })).toBeVisible();
    await startControl(things, 'desktop').click();
    await expect.poll(() => router.state.location.pathname).toContain(`/app/${RIVERA.emergenciesDeskId}/conversations/`);
    expect(demoChats()[0]!.deskId).toBe(RIVERA.emergenciesDeskId);

    // Back on that Desk's Today, its card is done, as it would be on the first Desk's.
    await router.navigate(second);
    things = region(screen, 'Things to try');
    const card = () => things.getByRole('heading', { level: 3, name: CARD_TITLE }).element().closest('.cd-things__item');
    await expect.poll(() => card()?.querySelector('.cd-things__done')?.textContent ?? null, { timeout: 5_000 }).toBe('Done');
    expect(card()?.querySelector('button, a'), 'no next step once done').toBeNull();
  });

  it.each(['desktop', 'phone'] as const)('its_row_and_its_head_say_demo_visitor_on_%s', async (viewport: Viewport) => {
    const { session_id: sessionId } = await startOne('row-and-head');
    const { screen, router } = await renderRoute(LIST, { viewport });
    // The row: the persona's first name, then the pill right after it on the row's top line.
    const row = screen.getByRole('link', { name: /^Riley Demo visitor/ });
    await expect.element(row).toBeVisible();
    const top = row.element().querySelector('.cd-conversation-item__top')!;
    const name = top.querySelector('.cd-conversation-item__name')!;
    const pill = top.querySelector('.cd-pill')!;
    expect(pill.textContent).toBe('Demo visitor');
    expect(name.nextElementSibling).toBe(pill);
    expect(pill.getBoundingClientRect().left - name.getBoundingClientRect().right).toBeCloseTo(8, 0);
    // A real visitor's row has none.
    expect(document.querySelectorAll('.cd-conversation-item .cd-pill')).toHaveLength(1);
    expectNoHorizontalScroll();

    // Its conversation's head: the name, "Public", then "Demo visitor".
    await router.navigate(`${LIST}/${sessionId}`);
    const head = screen.getByRole('heading', { level: 2, name: 'Riley' });
    await expect.element(head).toBeVisible();
    const pills = [...head.element().closest('header')!.querySelectorAll('.cd-pill')].map((el) => el.textContent);
    expect(pills).toEqual(['Public', 'Demo visitor']);
    await expect.element(demoNote(screen)).toMatchTextContent(NOTE);
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: true });
  });

  it.each(['desktop', 'phone'] as const)('the_note_says_who_plays_it_and_stop_ends_it_on_%s', async (viewport: Viewport) => {
    const { screen, router } = await renderRoute(TODAY, { viewport });
    await startControl(region(screen, 'Things to try'), viewport).click();
    await expect.poll(() => router.state.location.pathname).toContain('/conversations/');
    const note = demoNote(screen);
    await expect.element(note).toMatchTextContent(NOTE);
    // 8 px under the head, over the transcript.
    const head = screen.getByRole('heading', { level: 2, name: 'Riley' }).element().closest('header')!;
    expect(note.element().getBoundingClientRect().top - head.getBoundingClientRect().bottom).toBeCloseTo(8, 0);
    expect(note.element().querySelector('.cd-status-dot--info'), 'its hollow dot').not.toBeNull();
    const stop = note.getByRole('button', { name: STOP, exact: true });
    await expect.element(stop).toBeVisible();
    expectNoHorizontalScroll();

    // Its typing shows as anyone's does, and its words arrive.
    await expect.poll(() => demoChats()[0]!.items.filter((item) => item.kind === 'visitor_text').length, { timeout: 5_000 }).toBeGreaterThan(0);

    await stop.click();
    await expect.poll(() => requests('stopDemoVisitor').length).toBe(1);
    const [stopped] = requests('stopDemoVisitor');
    expect(stopped?.path).toMatch(/\/demo_visitor\/visitor-[^/]+\/stop$/);
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    expect(demoNote(screen).getByRole('button').elements()).toHaveLength(0);
    // Focus doesn't fall to the page as Stop goes: it goes to the conversation's name.
    await expect.element(screen.getByRole('heading', { level: 2, name: 'Riley' })).toHaveFocus();
    // Nothing more comes from it.
    const said = demoChats()[0]!.items.filter((item) => item.kind === 'visitor_text').length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(demoChats()[0]!.items.filter((item) => item.kind === 'visitor_text')).toHaveLength(said);
    expectNoHorizontalScroll();
  });

  it.each(['finished', 'owner_silent', 'limit', 'chat_ended', 'failed', 'budget'] as const)('the_note_says_the_demo_visitor_finished_when_it_ended_%s', async (ended) => {
    const { session_id: sessionId, run_id: runId } = await startOne(`ended-${ended}`);
    const opened = await renderRoute(`${LIST}/${sessionId}`);
    await expect.element(demoNote(opened.screen)).toMatchTextContent(NOTE);
    // It ended on its own, or for any reason but Stop: the same line, with no button.
    mockStore.demoVisitors.endRun(runId, ended);
    await expect.element(demoNote(opened.screen)).toHaveTextContent(FINISHED);
    expect(demoNote(opened.screen).getByRole('button').elements()).toHaveLength(0);
    // The row keeps its tag.
    await expect.element(opened.screen.getByRole('link', { name: /^Riley Demo visitor/ })).toBeVisible();
  });

  it('a_run_the_api_no_longer_keeps_ends_the_note', async () => {
    const { session_id: sessionId } = await startOne('gone');
    const { screen } = await renderRoute(`${LIST}/${sessionId}`);
    await expect.element(demoNote(screen)).toMatchTextContent(NOTE);
    // The API restarted, or its record of the run expired: the run reads 404 from now on. The note
    // says it has ended, with no Stop that can't work.
    mockStore.inject({ route: 'demoVisitorRun', status: 404, times: 10_000 });
    await expect.element(demoNote(screen)).toHaveTextContent(FINISHED);
    expect(demoNote(screen).getByRole('button').elements()).toHaveLength(0);
  });

  it('a_run_stopped_here_still_says_so_once_the_api_no_longer_keeps_it', async () => {
    const { session_id: sessionId } = await startOne('stopped-then-gone');
    const { screen, router } = await renderRoute(`${LIST}/${sessionId}`);
    await demoNote(screen).getByRole('button', { name: STOP, exact: true }).click();
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    // Its record goes; the conversation, opened again in this tab, reads 404 and still says the owner stopped it.
    mockStore.inject({ route: 'demoVisitorRun', status: 404, times: 10_000 });
    await router.navigate(LIST);
    await expect.element(screen.getByText('Choose a conversation to read it.')).toBeVisible();
    await router.navigate(`${LIST}/${sessionId}`);
    await expect.poll(() => requests('demoVisitorRun').filter((r) => r.path.includes('/demo_visitor/visitor-')).length).toBeGreaterThan(1);
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
  });

  it('an_older_conversation_opened_afresh_reads_its_own_ending', async () => {
    // The first demo visitor is stopped and a second one runs on the Desk now; then the first
    // conversation opens in a new tab, with nothing this tab learned before.
    const first = await startOne('first');
    await mockStore.dispatch('stopDemoVisitor', { params: { desk_id: RIVERA.deskId, run_id: first.run_id } });
    await startOne('second');
    const { screen } = await renderRoute(`${LIST}/${first.session_id}`);
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    expect(requests('demoVisitorRun').some((r) => r.path.endsWith(`/demo_visitor/${first.run_id}`))).toBe(true);
  });

  it('a_demo_chat_whose_reads_name_no_run_reads_as_ended', async () => {
    // A chat marked before its mark named its run: its own run can't be read, so it has ended for the page,
    // which reads no other run in its place.
    const { session_id: sessionId } = await startOne('unnamed');
    demoChats()[0]!.demoVisitorRun = null;
    const { screen } = await renderRoute(`${LIST}/${sessionId}`);
    await expect.element(demoNote(screen)).toHaveTextContent(FINISHED);
    expect(demoNote(screen).getByRole('button').elements()).toHaveLength(0);
    expect(requests('demoVisitor')).toHaveLength(0);
  });

  it('an_older_conversation_keeps_its_own_ending', async () => {
    // The first demo visitor is stopped; a second one runs on the Desk now.
    const first = await startOne('first');
    await mockStore.dispatch('stopDemoVisitor', { params: { desk_id: RIVERA.deskId, run_id: first.run_id } });
    const { screen, router } = await renderRoute(`${LIST}/${first.session_id}`);
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    const second = await startOne('second');
    await router.navigate(`${LIST}/${second.session_id}`);
    await expect.element(demoNote(screen)).toMatchTextContent(NOTE);
    // Back on the first, it still says how it ended, read by its own run.
    await router.navigate(`${LIST}/${first.session_id}`);
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    expect(requests('demoVisitorRun').some((r) => r.path.endsWith(`/demo_visitor/${first.run_id}`))).toBe(true);
  });

  it.each(['desktop', 'phone'] as const)('needs_you_tags_the_demo_visitors_held_request_on_%s', async (viewport: Viewport) => {
    const { session_id: sessionId } = await startOne('needs-you');
    // Its discount ask is held for the owner.
    await expect
      .poll(() => [...mockStore.world.decisions.values()].some(({ decision }) => decision.session_id === sessionId && decision.state === 'held'), { timeout: 8_000 })
      .toBe(true);
    const { screen } = await renderRoute(TODAY, { viewport });
    const needsYou = screen.getByRole('region', { name: 'Needs you' });
    const cards = needsYou.getByRole('article');
    await expect.poll(() => cards.elements().length).toBe(2);
    const tagged = cards.elements().filter((card) => card.querySelector('.cd-pill')?.textContent === 'Demo visitor');
    // Only the demo visitor's request, beside where it came from; the seeded visitor's has none.
    expect(tagged).toHaveLength(1);
    const pill = tagged[0]!.querySelector('.cd-pill')!;
    expect(pill.closest('.cd-approval-card__top')).not.toBeNull();
    expect(tagged[0]!.textContent).toContain('Could I get 10% off as a returning customer?');
    expectNoHorizontalScroll();
  });

  it.each(['desktop', 'phone'] as const)('since_last_night_and_people_tag_the_demo_visitors_booking_and_lead_on_%s', async (viewport: Viewport) => {
    const { run_id: runId, session_id: sessionId } = await startOne('briefing');
    // It books, at the end of its lines, and has left a lead.
    await expect.poll(() => mockStore.demoVisitors.read(runId)?.state, { timeout: 10_000 }).toBe('done');
    const world = mockStore.world;
    world.leads.push({ leadId: 'lead-riley', deskId: RIVERA.deskId, sessionId, displayName: 'Riley Morgan', note: 'Kitchen sink leak', createdAt: world.now() });
    const { screen, router } = await renderRoute(TODAY, { viewport });
    const since = screen.getByRole('region', { name: 'Since last night' });
    const booked = since.getByRole('link').filter({ hasText: 'Booked' });
    await expect.element(booked).toBeVisible();
    // The demo visitor's booking: named by its persona, with the pill beside the name.
    const pill = booked.element().querySelector('.cd-briefing-row__who .cd-pill');
    expect(booked.element().querySelector('.cd-briefing-row__who')?.textContent).toBe('RileyDemo visitor');
    expect(pill?.textContent).toBe('Demo visitor');
    expectNoHorizontalScroll();

    await router.navigate(`/app/${RIVERA.deskId}/people`);
    const leadRow = () => [...document.querySelectorAll('.cd-lead-row')].find((row) => row.querySelector('.cd-lead-row__name')?.textContent === 'Riley Morgan');
    await expect.poll(() => leadRow()?.querySelector('.cd-pill')?.textContent ?? null).toBe('Demo visitor');
    // A real visitor's lead has none.
    expect(document.querySelectorAll('.cd-lead-row .cd-pill')).toHaveLength(1);
    expectNoHorizontalScroll();
  });

  it('needs_you_tags_the_demo_visitors_handoff_too', async () => {
    const { run_id: runId } = await startOne('handoff');
    mockStore.demoVisitors.endRun(runId, 'finished');
    const chat = demoChats()[0]!;
    // Its chat asks for a call back, which opens a handoff for the owner.
    const callback = SCRIPT.find((rule) => rule.name === 'callback');
    if (!callback) throw new Error('the script has its call-back row');
    mockStore.world.replay(chat, mockStore.world.now() - 30_000, [{ text: 'Can you call me back?', steps: callback.steps }], 10_000);
    const { screen } = await renderRoute(TODAY);
    const wants = screen.getByRole('region', { name: 'Needs you' }).getByRole('article', { name: 'Wants you' });
    await expect.element(wants).toBeVisible();
    const pill = wants.element().querySelector('.cd-callback__top .cd-pill');
    expect(pill?.textContent).toBe('Demo visitor');
    expectNoHorizontalScroll();
  });

  it('the_card_and_stop_take_the_keyboard_by_their_names', async () => {
    const { screen, router } = await renderRoute(TODAY);
    const things = region(screen, 'Things to try');
    const start = things.getByRole('button', { name: 'Start a demo visitor', exact: true });
    await expect.element(start).toBeVisible();
    // The card's button is the stop after "Open your public page", and Enter starts it.
    (things.getByRole('link', { name: 'Open your public page', exact: true }).element() as HTMLElement).focus();
    await userEvent.tab();
    await expect.element(start).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => router.state.location.pathname).toContain('/conversations/');

    // In its conversation, Stop is the first stop after the conversation's name, named by its words.
    const name = screen.getByRole('heading', { level: 2, name: 'Riley' });
    const stop = screen.getByRole('button', { name: STOP, exact: true });
    await expect.element(stop).toBeVisible();
    (name.element() as HTMLElement).focus();
    await userEvent.tab();
    await expect.element(stop).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(demoNote(screen)).toHaveTextContent(STOPPED);
    await expect.element(name).toHaveFocus();
  });

  it('on_a_phone_the_row_is_named_by_its_title_and_described_by_its_line', async () => {
    const { screen } = await renderRoute(TODAY, { viewport: 'phone' });
    const things = region(screen, 'Things to try');
    const row = things.getByRole('button', { name: CARD_TITLE, exact: true });
    await expect.element(row).toBeVisible();
    await expect.element(row).toHaveAccessibleDescription(CARD_DETAIL);
    // After a start that failed, the row is described by the line that says so.
    mockStore.inject({ route: 'startDemoVisitor', status: 503, body: { error: 'demo_budget' } });
    await row.click();
    await expect.element(things.getByRole('alert')).toHaveTextContent(START_FAILED);
    await expect.element(row).toHaveAccessibleDescription(START_FAILED);
  });
});
