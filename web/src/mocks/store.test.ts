/**
 * The mock API's store, driven the way its handlers drive it: the scripted Desk, held requests and
 * answers, Today, the event log a stream replays, the transcript, a start over and injected faults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerPage, SseEvent } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type {
  ConversationSummary,
  CopyOut,
  NeedsYouItem,
  OwnerTranscript,
  Today,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { EVENT_GAP_MS, matchRule, turnLanguage, type RuleName } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore, streamAfter, type MockAnswer, type MockRequestInit } from './store.ts';

const slug = RIVERA.slug;
const deskId = RIVERA.deskId;

/** A route's answer, which must be one with a status (not a dropped connection). */
async function call(key: RouteKey, init: MockRequestInit = {}): Promise<{ status: number; body: unknown }> {
  const answer: MockAnswer = await mockStore.dispatch(key, init);
  if ('network' in answer) throw new Error(`${key} dropped the connection`);
  return { status: answer.status, body: answer.body };
}

/** Opens this browser's chat with Rivera's main Desk and records every event its stream gets. */
async function openChat(after = 0) {
  const opened = await call('openSession', { params: { slug } });
  expect(opened.status).toBe(200);
  const events: [number, SseEvent][] = [];
  const stop = mockStore.listen(slug, after, (seq, ev) => events.push([seq, ev]));
  return { session: (opened.body as VisitorSession).state, events, stop };
}

async function send(text: string) {
  const sent = await call('sendMessage', { params: { slug }, body: { text } });
  expect(sent.status).toBe(202);
}

/** Lets every scheduled event of a turn of `steps` events arrive. */
async function drain(steps = 12) {
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * steps);
}

const typesOf = (events: [number, SseEvent][]) => events.map(([, ev]) => ev.type);

beforeEach(() => {
  vi.useFakeTimers();
  mockStore.reset('rivera');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the scripted Desk', () => {
  it('script_matches_the_first_rule', () => {
    const cases: [text: string, rule: RuleName, language: 'en' | 'es'][] = [
      // "off" comes before "pay": a discount asked with cash is held, not a payment link.
      ['Can I get 50% off if I pay cash?', 'discount', 'en'],
      ['Is there a DISCOUNT for seniors?', 'discount', 'en'],
      ['¿Me hacen un descuento?', 'discount', 'es'],
      ['Can you send my invoice?', 'invoice', 'en'],
      ['I want to return the part', 'invoice', 'en'],
      ['Necesito mi factura', 'invoice', 'es'],
      ['How do I pay the deposit?', 'deposit', 'en'],
      ['Quiero pagar ahora', 'deposit', 'es'],
      // "first one" picks a time already offered, before "book" or "tuesday" would list them again.
      ['Book the first one', 'booked', 'en'],
      ['The first one works. Dana Whitfield, 2817 Fruitvale Ave.', 'booked', 'en'],
      ['Quiero reservar la primera', 'booked', 'es'],
      ['Can I book Tuesday?', 'book', 'en'],
      ['Quiero reservar una visita', 'book', 'es'],
      ['How much is drain clearing?', 'price', 'en'],
      ['What does a leak repair cost?', 'price', 'en'],
      ['¿Cuánto cuesta?', 'price', 'es'],
      ['Can you call me back?', 'callback', 'en'],
      ['Please call me tonight', 'callback', 'en'],
      ['Llámame, por favor', 'callback', 'es'],
      ["I'd like to talk to Maria Rivera.", 'talk', 'en'],
      ['Quiero hablar con alguien', 'talk', 'es'],
      ['outage', 'outage', 'en'],
      ['Hello there', 'other', 'en'],
      ['Hola', 'other', 'es'],
    ];
    for (const [text, rule, language] of cases) {
      expect(matchRule(text).name, text).toBe(rule);
      expect(turnLanguage(text), text).toBe(language);
    }
  });

  it('discount_holds_and_reaches_needs_you', async () => {
    // Rivera's Today greets Maria, counts the seeded hold, and has Dana's chat live (the held
    // visitor's last word was twelve minutes ago).
    const today = async () => (await call('today', { params: { desk_id: deskId } })).body as Today;
    const seeded = await today();
    expect(seeded.greeting_name).toBe('Maria');
    expect(seeded.needs_you_count).toBe(1);
    expect(seeded.live.map((c) => [c.session_id, c.display_name])).toEqual([['ses-dana-web', null]]);

    mockStore.reset('rivera_quiet');
    expect((await call('needsYou', { params: { desk_id: deskId } })).body).toEqual([]);
    expect(await today()).toMatchObject({ greeting_name: 'Maria', needs_you_count: 0, live: [] });

    const { session, events } = await openChat();
    await send('Can I get 50% off if I pay cash?');
    await drain();
    const afterHold = await today();
    expect(afterHold.needs_you_count).toBe(1);
    expect(afterHold.live.map((c) => c.session_id)).toEqual([session.session_id]);

    expect(typesOf(events)).toEqual(['held', 'writing', 'message', 'turn_end']);
    expect(events.map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    const [, held] = events[0] ?? [];
    expect(held).toMatchObject({ type: 'held', state: 'held', visitor_plain: 'Waiting for Maria Rivera to approve' });
    const [, reply] = events[2] ?? [];
    expect(reply).toMatchObject({ type: 'message', handoff: true, language: 'en' });
    expect(reply?.type === 'message' && reply.blocks.map((b) => b.template)).toEqual(['handoff']);

    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou).toHaveLength(1);
    const [item] = needsYou;
    expect(item?.decision).toMatchObject({
      session_id: session.session_id,
      outcome: 'hold',
      state: 'held',
      answers: ['allow_once', 'deny_once', 'deny_always'],
    });
    expect(item?.decision?.decision_id).toBe(held?.type === 'held' ? held.decision_id : 'none');
    expect(item?.held_by).toBe('Quotes from your price list, at list price.');
    expect(item?.from_the_visitor).toBe('Can I get 50% off if I pay cash?');
    expect(item?.session).toMatchObject({ session_id: session.session_id, kind: 'visitor', verified: false });

    const ledger = (await call('ledger', { params: { desk_id: deskId }, query: { verify: 'true' } })).body as LedgerPage;
    const decide = ledger.entries.find((e) => e.event.kind === 'decide' && e.event.ref_id === item?.decision?.decision_id);
    expect(decide?.seq).toBe(item?.decision?.ledger_seq);
    expect(decide?.event.summary).toMatchObject({ tool: 'native.quote', outcome: 'hold' });
  });

  it('answer_resolves_and_follows_up', async () => {
    const { events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[0] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    const answered = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      decision: { decision_id: decisionId, state: 'executed', visitor_plain: "Quoted from Maria Rivera's price list" },
      execution_state: 'succeeded',
      card_diff: null,
    });
    // Nothing reaches the chat in the answer itself: the follow-up arrives on the stream.
    expect(typesOf(events)).toEqual(['held', 'writing', 'message', 'turn_end']);

    await drain();
    expect(typesOf(events).slice(4)).toEqual(['resolved', 'writing', 'message', 'turn_end']);
    const [, resolved] = events[4] ?? [];
    // An executed action's line says what ran and whose records it used, never a bare "Done".
    expect(resolved).toMatchObject({
      type: 'resolved',
      decision_id: decisionId,
      state: 'executed',
      visitor_plain: "Quoted from Maria Rivera's price list",
    });
    const [, followUp] = events[6] ?? [];
    expect(followUp?.type === 'message' && followUp.blocks.map((b) => [b.kind, b.template])).toEqual([
      ['prose', null],
      ['card', 'quote'],
    ]);
    expect(followUp?.type === 'message' && followUp.blocks[1]?.title).toBe('$153.00');

    // The hold has left Needs you; the seeded one is still there.
    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou.map((item) => item.decision?.decision_id)).not.toContain(decisionId);
    expect(needsYou).toHaveLength(1);
  });

  it('executed_receipts_say_what_ran', async () => {
    const { events } = await openChat();
    const turns: [text: string, line: string][] = [
      ['How much is drain clearing?', "Quoted from Maria Rivera's price list"],
      ['Can I book Tuesday?', "Times read from Maria Rivera's calendar"],
      ['Book the first one', "Booked on Maria Rivera's calendar"],
      ['How do I pay the deposit?', 'Payment link made for this quote'],
      ['Can you call me back?', 'Callback request saved for Maria Rivera'],
      ['¿Cuánto cuesta?', 'Cotizado con la lista de precios de Maria Rivera'],
      ['Quiero reservar la primera', 'Reservado en el calendario de Maria Rivera'],
    ];
    for (const [text] of turns) {
      await send(text);
      await drain();
    }
    const receipts = events.flatMap(([, ev]) => (ev.type === 'receipt' ? [ev] : []));
    expect(receipts.map((ev) => [ev.state, ev.visitor_plain])).toEqual(turns.map(([, line]) => ['executed', line]));
    expect(events.some(([, ev]) => 'visitor_plain' in ev && /^(?:Done|Hecho)$/.test(ev.visitor_plain))).toBe(false);

    // "Book the first one" books the first time offered: the kernel's booked card, in its words,
    // after a prose line with no price or date.
    const booked = events.flatMap(([, ev]) => (ev.type === 'message' && ev.blocks.some((b) => b.template === 'booking_confirmed') ? [ev] : []));
    expect(booked.map((ev) => [ev.language, ev.blocks.map((b) => [b.kind, b.title, b.lines])])).toEqual([
      [
        'en',
        [
          ['prose', null, []],
          ['card', 'Tuesday, November 3', ['Arriving 2:00 pm to 4:00 pm', 'With Maria Rivera']],
        ],
      ],
      [
        'es',
        [
          ['prose', null, []],
          ['card', 'martes 3 de noviembre, 14:00', ['120 minutos', 'Reserva B-77']],
        ],
      ],
    ]);
    // The booking is this chat's, confirmed.
    const sessionId = mockStore.visitorSession(slug)?.state.session_id;
    const bookings = [...mockStore.world.decisions.values()].filter(
      (d) => d.decision.session_id === sessionId && d.decision.action?.tool === 'native.book',
    );
    expect(bookings.map((d) => d.decision.state)).toEqual(['executed', 'executed']);
  });

  it('visitor_cancel_resolves_the_hold', async () => {
    const { events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[0] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    // Only this browser's own session can cancel, and only a decision of that session.
    const seeded = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).find(
      (item) => item.decision?.decision_id !== decisionId,
    );
    expect((await call('cancelRequest', { params: { slug, decision_id: seeded?.decision?.decision_id ?? '' } })).status).toBe(404);

    const cancelled = await call('cancelRequest', { params: { slug, decision_id: decisionId } });
    expect(cancelled).toEqual({ status: 202, body: { decision_id: decisionId } });
    // The outcome reaches the chat as the resolved receipt, with the kernel's line.
    expect(events.at(-1)?.[1]).toMatchObject({ type: 'resolved', decision_id: decisionId, state: 'cancelled', visitor_plain: 'Cancelled' });
    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou.map((item) => item.decision?.decision_id)).not.toContain(decisionId);

    // Cancelling again, or answering it now, changes nothing.
    expect((await call('cancelRequest', { params: { slug, decision_id: decisionId } })).status).toBe(409);
    expect((await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } })).status).toBe(409);
    const ledger = (await call('ledger', { params: { desk_id: deskId } })).body as LedgerPage;
    expect(ledger.entries.filter((e) => e.event.ref_id === decisionId).map((e) => e.event.kind)).toEqual(['decide', 'approval']);
  });

  it('second_answer_conflicts_with_the_decision', async () => {
    const [seeded] = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const decisionId = seeded?.decision?.decision_id ?? '';
    expect(seeded?.decision?.answers).toEqual(['allow_once', 'deny_once', 'deny_always']);

    // An answer the hold doesn't offer changes nothing.
    const notOffered = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_person' } });
    expect(notOffered).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });

    const first = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'deny_always' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      decision: { state: 'denied' },
      execution_state: null,
      card_diff: [{ card_id: 'never-anyone-native.quote', applies_to: 'native.quote', mode: 'never', who: 'anyone' }],
    });

    const second = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'already_resolved', decision: { decision_id: decisionId, state: 'denied' } });

    const unknown = await call('answer', { params: { decision_id: 'dec-elsewhere' }, body: { answer: 'allow_once' } });
    expect(unknown.status).toBe(404);
  });

  it('events_replay_after_seq', async () => {
    // No stream without this browser's session for the Desk, and none for a Desk that doesn't exist.
    expect(await call('events', { params: { slug } })).toEqual({ status: 401, body: { error: 'no_session' } });
    expect((await call('events', { params: { slug: 'rivera-plumbing-nope00' } })).status).toBe(404);

    const { session, stop } = await openChat();
    expect((await call('events', { params: { slug }, query: { after: '0' } })).status).toBe(200);
    await send('How much is drain clearing?');
    await drain();
    stop();

    // A reconnect from seq 2 gets 3 and 4 at once, in order, then what comes next as it happens.
    const replayed: [number, SseEvent][] = [];
    mockStore.listen(slug, 2, (seq, ev) => replayed.push([seq, ev]));
    expect(replayed.map(([seq, ev]) => [seq, ev.type])).toEqual([
      [3, 'message'],
      [4, 'turn_end'],
    ]);
    await send('Can you call me back?');
    await drain();
    expect(replayed.map(([seq]) => seq)).toEqual([3, 4, 5, 6, 7, 8]);

    // A listener that throws (a framing bug, a failed expect) is dropped and the others still hear
    // the event, but its error is rethrown where the test runner sees it, not swallowed.
    const record = mockStore.world.sessions.get(session.session_id);
    if (!record) throw new Error('the session is in the copy');
    const broken = new Error('the listener failed');
    let brokenCalls = 0;
    mockStore.listen(slug, 8, () => {
      brokenCalls += 1;
      throw broken;
    });
    const surfaced: (() => void)[] = [];
    const microtasks = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => void surfaced.push(task));
    mockStore.world.emit(record, { type: 'writing' });
    microtasks.mockRestore();
    mockStore.world.emit(record, { type: 'turn_end' });
    expect(brokenCalls).toBe(1);
    expect(replayed.map(([seq, ev]) => [seq, ev.type]).slice(-2)).toEqual([
      [9, 'writing'],
      [10, 'turn_end'],
    ]);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toThrow(broken);

    // The resume point: `?after=`, or the browser's Last-Event-ID when it is later.
    expect(streamAfter(new URLSearchParams('after=4'), null)).toBe(4);
    expect(streamAfter(new URLSearchParams('after=4'), '6')).toBe(6);
    expect(streamAfter(new URLSearchParams('after=7'), '6')).toBe(7);
    expect(streamAfter(new URLSearchParams('after=-1'), 'x')).toBe(0);

    // A start over is a new copy: new ids, the old Desk gone, a chat that starts afresh, and the
    // old copy's turn in flight never finishing.
    await send('How much is drain clearing?');
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS);
    expect(replayed.at(-1)?.[1].type).toBe('receipt');
    const heard = replayed.length;
    const fresh = await call('startOver');
    expect(fresh.status).toBe(200);
    const copy = fresh.body as CopyOut;
    const newDesk = copy.desks[0];
    if (!newDesk) throw new Error('the new copy has its Desk');
    expect(copy.copy_id).not.toBe(RIVERA.copyId);
    expect(newDesk.desk_id).not.toBe(deskId);
    expect(newDesk.slug).not.toBe(slug);
    expect((await call('today', { params: { desk_id: deskId } })).status).toBe(404);
    expect((await call('events', { params: { slug } })).status).toBe(404);
    expect((await call('today', { params: { desk_id: newDesk.desk_id } })).status).toBe(200);
    expect(await call('visitorSession', { params: { slug: newDesk.slug } })).toEqual({ status: 401, body: { error: 'no_session' } });
    const reopened = (await call('openSession', { params: { slug: newDesk.slug } })).body as VisitorSession;
    expect(reopened.resumed).toBe(false);
    expect(reopened.state.session_id).not.toBe(session.session_id);
    await drain();
    expect(replayed).toHaveLength(heard);
  });

  it('transcript_keeps_visitor_text_in_order', async () => {
    const { session } = await openChat();
    // Untrusted text is kept exactly as typed.
    const first = 'How much is drain clearing? <b>now</b>';
    await send(first);
    await drain();
    await send('Can I book Tuesday?');
    await drain();
    // The owner whispers to Claude: the owner's view keeps it, the visitor's never shows it.
    const record = mockStore.world.sessions.get(session.session_id);
    if (!record) throw new Error('the session is in the copy');
    mockStore.world.whisper(record, 'offer Thursday morning too');

    const read = (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;
    expect(read.state.session_id).toBe(session.session_id);
    expect(read.last_seq).toBe(8);
    expect(read.items.map((item) => [item.kind, item.text ?? item.event?.type])).toEqual([
      ['visitor_text', first],
      ['status', 'receipt'],
      ['delivered', 'message'],
      ['visitor_text', 'Can I book Tuesday?'],
      ['status', 'receipt'],
      ['delivered', 'message'],
    ]);
    const ns = read.items.map((item) => item.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(read.items.every((item) => !('owner_translation' in item) && !('triage' in item))).toBe(true);

    // The owner reads the same items and the whisper, from a cursor, with the owner-only fields.
    const owner = (await call('conversation', { params: { session_id: session.session_id }, query: { after: String(ns[2]) } }))
      .body as OwnerTranscript;
    expect(owner.items.map((item) => [item.kind, item.text ?? item.event?.type])).toEqual([
      ['visitor_text', 'Can I book Tuesday?'],
      ['status', 'receipt'],
      ['delivered', 'message'],
      ['whisper', 'offer Thursday morning too'],
    ]);
    expect(owner.items[0]).toMatchObject({ owner_translation: null, triage: null });

    // Dana's seeded chat: three actions that ran, and Maria's whisper in it.
    const conversations = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    const dana = conversations.find((c) => c.session_id === 'ses-dana-web');
    expect(dana?.outcome_counts).toEqual({ executed: 3 });
    const danaOwner = (await call('conversation', { params: { session_id: 'ses-dana-web' } })).body as OwnerTranscript;
    expect(danaOwner.items.filter((item) => item.kind === 'whisper').map((item) => item.text)).toEqual(['offer Thursday morning too']);

    // The owner's preview of her Desk is a chat of its own, flagged as hers, and opening it again
    // resumes it rather than starting another.
    const preview = (await call('openPreview', { params: { desk_id: deskId } })).body as VisitorSession;
    expect(preview.resumed).toBe(false);
    expect(preview.state.session_id).not.toBe(session.session_id);
    expect((await call('openPreview', { params: { desk_id: deskId } })).body).toEqual({ state: preview.state, resumed: true });
    const listed = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(listed.filter((c) => c.owner_preview).map((c) => c.session_id)).toEqual([preview.state.session_id]);
  });
});

describe('planted faults', () => {
  const answering = async () => ((await call('me')).body as CopyOut).desks[0]?.answering;

  it('injected_fault_applies_once', async () => {
    // A fault answers in the route's place, once, and changes nothing.
    mockStore.inject({ route: 'setAnswering', status: 503 });
    expect(await call('setAnswering', { params: { desk_id: deskId }, body: { on: false } })).toEqual({
      status: 503,
      body: { error: 'kernel', code: 'kernel_unavailable' },
    });
    expect(await answering()).toBe(true);
    expect((await call('setAnswering', { params: { desk_id: deskId }, body: { on: false } })).status).toBe(200);
    expect(await answering()).toBe(false);

    // `times`, a body of its own, and a delay before the answer.
    mockStore.inject({ route: 'today', status: 429, times: 2, body: { error: 'rate_limited', retry_after: 7 }, delayMs: 300 });
    const late = call('today', { params: { desk_id: deskId } });
    let settled = false;
    void late.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await late).toEqual({ status: 429, body: { error: 'rate_limited', retry_after: 7 } });
    const again = call('today', { params: { desk_id: deskId } });
    await vi.advanceTimersByTimeAsync(300);
    expect((await again).status).toBe(429);
    expect((await call('today', { params: { desk_id: deskId } })).status).toBe(200);

    // `afterCommit`: the message is kept and Claude answers it, but its answer is lost.
    const { events } = await openChat();
    mockStore.inject({ route: 'sendMessage', status: 'network', afterCommit: true });
    expect(await mockStore.dispatch('sendMessage', { params: { slug }, body: { text: 'How much is drain clearing?' } })).toEqual({
      network: true,
    });
    await drain();
    const read = (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;
    expect(read.items.filter((item) => item.kind === 'visitor_text').map((item) => item.text)).toEqual([
      'How much is drain clearing?',
    ]);
    expect(typesOf(events)).toEqual(['receipt', 'writing', 'message', 'turn_end']);

    // Every request is recorded with its body and path, faulted or not.
    expect(mockStore.requests.filter((r) => r.key === 'setAnswering')).toEqual([
      { key: 'setAnswering', body: { on: false }, path: `/api/owner/desks/${deskId}/answering` },
      { key: 'setAnswering', body: { on: false }, path: `/api/owner/desks/${deskId}/answering` },
    ]);
  });
});
