/**
 * The public chat page in a real browser against the mock API: Rivera Plumbing's Desk as a
 * stranger sees it, with the kernel's checked replies, the receipts under each message, a held
 * request they can cancel, the open status in the header and what happens when things fail.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { RenderResult } from 'vitest-browser-react';

import type { EvMessage, OpenStatus, PublicDesk, SseEvent } from '../api/contracts.ts';
import { typingPingMs } from '../app/poll.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { CHAT_ENDED_COPY, NEW_CHAT_LABEL, RATE_LIMITED_COPY, UNREACHABLE_COPY } from '../ds/index.ts';
import { worker } from '../mocks/browser.ts';
import { HELD_PROSE, SCRIPT, matchRule, type RuleName } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { VIEWPORTS, renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../test/screen.ts';

const PAGE = `/d/${RIVERA.slug}`;

/** The app's own name in the tab, as index.html sets it (the test browser's page has its own). */
const APP_TITLE = 'Claude Desk';

/** The requests a route got, by key. */
const requests = (key: string) => mockStore.requests.filter((r) => r.key === key);

/** Every event this browser's chat with Rivera has carried, in order. */
function chatEvents(): { seq: number; ev: SseEvent }[] {
  return mockStore.visitorSession(RIVERA.slug)?.events ?? [];
}

const messagesOf = (events: { ev: SseEvent }[]) => events.flatMap(({ ev }) => (ev.type === 'message' ? [ev] : []));

/** The messages the page shows from Claude, the Desk or a person. */
const shownMessages = () => document.querySelectorAll('.cd-claude-message, .cd-person-message');

/** Waits for the chat to load: its composer can be typed in. */
async function ready(screen: RenderResult): Promise<void> {
  await expect.element(screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / })).toBeEnabled();
}

/** Types `text` and sends it, then waits for the turn to end and the page to show all of it. */
async function say(screen: RenderResult, text: string): Promise<void> {
  const before = chatEvents().length;
  await screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / }).fill(text);
  await screen.getByRole('button', { name: /^(?:Send|Enviar)$/ }).click();
  await turnEnded(before);
}

/** Types `text` and sends it, without waiting for an answer. */
async function type(screen: RenderResult, text: string): Promise<void> {
  await screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / }).fill(text);
  await screen.getByRole('button', { name: /^(?:Send|Enviar)$/ }).click();
}

/** Waits until the chat's stream has carried a turn's end past `before`, and the page shows every message. */
async function turnEnded(before: number): Promise<void> {
  await vi.waitFor(
    () => {
      const events = chatEvents();
      expect(events.length).toBeGreaterThan(before);
      expect(events.at(-1)?.ev.type).toBe('turn_end');
    },
    { timeout: 5_000 },
  );
  await vi.waitFor(() => {
    expect(shownMessages()).toHaveLength(messagesOf(chatEvents()).length);
    expect(document.querySelector('.cd-writing-indicator')).toBeNull();
  });
}

/** The row (`.cd-transcript-row`) holding `el`. */
function rowOf(el: Element): HTMLElement {
  const row = el.closest<HTMLElement>('.cd-transcript-row');
  if (!row) throw new Error('not in a transcript row');
  return row;
}

/** The receipt lines attached under a row, in order. */
function receiptsOf(row: Element): string[] {
  return [...row.querySelectorAll('.cd-transcript-row__margin .cd-margin-receipt')].map((el) => el.textContent?.trim() ?? '');
}

describe('public chat page', () => {
  it('public_page_discloses_ai_en_es', async () => {
    document.title = APP_TITLE;
    const { screen } = await renderRoute(PAGE);
    const main = screen.getByRole('main');
    await expect.element(main.getByText("You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.")).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    // The kernel's charter, in the about column.
    const about = screen.getByRole('complementary', { name: 'About Rivera Plumbing' });
    for (const block of rivera.publicDesk.en.charter) await expect.element(about.getByText(block.title ?? '', { exact: true }).first()).toBeVisible();
    expect(requests('publicDesk').map((r) => r.path)).toEqual([`/api/public/${RIVERA.slug}?lang=en`]);
    await expectScreenBasics(screen.container, { owner: false });
    // The tab names the business; elsewhere it stays the app's own name.
    await vi.waitFor(() => expect(document.title).toBe('Rivera Plumbing'));
    await renderRoute('/no/such/page');
    expect(document.title).toBe(APP_TITLE);

    const es = await renderRoute(PAGE, { language: 'es-MX' });
    await expect
      .element(es.screen.getByText('Estás hablando con Claude, una IA que responde por Rivera Plumbing. Puedes pedir hablar con Maria Rivera cuando quieras.'))
      .toBeVisible();
    await expect.element(es.screen.getByRole('textbox', { name: 'Mensaje para Rivera Plumbing' })).toBeVisible();
    expect(requests('publicDesk').at(-1)?.path).toBe(`/api/public/${RIVERA.slug}?lang=es`);
    await expectScreenBasics(es.screen.container, { owner: false });
  });

  it('quote_reveals_whole_after_writing', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    // Watch every change to the page: while Claude writes, nothing of the reply shows.
    const seen: { writing: boolean; card: boolean; receipts: number }[] = [];
    const observer = new MutationObserver(() => {
      seen.push({
        writing: document.querySelector('.cd-writing-indicator') !== null,
        card: screen.container.querySelector('[aria-label="Quote"]') !== null,
        receipts: screen.container.querySelectorAll('.cd-margin-receipt').length,
      });
    });
    observer.observe(screen.container, { childList: true, subtree: true, characterData: true });
    try {
      await say(screen, 'How much is drain clearing?');
    } finally {
      observer.disconnect();
    }
    expect(seen.some((s) => s.writing && !s.card && s.receipts === 0), 'Claude is writing, with no card or receipt yet').toBe(true);
    expect(seen.some((s) => s.writing && s.card), 'never a card while Claude is writing').toBe(false);

    const cards = screen.getByRole('article', { name: 'Quote' });
    await expect.element(cards).toBeVisible();
    expect(cards.elements()).toHaveLength(1);
    await expect.element(screen.getByText('Claude is writing')).not.toBeInTheDocument();
    const [message] = messagesOf(chatEvents()) as [EvMessage];
    // The reply's own check comes first under it, then the quote's: the kernel's lines, as written.
    expect(receiptsOf(rowOf(cards.element()))).toEqual([message.visitor_plain, "Quoted from Maria Rivera's price list"]);
  });

  it('booked_card_uses_the_kernel_lines', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Book the first one');
    const booked = screen.getByRole('article', { name: 'Booked' });
    await expect.element(booked).toBeVisible();
    expect(booked.elements()).toHaveLength(1);
    const card = booked.element();
    // The kernel's lines, word for word: its title as the headline, then each line in order.
    expect(card.querySelector('.cd-reply-card__headline')?.textContent).toBe('Tuesday, November 3');
    expect([...card.querySelectorAll('.cd-reply-card__detail')].map((p) => p.textContent)).toEqual([
      'Arriving 2:00 pm to 4:00 pm',
      'With Maria Rivera',
    ]);
    // The page adds nothing to a card: no date tile, price, link or calendar action.
    expect(card.querySelectorAll('time, button, a')).toHaveLength(0);
    expect(card.textContent).not.toContain('$');
    expect(receiptsOf(rowOf(card))).toEqual(["Reply checked against Maria Rivera's rules", "Booked on Maria Rivera's calendar"]);
  });

  it('prose_has_no_prices_or_dates', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    // One message for every row of the script, in English and in Spanish.
    const said = new Set<string>();
    for (const rule of SCRIPT) {
      for (const text of SCRIPT_SAMPLES[rule.name]) {
        expect(matchRule(text).name, text).toBe(rule.name);
        said.add(rule.name);
        await say(screen, text);
      }
    }
    expect([...said].sort()).toEqual(SCRIPT.map((rule) => rule.name).sort());
    const languages = new Set(messagesOf(chatEvents()).map((ev) => ev.language));
    expect([...languages].sort()).toEqual(['en', 'es']);

    // Prices and dates reach a visitor only in cards; Claude's own words carry none.
    for (const bad of ['It is $180', 'Good until Tuesday', 'el sábado', 'en noviembre', 'at 2 pm']) expect(bad).toMatch(PRICE_OR_DATE);
    expect("You're all set. Here's your visit.").not.toMatch(PRICE_OR_DATE);
    const prose = [...screen.container.querySelectorAll('.cd-claude-message__prose')].map((p) => p.textContent ?? '');
    expect(prose.length).toBeGreaterThanOrEqual(6);
    for (const text of prose) expect(text, text).not.toMatch(PRICE_OR_DATE);
  }, 60_000);

  it('receipts_sit_under_each_message', async () => {
    const desktop = await renderRoute(PAGE);
    await ready(desktop.screen);
    await say(desktop.screen, 'How much is drain clearing?');
    await say(desktop.screen, 'Book the first one');
    expectReceiptsUnderTheirMessages(desktop.screen);

    // The same chat at phone width (read back from the stored conversation).
    const phone = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(phone.screen);
    await vi.waitFor(() => expect(shownMessages()).toHaveLength(2));
    expectReceiptsUnderTheirMessages(phone.screen);
  });

  it('held_request_shows_the_kernel_line', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can I get 15% off if I pay cash?');
    const held = screen.getByText(rivera.decisions.held.visitor_plain, { exact: true });
    await expect.element(held).toBeVisible();
    // Under Claude's checked reply, which says Maria decides (no card), after the reply's own
    // line, and the ghost cancel under that.
    const row = rowOf(held.element());
    expect([...row.querySelectorAll('.cd-claude-message__prose')].map((p) => p.textContent)).toEqual([HELD_PROSE.en]);
    expect(row.querySelectorAll('article')).toHaveLength(0);
    expect(receiptsOf(row)).toEqual(["Reply checked against Maria Rivera's rules", rivera.decisions.held.visitor_plain]);
    const cancel = screen.getByRole('button', { name: 'Cancel this request' });
    await expect.element(cancel).toBeVisible();
    expect(cancel.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(held.element().getBoundingClientRect().bottom);
    // Receipts are lines to read, never controls.
    expect(screen.container.querySelectorAll('.cd-margin-receipt button, button.cd-margin-receipt')).toHaveLength(0);
  });

  it('held_request_can_be_cancelled', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can I get 15% off if I pay cash?');
    const held = chatEvents().find(({ ev }) => ev.type === 'held')?.ev;
    if (held?.type !== 'held') throw new Error('the discount was held');

    await screen.getByRole('button', { name: 'Cancel this request' }).click();
    await expect.element(screen.getByRole('button', { name: 'Cancel this request' })).not.toBeInTheDocument();
    // The button is gone, so the visitor's place moves to the composer rather than the page.
    await expect.element(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toHaveFocus();
    expect(requests('cancelRequest').map((r) => r.path)).toEqual([
      `/api/public/desks/${RIVERA.slug}/decisions/${encodeURIComponent(held.decision_id)}/cancel`,
    ]);
    const resolved = chatEvents().find(({ ev }) => ev.type === 'resolved')?.ev;
    expect(resolved).toMatchObject({ decision_id: held.decision_id, state: 'cancelled' });
    const line = resolved?.type === 'resolved' ? resolved.visitor_plain : '';
    await expect.element(screen.getByText(line, { exact: true })).toBeVisible();
    expect(receiptsOf(rowOf(screen.getByText(line, { exact: true }).element()))).toEqual([
      "Reply checked against Maria Rivera's rules",
      held.visitor_plain,
      line,
    ]);

    // In a second chat the visitor goes on after the hold: the cancel stays under the held
    // message, and so does what cancelling it says, never under the booking that followed.
    const second = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(second.screen);
    await say(second.screen, 'Can I get 15% off if I pay cash?');
    await say(second.screen, 'Book the first one');
    const heldLine = second.screen.getByText(held.visitor_plain, { exact: true }).element();
    const heldRow = rowOf(heldLine);
    const bookedRow = rowOf(second.screen.getByRole('article', { name: 'Booked' }).element());
    const booked = receiptsOf(bookedRow);
    expect(booked).toEqual(["Reply checked against Maria Rivera's rules", "Booked on Maria Rivera's calendar"]);
    const cancel = second.screen.getByRole('button', { name: 'Cancel this request' });
    await expect.element(cancel).toBeVisible();
    const box = cancel.element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(heldLine.getBoundingClientRect().bottom);
    expect(box.bottom).toBeLessThanOrEqual(heldRow.nextElementSibling?.getBoundingClientRect().top ?? 0);
    expect(box.bottom).toBeLessThanOrEqual(bookedRow.getBoundingClientRect().top);

    await cancel.click();
    await expect.element(second.screen.getByRole('button', { name: 'Cancel this request' })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(receiptsOf(heldRow)).toEqual(["Reply checked against Maria Rivera's rules", held.visitor_plain, 'Cancelled']));
    expect(receiptsOf(bookedRow)).toEqual(booked);

    // In a third chat two requests are held. While the first one's cancel is out, the other
    // request's button waits: its words shown with no spinner, still in the tab order, and a click
    // on it sends nothing, so no click is lost. Once the first is back, that one cancels too.
    const third = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(third.screen);
    await say(third.screen, 'Can I get 15% off if I pay cash?');
    await say(third.screen, 'Can I get 15% off if I pay cash?');
    const holds = chatEvents().flatMap(({ ev }) => (ev.type === 'held' ? [ev.decision_id] : []));
    expect(holds).toHaveLength(2);
    const cancels = third.screen.getByRole('button', { name: 'Cancel this request' });
    await vi.waitFor(() => expect(cancels.elements()).toHaveLength(2));
    const [firstHold, secondHold] = cancels.elements();
    // The first cancel goes through a second late, answered as the route answers.
    mockStore.inject({ route: 'cancelRequest', status: 202, body: { decision_id: holds[0] }, delayMs: 1_000, afterCommit: true });
    const before = requests('cancelRequest').length;
    await cancels.first().click();
    await expect.element(cancels.first()).toHaveAttribute('aria-busy', 'true');
    await expect.element(cancels.last()).toHaveAttribute('aria-disabled', 'true');
    const waiting = secondHold as HTMLButtonElement;
    expect(waiting.disabled).toBe(false);
    expect(waiting.tabIndex).toBe(0);
    expect(waiting.textContent).toBe('Cancel this request');
    expect(waiting.getAttribute('aria-busy')).toBeNull();
    expect(waiting.querySelector('.cd-button__spinner')).toBeNull();
    // The click on the waiting one sends nothing: the paths at the end are each hold's once.
    await expect.poll(() => requests('cancelRequest').length).toBe(before + 1);
    waiting.click();
    await vi.waitFor(() => expect(firstHold?.isConnected).toBe(false), { timeout: 3_000 });
    await expect.element(cancels).not.toHaveAttribute('aria-disabled');
    await expect.element(cancels).toBeEnabled();
    await cancels.click();
    await expect.element(cancels).not.toBeInTheDocument();
    expect(requests('cancelRequest').slice(before).map((r) => r.path)).toEqual(
      holds.map((id) => `/api/public/desks/${RIVERA.slug}/decisions/${encodeURIComponent(id)}/cancel`),
    );
    const states = chatEvents().flatMap(({ ev }) => (ev.type === 'resolved' ? [[ev.decision_id, ev.state]] : []));
    expect(states).toEqual(holds.map((id) => [id, 'cancelled']));
  });

  it('error_event_shows_static_copy', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'outage');
    await expect.element(screen.getByRole('alert').getByText(UNREACHABLE_COPY.en, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('kernel_unavailable');
    expect(document.body.innerHTML).not.toContain('kernel_unavailable');
    // The visitor can keep going: the next reply clears the line.
    await say(screen, 'How much is drain clearing?');
    await expect.element(screen.getByText(UNREACHABLE_COPY.en, { exact: true })).not.toBeInTheDocument();
  });

  it('deleted_desk_ends_the_chat', async () => {
    // The owner deletes the Desk the moment Claude starts writing a reply.
    const { screen } = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(screen);
    const deleted: Promise<unknown>[] = [];
    const stop = mockStore.listen(RIVERA.slug, chatEvents().length, (_seq, ev) => {
      if (ev.type === 'writing' && deleted.length === 0) deleted.push(mockStore.dispatch('deleteDesk', { params: { desk_id: RIVERA.deskId } }));
    });
    onTestFinished(stop);
    await type(screen, 'How much is drain clearing?');
    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(await deleted[0]).toMatchObject({ status: 204 });

    // The chat ends, and stops showing Claude writing: no reply is coming.
    await expect.element(screen.getByText(CHAT_ENDED_COPY.en, { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Claude is writing')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).element()).toBeDisabled();
    expect(messagesOf(chatEvents())).toEqual([]);

    // A new chat finds the Desk gone.
    await screen.getByRole('button', { name: NEW_CHAT_LABEL.en }).click();
    await expect.element(screen.getByText("This Desk isn't available", { exact: true })).toBeVisible();
  });

  it('session_error_offers_a_new_chat', async () => {
    const newChat = async (screen: RenderResult) => {
      await expect.element(screen.getByText(CHAT_ENDED_COPY.en, { exact: true })).toBeVisible();
      expect(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).element()).toBeDisabled();
      const opened = requests('openSession').length;
      await screen.getByRole('button', { name: NEW_CHAT_LABEL.en }).click();
      await vi.waitFor(() => expect(requests('openSession')).toHaveLength(opened + 1));
      await ready(screen);
      await expect.element(screen.getByText(CHAT_ENDED_COPY.en, { exact: true })).not.toBeInTheDocument();
    };

    // The stream says the session ended: the new chat starts with an empty composer.
    const first = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(first.screen);
    mockStore.emit(RIVERA.slug, { type: 'error', code: 'session' });
    await newChat(first.screen);
    await expect.element(first.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toHaveValue('');

    // Sending answers 401: the words that didn't send wait in the new chat's composer, ready to send.
    const second = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(second.screen);
    mockStore.inject({ route: 'sendMessage', status: 401 });
    await second.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).fill('How much is drain clearing?');
    await second.screen.getByRole('button', { name: 'Send' }).click();
    await newChat(second.screen);
    const carried = second.screen.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await expect.element(carried).toHaveValue('How much is drain clearing?');
    await expect.element(carried).toHaveFocus();
    await second.screen.getByRole('button', { name: 'Send' }).click();
    await vi.waitFor(() => expect(requests('sendMessage').map((r) => r.body)).toEqual([{ text: 'How much is drain clearing?' }, { text: 'How much is drain clearing?' }]));
    await expect.element(carried).toHaveValue('');

    // Requests from a chat that ended never change the new one. First a send, the read after a lost
    // send and a cancel, each answering 401 after "Start a new chat"; then a cancel whose answer is
    // lost, and whose read settles after the next new chat.
    const late = 2_000;
    const stale = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(stale.screen);
    await say(stale.screen, 'Can I get 15% off if I pay cash?');
    const cancel = stale.screen.getByRole('button', { name: 'Cancel this request' });
    mockStore.inject({ route: 'cancelRequest', status: 401, delayMs: late });
    mockStore.inject({ route: 'sendMessage', status: 401, delayMs: late });
    mockStore.inject({ route: 'sendMessage', status: 'network' });
    mockStore.inject({ route: 'visitorSession', status: 401, delayMs: late });
    await cancel.click();
    await type(stale.screen, 'How much is drain clearing?');
    await type(stale.screen, 'Can someone come Tuesday afternoon?');
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(2));
    mockStore.emit(RIVERA.slug, { type: 'error', code: 'session' });
    await newChat(stale.screen);

    mockStore.inject({ route: 'cancelRequest', status: 'network' });
    mockStore.inject({ route: 'visitorSession', status: 503, delayMs: late });
    const asked = requests('visitorSession').length;
    await cancel.click();
    const settled = performance.now() + late;
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(asked + 1));
    mockStore.emit(RIVERA.slug, { type: 'error', code: 'session' });
    await newChat(stale.screen);
    await sleep(settled - performance.now() + 500);
    expect(stale.screen.getByText(CHAT_ENDED_COPY.en, { exact: true }).query()).toBeNull();
    expect(stale.screen.getByText(UNREACHABLE_COPY.en, { exact: true }).query()).toBeNull();
    await expect.element(cancel).toBeEnabled();
    await ready(stale.screen);

    // The stream closes, and reading the conversation answers 401.
    mockStore.reset('rivera');
    mockStore.inject({ route: 'events', status: 401 });
    let reads = 0;
    worker.use(
      http.get(`/api/public/desks/${RIVERA.slug}/session`, () => {
        reads += 1;
        // The load's read goes through; the one after the stream closed finds no session.
        return reads === 2 ? HttpResponse.json({ error: 'no_session' }, { status: 401 }) : undefined;
      }),
    );
    const third = await renderRoute(PAGE);
    await newChat(third.screen);
    expect(document.body.textContent).not.toContain('no_session');
  });

  it('stream_503_reopens_then_gives_up', async () => {
    useTimers();
    // The stream can't open: the first try and every reopen answer 503.
    mockStore.inject({ route: 'events', status: 503, times: 4 });
    const { screen } = await renderRoute(PAGE);
    const streams = () => requests('events').map((r) => r.path);
    const reads = () => requests('visitorSession').length;

    // Each failure reads the conversation (it still exists), then reopens from the last seq after
    // 2, 5 and 10 seconds, saying it is reconnecting meanwhile.
    for (const [wait, opened] of [
      [2_000, 2],
      [5_000, 3],
      [10_000, 4],
    ] as const) {
      await until(() => expect(reads()).toBe(opened));
      await until(() => expect(screen.container.textContent).toContain('Reconnecting to the chat'));
      await settle();
      await vi.advanceTimersByTimeAsync(wait - MARGIN_MS);
      await settle();
      expect(streams()).toHaveLength(opened - 1);
      await vi.advanceTimersByTimeAsync(MARGIN_MS);
      await until(() => expect(streams()).toHaveLength(opened));
    }
    expect(streams()).toEqual(Array.from({ length: 4 }, () => `/api/public/desks/${RIVERA.slug}/events?after=0`));

    // After the third reopen it gives up: the static line, a way to try again, and no more tries.
    await until(() => expect(reads()).toBe(5));
    await until(() => expect(screen.getByRole('alert').getByText(UNREACHABLE_COPY.en, { exact: true }).query()).not.toBeNull());
    expect(screen.container.textContent).not.toContain('Reconnecting to the chat');
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(streams()).toHaveLength(4);

    await screen.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await until(() => expect(streams()).toHaveLength(5));
    await until(() => expect(screen.getByText(UNREACHABLE_COPY.en, { exact: true }).query()).toBeNull());
    vi.useRealTimers();
    await say(screen, 'How much is drain clearing?');
  });

  it('send_failure_keeps_the_message', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    // The send fails on the server's side without being kept: the chat checks, then says so.
    mockStore.inject({ route: 'sendMessage', status: 500 });
    await type(screen, 'How much is drain clearing?');
    const failed = screen.getByRole('alert');
    await expect.element(failed.getByText("That didn't send. Your message is still here.", { exact: true })).toBeVisible();
    await expect.element(screen.getByText('How much is drain clearing?', { exact: true })).toBeVisible();
    expect(requests('sendMessage')).toHaveLength(1);
    expect(requests('visitorSession')).toHaveLength(2);

    const before = chatEvents().length;
    await failed.getByRole('button', { name: 'Try again' }).click();
    await turnEnded(before);
    expect(requests('sendMessage')).toHaveLength(2);
    await expect.element(screen.getByText("That didn't send. Your message is still here.")).not.toBeInTheDocument();
    // One message, answered once.
    expect(screen.getByText('How much is drain clearing?', { exact: true }).elements()).toHaveLength(1);
    expect(screen.getByRole('article', { name: 'Quote' }).elements()).toHaveLength(1);
  });

  it('lost_send_response_does_not_duplicate', async () => {
    const { screen, router } = await renderRoute(PAGE);
    await ready(screen);
    // The message is kept and answered, but its answer never reaches the page.
    mockStore.inject({ route: 'sendMessage', status: 'network', afterCommit: true });
    const before = chatEvents().length;
    await type(screen, 'How much is drain clearing?');
    await turnEnded(before);
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(2));
    expect(requests('sendMessage')).toHaveLength(1);
    // The chat found it in the conversation, so it never says it didn't send, and shows it once.
    await expect.element(screen.getByRole('article', { name: 'Quote' })).toBeVisible();
    expect(screen.container.textContent).not.toContain("That didn't send");
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
    expect(screen.getByText('How much is drain clearing?', { exact: true }).elements()).toHaveLength(1);
    expect(mockStore.visitorSession(RIVERA.slug)?.items.filter((item) => item.kind === 'visitor_text')).toHaveLength(1);

    // The read after a lost answer fails too: the chat can't tell yet, so it says nothing and
    // offers no resend, and reads again 2 s later. That read finds the message, which went through.
    const stored = () => mockStore.visitorSession(RIVERA.slug)?.items.filter((item) => item.kind === 'visitor_text') ?? [];
    const notSent = "That didn't send";
    mockStore.inject({ route: 'sendMessage', status: 'network', afterCommit: true });
    mockStore.inject({ route: 'visitorSession', status: 503 });
    const reads = requests('visitorSession').length;
    const lost = chatEvents().length;
    await type(screen, 'Can someone come Tuesday afternoon?');
    await turnEnded(lost);
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(reads + 1));
    await sleep(300);
    expect(screen.container.textContent).not.toContain(notSent);
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(reads + 2), { timeout: 4_000 });
    await sleep(300);
    expect(screen.container.textContent).not.toContain(notSent);
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
    expect(requests('sendMessage')).toHaveLength(2);
    expect(stored()).toHaveLength(2);

    // A message that didn't get through is said to have failed only once a read shows it isn't
    // there. Here that read comes when the stream next opens: the visitor leaves the page and comes back.
    mockStore.inject({ route: 'sendMessage', status: 'network' });
    mockStore.inject({ route: 'visitorSession', status: 503 });
    await type(screen, 'Can you call me back?');
    await vi.waitFor(() => expect(requests('visitorSession')).toHaveLength(reads + 3));
    await sleep(300);
    expect(screen.container.textContent).not.toContain(notSent);
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
    const streams = requests('events').length;
    await router.navigate('/d/nobody-here');
    await expect.element(screen.getByText("This Desk isn't available", { exact: true })).toBeVisible();
    await router.navigate(PAGE);
    await vi.waitFor(() => expect(requests('events')).toHaveLength(streams + 1));
    const failed = screen.getByRole('alert');
    // Sooner than the 2 s retry, which leaving the page called off.
    await expect.element(failed.getByText(`${notSent}. Your message is still here.`, { exact: true }), { timeout: 1_000 }).toBeVisible();
    expect(requests('visitorSession')).toHaveLength(reads + 4);
    const resent = chatEvents().length;
    await failed.getByRole('button', { name: 'Try again' }).click();
    await turnEnded(resent);
    expect(requests('sendMessage')).toHaveLength(4);
    expect(stored()).toHaveLength(3);
    expect(screen.container.textContent).not.toContain(notSent);
  });

  it('rejected_send_keeps_the_message', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    mockStore.inject({ route: 'sendMessage', status: 429 });
    await type(screen, 'How much is drain clearing?');
    const limited = screen.getByRole('alert');
    await expect.element(limited.getByText(RATE_LIMITED_COPY.en, { exact: true })).toBeVisible();
    await expect.element(limited.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect.element(screen.getByText('How much is drain clearing?', { exact: true })).toBeVisible();

    mockStore.inject({ route: 'sendMessage', status: 422 });
    await type(screen, 'Can someone come Tuesday afternoon?');
    await expect.element(screen.getByText("That's too long. Shorten it and try again.", { exact: true })).toBeVisible();
    await expect.element(screen.getByText('Can someone come Tuesday afternoon?', { exact: true })).toBeVisible();

    // Only a 422 is about the length: any other refusal says it didn't send, with "Try again".
    mockStore.inject({ route: 'sendMessage', status: 400 });
    await type(screen, 'Can you call me back?');
    const notSent = () => rowOf(screen.getByText('Can you call me back?', { exact: true }).element()).querySelector('[role="alert"]');
    await vi.waitFor(() => expect(notSent()?.textContent ?? '').toContain("That didn't send. Your message is still here."));
    expect(notSent()?.textContent).not.toContain('too long');
    expect(notSent()?.querySelector('button')?.textContent).toBe('Try again');
    // Rejected outright: the chat neither checks nor sends again on its own.
    expect(requests('sendMessage')).toHaveLength(3);
    expect(requests('visitorSession')).toHaveLength(1);

    // The composer stops at Plan 02's limit, with a counter near it.
    const box = screen.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await box.fill('a'.repeat(2_100));
    expect((box.element() as HTMLTextAreaElement).value).toHaveLength(2_000);
    await expect.element(screen.getByText('2000 / 2000')).toBeVisible();
  });

  it('newest_row_stays_in_view', async () => {
    for (const viewport of ['desktop', 'phone'] as const) {
      const { screen } = await renderRoute(PAGE, { viewport, seed: 'rivera' });
      await ready(screen);
      // Each reply, its receipts and the cancel under it end just above the composer, as the boards show.
      for (const text of ['How much is drain clearing?', 'Can someone come Tuesday afternoon?', 'Book the first one', 'Can I get 15% off if I pay cash?']) {
        await say(screen, text);
        await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
      }
      expect(document.scrollingElement?.scrollTop, viewport).toBeGreaterThan(0);

      // Narrowing the window at the end (a phone turned, a window made smaller) rewraps the rows,
      // and the newest still ends above the composer, with nothing sent.
      if (viewport === 'desktop') {
        await page.viewport(VIEWPORTS.phone.width, VIEWPORTS.phone.height);
        await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
        await page.viewport(VIEWPORTS.desktop.width, VIEWPORTS.desktop.height);
      }

      // A visitor reading back up stays where they are while the chat goes on...
      window.scrollTo(0, 0);
      await sleep(100);
      mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
      await expect.element(screen.getByText('Maria Rivera joined the chat', { exact: true })).toBeInTheDocument();
      await sleep(100);
      expect(document.scrollingElement?.scrollTop, viewport).toBe(0);

      // ...until they send: then the end of the conversation comes back into view.
      await say(screen, 'Can you call me back?');
      await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
    }
  }, 30_000);

  it('moving_back_up_holds_as_the_chat_goes_on', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'phone', seed: 'rivera' });
    await ready(screen);
    for (const text of ['How much is drain clearing?', 'Can someone come Tuesday afternoon?', 'Book the first one', 'Can I get 15% off if I pay cash?']) {
      await say(screen, text);
      await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
    }
    const ask = screen.getByRole('button', { name: 'Ask for Maria Rivera' }).element();
    const askInView = () => {
      const { top, bottom } = ask.getBoundingClientRect();
      return top >= 0 && bottom <= innerHeight;
    };
    expect(askInView(), 'the chat has scrolled past "Ask for Maria Rivera"').toBe(false);

    // A visitor at the end moves back up with the keyboard, and Maria joins in that same moment:
    // the page scrolls at once, but its scroll event comes only with the browser's next frame (here
    // a whole frame away, from inside this one's callbacks), after the chat has already gone on.
    // They stay where they moved to.
    const atTheEnd = document.scrollingElement?.scrollTop ?? 0;
    let movedTo = atTheEnd;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        ask.focus();
        movedTo = document.scrollingElement?.scrollTop ?? 0;
        mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
        resolve();
      });
    });
    expect(movedTo, 'focus moved the page up').toBeLessThan(atTheEnd);
    await expect.element(screen.getByText('Maria Rivera joined the chat', { exact: true })).toBeInTheDocument();
    await sleep(100);
    expect(document.activeElement).toBe(ask);
    expect(document.scrollingElement?.scrollTop).toBe(movedTo);
    expect(askInView(), '"Ask for Maria Rivera", where the visitor moved to, stays in view').toBe(true);
  });

  it('newest_row_follows_a_shorter_window', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'desktop', seed: 'rivera' });
    await ready(screen);
    for (const text of ['How much is drain clearing?', 'Can someone come Tuesday afternoon?', 'Book the first one', 'Can I get 15% off if I pay cash?']) {
      await say(screen, text);
      await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
    }

    // The window gets shorter at the end of the chat (a panel docks, a browser bar opens): the
    // page doesn't scroll and nothing around the conversation changes size, so the end slips under
    // the composer with no scroll event and nothing for the page to see.
    const atTheEnd = document.scrollingElement?.scrollTop ?? 0;
    await page.viewport(VIEWPORTS.desktop.width, 640);
    await sleep(200);
    expect(document.scrollingElement?.scrollTop, 'the page did not scroll').toBe(atTheEnd);
    expect(endUnderTheComposer(screen), 'the end is under the composer').toBeGreaterThan(48);

    // The visitor never moved, so the chat going on brings the end back above the composer.
    mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
    await expect.element(screen.getByText('Maria Rivera joined the chat', { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
  });

  it('newest_row_follows_a_growing_composer', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'desktop', seed: 'rivera' });
    await ready(screen);
    for (const text of ['How much is drain clearing?', 'Can someone come Tuesday afternoon?', 'Book the first one', 'Can I get 15% off if I pay cash?']) {
      await say(screen, text);
      await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
    }

    // Between two frames, a pasted message grows the composer over the end of the chat, and Maria
    // joins before the browser's next frame tells the page the composer changed size. The visitor
    // never moved, so the end comes back above the composer.
    const box = screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).element() as HTMLTextAreaElement;
    let grownOver = 0;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        realSetTimeout(() => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'one\ntwo\nthree\nfour\nfive\nsix');
          box.dispatchEvent(new Event('input', { bubbles: true }));
          grownOver = endUnderTheComposer(screen);
          mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
          resolve();
        }, 0);
      });
    });
    expect(grownOver, 'the composer grew over the end before Maria joined').toBeGreaterThan(48);
    await expect.element(screen.getByText('Maria Rivera joined the chat', { exact: true })).toBeInTheDocument();
    await sleep(200);
    expect(box.value.split('\n'), 'the pasted lines are in the composer').toHaveLength(6);
    await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
  });

  it('newest_row_follows_a_narrower_window', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'desktop', seed: 'rivera' });
    await page.viewport(700, VIEWPORTS.desktop.height);
    await ready(screen);
    const long = Array.from({ length: 5 }, () => 'The kitchen sink drains slowly and gurgles whenever the dishwasher runs, and the bathroom one has started to smell.').join(' ');
    for (const text of ['How much is drain clearing?', 'Can someone come Tuesday afternoon?', 'Book the first one', 'Can I get 15% off if I pay cash?', long]) {
      await say(screen, text);
      await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
    }

    // The window narrows in one step at the end of the chat (a split view, a window snapped
    // narrower), and the visitor cancels their held request in that same moment, before the
    // browser tells the page the shell changed size. The rows rewrap taller: the browser's scroll
    // anchoring moves the page down to keep the rows on screen where they were, and the end slips
    // under the composer. The visitor never moved, so the end comes back above the composer and
    // stays there as the chat goes on.
    const cancel = screen.getByRole('button', { name: 'Cancel this request' }).element() as HTMLButtonElement;
    const atTheEnd = document.scrollingElement?.scrollTop ?? 0;
    let anchoredTo = atTheEnd;
    const narrowed = () => {
      anchoredTo = document.scrollingElement?.scrollTop ?? 0;
      cancel.click();
    };
    window.addEventListener('resize', narrowed, { once: true });
    onTestFinished(() => window.removeEventListener('resize', narrowed));
    await page.viewport(380, VIEWPORTS.desktop.height);
    await expect.element(screen.getByRole('button', { name: 'Cancel this request' })).not.toBeInTheDocument();
    expect(anchoredTo, 'scroll anchoring moved the page down as the rows rewrapped').toBeGreaterThan(atTheEnd);
    await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });

    mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
    await expect.element(screen.getByText('Maria Rivera joined the chat', { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => expectEndAboveTheComposer(screen), { timeout: 1_000 });
  });

  it('reload_restores_the_conversation', async () => {
    const first = await renderRoute(PAGE);
    await ready(first.screen);
    await say(first.screen, 'How much is drain clearing?');
    await say(first.screen, 'Book the first one');
    const conversation = () => document.querySelector('[role="log"]')?.textContent ?? '';
    const before = conversation();
    const rows = document.querySelectorAll('.cd-transcript-row').length;
    expect(rows).toBe(4);

    // A new page load: the same chat comes back from the stored conversation, once.
    const second = await renderRoute(PAGE);
    await ready(second.screen);
    await vi.waitFor(() => expect(conversation()).toBe(before));
    // Its stream picks up after what the page already shows: nothing doubles.
    await vi.waitFor(() => expect(requests('events').at(-1)?.path).toMatch(/after=8$/));
    await sleep(300);
    expect(document.querySelectorAll('.cd-transcript-row')).toHaveLength(rows);
    expect(conversation()).toBe(before);
    expect(requests('openSession').map((r) => r.path)).toEqual([
      `/api/public/desks/${RIVERA.slug}/sessions`,
      `/api/public/desks/${RIVERA.slug}/sessions`,
    ]);
  });

  it('callback_card_shows_the_kernel_title', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await say(screen, 'Can you call me back?');
    const card = screen.getByRole('article', { name: 'Callback set' });
    await expect.element(card).toBeVisible();
    expect(card.element().querySelector('.cd-reply-card__headline')?.textContent).toBe(
      'Maria Rivera will call you back on Monday, between 8:00 am and 9:00 am',
    );
    expect(receiptsOf(rowOf(card.element()))).toEqual(["Reply checked against Maria Rivera's rules", 'Callback request saved for Maria Rivera']);

    await say(screen, 'Please call me tonight');
    const cards = screen.getByRole('article', { name: 'Callback set' });
    await vi.waitFor(() => expect(cards.elements()).toHaveLength(2));
    expect(cards.elements()[1]?.querySelector('.cd-reply-card__headline')?.textContent).toBe('Maria Rivera will call you back');
  });

  it('ask_for_owner_leads_to_a_person', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    const before = chatEvents().length;
    await screen.getByRole('button', { name: 'Ask for Maria Rivera' }).click();
    await turnEnded(before);
    expect(requests('sendMessage').map((r) => r.body)).toEqual([{ text: "I'd like to talk to Maria Rivera." }]);
    await expect.element(screen.getByText("I'd like to talk to Maria Rivera.", { exact: true })).toBeVisible();
    const handoff = screen.getByRole('article', { name: 'Handed to a person' });
    await expect.element(handoff).toBeVisible();
    expect(handoff.elements()).toHaveLength(1);

    // Maria joins: a line about the chat, with no clock time.
    mockStore.emit(RIVERA.slug, { type: 'owner_joined', name: 'Maria Rivera' });
    const joined = screen.getByRole('status').filter({ hasText: 'Maria Rivera joined the chat' });
    await expect.element(joined).toBeVisible();
    expect(joined.element().textContent?.trim()).toMatch(/Maria Rivera joined the chat$/);
    expect(joined.element().textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(joined.element().querySelector('time')).toBeNull();

    // Another chat: the same start, then a callback instead.
    const second = await renderRoute(PAGE, { seed: 'rivera' });
    await ready(second.screen);
    const start = chatEvents().length;
    await second.screen.getByRole('button', { name: 'Ask for Maria Rivera' }).click();
    await turnEnded(start);
    await expect.element(second.screen.getByRole('article', { name: 'Handed to a person' })).toBeVisible();
    await say(second.screen, 'Can you call me back?');
    await expect.element(second.screen.getByRole('article', { name: 'Callback set' })).toBeVisible();
  });

  it('owner_typing_shows_their_name_and_dots', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('this browser has a chat');
    const typing = () => screen.getByRole('status').filter({ hasText: 'Maria Rivera is typing' });
    const dots = () => document.querySelectorAll('.cd-writing-indicator--person');
    /** Maria typing, until `ms` from now on this browser's clock. */
    const typingFor = (ms: number) =>
      mockStore.emit(RIVERA.slug, { type: 'owner_typing', name: 'Maria Rivera', until: new Date(Date.now() + ms).toISOString() });

    mockStore.world.takeOver(chat);
    await expect.element(screen.getByRole('status').filter({ hasText: 'Maria Rivera joined the chat' })).toBeVisible();

    // The page's timers and clock are fake from here: the dots go only when the test moves the
    // clock, and an event is as fresh when it arrives as when it was sent, however long the stream
    // and the page take. Checks poll in real time (`until`), which never moves the fake clock.
    useTypingClock();

    // An event whose time has passed shows nothing.
    typingFor(-1_000);
    await sleep(200);
    expect(dots()).toHaveLength(0);

    // While she types: her initials, her name and three dots where her words will start, said
    // once to screen readers. No words, and nothing says Claude is writing.
    typingFor(5_000);
    await until(() => expect(typing().elements()).toHaveLength(1));
    expect(dots()).toHaveLength(1);
    const rows = document.querySelectorAll('.cd-transcript-row');
    expect(rows[rows.length - 1]?.contains(dots()[0] ?? null)).toBe(true);
    expect(dots()[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('MRMaria Rivera is typing');
    expect(screen.getByText('Claude is writing').elements()).toHaveLength(0);
    // The screen checks run axe, which waits on timers of its own, so they run in real time. The
    // dots stay up meanwhile: the fake timer that would take them down goes with the fake clock.
    vi.useRealTimers();
    await expectScreenBasics(screen.container, { owner: false });
    useTypingClock();
    expect(dots()).toHaveLength(1);

    // Her message takes their place.
    mockStore.world.say(chat, 'Hi, it is Maria. I can come at 4 today.');
    await until(() => expect(screen.getByText('Hi, it is Maria. I can come at 4 today.', { exact: true }).element()).toBeVisible());
    expect(dots()).toHaveLength(0);

    // Typing again shows until its time, and goes then.
    typingFor(400);
    await until(() => expect(typing().elements()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(399);
    await settle();
    expect(dots()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => expect(dots()).toHaveLength(0));

    // A time far ahead, as a phone whose clock runs behind would read it, shows no longer than the
    // API's five seconds.
    typingFor(60_000);
    await until(() => expect(typing().elements()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000 - MARGIN_MS);
    await settle();
    expect(dots()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MARGIN_MS);
    await until(() => expect(dots()).toHaveLength(0));

    // After a reload, what the stream already carried shows nothing, though its time hasn't run out.
    typingFor(5_000);
    await until(() => expect(typing().elements()).toHaveLength(1));
    const again = await renderRoute(PAGE);
    await readyNow(again.screen);
    await until(() => expect(again.screen.getByText('Hi, it is Maria. I can come at 4 today.', { exact: true }).element()).toBeVisible());
    await sleep(300);
    expect(dots()).toHaveLength(0);
  });

  it('owner_typing_ends_with_the_chat', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    const chat = mockStore.visitorSession(RIVERA.slug);
    if (!chat) throw new Error('this browser has a chat');
    const dots = () => document.querySelectorAll('.cd-writing-indicator--person');
    mockStore.world.takeOver(chat);
    await expect.element(screen.getByRole('status').filter({ hasText: 'Maria Rivera joined the chat' })).toBeVisible();

    // Maria types. The page's timers are fake from here, so her dots can't run out on their own.
    useTimers();
    mockStore.emit(RIVERA.slug, { type: 'owner_typing', name: 'Maria Rivera', until: new Date(Date.now() + 5_000).toISOString() });
    await until(() => expect(dots()).toHaveLength(1));

    // The chat ends (a send answers 401): the line says so, and her dots go with it.
    mockStore.inject({ route: 'sendMessage', status: 401 });
    await type(screen, 'Are you still there?');
    await until(() => expect(screen.getByText(CHAT_ENDED_COPY.en, { exact: true }).query()).not.toBeNull());
    expect(dots()).toHaveLength(0);
  });

  it('visitor_typing_pings_the_owner', async () => {
    // Pings go at most every 2 s, scaled. The clock they are timed by moves only when the test
    // moves it, so how long typing takes in the browser never changes how many go.
    const { screen } = await renderRoute(PAGE, { pollScale: 100 });
    await ready(screen);
    const clock = freezeClock();
    const box = screen.getByRole('textbox', { name: 'Message Rivera Plumbing' });
    const pings = () => requests('visitorTyping').length;

    // Typing tells the Desk someone is typing, never what: a ping with no body.
    await userEvent.type(box, 'Is');
    await expect.poll(pings).toBe(1);
    expect(requests('visitorTyping').map((r) => r.body)).toEqual([undefined]);
    // More keystrokes within the interval send no more.
    await userEvent.type(box, ' Thu');
    expect(pings()).toBe(1);
    // After it, one more.
    clock.pass(typingPingMs());
    await userEvent.type(box, 'rsday');
    await expect.poll(pings).toBe(2);
    await sleep(200);
    expect(pings()).toBe(2);
    expect(mockStore.visitorSession(RIVERA.slug)?.typingUntil).toBeGreaterThan(Date.now());

    // An emptied composer sends nothing.
    clock.pass(typingPingMs());
    await box.clear();
    await sleep(200);
    expect(pings()).toBe(2);

    // A ping the server fails says nothing.
    mockStore.inject({ route: 'visitorTyping', status: 500 });
    await userEvent.type(box, 'Hello');
    await expect.poll(pings).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getByRole('alert').elements()).toHaveLength(0);
    await expectScreenBasics(screen.container, { owner: false });
  });

  it('about_column_shows_the_charter_cards', async () => {
    const { screen } = await renderRoute(PAGE);
    const about = screen.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect.element(about.getByRole('article', { name: 'Hours' })).toBeVisible();
    const charter = rivera.publicDesk.en.charter;
    const cards = [...about.element().querySelectorAll('article')];
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['Hours', 'Contact', 'Policy', 'Policy', 'Policy']);
    // The kernel's words, verbatim: each card's title, then its lines.
    expect(cards.map((card) => [...card.querySelectorAll('.cd-reply-card__data p')].map((p) => p.textContent))).toEqual(
      charter.map((block) => [block.title, ...(block.lines ?? [])]),
    );
  });

  it('preview_link_opens_a_preview_session', async () => {
    const preview = `${PAGE}?preview=${RIVERA.deskId}`;
    const { screen } = await renderRoute(preview);
    await ready(screen);
    expect(requests('openPreview').map((r) => r.path)).toEqual([`/api/owner/desks/${RIVERA.deskId}/preview_session`]);
    expect(requests('openSession')).toEqual([]);
    expect(mockStore.visitorSession(RIVERA.slug)?.ownerPreview).toBe(true);

    // Anyone but the owner of that Desk's copy: the preview fails, a plain chat opens, and the
    // page stays where it is.
    mockStore.reset('rivera', { signedIn: false });
    const stranger = await renderRoute(preview);
    await ready(stranger.screen);
    expect(requests('openPreview')).toHaveLength(1);
    expect(requests('openSession')).toHaveLength(1);
    expect(mockStore.visitorSession(RIVERA.slug)?.ownerPreview).toBe(false);
    await sleep(100);
    expect(`${stranger.router.state.location.pathname}${stranger.router.state.location.search}`).toBe(preview);
    await expect.element(stranger.screen.getByRole('main')).toBeVisible();
  });

  it('preview_reload_resumes_its_chat', async () => {
    // The owner's chat as a customer, from Today's link: one exchange, then a new page load.
    const preview = `${PAGE}?preview=${RIVERA.deskId}`;
    const first = await renderRoute(preview);
    await ready(first.screen);
    await say(first.screen, 'How much is drain clearing?');
    const conversation = () => document.querySelector('[role="log"]')?.textContent ?? '';
    const before = conversation();
    const session = mockStore.visitorSession(RIVERA.slug)?.state.session_id;
    expect(mockStore.visitorSession(RIVERA.slug)?.ownerPreview).toBe(true);
    expect(document.querySelectorAll('.cd-transcript-row')).toHaveLength(2);

    // The browser's visitor cookie still names that chat, so the page reads it and resumes it,
    // rather than asking for a new preview, which would start an empty chat.
    const second = await renderRoute(preview);
    await ready(second.screen);
    await vi.waitFor(() => expect(conversation()).toBe(before));
    expect(document.querySelectorAll('.cd-transcript-row')).toHaveLength(2);
    expect(mockStore.visitorSession(RIVERA.slug)?.state.session_id).toBe(session);
    expect(requests('openPreview')).toHaveLength(1);
    expect(requests('openSession')).toEqual([]);
    // Each load reads the chat first; only the first, which had none, asked for a preview.
    const opening = mockStore.requests.filter((r) => ['visitorSession', 'openPreview', 'openSession'].includes(r.key)).map((r) => r.key);
    expect(opening).toEqual(['visitorSession', 'openPreview', 'visitorSession', 'visitorSession']);
  });

  it('open_status_shows_the_kernel_text', async () => {
    // Open, as the kernel serves Rivera now: its words and a filled dot, nothing more.
    const open = await renderRoute(PAGE);
    await expectOpenStatus(open.screen, 'Open now, until 6:00 pm', 'open');
    expect(open.screen.container.textContent).not.toContain('Claude can still help.');
    // At the right of the header's name on a wide page.
    const name = textBox(open.screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing' }).element());
    expect(textBox(statusText()).left).toBeGreaterThanOrEqual(name.right);

    // Closed: its words, a hollow dot, then the page's own quieter line.
    mockStore.inject({ route: 'publicDesk', status: 200, body: deskWith('en', CLOSED.en) });
    const closed = await renderRoute(PAGE, { viewport: 'phone' });
    await expectOpenStatus(closed.screen, 'Closed now. Opens Monday at 8:00 am', 'closed');
    await expect.element(closed.screen.getByText('Claude can still help.', { exact: true })).toBeVisible();
    // On its own line under the name and tagline on a phone.
    const tagline = textBox(closed.screen.getByText('Main line', { exact: true }).element());
    expect(textBox(statusText()).top).toBeGreaterThanOrEqual(tagline.bottom);
    expectNoHorizontalScroll();

    // In Spanish, the kernel's Spanish words and the page's Spanish line.
    const abierto = await renderRoute(PAGE, { language: 'es-MX' });
    await expectOpenStatus(abierto.screen, 'Abierto ahora, hasta las 18:00', 'open');
    mockStore.inject({ route: 'publicDesk', status: 200, body: deskWith('es', CLOSED.es) });
    const cerrado = await renderRoute(PAGE, { language: 'es-MX', viewport: 'phone' });
    await expectOpenStatus(cerrado.screen, 'Cerrado ahora. Abre el lunes a las 8:00', 'closed');
    await expect.element(cerrado.screen.getByText('Claude puede ayudarte igual.', { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('open_status_refetches_once_at_refresh_at', async () => {
    useTimers();
    const streams = countStreams();

    // Rivera's status: `refresh_at` 90 s after `as_of`. One read then, none before.
    const { screen } = await renderRoute(PAGE);
    await readyNow(screen);
    await until(() => expect(streams.opened).toBe(1));
    const chat = chatOpened(streams);
    expect(requests('publicDesk')).toHaveLength(1);
    await settle();
    await vi.advanceTimersByTimeAsync(90_000 - MARGIN_MS);
    await settle();
    expect(requests('publicDesk')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MARGIN_MS);
    await until(() => expect(requests('publicDesk')).toHaveLength(2));
    // Only the header follows it: the chat opens no new session, read or stream.
    await settle();
    expect(chatOpened(streams)).toEqual(chat);
    await expectOpenStatus(screen, 'Open now, until 6:00 pm', 'open');

    // A `refresh_at` 5 s after `as_of`, or one that can't be read, waits the 30 s floor.
    for (const refreshAt of ['2026-10-30T17:58:35-07:00', 'soon']) {
      mockStore.reset('rivera');
      mockStore.inject({ route: 'publicDesk', status: 200, body: deskWith('en', { ...OPEN.en, refresh_at: refreshAt }) });
      const again = await renderRoute(PAGE);
      await readyNow(again.screen);
      await settle();
      await vi.advanceTimersByTimeAsync(30_000 - MARGIN_MS);
      await settle();
      expect(requests('publicDesk'), refreshAt).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(MARGIN_MS);
      await until(() => expect(requests('publicDesk')).toHaveLength(2));
    }

    // A read on focus at 60 s answers with its own 90 s: it replaces the first timer, so nothing
    // at 90 s and one read at 150 s.
    mockStore.reset('rivera');
    const focused = await renderRoute(PAGE);
    await readyNow(focused.screen);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('focus'));
    await until(() => expect(requests('publicDesk')).toHaveLength(2));
    await settle();
    await vi.advanceTimersByTimeAsync(90_000 - MARGIN_MS);
    await settle();
    expect(requests('publicDesk')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MARGIN_MS);
    await until(() => expect(requests('publicDesk')).toHaveLength(3));
  });

  it('open_status_refetches_when_the_tab_is_visible', async () => {
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    const reads = () => requests('publicDesk').length;
    expect(reads()).toBe(1);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(200);
    expect(reads()).toBe(1);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(reads()).toBe(2));
    await sleep(200);

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(reads()).toBe(3));
    await sleep(200);

    // Coming back from sleep fires both at once: one read.
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(reads()).toBe(4));
    await sleep(300);
    expect(reads()).toBe(4);
    await expectOpenStatus(screen, 'Open now, until 6:00 pm', 'open');
  });

  it('stale_open_status_is_dropped_on_refetch_failure', async () => {
    useTimers();
    const streams = countStreams();
    const { screen } = await renderRoute(PAGE);
    await readyNow(screen);
    await until(() => expect(streams.opened).toBe(1));
    await until(() => expect(statusText().textContent).toBe('Open now, until 6:00 pm'));
    const chat = chatOpened(streams);

    // The read at `refresh_at` fails: the kernel no longer vouches for the line, so it goes, and
    // everything else stays as it was.
    mockStore.inject({ route: 'publicDesk', status: 503 });
    await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    await until(() => expect(requests('publicDesk')).toHaveLength(2));
    await until(() => expect(document.querySelector(OPEN_STATUS)).toBeNull());
    expect(screen.container.textContent).not.toContain('Open now');
    expect(screen.getByRole('heading', { level: 1, name: 'Rivera Plumbing' }).query()).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'About Rivera Plumbing' }).query()).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).element()).toBeEnabled();
    expect(chatOpened(streams)).toEqual(chat);

    // One retry 30 s later; its answer brings the line back.
    await settle();
    await vi.advanceTimersByTimeAsync(30_000 - MARGIN_MS);
    await settle();
    expect(requests('publicDesk')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MARGIN_MS);
    await until(() => expect(requests('publicDesk')).toHaveLength(3));
    await until(() => expect(statusLine().textContent).toContain('Open now, until 6:00 pm'));

    // A read on focus that gets no answer at all drops it the same way.
    mockStore.inject({ route: 'publicDesk', status: 'network' });
    window.dispatchEvent(new Event('focus'));
    await until(() => expect(requests('publicDesk')).toHaveLength(4));
    await until(() => expect(document.querySelector(OPEN_STATUS)).toBeNull());
    expect(chatOpened(streams)).toEqual(chat);
  });

  it('no_open_status_line_when_null', async () => {
    const open = await renderRoute(PAGE);
    await ready(open.screen);
    const header = (screen: RenderResult) => screen.getByRole('banner').element();
    // The header with the open status, less the status itself: what a Desk without hours shows.
    const withStatus = header(open.screen).cloneNode(true) as HTMLElement;
    const status = withStatus.querySelector(OPEN_STATUS);
    expect(status, 'the open header has a status to leave out').not.toBeNull();
    status?.remove();

    mockStore.inject({ route: 'publicDesk', status: 200, body: deskWith('en', null) });
    const { screen } = await renderRoute(PAGE);
    await ready(screen);
    await sleep(100);
    expect(document.querySelector(OPEN_STATUS)).toBeNull();
    expect(header(screen).querySelector('.cd-status-dot')).toBeNull();
    expect(screen.container.textContent).not.toMatch(/Open now|Closed now|Claude can still help/);
    expect(header(screen).innerHTML).toBe(withStatus.innerHTML);
  });

  it('unknown_desk_is_kind', async () => {
    document.title = APP_TITLE;
    const { screen } = await renderRoute('/d/rivera-plumbing-nope00');
    const main = screen.getByRole('main');
    await expect.element(main.getByText("This Desk isn't available", { exact: true })).toBeVisible();
    expect(document.title).toBe(APP_TITLE);
    await expect.element(main.getByText('Check the link, or contact the business another way.', { exact: true })).toBeVisible();
    expect(requests('openSession')).toEqual([]);
    await expectScreenBasics(screen.container, { owner: false });

    const es = await renderRoute('/d/rivera-plumbing-nope00', { language: 'es-MX', viewport: 'phone' });
    await expect.element(es.screen.getByText('Este Desk no está disponible', { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
  });

  it('phone_width_fits', async () => {
    const { screen } = await renderRoute(PAGE, { viewport: 'phone' });
    await ready(screen);
    await say(screen, 'How much is drain clearing?');
    await say(screen, 'Can someone come Tuesday afternoon?');
    await say(screen, 'Can I get 15% off if I pay cash?');
    await expect.element(screen.getByRole('button', { name: 'Cancel this request' })).toBeVisible();
    expectNoHorizontalScroll();
    await expectScreenBasics(screen.container, { owner: false });
  });
});

/**
 * The end of the conversation (its last row, receipt or notice) sits right above the composer that
 * stays at the bottom of the window: in view, and not hidden under it.
 */
function expectEndAboveTheComposer(screen: RenderResult): void {
  const { composer, conversation } = conversationAndComposer(screen);
  const end = conversation.getBoundingClientRect().bottom;
  const top = composer.getBoundingClientRect().top;
  expect(Math.abs(end - top), `the conversation ends at ${end}, the composer starts at ${top}`).toBeLessThanOrEqual(2);
  expect(top).toBeLessThanOrEqual(innerHeight);
  const rows = conversation.querySelectorAll('.cd-transcript-row');
  const last = rows[rows.length - 1]?.getBoundingClientRect();
  expect(last?.bottom ?? 0).toBeLessThanOrEqual(top);
  expect(last?.bottom ?? 0).toBeGreaterThan(0);
}

/** How far the end of the conversation reaches under the top of the composer area, in pixels. */
function endUnderTheComposer(screen: RenderResult): number {
  const { composer, conversation } = conversationAndComposer(screen);
  return conversation.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
}

/** The conversation and the composer area that stays at the bottom of the window. */
function conversationAndComposer(screen: RenderResult): { composer: Element; conversation: Element } {
  const composer = screen.getByRole('textbox', { name: 'Message Rivera Plumbing' }).element().closest('.cd-public-shell__composer');
  const conversation = document.querySelector('.cd-public-shell__conversation');
  if (!composer || !conversation) throw new Error('no conversation or composer');
  return { composer, conversation };
}

/** The open status, as the design system's PublicShell draws it in the header. */
const OPEN_STATUS = '.cd-public-shell__open-status';

/** The open status the page shows, in the header. */
function statusLine(): HTMLElement {
  const line = document.querySelector<HTMLElement>(OPEN_STATUS);
  if (!line) throw new Error('no open status line');
  expect(line.closest('header'), 'the open status sits in the header').not.toBeNull();
  return line;
}

/** The kernel's words in the open status line. */
function statusText(): HTMLElement {
  const text = statusLine().querySelector<HTMLElement>('.cd-public-shell__open-status-text');
  if (!text) throw new Error('no open status text');
  return text;
}

/** Where `el`'s text is drawn, rather than the box it sits in. */
function textBox(el: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
}

/** The kernel's words, exactly, with a dot that says the same: filled when open, hollow when closed. */
async function expectOpenStatus(screen: RenderResult, text: string, dot: 'open' | 'closed'): Promise<void> {
  await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  expect(statusText().textContent).toBe(text);
  const shown = statusLine().querySelector('.cd-status-dot');
  expect(shown?.getAttribute('aria-hidden')).toBe('true');
  const style = getComputedStyle(shown as Element);
  if (dot === 'open') {
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  } else {
    // Hollow: no fill, and an outline that still draws the dot.
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(style.borderTopStyle).toBe('solid');
  }
}

/** Rivera's public Desk as the kernel would serve it with `status` in its header. */
function deskWith(language: 'en' | 'es', status: OpenStatus | null): PublicDesk {
  return { ...rivera.publicDesk[language], open_status: status };
}

/** Rivera open until 6:00 pm, 90 s before closing (the mock's own status). */
const OPEN: Record<'en' | 'es', OpenStatus> = {
  en: {
    open: true,
    until: '2026-10-30T18:00:00-07:00',
    opens_at: null,
    text: 'Open now, until 6:00 pm',
    as_of: '2026-10-30T17:58:30-07:00',
    refresh_at: '2026-10-30T18:00:00-07:00',
  },
  es: {
    open: true,
    until: '2026-10-30T18:00:00-07:00',
    opens_at: null,
    text: 'Abierto ahora, hasta las 18:00',
    as_of: '2026-10-30T17:58:30-07:00',
    refresh_at: '2026-10-30T18:00:00-07:00',
  },
};

/** Rivera on a Saturday afternoon: closed until Monday at 8:00 am; the words hold until midnight. */
const CLOSED: Record<'en' | 'es', OpenStatus> = {
  en: {
    open: false,
    until: null,
    opens_at: '2026-11-02T08:00:00-08:00',
    text: 'Closed now. Opens Monday at 8:00 am',
    as_of: '2026-10-31T14:00:00-07:00',
    refresh_at: '2026-11-01T00:00:00-07:00',
  },
  es: {
    open: false,
    until: null,
    opens_at: '2026-11-02T08:00:00-08:00',
    text: 'Cerrado ahora. Abre el lunes a las 8:00',
    as_of: '2026-10-31T14:00:00-07:00',
    refresh_at: '2026-11-01T00:00:00-07:00',
  },
};

/** Makes `document.visibilityState` report `state` for the rest of the test. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  onTestFinished(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });
}

/** `ready`, polled in real time, for tests whose timers are fake. */
async function readyNow(screen: RenderResult): Promise<void> {
  await until(() => expect(screen.getByRole('textbox', { name: /^(?:Message|Mensaje para) / }).element()).toBeEnabled());
}

/** Real time, kept before any test fakes the timers. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** How far a timing check stays from the page's own timer, in fake time. */
const MARGIN_MS = 1_000;

/** Lets requests in flight reach the mock and the page act on their answers, in real time. */
async function settle(): Promise<void> {
  await sleep(200);
}

/** Polls `check` in real time until it passes: unlike `vi.waitFor`, it never moves fake timers on. */
async function until(check: () => void, timeoutMs = 4_000): Promise<void> {
  const start = performance.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (performance.now() - start > timeoutMs) throw err;
    }
    await sleep(20);
  }
}

/**
 * Fake timers and a fake clock for the owner's typing: her dots go only when the test moves the
 * clock (`vi.advanceTimersByTimeAsync`), and an event's time is read against the clock it was sent
 * by. Checks poll with `until`, since `expect.poll` would move the fake clock as it polls.
 */
function useTypingClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/**
 * A clock the typing pings are timed by that moves only when the test moves it (`pass`). Nothing
 * else is faked: the page's timers and the test's waits keep real time.
 */
function freezeClock(): { pass: (ms: number) => void } {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return { pass: (ms) => vi.advanceTimersByTime(ms) };
}

/**
 * Fake timers for the page's own waits (reopening the stream, refreshing the open status): the
 * clock moves only when the test moves it. The browser's stream, the mock API and the test's own
 * polling (`until`, `settle`) don't use those timers, so they keep running.
 */
function useTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** The event streams the page opens from here to the end of the test. */
interface StreamCount {
  readonly opened: number;
}

/**
 * Counts each `EventSource` the page constructs from here to the end of the test: the streams it
 * opens. The mock's log of stream requests can't be counted instead, because it also gets the
 * browser reconnecting a stream the page already has, and a stream that a page from the test
 * before was still opening when it closed.
 */
function countStreams(): StreamCount {
  const native = window.EventSource;
  const count = { opened: 0 };
  window.EventSource = class extends native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      count.opened += 1;
    }
  };
  onTestFinished(() => {
    window.EventSource = native;
  });
  return count;
}

/** What the chat has opened so far: sessions, reads of its conversation and streams. */
function chatOpened(streams: StreamCount): { sessions: number; reads: number; streams: number } {
  return { sessions: requests('openSession').length, reads: requests('visitorSession').length, streams: streams.opened };
}

/**
 * Each message's receipts are the kernel's lines for it, word for word (its reply check, then the
 * turn's actions), each one under the message and above the next row, with no clock time.
 */
function expectReceiptsUnderTheirMessages(screen: RenderResult): void {
  const expected: string[][] = [];
  let turn: string[] = [];
  for (const { ev } of chatEvents()) {
    if (ev.type === 'receipt' || ev.type === 'held' || ev.type === 'resolved') turn.push(ev.visitor_plain);
    if (ev.type === 'message') {
      expected.push([ev.visitor_plain, ...turn]);
      turn = [];
    }
  }
  const rows = [...screen.container.querySelectorAll<HTMLElement>('.cd-transcript-row')];
  const messageRows = rows.filter((row) => row.querySelector('.cd-claude-message') !== null);
  expect(messageRows.map((row) => receiptsOf(row))).toEqual(expected);
  for (const row of messageRows) {
    const message = row.querySelector('.cd-transcript-row__main')?.getBoundingClientRect();
    const next = rows[rows.indexOf(row) + 1]?.getBoundingClientRect();
    for (const receipt of row.querySelectorAll('.cd-margin-receipt')) {
      const box = receipt.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(message?.bottom ?? Number.POSITIVE_INFINITY);
      if (next) expect(box.bottom).toBeLessThanOrEqual(next.top);
      expect(receipt.textContent).not.toMatch(/\d{1,2}:\d{2}/);
      expect(receipt.querySelector('time')).toBeNull();
    }
  }
}

/** A message for each row of the script, in English and, where the row reads it, Spanish. */
const SCRIPT_SAMPLES: Record<RuleName, string[]> = {
  discount: ['Can I get 15% off if I pay cash?', '¿Me hacen un descuento?'],
  invoice: ['Can you send my invoice?', 'Necesito mi factura'],
  deposit: ['How do I pay the deposit?', 'Quiero pagar'],
  booked: ['Book the first one', 'Quiero reservar la primera'],
  book: ['Can someone come Tuesday afternoon?', 'Quiero reservar'],
  price: ['How much is drain clearing?', '¿Cuánto cuesta?'],
  callback: ['Can you call me back?', 'Llámame, por favor'],
  talk: ["I'd like to talk to Maria Rivera.", 'Quiero hablar con Maria'],
  outage: ['outage'],
  other: ['Hello there', 'Hola'],
};

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const DIAS = 'lunes|martes|miércoles|jueves|viernes|sábado|domingo';
/** A price or a date in prose: a currency sign, any digit, or a month or weekday name. */
const PRICE_OR_DATE = new RegExp(`[$€£]|\\d|(?<![\\p{L}])(?:${MONTHS}|${MESES}|${DAYS}|${DIAS})(?![\\p{L}])`, 'iu');
