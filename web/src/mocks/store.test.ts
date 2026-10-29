/**
 * The mock API's store, driven the way its handlers drive it: the scripted Desk, held requests and
 * answers, Today, the event log a stream replays, the transcript, a start over and injected faults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionState, EvMessage, LedgerPage, PublicDesk, SseEvent } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type {
  BriefingList,
  ConversationSummary,
  CopyOut,
  NeedsYouItem,
  OwnerTranscript,
  Today,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { executedLine } from '../ds/fixtures/receipts.ts';
import { DECISIONS, EVENT_GAP_MS, VISITOR_PLAIN, matchRule, turnLanguage, type RuleName } from './script.ts';
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
  it('script_matches_the_first_rule', async () => {
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

    // The last rule, which takes anything, answers with the signed board's line, in the turn's language.
    const { events } = await openChat();
    await send('Is it better to replace my water heater than to repair it?');
    await drain();
    await send('Hola');
    await drain();
    const replies = events.flatMap(([, ev]) => (ev.type === 'message' ? [[ev.language, ev.blocks.map((b) => [b.kind, b.text])]] : []));
    expect(replies).toEqual([
      ['en', [['prose', 'Maria can tell you once she sees it. You can ask for her here anytime.']]],
      ['es', [['prose', 'Maria te lo puede decir cuando lo vea. Puedes pedir hablar con ella aquí cuando quieras.']]],
    ]);
  });

  it('discount_holds_and_reaches_needs_you', async () => {
    // Rivera's Today greets Maria, counts the seeded hold, and has Dana's chat live (the held
    // visitor's last word was twelve minutes ago).
    const today = async () => (await call('today', { params: { desk_id: deskId } })).body as Today;
    const seeded = await today();
    expect(seeded.greeting_name).toBe('Maria');
    expect(seeded.needs_you_count).toBe(1);
    expect(seeded.live.map((c) => [c.session_id, c.display_name])).toEqual([['ses-dana-web', null]]);

    // The Emergencies Desk is open around the clock: each day's window ends at midnight, where the
    // next begins, so the windows touch and its status says "Open now" with no end.
    mockStore.reset('rivera_two_desks');
    const emergencies = ((await call('me')).body as CopyOut).desks.find((d) => d.desk_id === RIVERA.emergenciesDeskId);
    expect(emergencies?.hours).toEqual([{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00:00', end: '00:00:00' }]);
    const open = (await call('publicDesk', { params: { slug: RIVERA.emergenciesSlug } })).body as PublicDesk;
    expect(open.open_status).toMatchObject({ open: true, until: null, text: 'Open now' });

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
    // The quote card's discount limit held it, not an ask card, so there is no "Deny always"; the
    // visitor isn't verified, so there is no "Allow only for this person" either.
    expect(item?.decision).toMatchObject({
      session_id: session.session_id,
      outcome: 'hold',
      state: 'held',
      answers: ['allow_once', 'deny_once'],
    });
    expect(item?.decision?.decision_id).toBe(held?.type === 'held' ? held.decision_id : 'none');
    expect(item?.held_by).toBe('Quotes from your price list, at list price.');
    expect(item?.from_the_visitor).toBe('Can I get 50% off if I pay cash?');
    expect(item?.session).toMatchObject({ session_id: session.session_id, kind: 'visitor', verified: false });

    const ledger = (await call('ledger', { params: { desk_id: deskId }, query: { verify: 'true' } })).body as LedgerPage;
    const decide = ledger.entries.find((e) => e.event.kind === 'decide' && e.event.ref_id === item?.decision?.decision_id);
    expect(decide?.seq).toBe(item?.decision?.ledger_seq);
    expect(decide?.event.summary).toMatchObject({ tool: 'native.quote', outcome: 'hold' });

    // A verified visitor's limit hold adds "Allow only for this person", for money only within the
    // rules' money cap; an ask card's hold adds "Deny always".
    const refund = mockStore.world.addHeldRefund();
    const dana = mockStore.world.sessions.get(refund.session_id);
    if (!dana) throw new Error("Dana's verified session is in the copy");
    expect(dana.state).toMatchObject({ verified: true, assurance: 'demo_code' });
    const answersFor = (spec: (typeof DECISIONS)[keyof typeof DECISIONS]) => mockStore.world.decide(dana, spec, 'en').answers;
    expect(answersFor(DECISIONS.heldQuote)).toEqual(['allow_once', 'deny_once', 'allow_person']);
    expect(refund.answers).toEqual(['allow_once', 'deny_once', 'allow_person', 'deny_always']);
    expect(answersFor({ ...DECISIONS.heldRefund, amountCents: 50_001 })).toEqual(['allow_once', 'deny_once', 'deny_always']);
    expect(answersFor({ ...DECISIONS.heldRefund, amountCents: 50_000 })).toContain('allow_person');
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
    // Each is the design system's signed line for its tool, word for word.
    expect(receipts.map((ev) => ev.visitor_plain)).toEqual([
      ...(['native.quote', 'native.find_slots', 'native.book', 'native.payment_link', 'native.request_callback'] as const).map((tool) =>
        executedLine(tool, 'en', 'Maria Rivera'),
      ),
      executedLine('native.quote', 'es', 'Maria Rivera'),
      executedLine('native.book', 'es', 'Maria Rivera'),
    ]);

    // The other status lines are the design system's too: every decision state's, and each reply's.
    const states = Object.keys(rivera.decisions).filter((state): state is Exclude<DecisionState, 'executed'> => state !== 'executed');
    for (const state of states) expect(VISITOR_PLAIN.en[state], state).toBe(rivera.decisions[state].visitor_plain);
    const reply = (turn: readonly SseEvent[]) => turn.find((ev): ev is EvMessage => ev.type === 'message')?.visitor_plain;
    expect([VISITOR_PLAIN.en.reply_checked, VISITOR_PLAIN.en.reply_handed_off, VISITOR_PLAIN.es.reply_checked]).toEqual([
      reply(rivera.events.quoteTurn),
      reply(rivera.events.heldTurn),
      reply(rivera.events.quoteTurnEs),
    ]);

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
    const seededId = seeded?.decision?.decision_id ?? '';
    // The seeded 15% quote is a limit hold from a visitor not on record: the two one-time answers.
    expect(seeded?.decision?.answers).toEqual(['allow_once', 'deny_once']);

    // An answer the hold doesn't offer changes nothing, "Deny always" on a limit hold included.
    const invalid = { status: 422, body: { error: 'kernel', code: 'invalid' } };
    for (const answer of ['allow_person', 'deny_always']) {
      expect(await call('answer', { params: { decision_id: seededId }, body: { answer } }), answer).toEqual(invalid);
    }
    expect(mockStore.world.decisions.get(seededId)?.decision.state).toBe('held');

    // Verified Dana's refund: the refund card asks about every refund, so all four answers.
    const refund = mockStore.world.addHeldRefund();
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).find(
      (item) => item.decision?.decision_id === refund.decision_id,
    );
    expect(held?.decision).toMatchObject({
      outcome: 'hold',
      state: 'held',
      card_ids: ['rv-refund'],
      action: { tool: 'payments.create_refund', amount_cents: 18_000 },
      answers: ['allow_once', 'deny_once', 'allow_person', 'deny_always'],
    });
    expect(held?.held_by).toBe('Refunds to a customer wait for your answer.');
    expect(held?.session).toMatchObject({ verified: true, display_name: 'Dana Whitfield' });

    // "Deny always" denies it and drafts a never card for Dana and this tool.
    const first = await call('answer', { params: { decision_id: refund.decision_id }, body: { answer: 'deny_always' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      decision: { decision_id: refund.decision_id, state: 'denied' },
      execution_state: null,
      card_diff: [
        {
          card_id: 'never-per-dana-payments.create_refund',
          applies_to: 'payments.create_refund',
          mode: 'never',
          who: 'person',
          person_id: 'per-dana',
        },
      ],
    });

    // A second answer, even one the hold offered, gets the decision as it now stands.
    for (const answer of ['allow_once', 'deny_always']) {
      const second = await call('answer', { params: { decision_id: refund.decision_id }, body: { answer } });
      expect(second.status, answer).toBe(409);
      expect(second.body).toMatchObject({ error: 'already_resolved', decision: { decision_id: refund.decision_id, state: 'denied' } });
    }

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

describe("Today's windows", () => {
  /** Thursday, October 29, 10:30 am in Los Angeles. */
  const NOW = new Date('2026-10-29T17:30:00Z');
  const HOUR = 60 * 60_000;
  const read = async () => (await call('today', { params: { desk_id: deskId } })).body as Today;
  const list = async () => (await call('briefing', { params: { desk_id: deskId } })).body as BriefingList;

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it('today_counts_what_happened', async () => {
    // A quiet copy: every figure zero, seven empty days ending today, and nothing since last night.
    mockStore.reset('rivera_quiet');
    const quiet = await read();
    expect(quiet.briefing).toEqual({
      since: '2026-10-28T18:00:00-07:00',
      conversations: 0,
      bookings: 0,
      leads: 0,
      blocked: 0,
      total: 0,
      newest: { blocked: null, booking: null, lead_or_answer: null },
    });
    expect(quiet.this_week).toEqual({
      timezone: 'America/Los_Angeles',
      start: '2026-10-23',
      end: '2026-10-29',
      bookings: 0,
      booked_cents: 0,
      conversations: 0,
      handled: 0,
      stepped_in: 0,
      stopped: 0,
      days: ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((date) => ({
        date,
        conversations: 0,
        bookings: 0,
        stopped: 0,
      })),
    });
    expect('recorded_history' in quiet).toBe(false);
    expect(await list()).toEqual({ since: '2026-10-28T18:00:00-07:00', items: [] });

    // Rivera's seed: the held visitor, whose drafted reply was stopped, and Dana's chat, where Maria
    // whispered and Claude booked her at the quoted list price.
    mockStore.reset('rivera');
    const seeded = await read();
    expect(seeded.this_week).toMatchObject({ bookings: 1, booked_cents: 18_000, conversations: 2, handled: 1, stepped_in: 1, stopped: 1 });
    expect(seeded.this_week.days.at(-1)).toEqual({ date: '2026-10-29', conversations: 2, bookings: 1, stopped: 1 });
    expect(seeded.briefing).toMatchObject({ conversations: 2, bookings: 1, leads: 0, blocked: 1, total: 2 });
    const blockedReply = mockStore.world.desks[0]?.ledger.find((e) => e.event.kind === 'reply' && e.event.summary.ok === false);
    expect(seeded.briefing.newest.blocked).toMatchObject({
      kind: 'blocked',
      session_id: 'ses-visitor-web',
      ref_id: String(blockedReply?.seq),
      line: null,
    });
    expect(seeded.briefing.newest.booking).toMatchObject({
      kind: 'booking',
      session_id: 'ses-dana-web',
      line: DECISIONS.book.reasonPlain,
    });
    expect(seeded.briefing.newest.lead_or_answer).toBeNull();
    // The blocked reply's attempt on Safety has the same ref.
    const attempts = (await call('safety', { params: { desk_id: deskId } })).body as { kind: string; ref_id: string }[];
    expect(attempts.find((a) => a.kind === 'reply_blocked')?.ref_id).toBe(String(blockedReply?.seq));

    // Maria allows the seeded hold: she stepped into that chat, and a quote isn't a booking.
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])[0]?.decision;
    await call('answer', { params: { decision_id: held?.decision_id ?? '' }, body: { answer: 'allow_once' } });
    await drain();
    expect((await read()).this_week).toMatchObject({ bookings: 1, conversations: 2, handled: 0, stepped_in: 2 });

    // A visitor Claude answers, and Maria's own preview that Claude answers too: both count.
    await openChat();
    await send('Hello there');
    await drain();
    await call('openPreview', { params: { desk_id: deskId } });
    await send('Do you work weekends?');
    await drain();
    const both = await read();
    expect(both.this_week).toMatchObject({ conversations: 4, stepped_in: 2, handled: 2 });
    expect(both.briefing).toMatchObject({ conversations: 4, total: 4 });
    expect(both.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', display_name: null });

    // And a visitor who asks for a callback is a lead, not an answer.
    mockStore.reset('rivera');
    await openChat();
    await send('Can you call me back?');
    await drain();
    const withLead = await read();
    expect(withLead.briefing).toMatchObject({ leads: 1, total: 3 });
    expect(withLead.briefing.newest.lead_or_answer).toMatchObject({
      kind: 'lead',
      display_name: 'Dana Wells',
      line: '(503) 555-0142 · Leaking water heater',
    });
    await openChat();
    await vi.advanceTimersByTimeAsync(60_000);
    await call('openPreview', { params: { desk_id: deskId } });
    await send('Do you work weekends?');
    await drain();
    const answered = await read();
    const preview = [...mockStore.world.sessions.values()].find((s) => s.ownerPreview);
    expect(answered.briefing.newest.lead_or_answer).toEqual({
      kind: 'answer',
      at: expect.any(String),
      session_id: preview?.state.session_id,
      display_name: null,
      ref_id: preview?.state.session_id,
      line: null,
    });
    expect(answered.this_week).toMatchObject({ conversations: 4, stepped_in: 1, handled: 3 });

    // The full list, newest first, and the short form's rows are its own.
    const full = await list();
    expect(full.items.map((item) => item.kind)).toEqual(['answer', 'lead', 'booking', 'blocked']);
    expect(full.items).toHaveLength(answered.briefing.total);
    expect(full.items).toContainEqual(answered.briefing.newest.blocked);
    expect(full.items).toContainEqual(answered.briefing.newest.booking);
  });

  it('windows_follow_the_business_clock', async () => {
    mockStore.reset('rivera_quiet');
    const desk = mockStore.world.desks[0];
    if (!desk) throw new Error('the copy has its Desk');
    const chatAt = (ms: number, text: string) => {
      const session = mockStore.world.at(ms, () => mockStore.world.addSession(desk));
      mockStore.world.replay(session, ms, [{ text, steps: matchRule(text).steps }]);
    };
    // Yesterday at 5:30 pm, before last night began at 6:00 pm: in the last 7 days, not the briefing.
    chatAt(Date.parse('2026-10-29T00:30:00Z'), 'Hello there');
    // Yesterday at 7:00 pm: in both.
    chatAt(Date.parse('2026-10-29T02:00:00Z'), 'How much is drain clearing?');
    // Eight days ago: in neither.
    chatAt(NOW.getTime() - 8 * 24 * HOUR, 'Hello there');
    // Friday the 23rd just after midnight, the first of the seven days.
    chatAt(Date.parse('2026-10-23T07:01:00Z'), 'Hello there');

    const today = await read();
    expect(today.this_week.conversations).toBe(3);
    expect(today.this_week.days.map((d) => d.conversations)).toEqual([1, 0, 0, 0, 0, 2, 0]);
    expect(today.briefing.conversations).toBe(1);
    // The quote at 7:00 pm answered a question: Claude replied with no booking, lead, hold or stop.
    expect(today.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', line: null });
    expect(today.briefing.total).toBe(1);
  });
});
