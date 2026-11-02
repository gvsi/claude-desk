/**
 * The mock API's store, driven the way its handlers drive it: the scripted Desk, held requests and
 * answers, Today, the event log a stream replays, the transcript, a start over and injected faults.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Decision, DecisionState, EvMessage, HoursWindow, KnowledgeItem, LedgerPage, PublicDesk, RuleCard, SseEvent } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type {
  ApprovalAnswerOut,
  Attempt,
  BriefingList,
  ConversationSummary,
  CopyOut,
  DemoAgentRun,
  KnowledgeRow,
  NeedsYouItem,
  OwnerTranscript,
  PeopleOut,
  PolicyVersionOut,
  Reports,
  RuleChatOut,
  RulesDraft,
  RulesView,
  SetupState,
  Today,
  ToolConfirmedOut,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { proseBlock, rivera } from '../ds/fixtures/index.ts';
import { executedLine } from '../ds/fixtures/receipts.ts';
import { chatReducer, initialChatState, type ChatState } from '../public/chatReducer.ts';
import { AGENT_TURN_GAP_MS } from './agents.ts';
import type { DocumentAnswer } from './documents.ts';
import {
  CALLBACK_WINDOW,
  DECISIONS,
  DEMO_CODE,
  EVENT_GAP_MS,
  HELD_PROSE,
  LINK_CANCELLED,
  VISITOR_PLAIN,
  afterAnswer,
  askedDiscountBp,
  linkCancelledBlock,
  matchRule,
  turnLanguage,
  type RuleName,
} from './script.ts';
import { PRESETS, RIVERA, RIVERA_HOURS, presetCards } from './seed.ts';
import { holdNextStart } from './setup.ts';
import { mockStore, streamAfter, type MockAnswer, type MockRequestInit } from './store.ts';
import { validateContract } from './validate.ts';
import type { ReplayTurn } from './world.ts';

const slug = RIVERA.slug;
const deskId = RIVERA.deskId;

/** A route's answer, which must be one with a status (not a dropped connection). */
async function call(key: RouteKey, init: MockRequestInit = {}): Promise<{ status: number; body: unknown }> {
  const answer: MockAnswer = await mockStore.dispatch(key, init);
  if ('network' in answer) throw new Error(`${key} dropped the connection`);
  return { status: answer.status, body: answer.body };
}

/** Opens this browser's chat with Turner's main Desk and records every event its stream gets. */
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
  it.each(['agent_text', 'visitor_text', 'whisper', 'turn_end', 'ended_agent_text'] as const)(
    'agent_summary_does_not_reuse_receipts_across_turns_%s', async (boundary) => {
      const world = mockStore.world;
      const agent = world.addSession(world.desk(deskId)!, { agent: "Alex Kim's assistant" });
      const ctx = world.context(agent, 'en', 'Book a visit');
      world.emit(agent, ctx.status('receipt', ctx.decide(DECISIONS.book)));
      if (boundary === 'turn_end' || boundary === 'ended_agent_text') world.emit(agent, { type: 'turn_end' });
      if (boundary === 'agent_text' || boundary === 'ended_agent_text') world.agentText(agent, 'New request');
      else if (boundary === 'visitor_text') world.visitorText(agent, 'New request');
      else if (boundary === 'whisper') world.whisper(agent, 'New request');
      world.emit(agent, ctx.reply([rivera.blocks.booking_confirmed.en]));
      const summaries = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
      expect(summaries.find((s) => s.session_id === agent.state.session_id)?.latest_outcome).toBeNull();
    },
  );

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('agent_summary_uses_ledger_order_with_newer_refusal_%s_and_reverse_publication_%s', async (newerRefusal, reversePublication) => {
    const world = mockStore.world;
    const agent = world.addSession(world.desk(deskId)!, { agent: "Alex Kim's assistant" });
    const ctx = world.context(agent, 'en', 'Book a visit');
    const refuse = () => ctx.decide({ ...DECISIONS.quote, outcome: 'refuse', executed: false });
    world.emit(agent, { type: 'turn_end' });
    world.agentText(agent, 'Book a visit');
    // Fake time stays fixed: ledger sequence alone decides which result is newer.
    const decisions = newerRefusal ? [ctx.decide(DECISIONS.book), refuse()] : [refuse(), ctx.decide(DECISIONS.book)];
    const published = reversePublication ? [...decisions].reverse() : decisions;
    for (const decision of published) world.emit(agent, ctx.status('receipt', decision));
    world.emit(agent, ctx.reply([rivera.blocks.booking_confirmed.en]));
    world.emit(agent, { type: 'turn_end' });
    const summaries = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(summaries.find((s) => s.session_id === agent.state.session_id)?.latest_outcome)
      .toBe(newerRefusal ? 'turned_down' : 'visit_booked');
  });

  it.each([
    ['book_visit', 'visit_booked'],
    ['quote_and_deposit', 'deposit_paid'],
    ['push_the_limit', 'turned_down'],
  ])('agent_summary_records_%s', async (task, expected) => {
    await openChat();
    await call('sendAgent', { params: { slug }, body: { task, idempotency_key: task } });
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 5);
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1)!;
    const summaries = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(summaries.find((s) => s.session_id === agent.state.session_id)?.latest_outcome).toBe(expected);
  });

  it('agent_summary_does_not_restore_success_after_a_hold_is_answered', async () => {
    await openChat();
    await call('sendAgent', { params: { slug }, body: { task: 'book_visit', idempotency_key: 'outcome-answered' } });
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 5);
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1)!;
    const held = mockStore.world.context(agent, 'en', 'Ask Mike').decide({ ...DECISIONS.quote, outcome: 'hold', executed: false });
    mockStore.world.answer(mockStore.world.decisions.get(held.decision_id)!, 'allow_once');
    const summaries = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(summaries.find((s) => s.session_id === agent.state.session_id)?.latest_outcome).toBeNull();
  });

  it('agent_summary_clears_success_after_a_handoff', async () => {
    await openChat();
    await call('sendAgent', { params: { slug }, body: { task: 'book_visit', idempotency_key: 'outcome-handoff' } });
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 5);
    const agent = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1)!;
    mockStore.world.reply(agent, [rivera.blocks.handoff.en], 'en');
    const summaries = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(summaries.find((s) => s.session_id === agent.state.session_id)?.latest_outcome).toBeNull();
  });

  it('answers_each_first_view_starter_in_its_language', () => {
    const cases = [
      ['How much is drain clearing?', 'price', 'en'],
      ['Can someone come Tuesday?', 'book', 'en'],
      ['¿Cuánto cuesta destapar un desagüe?', 'price', 'es'],
      ['¿Puede venir alguien el martes?', 'book', 'es'],
      ['Do you work in Alameda?', 'area', 'en'],
      ['¿Trabajan en Alameda?', 'area', 'es'],
    ];
    for (const [words, rule, language] of cases) {
      expect(matchRule(words!).name, words).toBe(rule);
      expect(turnLanguage(words!), words).toBe(language);
    }
  });

  it('kept_cards_with_drafted_handoff_open_the_owner_card_handoff', async () => {
    const { session, events } = await openChat();
    await send('cards-kept-handoff');
    await drain();
    expect(typesOf(events)).toEqual(['writing', 'receipt', 'message', 'turn_end']);
    expect(events.find(([, ev]) => ev.type === 'receipt')?.[1]).toMatchObject({
      state: 'executed', visitor_plain: executedLine('native.quote', 'en', 'Mike Turner'),
    });
    const reply = events.find(([, ev]) => ev.type === 'message')?.[1];
    const ledger = mockStore.world.desks[0]?.ledger.filter((e) => e.event.session_id === session.session_id);
    expect(ledger?.map((e) => e.event.kind)).toEqual(['session', 'decide', 'execute', 'desk_data', 'reply']);
    expect(ledger?.find((e) => e.event.kind === 'decide')?.event.summary).toMatchObject({ tool: 'native.quote', outcome: 'allow' });
    const entry = mockStore.world.desks[0]?.ledger.find((e) => e.event.kind === 'reply' && e.event.session_id === session.session_id);
    expect(entry?.event.summary).toMatchObject({ ok: false, violations: ['number_in_prose'] });
    expect(reply).toMatchObject({ handoff: true, visitor_plain: VISITOR_PLAIN.en.reply_handed_off, blocks: [rivera.blocks.quote.en, rivera.blocks.handoff.en] });
    const items = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(items.filter((item) => item.handoff?.session_id === session.session_id)).toMatchObject([
      { decision: null, handoff: { kind: 'card', status: 'open' } },
    ]);
  });

  it('cards_only_failure_keeps_checked_cards_without_a_handoff', async () => {
    const { session, events } = await openChat();
    await send('cards-only');
    await drain();
    expect(typesOf(events)).toEqual(['writing', 'receipt', 'message', 'turn_end']);
    expect(events.find(([, ev]) => ev.type === 'receipt')?.[1]).toMatchObject({
      state: 'executed', visitor_plain: executedLine('native.quote', 'en', 'Mike Turner'),
    });
    const reply = events.find(([, ev]) => ev.type === 'message')?.[1];
    const ledger = mockStore.world.desks[0]?.ledger.filter((e) => e.event.session_id === session.session_id);
    expect(ledger?.map((e) => e.event.kind)).toEqual(['session', 'decide', 'execute', 'reply']);
    expect(ledger?.find((e) => e.event.kind === 'decide')?.event.summary).toMatchObject({ tool: 'native.quote', outcome: 'allow' });
    const entry = mockStore.world.desks[0]?.ledger.find((e) => e.event.kind === 'reply' && e.event.session_id === session.session_id);
    expect(entry?.event.summary).toMatchObject({ ok: false, violations: ['number_in_prose'] });
    expect(reply).toMatchObject({ handoff: false, visitor_plain: VISITOR_PLAIN.en.reply_checked, blocks: [rivera.blocks.quote.en] });
    expect([...mockStore.world.handoffs.values()].filter((h) => h.handoff.session_id === session.session_id)).toEqual([]);
  });

  it('passed_handoff_card_sets_the_handoff_flag_and_line', async () => {
    const { session, events } = await openChat();
    await send('Talk to Mike');
    await drain();
    const reply = events.find(([, ev]) => ev.type === 'message')?.[1];
    expect(reply).toMatchObject({ handoff: true, visitor_plain: VISITOR_PLAIN.en.reply_handed_off, blocks: [rivera.blocks.handoff.en] });
    const entry = mockStore.world.desks[0]?.ledger.find((e) => e.event.kind === 'reply' && e.event.session_id === session.session_id);
    expect(entry?.event.summary).toMatchObject({ ok: true, violations: [] });
  });

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
      ["I'd like to talk to Mike Turner.", 'talk', 'en'],
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
      ['en', [['prose', 'Mike can tell you once he sees it. You can ask for him here anytime.']]],
      ['es', [['prose', 'Mike te lo puede decir cuando lo vea. Puedes pedir hablar con él aquí cuando quieras.']]],
    ]);
  });

  it('held_discount_says_maria_decides', async () => {
    // A discount past the quote card's limit is held, and Claude's checked reply says Mike decides,
    // in the turn's language, with the reply's own receipt and the held one: no handoff card.
    const { session, events } = await openChat();
    await send('Can I get 15% off if I pay cash?');
    await drain();
    await send('¿Me hacen un descuento?');
    await drain();
    const turns = events.flatMap(([, ev]) =>
      ev.type === 'message' ? [[ev.language, ev.handoff, ev.visitor_plain, ev.blocks.map((b) => [b.kind, b.template, b.text])]] : [],
    );
    expect(turns).toEqual([
      ['en', false, VISITOR_PLAIN.en.reply_checked, [['prose', null, HELD_PROSE.en]]],
      ['es', false, VISITOR_PLAIN.es.reply_checked, [['prose', null, HELD_PROSE.es]]],
    ]);
    const held = events.flatMap(([, ev]) => (ev.type === 'held' ? [ev.visitor_plain] : []));
    expect(held).toEqual([VISITOR_PLAIN.en.held, VISITOR_PLAIN.es.held]);
    // Each reply passed its check: no reply of this chat was stopped.
    const replies = (mockStore.world.desks[0]?.ledger ?? []).filter((e) => e.event.kind === 'reply' && e.event.session_id === session.session_id);
    expect(replies.map((e) => e.event.summary)).toEqual([
      { author: 'claude', ok: true, language: 'en', violations: [] },
      { author: 'claude', ok: true, language: 'es', violations: [] },
    ]);
  });

  it('invoice_asks_to_confirm_first', async () => {
    // As the signed verify board has it: Claude's checked line, with no digits, then the kernel's
    // verify card, in the turn's language. The code reaches the Demo inbox in the kernel's own
    // words (its `inbox_code_body`), in that language too, with the expiry and what to do if the
    // visitor didn't ask.
    const { session, events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    await send('Necesito mi factura');
    await drain();
    const replies = events.flatMap(([, ev]) => (ev.type === 'message' ? [[ev.language, ev.blocks.map((b) => [b.kind, b.template, b.text])]] : []));
    expect(replies).toEqual([
      ['en', [['prose', null, "I can send that after you confirm it's you."], ['card', 'verify_prompt', rivera.blocks.verify_prompt.en.text]]],
      ['es', [['prose', null, 'Puedo enviarlo cuando confirmes que eres tú.'], ['card', 'verify_prompt', rivera.blocks.verify_prompt.es.text]]],
    ]);
    const codes = mockStore.world.inbox.filter((record) => record.sessionId === session.session_id).map((record) => record.entry.body);
    expect(codes).toEqual([
      `Your Turner Plumbing code is ${DEMO_CODE}. It expires in ten minutes. If you didn't ask for it, ignore this message.`,
      `Tu código de Turner Plumbing es ${DEMO_CODE}. Vence en diez minutos. Si no lo pediste, ignora este mensaje.`,
    ]);
  });

  it('invoice_asks_to_confirm_first_in_a_chat_not_verified_as_its_owner', async () => {
    // Only the invoice's own verified owner skips the code. A chat with a code sent but not yet
    // entered, and a chat verified as someone else, each start verification as before: the
    // checked line, the verify card and a code to Dana's contact on record, with no invoice.
    const { session, events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    await send('Could you send my last invoice again, please?');
    await drain();
    const record = mockStore.world.sessions.get(session.session_id);
    if (!record) throw new Error('the chat is on record');
    mockStore.world.verify(record, rivera.people.bob);
    await send('Please send my last invoice.');
    await drain();
    const replies = events.flatMap(([, ev]) => (ev.type === 'message' ? [ev.blocks.map((b) => [b.kind, b.template])] : []));
    const confirmFirst = [['prose', null], ['card', 'verify_prompt']];
    expect(replies).toEqual([confirmFirst, confirmFirst, confirmFirst]);
    const codes = mockStore.world.inbox.filter((r) => r.sessionId === session.session_id && r.entry.kind === 'verification_code');
    expect(codes.map((r) => r.entry.to)).toEqual(Array(3).fill(rivera.people.dana.maskedContact));
  });

  it('script_matches_whole_words', async () => {
    // A rule's word picks it only as a word of its own, never inside another one.
    const cases: [text: string, rule: RuleName][] = [
      ['Do you offer weekend service?', 'other'],
      ['Is the office open on Saturday?', 'other'],
      ['Can I get 15% off?', 'discount'],
      ['Off-peak discount?', 'discount'],
      ['Who is Mariana?', 'other'],
      ['¿Cuánto?', 'price'],
      ['Llámame.', 'callback'],
      // The two demo commands for a kept-card reply pick their rule only as the whole message.
      ['cards-only', 'cards-only'],
      [' Cards-Kept-Handoff ', 'cards-kept-handoff'],
      ['Are you cards-only, or can I pay cash?', 'deposit'],
      ['Is it cards-kept-handoff?', 'other'],
      ['solo-tarjetas', 'cards-only'],
      ['¿Aceptan solo-tarjetas?', 'other'],
    ];
    for (const [text, rule] of cases) expect(matchRule(text).name, text).toBe(rule);

    // So asking about an offer starts no held discount: nothing new for Mike, and a plain answer.
    const before = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const { events } = await openChat();
    await send('Do you offer weekend service?');
    await drain();
    expect(typesOf(events)).toEqual(['writing', 'message', 'turn_end']);
    expect((await call('needsYou', { params: { desk_id: deskId } })).body).toEqual(before);
    expect([...mockStore.world.decisions.values()].filter((d) => d.decision.state === 'held')).toHaveLength(before.length);
  });

  it('discount_holds_and_reaches_needs_you', async () => {
    // Turner's Today greets Mike, counts the seeded hold, and has Dana's chat live (the held
    // visitor's last word was twelve minutes ago).
    const today = async () => (await call('today', { params: { desk_id: deskId } })).body as Today;
    const seeded = await today();
    expect(seeded.greeting_name).toBe('Mike');
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
    expect(await today()).toMatchObject({ greeting_name: 'Mike', needs_you_count: 0, live: [] });

    const { session, events } = await openChat();
    await send('Can I get 50% off if I pay cash?');
    await drain();
    const afterHold = await today();
    expect(afterHold.needs_you_count).toBe(1);
    expect(afterHold.live.map((c) => c.session_id)).toEqual([session.session_id]);

    expect(typesOf(events)).toEqual(['writing', 'held', 'message', 'turn_end']);
    expect(events.map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    const [, held] = events[1] ?? [];
    expect(held).toMatchObject({ type: 'held', state: 'held', visitor_plain: 'Waiting for Mike Turner to approve' });
    // Claude says, in checked words, that Mike decides and his answer will show up in the chat.
    const [, reply] = events[2] ?? [];
    expect(reply).toMatchObject({ type: 'message', handoff: false, language: 'en', visitor_plain: VISITOR_PLAIN.en.reply_checked });
    expect(reply?.type === 'message' && reply.blocks.map((b) => [b.kind, b.text])).toEqual([['prose', HELD_PROSE.en]]);

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
    // Past rv-quote's automatic limit: held_by names only an ask card's reason.
    expect(item?.held_by).toBeNull();
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

  it('a_held_request_quotes_the_words_that_made_it', async () => {
    // The held request quotes only its own turn after Claude answered the price question,
    // as the API's Needs you does, while the same chat's callback quotes its latest.
    const { session } = await openChat();
    await send('How much to clear a drain?');
    await drain();
    await send('Can I get 15% off?');
    await drain();
    await send('Can you come Tuesday?');
    await drain();
    await send('Please call me back');
    await drain();

    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const chat = needsYou.filter((item) => item.session.session_id === session.session_id);
    expect(chat.map((item) => [item.decision ? 'held' : 'handoff', item.from_the_visitor])).toEqual([
      ['held', 'Can I get 15% off?'],
      ['handoff', 'Can you come Tuesday? · Please call me back'],
    ]);
  });

  it.each(['desk', 'owner'] as const)('a_%s_delivery_keeps_the_held_requests_visitor_words', async (author) => {
    const world = mockStore.world;
    const session = world.addSession(world.desk(deskId)!);
    const ctx = world.context(session, 'en', 'Can I get 15% off?');
    world.visitorText(session, 'It is the downstairs drain.');
    world.visitorText(session, 'Can I get 15% off?');
    world.emit(session, { ...ctx.reply([proseBlock('Your payment link was cancelled.')]), author });
    const decision = ctx.decide(DECISIONS.heldQuote);
    world.emit(session, ctx.status('held', decision));

    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou.find((item) => item.decision?.decision_id === decision.decision_id)?.from_the_visitor)
      .toBe('It is the downstairs drain. · Can I get 15% off?');
  });

  it.each(['visitor', 'agent'] as const)('a_late_reply_keeps_one_line_from_the_%s_before_the_hold', async (kind) => {
    const world = mockStore.world;
    const session = world.addSession(world.desk(deskId)!, kind === 'agent' ? { agent: "Alex Kim's assistant" } : {});
    const say = (text: string) => kind === 'agent' ? world.agentText(session, text) : world.visitorText(session, text);
    const ctx = world.context(session, 'en', 'Can I get 15% off?');
    say('How much to clear a drain?');
    say('Can I get 15% off?');
    world.emit(session, ctx.reply([proseBlock('Here is the drain clearing quote.')]));
    const decision = ctx.decide(DECISIONS.heldQuote);
    world.emit(session, ctx.status('held', decision));
    say('A later request must not be quoted.');

    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou.find((item) => item.decision?.decision_id === decision.decision_id)?.from_the_visitor)
      .toBe('Can I get 15% off?');
  });

  it('a_first_turn_hold_quotes_both_visitor_lines', async () => {
    const world = mockStore.world;
    const session = world.addSession(world.desk(deskId)!);
    const ctx = world.context(session, 'en', 'Can I get 15% off?');
    world.visitorText(session, 'It is the downstairs drain.');
    world.visitorText(session, 'Can I get 15% off?');
    const decision = ctx.decide(DECISIONS.heldQuote);
    world.emit(session, ctx.status('held', decision));

    const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(needsYou.find((item) => item.decision?.decision_id === decision.decision_id)?.from_the_visitor)
      .toBe('It is the downstairs drain. · Can I get 15% off?');
  });

  it('owner_alert_names_the_held_request', async () => {
    // Mike's Demo inbox alert for a hold names that held request; the code sent to a visitor names none.
    const before = mockStore.world.inbox.length;
    const { session } = await openChat();
    await send('Can I get 50% off if I pay cash?');
    await drain();
    await send('Can you send my invoice?');
    await drain();
    const held = [...mockStore.world.decisions.values()].find((d) => d.decision.session_id === session.session_id)?.decision;
    if (!held) throw new Error('the discount is held');
    const entries = mockStore.world.inbox.slice(before).map(({ entry }) => [entry.entry_id, entry.to, entry.kind, entry.decision_id]);
    expect(entries).toEqual([
      [held.inbox?.[0]?.entry_id, 'owner', 'alert', held.decision_id],
      [expect.any(String), rivera.people.dana.maskedContact, 'verification_code', null],
    ]);
  });

  it('owner_inbox_alerts_carry_their_held_request', async () => {
    // As the kernel writes them: a hold's alert says the held decision's own reason_plain and names
    // that decision; every other entry, in the copy as seeded and after a chat, names none.
    mockStore.reset('rivera_two_desks');
    await openChat();
    await send('Can I get 50% off if I pay cash?');
    await drain();
    await send('Can you send my invoice?');
    await drain();
    const read = await call('ownerInbox');
    expect(read.status).toBe(200);
    const entries = read.body as { entry_id: string; kind: string; to: string; body: string; decision_id?: string | null }[];
    const holds = [...mockStore.world.decisions.values()].map((d) => d.decision).filter((d) => d.outcome === 'hold');
    expect(holds.length).toBeGreaterThanOrEqual(2);
    for (const held of holds) {
      const alert = entries.find((entry) => entry.entry_id === held.inbox?.[0]?.entry_id);
      expect(alert, held.decision_id).toMatchObject({ to: 'owner', kind: 'alert', body: held.reason_plain, decision_id: held.decision_id });
    }
    const alertIds = new Set(holds.map((held) => held.inbox?.[0]?.entry_id));
    const others = entries.filter((entry) => !alertIds.has(entry.entry_id));
    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) expect(entry.decision_id, entry.entry_id).toBeNull();
  });

  it.each(['en', 'es'] as const)('allowed_answer_emits_approved_before_outcome_and_follows_up_%s', async (language) => {
    const { events } = await openChat();
    await send(language === 'es' ? '¿Me hacen un descuento del 15%?' : 'Can I get 15% off?');
    await drain();
    const [, held] = events[1] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    const answered = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      decision: { decision_id: decisionId, state: 'executed', visitor_plain: executedLine('native.quote', language, 'Mike Turner') },
      execution_state: 'succeeded',
      card_diff: null,
    });
    // Nothing reaches the chat in the answer itself: the follow-up arrives on the stream.
    expect(typesOf(events)).toEqual(['writing', 'held', 'message', 'turn_end']);

    await drain();
    expect(typesOf(events).slice(4)).toEqual(['receipt', 'resolved', 'writing', 'message', 'turn_end']);
    const [, approved] = events[4] ?? [];
    expect(approved).toMatchObject({ type: 'receipt', decision_id: decisionId, state: 'approved', visitor_plain: VISITOR_PLAIN[language].approved });
    const [, resolved] = events[5] ?? [];
    // An executed action's line says what ran and whose records it used, never a bare "Done".
    expect(resolved).toMatchObject({
      type: 'resolved',
      decision_id: decisionId,
      state: 'executed',
      visitor_plain: executedLine('native.quote', language, 'Mike Turner'),
    });
    if (approved?.type !== 'receipt' || resolved?.type !== 'resolved') throw new Error('approval precedes resolution');
    expect(approved.ledger_seq).toBeLessThan(resolved.ledger_seq);
    const approvalEntry = mockStore.world.desks[0]?.ledger.find((entry) => entry.seq === approved.ledger_seq);
    expect(approvalEntry?.event).toMatchObject({ kind: 'approval', ref_id: decisionId, summary: { state: 'approved' } });
    const [, followUp] = events[7] ?? [];
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

  it.each(['missing', 'different decision', 'not approved', 'same ledger', 'later ledger'] as const)(
    'answer_drops_snapshot_when_%s', async (reason) => {
      const { session } = await openChat();
      const chat = mockStore.world.sessions.get(session.session_id);
      if (!chat) throw new Error('the visitor opened a chat');
      const held = mockStore.world.decide(chat, DECISIONS.heldQuote, 'en');
      const record = mockStore.world.decisions.get(held.decision_id);
      if (!record) throw new Error('the discount was held');
      const decision = mockStore.world.answer(record, 'allow_once');
      const approved = record.approved;
      if (!approved) throw new Error('the owner approved the discount');
      const snapshots: Record<typeof reason, Decision | null> = {
        missing: null,
        'different decision': { ...approved, decision_id: 'another-decision' },
        'not approved': { ...approved, state: 'held' },
        'same ledger': { ...approved, ledger_seq: decision.ledger_seq },
        'later ledger': { ...approved, ledger_seq: decision.ledger_seq + 1 },
      };
      const ctx = mockStore.world.context(chat, 'en', '');
      const emitted = afterAnswer('allow_once', decision, snapshots[reason]).map((step) => step(ctx));
      expect(emitted.map((ev) => ev.type)).toEqual(['resolved', 'writing', 'message']);
      expect(emitted[0]).toEqual(ctx.status('resolved', decision));
    },
  );

  it('denied_answer_emits_only_the_denial_before_follow_up', async () => {
    const { events } = await openChat();
    await send('Can I get 10% off?');
    await drain();
    const held = events.find(([, ev]) => ev.type === 'held')?.[1];
    if (held?.type !== 'held') throw new Error('the discount was held');
    expect((await call('answer', { params: { decision_id: held.decision_id }, body: { answer: 'deny_once' } })).status).toBe(200);
    await drain();
    expect(typesOf(events).slice(4)).toEqual(['resolved', 'writing', 'message', 'turn_end']);
    expect(events[4]?.[1]).toMatchObject({ type: 'resolved', state: 'denied', visitor_plain: VISITOR_PLAIN.en.denied });
  });

  it('answer_records_the_kernels_approval', async () => {
    // As `approvals.py` records an answer it takes: the decision, its action, the answer and the
    // state it left the request in, `approved` for an allow (its run follows) and `denied` for a deny.
    await openChat();
    await send('Can I get 10% off?');
    await drain();
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).flatMap((item) =>
      item.decision ? [item.decision] : [],
    );
    const [seeded, asked] = held;
    if (!seeded || !asked) throw new Error('the seed holds one request and the chat another');
    expect((await call('answer', { params: { decision_id: seeded.decision_id }, body: { answer: 'allow_once' } })).status).toBe(200);
    expect((await call('answer', { params: { decision_id: asked.decision_id }, body: { answer: 'deny_once' } })).status).toBe(200);

    const ledger = (await call('ledger', { params: { desk_id: deskId } })).body as LedgerPage;
    const approvals = ledger.entries.filter((e) => e.event.kind === 'approval');
    expect(approvals.map((e) => [e.event.ref_id, e.event.summary])).toEqual([
      [seeded.decision_id, { decision_id: seeded.decision_id, action_id: seeded.action?.action_id, answer: 'allow_once', state: 'approved' }],
      [asked.decision_id, { decision_id: asked.decision_id, action_id: asked.action?.action_id, answer: 'deny_once', state: 'denied' }],
    ]);
    expect(seeded.action?.action_id).toEqual(expect.any(String));
    // The allow's run, as `execute.py` records it: the decision, its action and the state it ran to.
    const runs = ledger.entries.filter((e) => e.event.kind === 'execute' && e.event.ref_id === seeded.decision_id);
    expect(runs.map((e) => e.event.summary)).toEqual([{ decision_id: seeded.decision_id, action_id: seeded.action?.action_id, state: 'executed' }]);
  });

  it('held_discount_is_the_one_asked_for', async () => {
    // The held quote carries the percent the visitor named, with its price worked out from the
    // $180.00 list price as the kernel does, and Mike's card says so; once he allows it, the
    // visitor's quote card has that percent. A discount asked with no percent is the fixtures' 15%.
    const { events } = await openChat();
    const asked = [
      'Can I get 10% off a drain clearing?',
      '¿Me hacen un 20 por ciento de descuento?',
      'Is 12.5 % off possible?',
      'Is there a discount for seniors?',
    ];
    const held: { action: unknown; reason: string | undefined }[] = [];
    const quotes: unknown[] = [];
    for (const text of asked) {
      const before = events.length;
      await send(text);
      await drain();
      const status = events.slice(before).find(([, ev]) => ev.type === 'held')?.[1];
      const decisionId = status?.type === 'held' ? status.decision_id : '';
      const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
      const decision = needsYou.find((item) => item.decision?.decision_id === decisionId)?.decision;
      held.push({ action: decision?.action, reason: decision?.reason_plain });
      expect((await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } })).status, text).toBe(200);
      await drain();
      const followUp = events.slice(before).findLast(([, ev]) => ev.type === 'message')?.[1];
      const card = followUp?.type === 'message' ? followUp.blocks.find((b) => b.template === 'quote') : undefined;
      quotes.push([card?.title, card?.lines]);
    }
    expect(held).toEqual([
      {
        action: expect.objectContaining({ list_cents: 18_000, discount_bp: 1000, amount_cents: 16_200 }),
        reason: 'A visitor not on record asked for a drain clearing quote at 10% off, $162.00 instead of $180.00.',
      },
      {
        action: expect.objectContaining({ list_cents: 18_000, discount_bp: 2000, amount_cents: 14_400 }),
        reason: 'A visitor not on record asked for a drain clearing quote at 20% off, $144.00 instead of $180.00.',
      },
      {
        action: expect.objectContaining({ list_cents: 18_000, discount_bp: 1250, amount_cents: 15_750 }),
        reason: 'A visitor not on record asked for a drain clearing quote at 12.5% off, $157.50 instead of $180.00.',
      },
      {
        action: expect.objectContaining({ list_cents: 18_000, discount_bp: 1500, amount_cents: 15_300 }),
        reason: rivera.decisions.held.reason_plain,
      },
    ]);
    const fixtureQuote = rivera.events.resolvedTurn.flatMap((ev) => (ev.type === 'message' ? ev.blocks : [])).find((b) => b.template === 'quote');
    expect(quotes).toEqual([
      ['$162.00', ['Drain clearing', 'Includes 10% off $180.00', 'Good until Tuesday, November 3, 2:00 pm']],
      ['$144.00', ['Drain clearing', 'Incluye 20 % de descuento sobre $180.00', 'Válido hasta martes 3 de noviembre, 14:00']],
      ['$157.50', ['Drain clearing', 'Includes 12.5% off $180.00', 'Good until Tuesday, November 3, 2:00 pm']],
      [fixtureQuote?.title, fixtureQuote?.lines],
    ]);

    // The first percentage standing on its own is the one asked for, whatever it is; 15% only when
    // the words name none.
    const read: [text: string, bp: number][] = [
      ['20 % off?', 2000],
      ['¿Un 10 por ciento de descuento?', 1000],
      ['12,5 % de descuento', 1250],
      ['10 percent off', 1000],
      ['1000% off', 100_000],
      ['0% off', 0],
      ['Any discount?', 1500],
    ];
    for (const [text, bp] of read) expect(askedDiscountBp(text), text).toBe(bp);
  });

  it('discount_at_none_or_over_all_is_not_held', async () => {
    // 0% off is a question about the list price: the list-price quote, with nothing held. Over 100%
    // is no discount anyone can give: Claude's plain answer, with nothing decided.
    expect(matchRule('Can I get 0% off?').name).toBe('price');
    expect(matchRule('Can I get 1000% off?').name).toBe('other');
    const { session, events } = await openChat();
    const decided = () => [...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === session.session_id).map((d) => d.decision);

    await send('Can I get 0% off?');
    await drain();
    const listPrice = events.flatMap(([, ev]) => (ev.type === 'message' ? ev.blocks.map((b) => [b.template, b.title]) : []));
    expect(listPrice).toEqual([
      [null, null],
      ['quote', rivera.blocks.quote.en.title],
    ]);
    expect(decided().map((d) => [d.outcome, d.state, d.reason_plain])).toEqual([['allow', 'executed', DECISIONS.quote.reasonPlain]]);

    const before = events.length;
    await send('Can I get 1000% off?');
    await drain();
    expect(typesOf(events.slice(before))).toEqual(['writing', 'message', 'turn_end']);
    const help = events.slice(before).flatMap(([, ev]) => (ev.type === 'message' ? ev.blocks.map((b) => b.text) : []));
    expect(help).toEqual(['Mike can tell you once he sees it. You can ask for him here anytime.']);
    expect(decided()).toHaveLength(1);
  });

  it('verified_discount_names_the_person_and_drafts_its_percent', async () => {
    // Dana confirms it's her, then asks for 20% off: Mike's card names her, and "Only for Dana
    // Whitfield, always" drafts a rule for her at that percent and its price. Once that rule is
    // active, the same card drafted again changes nothing, and another percent is a change the
    // draft's review shows.
    const { events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    expect((await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } })).status).toBe(200);
    await drain();
    const allowForDana = async (text: string) => {
      const before = events.length;
      await send(text);
      await drain();
      const status = events.slice(before).find(([, ev]) => ev.type === 'held')?.[1];
      const decisionId = status?.type === 'held' ? status.decision_id : '';
      const needsYou = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
      const decision = needsYou.find((item) => item.decision?.decision_id === decisionId)?.decision;
      const answered = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_person' } });
      expect(answered.status, text).toBe(200);
      await drain();
      return { decision, cards: (answered.body as ApprovalAnswerOut).card_diff ?? [] };
    };
    const review = async (cards: unknown[]) => {
      const drafted = await call('draftRules', { params: { desk_id: deskId }, body: { add: cards } });
      expect(drafted.status).toBe(200);
      return drafted.body as RulesDraft;
    };
    const limits = (card: { max_discount_bp?: number; max_amount_cents?: number | null } | undefined) => [card?.max_discount_bp, card?.max_amount_cents];

    const twenty = await allowForDana('Can I get 20% off?');
    expect(twenty.decision).toMatchObject({
      reason_plain: 'Dana Whitfield, verified with a code, asked for a drain clearing quote at 20% off, $144.00 instead of $180.00.',
      answers: ['allow_once', 'deny_once', 'allow_person'],
      action: { list_cents: 18_000, discount_bp: 2000, amount_cents: 14_400 },
    });
    expect(twenty.cards).toMatchObject([{ card_id: 'person-per-dana-native.quote', who: 'person', person_id: 'per-dana', mode: 'auto' }]);
    const first = await review(twenty.cards);
    expect(first.diff?.added.map((card) => [card.card_id, ...limits(card)])).toEqual([['person-per-dana-native.quote', 2000, 14_400]]);
    expect((await call('confirmRules', { params: { desk_id: deskId }, body: { version: first.version } })).status).toBe(200);
    expect((await review(twenty.cards)).diff).toEqual({ added: [], removed: [], changed: [] });

    // 10% off is a higher price than her rule's $144.00, so it is held again.
    const ten = await allowForDana('What about 10% off?');
    expect(ten.decision?.reason_plain).toBe('Dana Whitfield, verified with a code, asked for a drain clearing quote at 10% off, $162.00 instead of $180.00.');
    const lowered = await review(ten.cards);
    expect(lowered.diff?.added).toEqual([]);
    expect(lowered.diff?.removed).toEqual([]);
    expect(lowered.diff?.changed.map(([before, after]) => [before.card_id, limits(before), limits(after)])).toEqual([
      ['person-per-dana-native.quote', [2000, 14_400], [1000, 16_200]],
    ]);
  });

  it('executed_receipts_say_what_ran', async () => {
    const { events } = await openChat();
    const turns: [text: string, line: string][] = [
      ['How much is drain clearing?', "Quoted from Mike Turner's price list"],
      ['Can I book Tuesday?', "Times read from Mike Turner's calendar"],
      ['Book the first one', "Booked on Mike Turner's calendar"],
      ['How do I pay the deposit?', 'Payment link made for this quote'],
      ['Can you call me back?', 'Callback request saved for Mike Turner'],
      ['¿Cuánto cuesta?', 'Cotizado con la lista de precios de Mike Turner'],
      ['Quiero reservar la primera', 'Reservado en el calendario de Mike Turner'],
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
        executedLine(tool, 'en', 'Mike Turner'),
      ),
      executedLine('native.quote', 'es', 'Mike Turner'),
      executedLine('native.book', 'es', 'Mike Turner'),
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
          ['card', 'Tuesday, November 3', ['2:00 pm to 4:00 pm', 'With Mike Turner']],
        ],
      ],
      [
        'es',
        [
          ['prose', null, []],
          ['card', 'martes 3 de noviembre', ['De 14:00 a 16:00', 'Con Mike Turner']],
        ],
      ],
    ]);
    // The prose leads into the card and promises nothing it doesn't back.
    expect(booked.map((ev) => ev.blocks[0]?.text)).toEqual(["You're all set. Here's your visit.", 'Ya está todo listo. Aquí tienes tu visita.']);
    // The booking is this chat's, confirmed.
    const sessionId = mockStore.visitorSession(slug)?.state.session_id;
    const bookings = [...mockStore.world.decisions.values()].filter(
      (d) => d.decision.session_id === sessionId && d.decision.action?.tool === 'native.book',
    );
    expect(bookings.map((d) => d.decision.state)).toEqual(['executed', 'executed']);
  });

  it('quick_messages_take_turns', async () => {
    // A second message sent before Claude has answered the first: the visitor's chat, as the public
    // page builds it from the two messages and the stream, has each reply's own check and its own
    // action's receipt under it, never the next turn's.
    const { events } = await openChat();
    await send('How much is drain clearing?');
    await send('Can I book Tuesday?');
    await drain();
    const chat = [
      { type: 'sent', id: 'v1', text: 'How much is drain clearing?' } as const,
      { type: 'sent', id: 'v2', text: 'Can I book Tuesday?' } as const,
      ...events.map(([seq, ev]) => ({ type: 'event', seq, ev }) as const),
    ].reduce<ChatState>(chatReducer, initialChatState());
    const replies = chat.rows.flatMap((row) => (row.item.kind === 'message' ? [row.receipts.map((receipt) => receipt.plain)] : []));
    expect(replies).toEqual([
      [VISITOR_PLAIN.en.reply_checked, executedLine('native.quote', 'en', 'Mike Turner')],
      [VISITOR_PLAIN.en.reply_checked, executedLine('native.find_slots', 'en', 'Mike Turner')],
    ]);

    // As the API's turn lock has it, the second turn waits for the first to end, and it starts as
    // the API's turns do, with Claude writing before anything it does.
    const turn = ['writing', 'receipt', 'message', 'turn_end'];
    expect(typesOf(events)).toEqual([...turn, ...turn]);
  });

  it('visitor_cancel_resolves_the_hold', async () => {
    const { events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[1] ?? [];
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

  it('answering_off_leaves_only_callbacks_and_leads', async () => {
    // With the Desk's Answering switch off, a visitor's or agent's turn may only reply, take a lead
    // or file a callback (master plan, "Model-visible tools"): what needs another tool gets the
    // handoff, as asking for Mike does, and decides nothing. The owner's preview keeps every tool.
    const setAnswering = async (on: boolean) => {
      expect((await call('setAnswering', { params: { desk_id: deskId }, body: { on } })).status).toBe(200);
    };
    const { session, events } = await openChat();
    const turn = async (text: string) => {
      const before = events.length;
      await send(text);
      await drain();
      return events.slice(before).map(([, ev]) => ev);
    };
    const toolsDecided = (sessionId: string) =>
      [...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === sessionId).map((d) => d.decision.action?.tool);
    const handoff = rivera.blocks.handoff.en;
    const shown = (evs: SseEvent[]) => evs.flatMap((ev) => (ev.type === 'message' ? ev.blocks.map((b) => [b.kind, b.template, b.text]) : []));

    await setAnswering(false);
    const price = await turn('How much to clear a drain?');
    expect(price.map((ev) => ev.type)).toEqual(['writing', 'message', 'turn_end']);
    expect(shown(price)).toEqual([[handoff.kind, handoff.template, handoff.text]]);
    for (const text of ['Can I get 10% off?', 'Can I book Tuesday?', 'Book the first one', 'How do I pay the deposit?', 'Can you send my invoice?']) {
      expect(shown(await turn(text)), text).toEqual([[handoff.kind, handoff.template, handoff.text]]);
    }
    expect(toolsDecided(session.session_id)).toEqual([]);
    expect(mockStore.world.inbox.filter((record) => record.sessionId === session.session_id)).toEqual([]);
    expect([...mockStore.world.links.values()].filter((link) => link.sessionId === session.session_id)).toEqual([]);

    // A callback still goes through, with its receipt and card, and closes the handoff the card
    // opened as it opens its own.
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);
    const callback = await turn('Can you call me back?');
    expect(callback.map((ev) => ev.type)).toEqual(['writing', 'receipt', 'message', 'turn_end']);
    expect(shown(callback).map(([, template]) => template)).toEqual(['callback_confirmed']);
    expect(toolsDecided(session.session_id)).toEqual(['native.request_callback']);
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['card', 'done'], ['callback', 'open']]);

    // An agent sent from the chat gets the handoff too, and decides nothing.
    const sent = await call('sendAgent', { params: { slug }, body: { task: 'book_visit', idempotency_key: 'key-1' } });
    expect(sent.status).toBe(202);
    const runId = (sent.body as { run_id: string }).run_id;
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 6);
    const run = (await call('agentRun', { params: { slug, run_id: runId } })).body as DemoAgentRun;
    expect(run.state).toBe('done');
    const desk = run.turns.filter((t) => t.author === 'desk');
    expect(desk.map((t) => [t.blocks.map((b) => [b.kind, b.template, b.text]), t.receipts])).toEqual([[[[handoff.kind, handoff.template, handoff.text]], []]]);
    const agentChat = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    expect(agentChat?.items.filter((item) => item.kind === 'agent_text').map((item) => item.text)).toEqual([
      'What’s your earliest visit for a leaking water heater? Any day this week.',
    ]);
    expect(toolsDecided(agentChat?.state.session_id ?? '')).toEqual([]);

    // Answering back on, the same question gets the quote.
    await setAnswering(true);
    const quoted = await turn('How much to clear a drain?');
    expect(shown(quoted).map(([, template]) => template)).toEqual([null, 'quote']);
    expect(toolsDecided(session.session_id)).toEqual(['native.request_callback', 'native.quote']);

    // A code sent while the Desk answered, confirmed once Answering is off: the visitor is verified,
    // but Claude's turn after it hands off instead of releasing the invoice.
    await turn('Can you send my invoice?');
    await setAnswering(false);
    const before = events.length;
    expect((await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } })).status).toBe(200);
    await drain();
    expect(shown(events.slice(before).map(([, ev]) => ev))).toEqual([[handoff.kind, handoff.template, handoff.text]]);
    expect(toolsDecided(session.session_id)).toEqual(['native.request_callback', 'native.quote', 'native.start_verification']);

    // Still off, the owner's preview of her Desk quotes: it keeps the visitor tools.
    const preview = ((await call('openPreview', { params: { desk_id: deskId } })).body as VisitorSession).state;
    const previewEvents: [number, SseEvent][] = [];
    mockStore.listen(slug, 0, (seq, ev) => previewEvents.push([seq, ev]));
    await send('How much to clear a drain?');
    await drain();
    expect(shown(previewEvents.map(([, ev]) => ev)).map(([, template]) => template)).toEqual([null, 'quote']);
    expect(toolsDecided(preview.session_id)).toEqual(['native.quote']);
  });

  it.each(['Talk to Mike', 'cards-kept-handoff'])('preview_handoff_opens_no_owner_item_%s', async (text) => {
    mockStore.reset('rivera_quiet');
    const opened = await call('openPreview', { params: { desk_id: deskId } });
    expect(opened.status).toBe(200);
    const { state } = opened.body as VisitorSession;
    const events: [number, SseEvent][] = [];
    mockStore.listen(slug, 0, (seq, ev) => events.push([seq, ev]));
    await send(text);
    await drain();

    const reply = events.find(([, ev]) => ev.type === 'message')?.[1];
    expect(reply).toMatchObject({ handoff: true, visitor_plain: VISITOR_PLAIN.en.reply_handed_off });
    expect(reply?.type === 'message' && reply.blocks.some((block) => block.template === 'handoff')).toBe(true);
    expect([...mockStore.world.handoffs.values()].filter((h) => h.handoff.session_id === state.session_id)).toEqual([]);
    expect((await call('needsYou', { params: { desk_id: deskId } })).body).toEqual([]);
    const entries = mockStore.world.desks[0]?.ledger.filter((e) => e.event.session_id === state.session_id);
    expect(entries?.some((e) => e.event.summary.part === 'handoffs')).toBe(false);
  });

  it('answering_is_read_when_a_turn_starts', async () => {
    // As the API gives a turn its tools when the turn starts: a question waiting behind a turn in
    // progress goes by Answering as it stands when its own turn begins, not when it was sent.
    const setAnswering = async (on: boolean) => {
      expect((await call('setAnswering', { params: { desk_id: deskId }, body: { on } })).status).toBe(200);
    };
    const { events } = await openChat();
    const templatesFrom = (from: number) =>
      events.slice(from).flatMap(([, ev]) => (ev.type === 'message' ? [ev.blocks.map((block) => block.template)] : []));

    // Sent while the Desk answers, behind a turn that has started; Answering goes off before its turn starts.
    await send('How much is drain clearing?');
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS);
    await send('How much to clear a drain?');
    await setAnswering(false);
    await drain();
    expect(templatesFrom(0)).toEqual([[null, 'quote'], ['handoff']]);

    // The other way round: sent while it doesn't, and Answering is back on before its turn starts.
    const before = events.length;
    await send('Can you call me back?');
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS);
    await send('How much to clear a drain?');
    await setAnswering(true);
    await drain();
    expect(templatesFrom(before)).toEqual([['callback_confirmed'], [null, 'quote']]);
  });

  it('agent_run_reads_answering_at_each_request', async () => {
    // The built-in agent's run goes by Answering as it stands at each of its requests: switched off
    // after the agent's quote and before its payment, the payment gets the handoff and nothing is charged.
    await openChat();
    const sent = await call('sendAgent', { params: { slug }, body: { task: 'quote_and_deposit', idempotency_key: 'key-1' } });
    expect(sent.status).toBe(202);
    const runId = (sent.body as { run_id: string }).run_id;
    const read = async () => (await call('agentRun', { params: { slug, run_id: runId } })).body as DemoAgentRun;
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 2);
    expect((await read()).turns.map((t) => t.author)).toEqual(['agent', 'desk']);
    expect((await call('setAnswering', { params: { desk_id: deskId }, body: { on: false } })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 4);

    const run = await read();
    expect(run.state).toBe('done');
    const desk = run.turns.filter((t) => t.author === 'desk');
    expect(desk.map((t) => [t.blocks.map((b) => b.template), t.receipts.map((ev) => ev.state)])).toEqual([
      [[null, 'quote'], ['executed']],
      [['handoff'], []],
    ]);
    const agentChat = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    const decided = [...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === agentChat?.state.session_id);
    expect(decided.map((d) => d.decision.action?.tool)).toEqual(['native.quote']);
  });

  it('callback_comes_from_dana_on_record', async () => {
    // The callback the script files is from Dana Whitfield, the one Dana the copy has on record, by
    // the name the kernel's seed keeps for her, with a phone number she typed: one of the fictional
    // 555-01xx numbers, and not the business's own.
    const seedPy = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'desk', 'kernel_service', 'seed.py'), 'utf8');
    const dana = /SeedPerson\(([^)]*\bref="dana"[^)]*)\)/.exec(seedPy)?.[1] ?? '';
    const name = /\bdisplay_name="([^"]+)"/.exec(dana)?.[1];
    expect(name).toBe(rivera.people.dana.name);
    const phone = '(510) 555-0118';
    expect(phone).not.toBe(rivera.blocks.contact.en.title);

    await openChat();
    await send('Can you call me back?');
    await drain();
    const handoff = [...mockStore.world.handoffs.values()].at(-1)?.handoff;
    expect(handoff?.reason).toBe(`${name} · ${phone} · Leaking water heater`);
    const lead = mockStore.world.leads.at(-1);
    expect([lead?.displayName, lead?.note]).toEqual([name, `${phone} · Leaking water heater`]);
  });

  it('link_cancelled_card_is_the_kernels', () => {
    // The card the mock posts for a link a rule change cancelled is the design system's fixture
    // card, which its fixtures test holds to the kernel's render/en.py and es.py: the deposit
    // link's amount, its title as the owner wrote it, then the kernel's line, citing the link's fact.
    for (const language of ['en', 'es'] as const) {
      const card = rivera.blocks.link_cancelled[language];
      expect(linkCancelledBlock({ title: 'Service call deposit', amount_cents: 2000 }, language), language).toEqual(card);
      expect(LINK_CANCELLED[language], language).toBe(card.lines?.at(-1));
    }
    // Its amount reads as render/cards.py `money` writes it: grouped dollars, then two cents digits.
    expect(linkCancelledBlock({ title: 'Leak repair', amount_cents: 123_456 }, 'en').title).toBe('$1,234.56');
    expect(linkCancelledBlock({ title: 'Leak repair', amount_cents: 5 }, 'es').title).toBe('$0.05');
  });

  it('handoff_card_opens_none_while_a_request_waits_for_the_owner', async () => {
    // As the kernel's reply check does (plan 01b, the owner's decision of 2026-10-31): while the chat
    // has a held request waiting for the owner, whose alert and item she already has, the card opens
    // no handoff, so she sees one item and gets one alert. Once the hold is answered, it opens one.
    const { session } = await openChat();
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    await send('Can I get 15% off if I pay cash?');
    await drain();
    const held = [...mockStore.world.decisions.values()].find((d) => d.decision.session_id === session.session_id && d.decision.state === 'held');
    expect(held).toBeDefined();
    const inbox = mockStore.world.inbox.length;

    await send('Can I talk to Mike?');
    await drain();
    expect(mine()).toEqual([]);
    expect(mockStore.world.inbox.slice(inbox).map(({ entry }) => entry.body)).not.toContain('A visitor is waiting in a conversation the Desk handed to you.');

    expect((await call('answer', { params: { decision_id: held?.decision.decision_id ?? '' }, body: { answer: 'deny_once' } })).status).toBe(200);
    await drain();
    // Answering it may itself show the card (the mock's reply after a deny does), which now opens one.
    await send('Can I talk to Mike?');
    await drain();
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);
  });

  it('handoff_card_opens_an_owner_handoff_as_the_kernel_does', async () => {
    // As the kernel's reply check does (plan 01b): a reply of Claude's that shows the handoff card
    // opens an owner handoff of kind `card` for the chat, unless one of either kind is open there.
    // It has the kernel's own reason and no call-back window, alerts the owner, and is recorded on
    // the chat just before the reply. The seeded history's stopped reply opened none: the kernel's
    // seed holds its request without checking a reply.
    expect(mockStore.world.handoffs.size).toBe(0);
    const { session } = await openChat();
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its main Desk');
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    const inbox = mockStore.world.inbox.length;

    await send('Can I talk to Mike?');
    await drain();
    expect(mine()).toEqual([
      { handoff_id: expect.any(String), session_id: session.session_id, reason: 'The Desk handed this to you.', callback_window: null, status: 'open', kind: 'card' },
    ]);
    const card = mine()[0]?.handoff_id;
    const [opened, reply] = desk.ledger.slice(-2).map((entry) => entry.event);
    expect(opened).toEqual({ kind: 'desk_data', origin: 'kernel', session_id: session.session_id, ref_id: null, summary: { part: 'handoffs', refs: [card], kind: 'card' } });
    expect(reply).toMatchObject({ kind: 'reply', session_id: session.session_id });
    expect(mockStore.world.inbox.slice(inbox).map(({ entry, sessionId }) => [entry.to, entry.kind, entry.body, entry.decision_id, sessionId])).toEqual([
      ['owner', 'alert', 'A visitor is waiting in a conversation the Desk handed to you.', null, null],
    ]);

    // One at a time: the card shown again opens no second handoff while this one is open.
    await send('Can I talk to Mike?');
    await drain();
    expect(mine()).toHaveLength(1);

    // Once the owner marks it done, a call back opens one of its own kind, which the card waits on too.
    expect((await call('handoffDone', { params: { handoff_id: card ?? '' } })).status).toBe(200);
    await send('Can you call me back?');
    await drain();
    expect(mine().map((h) => [h.kind, h.status, h.callback_window])).toEqual([
      ['card', 'done', null],
      ['callback', 'open', CALLBACK_WINDOW],
    ]);
    await send('Can I talk to Mike?');
    await drain();
    expect(mine()).toHaveLength(2);
  });

  it('callback_closes_the_open_handoff_and_opens_its_own', async () => {
    // As the kernel's `native.request_callback` does (plan 01b): a chat holds one open handoff, so a
    // call back first closes the open one, the card's here, exactly as the owner's mark of done does
    // (`done`, a `desk_data` entry naming it), then opens its own of kind `callback`. A row's kind
    // never changes, so the owner keeps one item, the call-back's, and a stale Done on the card's is 409.
    const { session } = await openChat();
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its main Desk');
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    await send('Can I talk to Mike?');
    await drain();
    const card = mine()[0]?.handoff_id ?? '';
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);

    const ledgered = desk.ledger.length;
    await send('Can you call me back?');
    await drain();
    expect(mine().map((h) => [h.handoff_id === card, h.kind, h.status, h.callback_window])).toEqual([
      [true, 'card', 'done', null],
      [false, 'callback', 'open', CALLBACK_WINDOW],
    ]);
    // Its closing entry names the call-back that replaced it; the next entry opens that call-back.
    const callback = mine()[1]?.handoff_id;
    const handoffs = desk.ledger.slice(ledgered).map((entry) => entry.event).filter((event) => event.kind === 'desk_data');
    expect(handoffs).toEqual([
      { kind: 'desk_data', origin: 'kernel', session_id: null, ref_id: null, summary: { part: 'handoffs', refs: [card], replaced_by: callback } },
      { kind: 'desk_data', origin: 'kernel', session_id: session.session_id, ref_id: null, summary: { part: 'handoffs', refs: [callback], kind: 'callback' } },
    ]);
    const items = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(items.filter((item) => item.handoff?.session_id === session.session_id).map((item) => item.handoff?.kind)).toEqual(['callback']);
    expect((await call('handoffDone', { params: { handoff_id: card } })).status).toBe(409);
  });

  it('booking_closes_the_chats_card_handoff_as_the_kernel_does', async () => {
    // As the kernel's `native.book` does (the owner's decision of 2026-11-01): a booking closes the
    // chat's open handoff the handoff card opened, exactly as the owner's mark of done does
    // (`done`), recorded `desk_data` naming it with `closed_by: "booking"` just before the
    // booking's own execution entry, so Needs you stops listing the chat. Finding open times
    // closes nothing, and another chat's card handoff stays open.
    const { session } = await openChat();
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its main Desk');
    const other = mockStore.world.addSession(desk);
    mockStore.world.reply(other, [rivera.blocks.handoff.en], 'en');
    const handoffsOf = (sessionId: string) => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === sessionId);
    expect(handoffsOf(other.state.session_id).map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);
    await send('Can I talk to Mike?');
    await drain();
    const card = handoffsOf(session.session_id)[0]?.handoff_id ?? '';
    await send('Can someone come Tuesday?');
    await drain();
    expect(handoffsOf(session.session_id).map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);

    const ledgered = desk.ledger.length;
    await send('The first one, please.');
    await drain();
    expect(handoffsOf(session.session_id).map((h) => [h.handoff_id === card, h.kind, h.status])).toEqual([[true, 'card', 'done']]);
    expect(handoffsOf(other.state.session_id).map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);
    const events = desk.ledger.slice(ledgered).map((entry) => entry.event);
    const ran = events.findIndex((event) => event.kind === 'execute');
    expect(events[ran - 1]).toEqual({ kind: 'desk_data', origin: 'kernel', session_id: null, ref_id: null, summary: { part: 'handoffs', refs: [card], closed_by: 'booking' } });
    expect(events.filter((event) => event.kind === 'desk_data')).toHaveLength(1);
    const items = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    expect(items.filter((item) => item.handoff?.session_id === session.session_id)).toEqual([]);
    expect((await call('handoffDone', { params: { handoff_id: card } })).status).toBe(409);
  });

  it('booking_leaves_a_call_back_open', async () => {
    // A call-back promises the visitor a call, which a booking doesn't keep: it stays open, and
    // nothing is recorded closing it.
    const { session } = await openChat();
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its main Desk');
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    await send('Can you call me back?');
    await drain();
    await send('Can someone come Tuesday?');
    await drain();
    const ledgered = desk.ledger.length;
    await send('The first one, please.');
    await drain();
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['callback', 'open']]);
    expect(desk.ledger.slice(ledgered).map((entry) => entry.event.kind)).toContain('execute');
    expect(desk.ledger.slice(ledgered).filter((entry) => entry.event.kind === 'desk_data')).toEqual([]);
  });

  it('open_handoff_quotes_its_visitors_latest_words', async () => {
    // As the API reads Needs you (`recent_texts`): an open handoff quotes what its visitor wrote
    // most recently, their previous and last messages joined with " · ", on every read, not what
    // they had written when it opened.
    const { session } = await openChat();
    const quoted = async () =>
      ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])
        .filter((item) => item.handoff?.session_id === session.session_id)
        .map((item) => [item.handoff?.kind, item.from_the_visitor]);
    await send('Can I talk to Mike?');
    await drain();
    expect(await quoted()).toEqual([['card', 'Can I talk to Mike?']]);
    await send('It is about the leak under my sink.');
    await drain();
    expect(await quoted()).toEqual([['card', 'Can I talk to Mike? · It is about the leak under my sink.']]);
    await send('Is   Tuesday\n\nfine?');
    await drain();
    expect(await quoted()).toEqual([['card', 'It is about the leak under my sink. · Is Tuesday fine?']]);
  });

  it('held_request_quotes_two_lines_each_cut_to_its_glimpse', async () => {
    // The last two visitor lines in the request's own turn (the API's `visitor_lines`): each with
    // whitespace collapsed, and past 200 characters cut to 199, trimmed, and "…".
    const { session } = await openChat();
    const long = `${'x'.repeat(198)}   ${'y'.repeat(10)}`;
    await send('How much to clear a drain?');
    await drain();
    const record = mockStore.world.sessions.get(session.session_id);
    if (!record) throw new Error('the visitor has a session');
    mockStore.world.visitorText(record, 'One more question about the drain.');
    mockStore.world.visitorText(record, long);
    await send('Can I get 50%   off if I pay cash?');
    await drain();
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).find(
      (item) => item.decision?.session_id === session.session_id,
    );
    expect(held?.from_the_visitor).toBe(`${'x'.repeat(198)}… · Can I get 50% off if I pay cash?`);
    expect(Array.from(held?.from_the_visitor?.split(' · ')[0] ?? '')).toHaveLength(199);
  });

  it('needs_you_summarises_a_handoff_never_a_hold', async () => {
    // As the API's Needs you sends `claude_summary`: on a handoff, the newest AI-written triage of
    // its chat's stopped attempts, the summary Safety shows for it; on a held request, never, since
    // a visitor could steer a summary to sway an approval.
    const read = async () => (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const [seeded] = await read();
    if (!seeded?.decision) throw new Error('a fresh copy holds the seeded request');
    // The seeded chat has the stopped draft Safety lists, and its request still carries no summary.
    expect(seeded.claude_summary).toBeNull();
    const triage = ((await call('safety', { params: { desk_id: deskId } })).body as Attempt[]).find((a) => a.kind === 'reply_blocked')?.triage;
    if (!triage) throw new Error("Safety triages the seeded chat's stopped draft");

    // Denied, the request's follow-up shows the handoff card, which hands the chat to Mike.
    expect((await call('answer', { params: { decision_id: seeded.decision.decision_id }, body: { answer: 'deny_once' } })).status).toBe(200);
    await drain();
    const handed = (await read()).find((item) => item.handoff?.session_id === seeded.session.session_id);
    expect(handed?.handoff?.kind).toBe('card');
    expect(handed?.claude_summary).toBe(triage.summary);
    expect(handed?.from_the_visitor).toBe(seeded.from_the_visitor);

    // A chat with nothing stopped has no triage to summarise it.
    const { session } = await openChat();
    await send('Can I talk to Mike?');
    await drain();
    const asked = (await read()).find((item) => item.handoff?.session_id === session.session_id);
    expect(asked?.handoff?.kind).toBe('card');
    expect(asked?.claude_summary).toBeNull();
  });

  it('held_by_names_the_rule_the_decision_quotes', async () => {
    // As the API reads it (`holding_card`): a hold's card_ids are every card behind its matching hold
    // permits, sorted by ID, so the kernel's default ask for anyone can come first. "Held by your rule"
    // names the card the decision's reason quotes: the most specific, an ask card at a tie, then the
    // first by ID.
    const refund = mockStore.world.addHeldRefund();
    const record = mockStore.world.decisions.get(refund.decision_id);
    const main = mockStore.world.desk(deskId);
    if (!record || !main) throw new Error('Dana has a refund held on the main Desk');
    const defaultAsk: RuleCard = {
      card_id: 'default:payments.create_refund',
      applies_to: 'payments.create_refund',
      mode: 'ask',
      who: 'anyone',
      is_default: true,
      reason: 'Not covered by a rule yet, so it asks you.',
    };
    main.policy.cards = [...main.policy.cards, defaultAsk];
    const read = async () =>
      ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).find(
        (item) => item.decision?.decision_id === refund.decision_id,
      );

    // The refund card held it, and the default ask matched too, listed first.
    record.decision.card_ids = [defaultAsk.card_id, 'rv-refund'];
    expect((await read())?.held_by).toBe(rivera.ruleCards['rv-refund'].reason);

    // Held by the default ask alone, it names no rule: no rule of the owner's decided it, and the
    // headline already says so.
    record.decision.card_ids = [defaultAsk.card_id];
    expect((await read())?.held_by).toBeNull();
  });

  it('held_by_names_no_rule_past_an_automatic_limit', async () => {
    // As the API reads it (`owner_reads._held_by`): the seed's quote at 15% off went past the
    // automatic list-price quote card, so Needs you names no rule. The mock keeps the fixture's headline.
    const quote = rivera.ruleCards['rv-quote'];
    expect(quote.mode).toBe('auto');
    const items = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const seeded = items.find((item) => item.decision?.card_ids.includes(quote.card_id));
    expect(seeded?.decision?.card_ids).toContain('rv-quote');
    expect(seeded?.held_by).toBeNull();
  });

  it.each([
    ['seed', 'changed'], ['seed', 'removed'], ['confirmed', 'changed'], ['confirmed', 'removed'],
  ] as const)('held_by_keeps_the_%s_version_when_the_rule_is_%s', async (start, change) => {
    const world = mockStore.world;
    const main = world.desk(deskId)!;
    const competing: RuleCard = {
      card_id: 'a-refund-effect', applies_to: 'effect:pay_out', mode: 'ask', who: 'anyone',
      reason: 'Payouts ask first.',
    };
    if (start === 'confirmed') {
      const initial = world.draft(main, [competing]);
      expect(world.confirmDraft(main, initial.version)).toMatchObject({ version: initial.version });
    } else {
      world.addActiveRules(main, [competing]);
      expect(main.versions.size).toBe(0);
    }
    const heldVersion = main.policy.version;
    const refundRule = main.policy.cards.find((card) => card.card_id === 'rv-refund')!;
    const refund = world.addHeldRefund();
    // All matching hold cards are stored; the tool card outranks the effect card.
    refund.card_ids = [competing.card_id, refundRule.card_id];
    expect(refund.policy_version).toBe(heldVersion);
    const read = async () =>
      ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[]).find(
        (item) => item.decision?.decision_id === refund.decision_id,
      );
    expect((await read())?.held_by).toBe(rivera.ruleCards['rv-refund'].reason);

    const next = world.draftCards(main, main.policy.cards.flatMap((card) =>
      card.card_id !== refundRule.card_id ? [card] : change === 'removed' ? [] : [{ ...card, reason: 'New refund rule.' }],
    ));
    expect(world.confirmDraft(main, next.version)).toMatchObject({ version: heldVersion + 1 });

    expect((await read())?.decision?.state).toBe('held');
    expect((await read())?.held_by).toBe(rivera.ruleCards['rv-refund'].reason);
    expect(main.versions.has(main.policy.version)).toBe(false);
  });

  it('keeps_no_archived_versions_after_100_confirms_without_held_decisions', () => {
    const world = mockStore.world;
    const main = world.desk(deskId)!;
    world.decisions.clear();
    for (let i = 0; i < 100; i += 1) {
      const draft = world.draft(main, []);
      expect(world.confirmDraft(main, draft.version)).toMatchObject({ version: draft.version });
    }
    expect(main.versions.size).toBe(0);
  });

  it('held_by_names_no_rule_when_the_deciding_version_is_missing', async () => {
    const refund = mockStore.world.addHeldRefund();
    refund.policy_version = 999;
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])
      .find((item) => item.decision?.decision_id === refund.decision_id);
    expect(held?.held_by).toBeNull();
  });

  it('held_by_reads_an_in_place_edit_of_the_active_cards', async () => {
    const world = mockStore.world;
    const main = world.desk(deskId)!;
    const draft = world.draft(main, []);
    expect(world.confirmDraft(main, draft.version)).toMatchObject({ version: draft.version });
    const refund = world.addHeldRefund();
    expect(refund.policy_version).toBe(main.policy.version);
    const card = main.policy.cards.find((card) => card.card_id === 'rv-refund')!;
    card.reason = 'The current refund rule asks for your answer.';
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])
      .find((item) => item.decision?.decision_id === refund.decision_id);
    expect(held?.held_by).toBe(card.reason);
    expect(main.versions.has(main.policy.version)).toBe(false);
  });

  it.each(['allow', 'deny', 'cancel', 'refuse', 'closed_allow', 'closed_deny'] as const)(
    'drops_archived_cards_after_the_last_hold_resolves_%s', (resolution) => {
      const world = mockStore.world;
      const main = world.desk(deskId)!;
      world.decisions.clear();
      const first = world.addHeldRefund();
      const last = world.addHeldRefund();
      const version = first.policy_version;
      const draft = world.draft(main, []);
      expect(world.confirmDraft(main, draft.version)).toMatchObject({ version: draft.version });
      expect([...main.versions.keys()]).toEqual([version]);

      world.cancel(world.decisions.get(first.decision_id)!);
      expect([...main.versions.keys()]).toEqual([version]);
      const record = world.decisions.get(last.decision_id)!;
      let state: DecisionState;
      if (resolution === 'cancel') state = world.cancel(record).state;
      else if (resolution === 'closed_allow' || resolution === 'closed_deny') {
        world.deleteDesk(main);
        state = world.answerClosed(record, resolution === 'closed_allow' ? 'allow_once' : 'deny_once').state;
      } else {
        if (resolution === 'refuse') {
          main.policy.cards = main.policy.cards.map((card) => card.card_id === 'rv-refund' ? { ...card, mode: 'never' } : card);
        }
        state = world.answer(record, resolution === 'deny' ? 'deny_once' : 'allow_once').state;
      }
      expect(state).toBe(resolution === 'cancel' ? 'cancelled'
        : resolution === 'refuse' || resolution === 'closed_allow' ? 'refused_at_execution'
        : resolution === 'deny' || resolution === 'closed_deny' ? 'denied' : 'executed');
      expect(main.versions.size).toBe(0);
    },
  );

  it('paused_chat_hands_off_and_opens_the_owner_handoff', async () => {
    // As the API's turn in a chat the breaker paused: no model call and no "writing", only the
    // kernel's handoff, which its check stops as paused (`session_paused`, no attempt anyone made)
    // and which opens the owner's handoff the first time, as any reply showing the card does.
    const { session, events } = await openChat();
    const record = mockStore.world.sessions.get(session.session_id);
    const desk = mockStore.world.desk(deskId);
    if (!record || !desk) throw new Error('the chat and its Desk are in the copy');
    const mine = () => [...mockStore.world.handoffs.values()].map((h) => h.handoff).filter((h) => h.session_id === session.session_id);
    const attempts = async () => ((await call('safety', { params: { desk_id: deskId } })).body as unknown[]).length;
    const stopped = await attempts();
    mockStore.world.pause(record);

    for (const text of ['Hello? Is anyone there?', 'Hello?']) {
      const before = events.length;
      await send(text);
      await drain();
      const shown = events.slice(before).map(([, ev]) => ev);
      expect(shown.map((ev) => ev.type), text).toEqual(['message', 'turn_end']);
      const [message] = shown;
      expect(message?.type === 'message' && [message.author, message.handoff, message.blocks.map((b) => b.template)]).toEqual(['claude', true, ['handoff']]);
      expect(desk.ledger.at(-1)?.event).toMatchObject({ kind: 'reply', summary: { ok: false, violations: ['session_paused'] } });
    }
    expect(mine().map((h) => [h.kind, h.status])).toEqual([['card', 'open']]);
    expect(await attempts()).toBe(stopped);
  });

  it('handoff_done_is_recorded_as_the_kernel_does', async () => {
    // The owner marking a handoff done, of either kind, is one `desk_data` entry naming it, on no
    // chat and with no `kind` (plan 01b, `POST /handoffs/{id}/done`).
    await openChat();
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its main Desk');
    for (const text of ['Can I talk to Mike?', 'Can you call me back?']) {
      await send(text);
      await drain();
      const handoff = [...mockStore.world.handoffs.values()].at(-1)?.handoff;
      if (handoff?.status !== 'open') throw new Error(`"${text}" opened a handoff`);
      expect((await call('handoffDone', { params: { handoff_id: handoff.handoff_id } })).status).toBe(200);
      expect(desk.ledger.at(-1)?.event, handoff.kind).toEqual({
        kind: 'desk_data',
        origin: 'kernel',
        session_id: null,
        ref_id: null,
        summary: { part: 'handoffs', refs: [handoff.handoff_id] },
      });
    }
  });

  it('events_replay_after_seq', async () => {
    // No stream without this browser's session for the Desk, and none for a Desk that doesn't exist.
    expect(await call('events', { params: { slug } })).toEqual({ status: 401, body: { error: 'no_session' } });
    expect((await call('events', { params: { slug: 'turner-plumbing-nope00' } })).status).toBe(404);

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
    expect(replayed.at(-1)?.[1].type).toBe('writing');
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

    // Dana's seeded chat: three actions that ran, and Mike's whisper in it.
    const conversations = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    const dana = conversations.find((c) => c.session_id === 'ses-dana-web');
    expect(dana?.outcome_counts).toEqual({ executed: 3 });
    const danaOwner = (await call('conversation', { params: { session_id: 'ses-dana-web' } })).body as OwnerTranscript;
    expect(danaOwner.items.filter((item) => item.kind === 'whisper').map((item) => item.text)).toEqual(['offer Thursday morning too']);

    // The owner's preview of her Desk is a chat of its own, flagged as hers, and the browser's
    // visitor cookie names it. Asking for a preview again starts another, as the API's preview
    // route does (the page reads the chat it has first, so it doesn't ask twice).
    const preview = (await call('openPreview', { params: { desk_id: deskId } })).body as VisitorSession;
    expect(preview.resumed).toBe(false);
    expect(preview.state.session_id).not.toBe(session.session_id);
    expect(((await call('visitorSession', { params: { slug } })).body as VisitorTranscript).state.session_id).toBe(preview.state.session_id);
    const again = (await call('openPreview', { params: { desk_id: deskId } })).body as VisitorSession;
    expect(again.resumed).toBe(false);
    expect(again.state.session_id).not.toBe(preview.state.session_id);
    expect(mockStore.visitorSession(slug)?.state.session_id).toBe(again.state.session_id);
    const listed = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(listed.filter((c) => c.owner_preview).map((c) => c.session_id).sort()).toEqual(
      [preview.state.session_id, again.state.session_id].sort(),
    );
  });

  it('summary_names_a_verified_visitors_person', async () => {
    mockStore.reset('rivera_regulars');
    const { dana, bob } = rivera.people;
    const world = mockStore.world;
    const desk = world.desk(deskId)!;
    const persons = async () =>
      new Map(((await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[]).map((c) => [c.session_id, c.person_id]));

    // The earlier chats Dana verified in are hers, newest first; Bob has none, and her live chat,
    // where she hasn't confirmed it's her, is no one's.
    const seeded = (await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[];
    expect(seeded.filter((c) => c.person_id === dana.personId).map((c) => c.session_id)).toEqual(['ses-dana-invoice', 'ses-dana-quote']);
    expect(seeded.filter((c) => c.person_id === bob.personId)).toEqual([]);
    expect((await persons()).get('ses-dana-web')).toBeNull();
    expect((await persons()).get('ses-alex-agent')).toBeNull();

    // A visitor who verifies as Bob is his; the owner's preview, verified as him too, isn't.
    const visitor = world.addSession(desk);
    world.visitorText(visitor, 'Hi, it is Bob.');
    world.verify(visitor, bob);
    const preview = world.addSession(desk, { ownerPreview: true });
    world.visitorText(preview, 'Testing my own Desk.');
    world.verify(preview, bob);
    const listed = await persons();
    expect(listed.get(visitor.state.session_id)).toBe(bob.personId);
    expect(listed.get(preview.state.session_id)).toBeNull();
  });

  it('summary_carries_the_visitors_newest_words', async () => {
    const latest = async (sessionId: string) =>
      ((await call('conversations', { params: { desk_id: deskId } })).body as ConversationSummary[]).find((c) => c.session_id === sessionId)
        ?.latest_visitor_text;
    // Dana's seeded chat, by her newest message; the visiting agent's chat has none.
    expect(await latest('ses-dana-web')).toBe('Tuesday at 2 works.');
    expect(await latest('ses-alex-agent')).toBeNull();

    // A new chat has none until the visitor writes, then their newest message, its whitespace
    // collapsed to single spaces, and cut to 199 characters and "…" past 200.
    const { session } = await openChat();
    expect(await latest(session.session_id)).toBeNull();
    await send('  Do you   work\n\nweekends?  ');
    await drain();
    expect(await latest(session.session_id)).toBe('Do you work weekends?');
    const whole = 'w'.repeat(200);
    await send(whole);
    await drain();
    expect(await latest(session.session_id)).toBe(whole);
    await send(`${'a'.repeat(150)} ${'b'.repeat(100)}`);
    await drain();
    expect(await latest(session.session_id)).toBe(`${'a'.repeat(150)} ${'b'.repeat(48)}…`);
    // A cut that falls just after a space ends on the word before it, with no space before the "…".
    await send(`${'c'.repeat(198)} ${'d'.repeat(10)}`);
    await drain();
    expect(await latest(session.session_id)).toBe(`${'c'.repeat(198)}…`);
    // A message that is all whitespace leaves none, as the API's null.
    await send(' \n\t ');
    await drain();
    expect(await latest(session.session_id)).toBeNull();

    // The owner's own preview has none, whatever she writes there.
    const preview = (await call('openPreview', { params: { desk_id: deskId } })).body as VisitorSession;
    await send('Do you work weekends?');
    await drain();
    expect(await latest(preview.state.session_id)).toBeNull();
  });
});

describe("a verified visitor's document link", () => {
  /** The headers the API sends with a document and with a refusal on its link, so it is never cached, sniffed, sent on or indexed. */
  const PRIVATE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' };
  const USED_OR_EXPIRED = 'This link was already opened or has expired. Ask in the chat for a new one.';

  /** A document link's answer, which must be one with a status (not a dropped connection). */
  function open(method: 'GET' | 'HEAD', token: string, headers: Record<string, string> = {}): DocumentAnswer {
    const answer = mockStore.document(method, token, { headers });
    if ('network' in answer) throw new Error(`${method} ${token} dropped the connection`);
    return answer;
  }

  /** Dana confirms it's her with the code and gets her last invoice: her chat, with every event its stream got. */
  async function danaVerified() {
    const chat = await openChat();
    await send("I'm Dana Whitfield. Please send my last invoice.");
    await drain();
    expect((await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } })).status).toBe(200);
    await drain();
    return chat;
  }

  /** The token of the link the newest invoice card in `events` hands out. */
  function newestToken(events: [number, SseEvent][]): string {
    const card = events.flatMap(([, ev]) => (ev.type === 'message' ? ev.blocks : [])).filter((block) => block.template === 'document_link').at(-1);
    expect(card?.title).toBe(rivera.blocks.document_link.en.title);
    const token = /^\/api\/d\/([A-Za-z0-9_-]+)$/.exec(card?.href ?? '')?.[1];
    if (token === undefined) throw new Error('the invoice card links to its document');
    return token;
  }

  /** Dana confirms it's her and gets her last invoice: the token of the link the newest card hands out. */
  async function invoiceToken(): Promise<string> {
    return newestToken((await danaVerified()).events);
  }

  it('the_first_open_gets_the_document', async () => {
    // As the API sends the kernel's document: plain text, shown in the tab under its title's file name.
    const opened = open('GET', await invoiceToken());
    expect(opened).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'inline; filename="Invoice-drain-clearing.txt"', ...PRIVATE },
      body: 'Turner Plumbing\nInvoice for Dana Whitfield\nDrain clearing, kitchen sink: $180.00\nPaid in full. Thank you.',
    });
  });

  it('a_second_open_is_404', async () => {
    const token = await invoiceToken();
    expect(open('GET', token).status).toBe(200);
    // The API's short static copy, in the browser's language, or its error when JSON is asked for.
    const refused = { 'content-type': 'text/plain; charset=utf-8', ...PRIVATE, vary: 'accept, accept-language' };
    expect(open('GET', token)).toEqual({ status: 404, headers: { ...refused, 'content-language': 'en' }, body: USED_OR_EXPIRED });
    expect(open('GET', token, { 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' })).toEqual({
      status: 404,
      headers: { ...refused, 'content-language': 'es' },
      body: 'Este enlace ya se abrió o caducó. Pide uno nuevo en el chat.',
    });
    expect(open('GET', token, { accept: 'application/json' })).toEqual({
      status: 404,
      headers: { 'content-type': 'application/json', ...PRIVATE, vary: 'accept, accept-language' },
      body: '{"error":"link_used_or_expired"}',
    });
  });

  it('an_unknown_link_is_404', async () => {
    // Before any card hands it out, the invoice's link names nothing, as a made-up one doesn't.
    for (const token of [rivera.blocks.document_link.en.href?.slice('/api/d/'.length) ?? '', 'nothing-here']) {
      expect([open('GET', token).status, open('GET', token).body], token).toEqual([404, USED_OR_EXPIRED]);
    }
    expect(open('GET', 'nothing-here').status).toBe(404);
    const token = await invoiceToken();
    expect(open('GET', `${token}x`).status).toBe(404);
    expect(open('GET', token).status).toBe(200);
  });

  it('asking_again_in_the_verified_chat_hands_out_a_new_card_with_no_new_code', async () => {
    // Verification lasts for the chat, as the API's does: verified Dana asks again and Claude's
    // turn after a confirmed code runs at once, with no code to her contact and no card asking her
    // to confirm. The invoice is released to her as its verified owner, and the new card's link is
    // a new one, which opens once; the link she already opened stays used.
    const { session, events } = await danaVerified();
    const first = newestToken(events);
    expect(open('GET', first).status).toBe(200);
    const before = events.length;
    await send('Could you send my last invoice again, please?');
    await drain();
    const again = events.slice(before);
    expect(typesOf(again)).toEqual(['writing', 'receipt', 'message', 'turn_end']);
    expect(again.flatMap(([, ev]) => (ev.type === 'message' ? ev.blocks.map((b) => [b.kind, b.template, b.text ?? b.title]) : []))).toEqual([
      ['prose', null, "Thanks, Dana. Here's your invoice."],
      ['card', 'document_link', rivera.blocks.document_link.en.title],
    ]);
    const decided = [...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === session.session_id);
    expect(decided.map(({ decision }) => [decision.action?.tool, decision.outcome, decision.reason_plain])).toEqual([
      [DECISIONS.startVerification.tool, 'allow', DECISIONS.startVerification.reasonPlain],
      [DECISIONS.releaseInvoice.tool, 'allow', DECISIONS.releaseInvoice.reasonPlain],
      [DECISIONS.releaseInvoice.tool, 'allow', DECISIONS.releaseInvoice.reasonPlain],
    ]);
    const codes = mockStore.world.inbox.filter((record) => record.sessionId === session.session_id && record.entry.kind === 'verification_code');
    expect(codes).toHaveLength(1);
    const second = newestToken(again);
    expect(second).not.toBe(first);
    expect(open('GET', first).status).toBe(404);
    expect(open('GET', second).status).toBe(200);
    expect([open('GET', first).status, open('GET', second).status]).toEqual([404, 404]);
  });

  it('a_look_before_opening_never_uses_the_link', async () => {
    // A link checker's HEAD answers 200 with the document's privacy headers and no body, whatever
    // the token names, and the link still opens once after it.
    const token = await invoiceToken();
    for (const named of [token, token, 'nothing-here']) expect(open('HEAD', named)).toEqual({ status: 200, headers: PRIVATE, body: null });
    expect(open('GET', token).status).toBe(200);
    expect(open('HEAD', token)).toEqual({ status: 200, headers: PRIVATE, body: null });
    expect(open('GET', token).status).toBe(404);
  });
});

describe('taking over', () => {
  /** What the ledger holds for `sessionId`, by kind, oldest first. */
  const kindsFor = (sessionId: string) =>
    (mockStore.world.desks[0]?.ledger ?? []).filter((e) => e.event.session_id === sessionId).map((e) => e.event.kind);

  it('hand_back_answers_the_waiting_visitor_once', async () => {
    const { session, events } = await openChat();
    const params = { session_id: session.session_id };
    expect((await call('takeover', { params, body: { generation: session.generation } })).status).toBe(200);
    await send('Do you work in Alameda?');
    await drain();
    expect(typesOf(events)).toEqual(['owner_joined']);

    expect((await call('handback', { params, body: { generation: session.generation + 1 } })).status).toBe(200);
    await drain();
    expect(typesOf(events)).toEqual(['owner_joined', 'owner_left', 'writing', 'message', 'turn_end']);
    expect(events[3]?.[1]).toMatchObject({ type: 'message', author: 'claude', generation: session.generation + 2 });
    await drain();
    expect(typesOf(events).filter((kind) => kind === 'message')).toHaveLength(1);
  });

  it('hand_back_leaves_a_waiting_agent_line_for_its_next_request', async () => {
    // As on the API, an agent's line waits too, but its turn runs only on the agent's own next request.
    const world = mockStore.world;
    const agent = world.addSession(world.desk(deskId)!, { agent: "Alex Kim's assistant" });
    const params = { session_id: agent.state.session_id };
    expect((await call('takeover', { params, body: { generation: agent.state.generation } })).status).toBe(200);
    world.agentText(agent, 'Can someone come on Thursday?');
    expect((await call('handback', { params, body: { generation: agent.state.generation } })).status).toBe(200);
    await drain();
    expect(agent.events.map(({ ev }) => ev.type)).toEqual(['owner_joined', 'owner_left']);
  });

  it.each(['empty', 'owner_answered', 'owner', 'claude'] as const)('hand_back_starts_nothing_after_%s', async (latest) => {
    const { session, events } = await openChat();
    const params = { session_id: session.session_id };
    if (latest === 'claude') {
      await send('Do you work in Alameda?');
      await drain();
    }
    expect((await call('takeover', { params, body: { generation: session.generation } })).status).toBe(200);
    if (latest === 'owner_answered') await send('Do you work in Alameda?');
    if (latest === 'owner_answered' || latest === 'owner') {
      expect((await call('ownerMessage', { params, body: { kind: 'say', text: 'Yes, we do.' } })).status).toBe(200);
    }
    const before = events.length;
    expect((await call('handback', { params, body: { generation: session.generation + 1 } })).status).toBe(200);
    await drain();
    expect(typesOf(events.slice(before))).toEqual(['owner_left']);
  });

  it('takeover_fences_the_turn_in_flight', async () => {
    const { session, events } = await openChat();
    // The visitor picks a time, and Mike takes the chat over before Claude's turn has done anything.
    await send('The first one please');
    const taken = await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation } });
    expect(taken).toEqual({ status: 200, body: { ...session, mode: 'owner', generation: session.generation + 1 } });
    await drain();

    // The turn was queued at the old generation, so it runs nothing: no booking, no receipt, no
    // reply. It ends silently, and "Claude is writing" clears.
    expect(typesOf(events)).toEqual(['owner_joined', 'turn_end']);
    expect(kindsFor(session.session_id)).not.toContain('decide');
    expect(kindsFor(session.session_id)).not.toContain('execute');
    expect([...mockStore.world.decisions.values()].filter((d) => d.decision.session_id === session.session_id)).toEqual([]);
    await drain();
    expect(typesOf(events)).toEqual(['owner_joined', 'turn_end']);
  });

  it('takeover_still_tells_the_visitor_approval_then_the_outcome', async () => {
    const { session, events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[1] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    // Mike allows the hold, then joins the chat at once. The action ran when he answered, so the
    // visitor still hears that; Claude's follow-up was for the old generation and never comes.
    expect((await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } })).status).toBe(200);
    expect((await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation } })).status).toBe(200);
    await drain();
    expect(typesOf(events).slice(4)).toEqual(['owner_joined', 'receipt', 'resolved', 'turn_end']);
    expect(events[5]?.[1]).toMatchObject({ type: 'receipt', decision_id: decisionId, state: 'approved' });
    expect(events[6]?.[1]).toMatchObject({ type: 'resolved', decision_id: decisionId, state: 'executed' });
    expect(kindsFor(session.session_id).filter((kind) => kind === 'reply')).toHaveLength(1);
  });
});

describe('the owner in the chat', () => {
  const owner = async (sessionId: string) => (await call('conversation', { params: { session_id: sessionId } })).body as OwnerTranscript;
  const ownerKinds = async (sessionId: string) => (await owner(sessionId)).items.map((item) => item.kind);
  const kindsFor = (sessionId: string) =>
    (mockStore.world.desks[0]?.ledger ?? []).filter((e) => e.event.session_id === sessionId).map((e) => e.event.kind);

  it('say_reaches_the_visitor_in_the_owners_words', async () => {
    const { session, events } = await openChat();
    const sessionId = session.session_id;

    // Not before he has taken the chat over.
    expect(await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'Hi, it is Mike.', kind: 'say' } })).toEqual({
      status: 409,
      body: { error: 'take_over_first' },
    });
    expect((await call('takeover', { params: { session_id: sessionId }, body: { generation: session.generation } })).status).toBe(200);
    const said = await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'Hi, it is Mike.', kind: 'say' } });
    expect(said.status).toBe(200);
    expect(said.body).toMatchObject({ verdict: { ok: true, violations: [] } });

    // The visitor's stream gets her joining, then her words, verbatim, as one owner_said card.
    expect(typesOf(events)).toEqual(['owner_joined', 'message']);
    const [, message] = events[1] ?? [];
    expect(message).toMatchObject({ type: 'message', author: 'owner', generation: session.generation + 1, visitor_plain: VISITOR_PLAIN.en.owner_said });
    expect(message?.type === 'message' && message.blocks.map((b) => [b.template, b.text])).toEqual([['owner_said', 'Hi, it is Mike.']]);
    expect(VISITOR_PLAIN.en.owner_said).toBe(rivera.events.takeOver.find((ev): ev is EvMessage => ev.type === 'message')?.visitor_plain);

    // Stored as a delivered item, author owner, in both transcripts.
    const item = (await owner(sessionId)).items.at(-1);
    expect(item).toMatchObject({ kind: 'delivered', text: null, event: { author: 'owner' } });
    const visitor = (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;
    expect(visitor.items.at(-1)).toMatchObject({ kind: 'delivered', event: { author: 'owner' } });
  });

  it('whisper_stays_with_the_owner', async () => {
    const { session, events } = await openChat();
    const sessionId = session.session_id;
    const whispered = await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'offer Thursday too', kind: 'whisper' } });
    expect(whispered.status).toBe(200);
    expect(whispered.body).toMatchObject({ verdict: null });
    await drain();
    expect(events).toEqual([]);
    expect(await ownerKinds(sessionId)).toEqual(['whisper']);
    expect((await owner(sessionId)).items[0]?.text).toBe('offer Thursday too');
    const visitor = (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;
    expect(visitor.items).toEqual([]);

    // Words the API would refuse: none, too long, or no kind it knows.
    for (const body of [{ text: '', kind: 'say' }, { text: 'x'.repeat(2001), kind: 'whisper' }, { text: 'hi', kind: 'shout' }]) {
      expect((await call('ownerMessage', { params: { session_id: sessionId }, body })).status).toBe(422);
    }
  });

  it('hand_back_and_resume_follow_the_mode', async () => {
    const { session, events } = await openChat();
    const sessionId = session.session_id;
    const at = (generation: number) => ({ params: { session_id: sessionId }, body: { generation } });

    // Hand back only from the owner's mode, at the generation she last read.
    expect((await call('handback', at(1))).body).toEqual({ error: 'kernel', code: 'conflict' });
    expect((await call('takeover', at(1))).status).toBe(200);
    expect((await call('handback', at(1))).body).toEqual({ error: 'kernel', code: 'stale_generation' });
    expect(await call('handback', at(2))).toEqual({ status: 200, body: { ...session, mode: 'ai', generation: 3 } });
    expect(typesOf(events)).toEqual(['owner_joined', 'owner_left']);

    // Resume only a chat Claude paused.
    expect((await call('resume', at(3))).body).toEqual({ error: 'kernel', code: 'conflict' });
    const record = mockStore.visitorSession(slug);
    if (!record) throw new Error('this browser has a chat');
    mockStore.world.pause(record);
    expect(record.state.mode).toBe('paused');
    expect(await call('resume', at(3))).toEqual({ status: 200, body: { ...session, mode: 'ai', generation: 4 } });
    expect(kindsFor(sessionId)).toEqual(['session', 'takeover', 'takeover', 'breaker', 'breaker']);
  });

  it('take_over_and_hand_back_stay_in_both_transcripts', async () => {
    const { session, events } = await openChat();
    const sessionId = session.session_id;
    const at = (generation: number) => ({ params: { session_id: sessionId }, body: { generation } });
    const visitor = async () => (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;

    // As the API keeps them: each an item of its own kind, holding the event the visitor's stream
    // got then, with no text, in the visitor's transcript and the owner's.
    expect((await call('takeover', at(session.generation))).status).toBe(200);
    const joined = { type: 'owner_joined', name: rivera.business.ownerName };
    expect((await visitor()).items.map((item) => [item.kind, item.text, item.event])).toEqual([['owner_joined', null, joined]]);
    expect((await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'Hi, it is Mike.', kind: 'say' } })).status).toBe(200);
    expect((await call('handback', at(session.generation + 1))).status).toBe(200);
    const read = await visitor();
    expect(read.items.map((item) => item.kind)).toEqual(['owner_joined', 'delivered', 'owner_left']);
    expect(read.items.at(-1)?.event).toEqual({ type: 'owner_left' });
    expect(await ownerKinds(sessionId)).toEqual(['owner_joined', 'delivered', 'owner_left']);
    // Read in step with the stream: a stream opened after `last_seq` repeats none of them.
    expect(typesOf(events)).toEqual(['owner_joined', 'message', 'owner_left']);
    expect(read.last_seq).toBe(events.at(-1)?.[0]);
  });

  it('a_code_confirmed_while_the_owner_has_the_chat_waits_for_the_hand_back', async () => {
    // As the API: the visitor is verified, but while the owner has the chat Claude takes no turn, so
    // it doesn't answer for him and the chat stays his. Handed back, Claude goes on with the invoice, once.
    const { session, events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    expect((await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation } })).status).toBe(200);
    const before = events.length;
    const checked = await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } });
    expect(checked).toMatchObject({ status: 200, body: { state: { verified: true, mode: 'owner' } } });
    await drain();
    expect(typesOf(events.slice(before)).filter((type) => ['writing', 'message', 'turn_end'].includes(type))).toEqual([]);
    expect((await call('visitorSession', { params: { slug } })).body).toMatchObject({ state: { mode: 'owner' } });

    const handedBack = events.length;
    expect((await call('handback', { params: { session_id: session.session_id }, body: { generation: session.generation + 1 } })).status).toBe(200);
    await drain();
    const after = events.slice(handedBack).map(([, ev]) => ev);
    expect(after.map((ev) => ev.type)).toEqual(['owner_left', 'writing', 'receipt', 'message', 'turn_end']);
    const reply = after.find((ev) => ev.type === 'message');
    expect(reply?.type === 'message' && reply.blocks.map((b) => b.template)).toContain('document_link');
    // A second hand-back after another take-over has nothing left to go on with.
    const again = events.length;
    expect((await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation + 2 } })).status).toBe(200);
    expect((await call('handback', { params: { session_id: session.session_id }, body: { generation: session.generation + 3 } })).status).toBe(200);
    await drain();
    expect(typesOf(events.slice(again))).toEqual(['owner_joined', 'owner_left']);
  });

  it('a_code_held_for_the_hand_back_survives_a_take_over_before_its_turn_and_comes_before_a_waiting_line', async () => {
    // The owner takes the chat back before Claude's turn starts: that turn never runs, and the next
    // hand-back has the code still. A line the visitor wrote meanwhile doesn't use it up: Claude goes
    // on with the invoice, once.
    const { session, events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    const at = (step: number) => ({ params: { session_id: session.session_id }, body: { generation: session.generation + step } });
    expect((await call('takeover', at(0))).status).toBe(200);
    expect((await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } })).status).toBe(200);
    await send('Did it work?');
    const before = events.length;
    expect((await call('handback', at(1))).status).toBe(200);
    expect((await call('takeover', at(2))).status).toBe(200);
    await drain();
    expect((await call('handback', at(3))).status).toBe(200);
    await drain();
    const replies = events.slice(before).flatMap(([, ev]) => (ev.type === 'message' ? [ev.blocks.map((b) => b.template)] : []));
    expect(replies.filter((templates) => templates.includes('document_link'))).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });

  it('a_code_confirmed_in_a_paused_chat_gets_the_kernels_handoff', async () => {
    // As a message in a paused chat: no "writing" and no invoice, only the kernel's handoff card.
    const { session, events } = await openChat();
    await send('Can you send my invoice?');
    await drain();
    const record = mockStore.world.sessions.get(session.session_id);
    if (!record) throw new Error('the chat is in the copy');
    mockStore.world.pause(record);
    const before = events.length;
    expect((await call('verifyCheck', { params: { slug }, body: { code: DEMO_CODE } })).status).toBe(200);
    await drain();
    const shown = events.slice(before).map(([, ev]) => ev);
    expect(shown.map((ev) => ev.type)).toEqual(['message', 'turn_end']);
    const [message] = shown;
    expect(message?.type === 'message' && [message.author, message.handoff, message.blocks.map((b) => b.template)]).toEqual(['claude', true, ['handoff']]);
  });

  it('typing_shows_both_ways', async () => {
    const { session, events } = await openChat();
    const sessionId = session.session_id;
    const typingUntil = async () => (await owner(sessionId)).typing_until ?? null;

    // The visitor typing reaches only the owner's view, for five seconds.
    expect(await typingUntil()).toBeNull();
    expect(await call('visitorTyping', { params: { slug } })).toEqual({ status: 204, body: undefined });
    const until = await typingUntil();
    expect(Date.parse(until ?? '') - Date.now()).toBe(5_000);
    const visitor = (await call('visitorSession', { params: { slug } })).body as VisitorTranscript;
    expect('typing_until' in visitor).toBe(false);
    // A second ping within 2 s changes nothing; one after it moves the time on.
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await call('visitorTyping', { params: { slug } })).status).toBe(204);
    expect(await typingUntil()).toBe(until);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await typingUntil()).toBeNull();

    // The owner typing reaches the visitor only after she took over: her name and how long, no words.
    const at = { params: { session_id: sessionId }, body: { generation: session.generation } };
    expect(await call('ownerTyping', at)).toEqual({ status: 409, body: { error: 'take_over_first' } });
    expect((await call('takeover', at)).status).toBe(200);
    const typing = { params: { session_id: sessionId }, body: { generation: session.generation + 1 } };
    expect(await call('ownerTyping', typing)).toEqual({ status: 204, body: undefined });
    expect(events.map(([, ev]) => ev)).toEqual([
      { type: 'owner_joined', name: rivera.business.ownerName },
      { type: 'owner_typing', name: rivera.business.ownerName, until: expect.any(String) as string },
    ]);
    const [, sent] = events[1] ?? [];
    expect(sent?.type === 'owner_typing' && Date.parse(sent.until) - Date.now()).toBe(5_000);
    // At most once every 2 s.
    expect((await call('ownerTyping', typing)).status).toBe(204);
    expect(events).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await call('ownerTyping', typing)).status).toBe(204);
    expect(events).toHaveLength(3);
  });

  it('a_visitor_message_ends_their_typing', async () => {
    const { session } = await openChat();
    const typingUntil = async () => (await owner(session.session_id)).typing_until ?? null;
    expect((await call('visitorTyping', { params: { slug } })).status).toBe(204);
    expect(await typingUntil()).not.toBeNull();
    // Her message takes the dots' place, and her next keystroke counts at once.
    expect((await call('sendMessage', { params: { slug }, body: { text: 'Thursday works.' } })).status).toBe(202);
    expect(await typingUntil()).toBeNull();
    expect((await call('visitorTyping', { params: { slug } })).status).toBe(204);
    expect(await typingUntil()).not.toBeNull();
  });

  it('decision_reads_by_id_in_the_copy', async () => {
    const held = mockStore.world.addHeldRefund();
    expect(await call('decision', { params: { decision_id: held.decision_id } })).toEqual({ status: 200, body: held });
    expect((await call('decision', { params: { decision_id: 'dec-elsewhere' } })).status).toBe(404);
    mockStore.reset('rivera', { signedIn: false });
    expect((await call('decision', { params: { decision_id: held.decision_id } })).status).toBe(401);
  });
});

describe('rules and tools', () => {
  const rules = async () => (await call('rules', { params: { desk_id: deskId } })).body as RulesView;
  const draftOf = async (version: number) => call('ruleDraft', { params: { desk_id: deskId, version: String(version) } });
  const confirm = (version: unknown) => call('confirmRules', { params: { desk_id: deskId }, body: { version } });
  const confirmTools = (body: unknown) => call('confirmTool', { params: { desk_id: deskId }, body });
  const statusOf = async (tool: string) => (await rules()).tools.find((row) => row.tool === tool)?.status;
  const hashOf = async (tool: string) => (await rules()).tools.find((row) => row.tool === tool)?.definition_sha256 ?? '';

  it('rule_drafts_read_and_confirm', async () => {
    // The active rules: version 7, Turner's $500 limit, every tool on, from no preset.
    const before = await rules();
    expect(before.active).toMatchObject({ version: 7, status: 'active', auto_money_cap_cents: 50_000 });
    expect(before.preset).toBeNull();
    expect(before.tools.map((row) => row.tool)).toContain('payments.create_refund');
    expect(before.tools.every((row) => row.status === 'enabled')).toBe(true);
    expect(Object.keys(before.tools[0] ?? {}).sort()).toEqual(
      ['business', 'cards', 'definition_sha256', 'description_confirmed', 'effects', 'pending_definition_text', 'pending_sha256', 'reversible', 'review_reason', 'source', 'status', 'tool'],
    );
    // Each row lists the active cards that cover its tool, in card order, a shared one marked so (plan 02b Task 9).
    const quote = rivera.ruleCards['rv-quote'];
    expect(before.tools.find((row) => row.tool === 'native.quote')?.cards).toEqual([{ card_id: quote.card_id, mode: quote.mode, reason: quote.reason, shared: false }]);
    // A tool gives a reason only while it waits for review.
    expect(before.tools.every((row) => row.review_reason === null)).toBe(true);

    // A draft reads back by its version until it is confirmed; nothing applies before then.
    const quoteAsks = { ...rivera.ruleCards['rv-quote'], mode: 'ask' as const };
    const drafted = (await call('draftRules', { params: { desk_id: deskId }, body: { add: [quoteAsks] } })).body as RulesDraft;
    expect(drafted).toMatchObject({ version: 8, auto_money_cap_cents: 50_000, diff: { changed: [[rivera.ruleCards['rv-quote'], quoteAsks]] } });
    expect(await draftOf(8)).toEqual({ status: 200, body: drafted });
    expect((await draftOf(99)).status).toBe(404);
    expect((await rules()).active.version).toBe(7);

    // A second draft from version 7, then the first confirmed: the second is out of date.
    const stale = (await call('draftRules', { params: { desk_id: deskId }, body: { add: [{ ...quoteAsks, reason: 'Quotes wait.' }] } })).body as RulesDraft;
    expect(stale.version).toBe(9);
    expect((await confirm('8')).status).toBe(422);
    const confirmed = await confirm(8);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body as PolicyVersionOut).toMatchObject({ version: 8, parent_version: 7, status: 'active', auto_money_cap_cents: 50_000 });
    const after = await rules();
    expect(after.active.version).toBe(8);
    expect(after.active.cards.find((card) => card.card_id === 'rv-quote')?.mode).toBe('ask');
    expect((await draftOf(8)).status).toBe(404);
    expect(await confirm(9)).toEqual({ status: 409, body: { error: 'rules_changed_since_draft' } });
    expect((await confirm(8)).status).toBe(404);
    expect(mockStore.world.desks[0]?.ledger.at(-1)?.event).toMatchObject({ kind: 'policy', summary: { version: 8, parent_version: 7 } });

    // The business's people, by name, and its leads.
    const people = (await call('people', { params: { desk_id: deskId } })).body as PeopleOut;
    expect(people.people).toContainEqual({ person_id: rivera.people.dana.personId, display_name: rivera.people.dana.name, masked_contact: rivera.people.dana.maskedContact });

    // Another copy's owner reaches none of it.
    mockStore.reset('rivera', { signedIn: false });
    for (const key of ['rules', 'people'] as const) expect((await call(key, { params: { desk_id: deskId } })).status).toBe(401);
    expect((await draftOf(8)).status).toBe(401);
    expect((await confirm(8)).status).toBe(401);
  });

  it.each(['ask_first', 'auto'] as const)('preset_%s_keeps_person_card_on_non_money_job', async (preset) => {
    const desk = mockStore.world.desks[0]!;
    const person: RuleCard = { ...desk.policy.cards.find((card) => card.card_id === 'rv-urgent')!, card_id: 'person-dana-callback', who: 'person', person_id: rivera.people.dana.personId };
    desk.policy.cards.push(person);
    const response = await call('draftPreset', { params: { desk_id: deskId }, body: { preset } });
    expect(response.status).toBe(200);
    const draft = response.body as RulesDraft;
    expect(draft.cards).toContainEqual(person);
    expect(draft.diff?.removed).not.toContainEqual(person);
    expect(draft.diff?.changed?.some(([old]) => old.card_id === person.card_id)).toBe(false);
    expect((await confirm(draft.version)).status).toBe(200);
    expect((await rules()).preset).toBe(preset);
  });

  it.each([
    ['needs_review', 'new', false], ['needs_review', 'changed', true],
    ['needs_review', 'delisted', false], ['disabled', null, false],
  ] as const)('preset_handles_job_state_%s_%s', async (status, reviewReason, kept) => {
    for (const preset of ['ask_first', 'auto'] as const) {
      mockStore.reset('rivera');
      const desk = mockStore.world.desks[0]!;
      const job = desk.tools.find((row) => row.tool === 'desk.emergency-callback')!;
      job.status = status;
      job.review_reason = reviewReason;
      const urgent = desk.policy.cards.find((card) => card.card_id === 'rv-urgent')!;
      const before = await rules();
      expect(before.tools.find((row) => row.tool === job.tool)?.review_reason).toBe(reviewReason);
      const response = await call('draftPreset', { params: { desk_id: deskId }, body: { preset } });
      expect(response.status).toBe(200);
      const draft = response.body as RulesDraft;
      expect(draft.cards.some((card) => card.card_id === urgent.card_id)).toBe(kept);
      expect(draft.diff?.removed?.some((card) => card.card_id === urgent.card_id)).toBe(!kept);
      expect((await confirm(draft.version)).status).toBe(200);
      expect((await rules()).preset).toBe(preset);
    }
  });

  it.each(['ask_first', 'auto'] as const)('preset_%s_card_wins_job_card_id_collision', async (preset) => {
    const desk = mockStore.world.desks[0]!;
    const presetCard = presetCards(preset, RIVERA_HOURS)[0]!;
    const collision: RuleCard = { ...desk.policy.cards.find((card) => card.card_id === 'rv-urgent')!, card_id: presetCard.card_id, mode: 'never' };
    desk.policy.cards = [...desk.policy.cards.filter((card) => card.card_id !== collision.card_id), collision];
    const response = await call('draftPreset', { params: { desk_id: deskId }, body: { preset } });
    expect(response.status).toBe(200);
    const draft = response.body as RulesDraft;
    expect(draft.cards).toContainEqual(presetCard);
    expect(draft.cards).not.toContainEqual(collision);
    expect(draft.diff?.changed).toContainEqual([collision, presetCard]);
    expect(new Set(draft.cards.map((card) => card.card_id)).size).toBe(draft.cards.length);
    expect((await confirm(draft.version)).status).toBe(200);
    expect((await rules()).preset).toBe(preset);
  });

  it.each(['ask_first', 'auto'] as const)('preset_%s_removes_automatic_money_job_cards', async (preset) => {
    const desk = mockStore.world.desks[0]!;
    const urgent = desk.tools.find((row) => row.tool === 'desk.emergency-callback')!;
    const payment: RuleCard = { ...desk.policy.cards.find((card) => card.card_id === 'rv-urgent')!, card_id: 'deposit', applies_to: 'desk.deposit', max_amount_cents: 5000 };
    const payout: RuleCard = { ...payment, card_id: 'payout', applies_to: 'desk.payout' };
    desk.tools.push({ ...urgent, tool: 'desk.deposit', effects: ['change', 'charge'] },
      { ...urgent, tool: 'desk.payout', effects: ['change', 'pay_out'] });
    desk.policy.cards.push(payment, payout);
    const response = await call('draftPreset', { params: { desk_id: deskId }, body: { preset } });
    expect(response.status).toBe(200);
    const draft = response.body as RulesDraft;
    for (const card of [payment, payout]) {
      expect(draft.cards).not.toContainEqual(card);
      expect(draft.diff?.removed).toContainEqual(card);
    }
    expect((await confirm(draft.version)).status).toBe(200);
    expect((await rules()).preset).toBe(preset);
    desk.policy.cards.push(payment);
    expect((await rules()).preset).toBeNull();
  });

  it.each(['ask_first', 'auto'] as const)('preset_%s_keeps_the_desks_job_cards', async (preset) => {
    const before = await rules();
    const urgent = before.active.cards.find((card) => card.card_id === 'rv-urgent');
    expect(urgent).toMatchObject({ applies_to: 'desk.emergency-callback', mode: 'auto', reason: 'Anyone can ask for an urgent callback, which alerts you at once.' });
    const response = await call('draftPreset', { params: { desk_id: deskId }, body: { preset } });
    expect(response.status).toBe(200);
    const draft = response.body as RulesDraft;
    expect(draft.cards).toEqual([...presetCards(preset, RIVERA_HOURS), urgent]);
    expect(new Set(draft.cards.map((card) => card.card_id)).size).toBe(draft.cards.length);
    expect(draft.diff?.removed).not.toContainEqual(urgent);
    const was = new Map(before.active.cards.map((card) => [card.card_id, card]));
    const now = new Map(draft.cards.map((card) => [card.card_id, card]));
    for (const card of draft.diff?.added ?? []) expect(was.has(card.card_id)).toBe(false);
    for (const card of draft.diff?.removed ?? []) expect(now.has(card.card_id)).toBe(false);
    for (const [old, next] of draft.diff?.changed ?? []) expect(old).not.toEqual(next);
    expect((await rules()).active).toEqual(before.active);
    expect((await confirm(draft.version)).status).toBe(200);
    const after = await rules();
    expect(after.preset).toBe(preset);
    expect(after.tools.find((row) => row.tool === 'desk.emergency-callback')).toEqual(before.tools.find((row) => row.tool === 'desk.emergency-callback'));
  });

  it('preset_drafts_recommended_rules_in_the_desks_own_hours', async () => {
    // Turner's Desk keeps 8:00 to 18:00 on weekdays and 9:00 to 13:00 on Saturdays: its "Recommended
    // rules" book weekdays 8 to 6, as the API drafts them, and Saturday bookings ask first.
    const preset = async () => (await call('draftPreset', { params: { desk_id: deskId }, body: { preset: 'auto' } })).body as RulesDraft;
    const bookings = (cards: readonly RuleCard[]) => cards.filter((card) => card.applies_to === 'native.book');
    const [shipped] = bookings(PRESETS.auto);
    if (shipped === undefined) throw new Error('"Recommended rules" books weekdays');
    const draft = await preset();
    // Its weekday card is Turner's own weekday rule, words included, in all but its id.
    const reason = 'Weekday bookings in opening hours, checked by the reviewer.';
    expect(bookings(draft.cards)).toEqual([{ ...shipped, hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00:00', end: '18:00:00' }, reason }]);
    const urgent = (await rules()).active.cards.find((card) => card.card_id === 'rv-urgent');
    expect(draft.cards).toEqual([...PRESETS.auto.map((card) => (card === shipped ? { ...shipped, hours: RIVERA_HOURS[0], reason } : card)), urgent]);
    expect(bookings(draft.cards)).toEqual([{ ...rivera.ruleCards['rv-book-wk'], card_id: 'preset-book-weekday' }]);
    expect((await confirm(draft.version)).status).toBe(200);
    expect((await rules()).preset).toBe('auto');

    // A Desk with no hours books weekdays 9 to 5: the preset's cards as they are.
    mockStore.reset('rivera');
    const desk = mockStore.world.desk(deskId);
    if (desk === undefined) throw new Error("Turner's Desk is in the copy");
    desk.summary.hours = [];
    expect((await rules()).preset).toBeNull();
    const fallback = await preset();
    expect(fallback.cards).toEqual([...PRESETS.auto, urgent]);
    expect((await confirm(fallback.version)).status).toBe(200);
    expect((await rules()).preset).toBe('auto');
  });

  it('preset_cards_match_the_apis', () => {
    // The mock drafts a preset as the API does (`desk.api.rules.preset_cards`): a booking card per
    // weekday window, numbered by first day and then hours, none for hours only at weekends, and the
    // presets' cards as they are for no hours at all or exactly 9 to 5.
    const window = (days: HoursWindow['days'], start: string, end: string): HoursWindow => ({ days, start, end });
    const bookings = (hours: HoursWindow[]) => presetCards('auto', hours).filter((card) => card.applies_to === 'native.book').map((card) => [card.card_id, card.hours]);
    const monToThu = window(['mon', 'tue', 'wed', 'thu'], '08:00:00', '18:00:00');
    const friday = window(['fri'], '08:00:00', '16:00:00');
    expect(bookings([friday, window(['sat'], '09:00:00', '13:00:00'), monToThu])).toEqual([
      ['preset-book-weekday-1', monToThu],
      ['preset-book-weekday-2', friday],
    ]);
    expect(bookings([window(['thu', 'fri'], '08:00:00', '18:00:00'), window(['sun', 'wed', 'tue', 'mon'], '08:00:00', '18:00:00')])).toEqual([
      ['preset-book-weekday', window(['mon', 'tue', 'wed', 'thu', 'fri'], '08:00:00', '18:00:00')],
    ]);
    expect(bookings([window(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], '00:00:00', '00:00:00')])).toEqual([
      ['preset-book-weekday', window(['mon', 'tue', 'wed', 'thu', 'fri'], '00:00:00', '00:00:00')],
    ]);
    for (const hours of [[], [window(['mon', 'tue'], '09:00:00', '17:00:00'), window(['wed', 'thu', 'fri', 'sat'], '09:00:00', '17:00:00')]]) {
      expect(presetCards('auto', hours)).toEqual(PRESETS.auto);
    }
    // Hours at weekends alone: no booking card, so weekday bookings ask first.
    for (const hours of [[window(['sat'], '09:00:00', '13:00:00')], [window(['sat', 'sun'], '10:00:00', '16:00:00')]]) {
      expect(presetCards('auto', hours)).toEqual(PRESETS.auto.filter((card) => card.applies_to !== 'native.book'));
    }
    expect(presetCards('ask_first', RIVERA_HOURS)).toEqual(PRESETS.ask_first);
  });

  it('rule_chat_answers_about_the_hold_a_question_names', async () => {
    const ask = async (text: string) => ((await call('ruleChat', { params: { desk_id: deskId }, body: { text } })).body as RuleChatOut).answer;
    const offer = "If you'd like requests like this to go through on their own, ask me to draft that rule.";
    const refund = mockStore.world.addHeldRefund();
    const record = mockStore.world.decisions.get(refund.decision_id);
    const main = mockStore.world.desk(deskId);
    if (!record || !main) throw new Error('Dana has a refund held on the main Desk');

    // Held by the refund rule: the request, the rule that held it, and an offer to draft one.
    expect(await ask('Why was this refund held?')).toBe(`${refund.reason_plain} It was held by your rule: Refunds to a customer wait for your answer. ${offer}`);

    // Held with no rule of the owner's deciding it: the kernel's own words for the default ask.
    record.decision.card_ids = [];
    expect(await ask('Why was this refund held?')).toBe(`${refund.reason_plain} Not covered by a rule yet, so it asks you. ${offer}`);

    // Above the payment limit, which no rule goes past: no offer to draft one, with a rule or without.
    main.policy.auto_money_cap_cents = 10_000;
    expect(await ask('Why was this refund held?')).toBe(`${refund.reason_plain} Not covered by a rule yet, so it asks you.`);
    record.decision.card_ids = ['rv-refund'];
    expect(await ask('Why was this refund held?')).toBe(`${refund.reason_plain} It was held by your rule: Refunds to a customer wait for your answer.`);
  });

  it('knowledge_seed_returns_every_generated_row_field', async () => {
    const answer = await call('knowledge', { params: { desk_id: deskId } });
    expect(answer.status).toBe(200);
    const rows = answer.body as KnowledgeRow[];
    expect(rows.map((row) => row.item_id)).toEqual(['kn-website', 'kn-price-list']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'item_id', 'readers', 'source', 'text', 'title']);
      expect(row.readers).toEqual(['public']);
      expect(row.title).toEqual(expect.any(String));
      expect(row.text).toEqual(expect.any(String));
      expect(row.created_at).toEqual(expect.any(String));
    }
    expect(rows.map((row) => row.source)).toEqual(['website', 'setup']);
    expect(Date.parse(rows[0]!.created_at!)).toBeLessThan(Date.parse(rows[1]!.created_at!));
  });

  it('knowledge_lists_legacy_items_first_then_timestamp_and_item_id', async () => {
    mockStore.world.knowledge.clear();
    const item: KnowledgeItem = { item_id: 'kn-legacy', source: 'setup', title: 'An older note', text: 'An older note', label: { readers: ['owner'] } };
    const at = Date.parse('2026-10-30T19:30:00Z');
    // Insert out of order, including a pre-epoch date, so null cannot sort as zero. Ties use the
    // item's id rather than the host locale's collation.
    for (const [itemId, createdAt] of [['kn-a', at], ['kn-legacy', null], ['kn-Z', at], ['kn-oldest', -1], ['kn-A-legacy', null]] as const) {
      mockStore.world.knowledge.set(`${deskId}:${itemId}`, { deskId, item: { ...item, item_id: itemId }, createdAt, forced: false });
    }
    const list = () => call('knowledge', { params: { desk_id: deskId } });
    const rows = (await list()).body as KnowledgeRow[];
    expect(rows.map((row) => row.item_id)).toEqual(['kn-A-legacy', 'kn-legacy', 'kn-oldest', 'kn-Z', 'kn-a']);
    expect(rows.map((row) => row.created_at)).toEqual([null, null, '1969-12-31T23:59:59.999000Z', '2026-10-30T19:30:00.000000Z', '2026-10-30T19:30:00.000000Z']);

    // Updating readers preserves the original timestamp, including an unknown one.
    await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, label: { readers: ['public'] } } } });
    expect(((await list()).body as typeof rows).find((row) => row.item_id === item.item_id)?.created_at).toBeNull();
  });

  it('knowledge_refuses_invalid_readers', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    for (const readers of [[], ['public', 'owner'], ['owner', 'owner'], ['person:p-1'], ['session:s-1'], ['stranger']]) {
      expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, label: { readers } } } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
      expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    }
    for (const readers of [['owner'], ['public']]) {
      expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, label: { readers } } } })).status).toBe(200);
    }
  });

  it('knowledge_refuses_a_record_owner', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'], record_owner: 'person-1' } };
    const before = [...mockStore.world.knowledge.entries()];
    expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
    expect([...mockStore.world.knowledge.entries()]).toEqual(before);
  });

  it('knowledge_refuses_invalid_item_ids', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    for (const item_id of ['', 'bad.id', 'bad/id', 'é', 'a'.repeat(65), 'note\n']) {
      expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, item_id } } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
      expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    }
    expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, item_id: 'A_0-'.repeat(16) } } })).status).toBe(200);
  });

  it('knowledge_caps_titles_at_200_characters', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: '🔧'.repeat(201), text: 'Parking is on the street.', label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
    expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, title: '🔧'.repeat(200) } } })).status).toBe(200);
  });

  it('knowledge_caps_text_at_100_kib_utf8', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: '🔧'.repeat(25 * 1024 + 1), label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    const refused = await call('addKnowledge', { params: { desk_id: deskId }, body: { item } });
    expect({ status: refused.status, body: refused.status === 422 ? refused.body : undefined }).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
    expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, text: '🔧'.repeat(25 * 1024) } } })).status).toBe(200);
  });

  it('knowledge_refuses_nul_in_title_or_text', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    for (const field of ['title', 'text']) {
      expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, [field]: 'Parking\0' } } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
      expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    }
  });

  it('knowledge_refuses_unpaired_surrogates', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'] } };
    const before = [...mockStore.world.knowledge.entries()];
    for (const field of ['title', 'text']) {
      for (const text of ['\ud800', '\udc00']) {
        expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, [field]: text } } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
        expect([...mockStore.world.knowledge.entries()]).toEqual(before);
      }
    }
  });

  it('knowledge_validates_title_and_text_utf8_separately', async () => {
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: '\ud800', text: '\udc00', label: { readers: ['owner'] } };
    expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
  });

  it('knowledge_caps_each_desk_at_200_items_but_allows_replacements', async () => {
    mockStore.world.knowledge.clear();
    const item: KnowledgeItem = { item_id: 'note-valid', source: 'setup', title: 'Parking is on the street.', text: 'Parking is on the street.', label: { readers: ['owner'] } };
    for (let i = 0; i < 200; i++) {
      mockStore.world.knowledge.set(`${deskId}:note-${i}`, { deskId, item: { ...item, item_id: `note-${i}` }, createdAt: i, forced: false });
    }
    const before = [...mockStore.world.knowledge.entries()];
    expect(await call('addKnowledge', { params: { desk_id: deskId }, body: { item } })).toEqual({ status: 422, body: { error: 'kernel', code: 'invalid' } });
    expect([...mockStore.world.knowledge.entries()]).toEqual(before);
    expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item: { ...item, item_id: 'note-0', label: { readers: ['public'] } } } })).status).toBe(200);
    expect(mockStore.world.knowledge.size).toBe(200);
    // A different Desk's items do not count against this Desk.
    const first = mockStore.world.knowledge.get(`${deskId}:note-0`)!;
    mockStore.world.knowledge.delete(`${deskId}:note-0`);
    mockStore.world.knowledge.set('desk-other:note-0', { ...first, deskId: 'desk-other' });
    expect((await call('addKnowledge', { params: { desk_id: deskId }, body: { item } })).status).toBe(200);
  });

  it('knowledge_answers_what_the_kernel_keeps', async () => {
    mockStore.world.knowledge.clear();
    const note: KnowledgeItem = {
      item_id: 'note-0f2c',
      source: 'setup',
      title: 'We don’t service tankless water heaters older than 15 years.',
      text: 'We don’t service tankless water heaters older than 15 years. Suggest a replacement quote instead.',
      label: { readers: ['owner'] },
    };
    const add = (item: unknown) => call('addKnowledge', { params: { desk_id: deskId }, body: { item } });

    // Stored as posted, and answered with the stored item, which is a contract KnowledgeItem: its
    // label with every field, as the API sends it.
    const labelled = (readers: string[]) => ({ ...note, label: { readers, record_owner: null } });
    const kept = await add(note);
    expect(kept).toEqual({ status: 200, body: labelled(['owner']) });
    expect(validateContract('KnowledgeItem', kept.body)).toEqual([]);
    // Posted again under its id with the public label: it replaces the item, and says so.
    expect((await add({ ...note, label: { readers: ['public'] } })).body).toEqual(labelled(['public']));
    expect([...mockStore.world.knowledge.values()].map((stored) => stored.item.label.readers)).toEqual([['public']]);

    // The kernel keeps an item to the owner whatever it's posted with, when a test says it does.
    mockStore.world.keepsKnowledgeOwnerOnly = (item) => item.item_id === note.item_id;
    const forced = await add({ ...note, label: { readers: ['public'] } });
    expect(forced.body).toEqual(labelled(['owner']));
    expect(validateContract('KnowledgeItem', forced.body)).toEqual([]);

    // Listed, with when it was first added: one the kernel keeps to the owner has its words withheld.
    const listed = await call('knowledge', { params: { desk_id: deskId } });
    const { label: _label, ...words } = note;
    expect(listed).toEqual({ status: 200, body: [{ ...words, readers: ['owner'], title: null, text: null, created_at: expect.any(String) }] });
    mockStore.world.keepsKnowledgeOwnerOnly = () => false;
    await add({ ...note, label: { readers: ['public'] } });
    expect((await call('knowledge', { params: { desk_id: deskId } })).body).toEqual([{ ...words, readers: ['public'], created_at: (listed.body as KnowledgeRow[])[0]?.created_at }]);

    // Not an item: refused, nothing stored.
    for (const bad of [undefined, { ...note, title: 3 }, { ...note, label: { readers: 'public' } }, { ...note, source: 'gossip' }, { ...note, item_id: '' }]) {
      expect((await add(bad)).status).toBe(422);
    }
    expect(mockStore.world.knowledge.size).toBe(1);

    // Another copy's owner reaches none of it.
    mockStore.reset('rivera', { signedIn: false });
    expect((await add(note)).status).toBe(401);
  });

  it('people_mark_replayed_leads', async () => {
    // A test adds leads as the kernel keeps them: one from the recorded history, one live.
    const at = mockStore.world.now();
    const lead = { deskId, sessionId: 'ses-lead', note: 'Wants a quote to replace a kitchen faucet.', createdAt: at };
    mockStore.world.leads.push({ ...lead, leadId: 'lead-recorded', displayName: 'Jordan Pike', replayed: true });
    mockStore.world.leads.push({ ...lead, leadId: 'lead-live', displayName: 'Sam Ortiz' });

    const people = (await call('people', { params: { desk_id: deskId } })).body as PeopleOut;
    const byId = new Map(people.leads.map((row) => [row.lead_id, row]));
    // Only the replayed one says so; a live lead leaves the flag out, as the API does until it has one.
    expect(byId.get('lead-recorded')).toMatchObject({ display_name: 'Jordan Pike', replayed: true });
    expect(byId.get('lead-live')).toEqual({ lead_id: 'lead-live', display_name: 'Sam Ortiz', note: lead.note, created_at: expect.any(String) });
  });

  it('draft_rules_hold_only_money_rules_to_the_payment_limit', async () => {
    const draft = (card: unknown) => call('draftRules', { params: { desk_id: deskId }, body: { add: [card] } });
    // A $600 limit on an automatic quote rule moves no money, so Turner's $500 payment limit doesn't hold it back.
    const quote600 = { ...rivera.ruleCards['rv-quote'], max_amount_cents: 60_000 };
    const quoted = await draft(quote600);
    expect(quoted.status).toBe(200);
    expect(quoted.body as RulesDraft).toMatchObject({ version: 8, diff: { changed: [[rivera.ruleCards['rv-quote'], quote600]] } });

    // An automatic payment link above it is refused with the limit, and nothing is drafted.
    const link600 = { ...rivera.ruleCards['rv-link'], max_amount_cents: 60_000 };
    expect(await draft(link600)).toEqual({ status: 422, body: { error: 'above_money_cap', cap_cents: 50_000 } });
    // Asking first above it takes no money on its own, so it drafts.
    expect((await draft({ ...link600, mode: 'ask' })).status).toBe(200);
    expect((await rules()).active.version).toBe(7);
  });

  it('money_cap_draft_lowers_each_money_rule_above_it_and_says_the_new_limit', async () => {
    // As the API's money-limit route drafts it (desk.api.rules.draft_money_cap through
    // desk.money_cap.lower_to_cap, in English): Turner's limit is $500, with an automatic payment
    // link up to $300 (`rv-link`) and visiting agents' deposits up to $20 (`rv-mandate`).
    const draftCap = (body: unknown) => call('draftMoneyCap', { params: { desk_id: deskId }, body });
    const link = rivera.ruleCards['rv-link'];
    const mandate = rivera.ruleCards['rv-mandate'];

    // Lowered to $100, the $300 link comes down to it, its reason replaced whole by the sentence
    // for the new limit; the $20 deposit already fits and keeps its own.
    const lowered = (await draftCap({ auto_money_cap_cents: 10_000 })).body as RulesDraft;
    expect(lowered.auto_money_cap_cents).toBe(10_000);
    expect(lowered.diff).toEqual({ added: [], removed: [], changed: [[link, { ...link, max_amount_cents: 10_000, reason: 'Up to $100, your payment limit.' }]] });
    expect(lowered.cards.find((card) => card.card_id === mandate.card_id)).toEqual(mandate);

    // At $0 each one asks instead, and says so, and the summary lists each reason once, as the
    // API's `rules_draft` does: the two lowered cards are one line.
    const zero = (await draftCap({ auto_money_cap_cents: 0 })).body as RulesDraft;
    const asks = { mode: 'ask', max_amount_cents: null, max_discount_bp: 0, hours: null, review: false, reason: 'Your payment limit is $0.' } as const;
    expect(zero.diff?.changed).toEqual([
      [link, { ...link, ...asks }],
      [mandate, { ...mandate, ...asks }],
    ]);
    expect(zero.summary?.asks_you).toEqual(['Your payment limit is $0.', rivera.ruleCards['rv-refund'].reason]);

    // Raised to $800, no rule changes.
    const raised = (await draftCap({ auto_money_cap_cents: 80_000 })).body as RulesDraft;
    expect(raised).toMatchObject({ auto_money_cap_cents: 80_000, diff: { added: [], removed: [], changed: [] } });

    // The API's refusals, with its test's bodies: above the $10,000 ceiling, anything but a whole
    // number of cents from 0 (its 500.0 parses as 500 here, so 500.5 stands in for it), or a field
    // the body doesn't have, which its model forbids.
    const refused: [unknown, string][] = [
      [{ auto_money_cap_cents: 1_000_001 }, 'above_platform_ceiling'],
      [{ auto_money_cap_cents: -1 }, 'invalid'],
      [{ auto_money_cap_cents: 500.5 }, 'invalid'],
      [{ auto_money_cap_cents: '500' }, 'invalid'],
      [{ auto_money_cap_cents: true }, 'invalid'],
      [{}, 'invalid'],
      [{ auto_money_cap_cents: 500, cards: [] }, 'invalid'],
    ];
    for (const [body, error] of refused) expect(await draftCap(body), JSON.stringify(body)).toEqual({ status: 422, body: { error } });
    expect((await draftCap({ auto_money_cap_cents: 1_000_000 })).status).toBe(200);
    // Nothing applies until the owner confirms a draft.
    expect((await rules()).active).toMatchObject({ version: 7, auto_money_cap_cents: 50_000 });
  });

  it('confirm_tool_takes_the_batch_body', async () => {
    const stripe = ['payments.list_charges', 'payments.create_refund'];
    const entries = async () => Promise.all(stripe.map(async (tool) => ({ tool, definition_sha256: await hashOf(tool) })));

    // The old one-tool body, an empty list or a tool named twice is not a batch.
    expect((await confirmTools({ tool: 'payments.create_refund', enable: false, definition_sha256: await hashOf('payments.create_refund') })).status).toBe(422);
    expect((await confirmTools({ tools: [], enable: false })).status).toBe(422);
    const [charges] = await entries();
    expect((await confirmTools({ tools: [charges, charges], enable: false })).status).toBe(422);
    expect((await confirmTools({ tools: [{ tool: 'calendar.free_busy', definition_sha256: 'x' }], enable: false })).status).toBe(404);

    // Turning a connector off applies at once, with no draft. The answer lists every tool of the
    // batch as it stands now, in the request's order.
    const listed = await entries();
    const off = await confirmTools({ tools: [...listed].reverse(), enable: false });
    expect(off.status).toBe(200);
    expect((off.body as ToolConfirmedOut).draft).toBeNull();
    expect((off.body as ToolConfirmedOut).profiles).toMatchObject([
      { tool: 'payments.create_refund', status: 'disabled' },
      { tool: 'payments.list_charges', status: 'disabled' },
    ]);
    for (const tool of stripe) expect(await statusOf(tool)).toBe('disabled');
    expect((await rules()).active.version).toBe(7);

    // Verification can't be turned off: the kernel refuses it, and nothing changes.
    const verify = { tool: 'native.start_verification', definition_sha256: await hashOf('native.start_verification') };
    expect(await confirmTools({ tools: [verify], enable: false })).toEqual({ status: 409, body: { error: 'kernel', code: 'conflict' } });
    expect(await statusOf('native.start_verification')).toBe('enabled');

    // Turning it back on names the listed hashes and drafts one version for the group, which applies
    // only when that draft is confirmed. Another hash is refused.
    expect((await confirmTools({ tools: [{ ...listed[0], definition_sha256: 'f'.repeat(64) }], enable: true })).status).toBe(409);
    const on = await confirmTools({ tools: listed, enable: true });
    expect(on.status).toBe(200);
    // Still off: the draft hasn't been confirmed.
    expect((on.body as ToolConfirmedOut).profiles.map(({ tool, status }) => ({ tool, status }))).toEqual([
      { tool: 'payments.list_charges', status: 'disabled' },
      { tool: 'payments.create_refund', status: 'disabled' },
    ]);
    const draft = (on.body as ToolConfirmedOut).draft;
    expect(draft).toMatchObject({ version: 8, parent_version: 7, status: 'proved', auto_money_cap_cents: 50_000, proof: { ok: true, method: 'symcc' } });
    expect(draft?.cards).toEqual((await rules()).active.cards);
    for (const tool of stripe) expect(await statusOf(tool)).toBe('disabled');
    expect((await confirm(8)).status).toBe(200);
    for (const tool of stripe) expect(await statusOf(tool)).toBe('enabled');

    // A tool already on at its hash needs no draft.
    const again = await confirmTools({ tools: [verify], enable: true });
    expect(again.status).toBe(200);
    expect((again.body as ToolConfirmedOut).draft).toBeNull();
    expect((again.body as ToolConfirmedOut).profiles).toMatchObject([{ tool: 'native.start_verification', status: 'enabled' }]);
  });

  /** The connector changes `tool`'s definition to one hashed `sha`: it waits for the owner's review, and says why. */
  const drift = (tool: string, sha: string) => {
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the mock has the main Desk');
    desk.tools = desk.tools.map((row) =>
      row.tool === tool ? { ...row, status: 'needs_review', pending_definition_text: `Changed ${sha[0]}`, pending_sha256: sha, review_reason: 'changed' } : row,
    );
  };
  const rowOf = async (tool: string) => (await rules()).tools.find((row) => row.tool === tool);

  it('changed_tool_confirms_only_its_pending_hash', async () => {
    const refund = 'payments.create_refund';
    const old = await hashOf(refund);
    drift(refund, 'e'.repeat(64));

    // The definition the owner reviewed is the changed one: the old hash is refused, and nothing is drafted.
    expect(await confirmTools({ tools: [{ tool: refund, definition_sha256: old }], enable: true })).toEqual({ status: 409, body: { error: 'kernel', code: 'conflict' } });
    expect(mockStore.world.desk(deskId)?.drafts.size).toBe(0);

    // The changed definition's hash drafts a version that turns it on at that hash.
    const on = await confirmTools({ tools: [{ tool: refund, definition_sha256: 'e'.repeat(64) }], enable: true });
    expect(on.status).toBe(200);
    const version = (on.body as ToolConfirmedOut).draft?.version;
    expect(await rowOf(refund)).toMatchObject({ status: 'needs_review', definition_sha256: old, pending_sha256: 'e'.repeat(64), review_reason: 'changed' });
    expect((await confirm(version)).status).toBe(200);
    expect(await rowOf(refund)).toMatchObject({ status: 'enabled', definition_sha256: 'e'.repeat(64), pending_sha256: null, pending_definition_text: null, review_reason: null });
  });

  it('second_drift_blocks_the_pending_confirm', async () => {
    const refund = 'payments.create_refund';
    const old = await hashOf(refund);
    drift(refund, 'e'.repeat(64));
    const on = await confirmTools({ tools: [{ tool: refund, definition_sha256: 'e'.repeat(64) }], enable: true });
    const version = (on.body as ToolConfirmedOut).draft?.version;

    // The definition changes again before the owner confirms: the draft names a hash that is no
    // longer listed, so the kernel refuses it and the tool stays off, waiting for the new review.
    // The API answers that refusal as it answers every kernel 409 on confirm.
    drift(refund, 'a'.repeat(64));
    expect(await confirm(version)).toEqual({ status: 409, body: { error: 'rules_changed_since_draft' } });
    expect((await rules()).active.version).toBe(7);
    expect(await rowOf(refund)).toMatchObject({ status: 'needs_review', definition_sha256: old, pending_sha256: 'a'.repeat(64) });

    // A tool turned back on from off is refused the same way when its definition changed since.
    const charges = 'payments.list_charges';
    const listed = await hashOf(charges);
    expect((await confirmTools({ tools: [{ tool: charges, definition_sha256: listed }], enable: false })).status).toBe(200);
    const back = await confirmTools({ tools: [{ tool: charges, definition_sha256: listed }], enable: true });
    drift(charges, 'b'.repeat(64));
    expect(await confirm((back.body as ToolConfirmedOut).draft?.version)).toEqual({ status: 409, body: { error: 'rules_changed_since_draft' } });
    expect(await rowOf(charges)).toMatchObject({ status: 'needs_review', pending_sha256: 'b'.repeat(64), review_reason: 'changed' });

    // Kept off with the changed definition's hash: off at once, so it no longer waits for review
    // and gives no reason, while the changed definition stays for a later review.
    expect((await confirmTools({ tools: [{ tool: charges, definition_sha256: 'b'.repeat(64) }], enable: false })).status).toBe(200);
    expect(await rowOf(charges)).toMatchObject({ status: 'disabled', pending_sha256: 'b'.repeat(64), review_reason: null });
  });
});

describe('deleting a Desk', () => {
  it('delete_desk_closes_its_page_and_chats', async () => {
    // Turner's main Desk, with a chat Claude is writing in when the Desk goes, and the seeded chats idle.
    mockStore.reset('rivera_two_desks');
    const { events } = await openChat();
    await send('How much is drain clearing?');
    await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 2);
    expect(typesOf(events)).toEqual(['writing', 'receipt']);
    const seeded = mockStore.world.sessionsOf(deskId).filter((s) => s !== mockStore.visitorSession(slug));
    expect(seeded.length).toBeGreaterThan(0);

    // Answered 204, with nothing to say.
    expect(await call('deleteDesk', { params: { desk_id: deskId } })).toEqual({ status: 204, body: undefined });

    // The copy's other Desk stays; this one is gone from the owner's Desks and its pages.
    const desks = async () => ((await call('me')).body as CopyOut).desks.map((d) => d.desk_id);
    expect(await desks()).toEqual([RIVERA.emergenciesDeskId]);
    expect((await call('today', { params: { desk_id: deskId } })).status).toBe(404);
    // Each of its chats hears that its session ended, as a closed session ends a visitor's turn; the
    // turn in flight ends there and says nothing more, so the chat no longer shows Claude writing.
    expect(typesOf(events)).toEqual(['writing', 'receipt', 'error', 'turn_end']);
    expect(events[2]?.[1]).toEqual({ type: 'error', code: 'session' });
    const chat = events.reduce((state, [seq, ev]) => chatReducer(state, { type: 'event', seq, ev }), initialChatState());
    expect(chat).toMatchObject({ writing: false, error: 'session' });
    for (const session of seeded) expect(session.events.at(-1)?.ev).toEqual({ type: 'error', code: 'session' });
    // Its public link stops working, and so do its chats.
    expect((await call('publicDesk', { params: { slug } })).status).toBe(404);
    expect((await call('sendMessage', { params: { slug }, body: { text: 'Hello?' } })).status).toBe(404);
    await drain();
    expect(typesOf(events)).toEqual(['writing', 'receipt', 'error', 'turn_end']);
    expect((await call('publicDesk', { params: { slug: RIVERA.emergenciesSlug } })).status).toBe(200);

    // Deleting it again, or a Desk outside the copy, is not found; without the owner cookie, refused.
    expect((await call('deleteDesk', { params: { desk_id: deskId } })).status).toBe(404);
    expect((await call('deleteDesk', { params: { desk_id: 'desk-elsewhere' } })).status).toBe(404);
    mockStore.reset('rivera_two_desks', { signedIn: false });
    expect((await call('deleteDesk', { params: { desk_id: deskId } })).status).toBe(401);
    mockStore.reset('rivera_two_desks');
    expect(await desks()).toEqual([deskId, RIVERA.emergenciesDeskId]);
  });

  it('deleted_desk_chats_answer_closed', async () => {
    // A chat on the main Desk with a callback request in it, and the seeded hold, when the Desk goes.
    mockStore.reset('rivera_two_desks');
    const { session } = await openChat();
    await send('Can you call me back?');
    await drain();
    const handoff = [...mockStore.world.handoffs.values()].find((record) => record.handoff.session_id === session.session_id);
    const held = [...mockStore.world.decisions.values()].find((record) => record.deskId === deskId && record.decision.state === 'held');
    if (!handoff || !held) throw new Error('the chat has a callback request and the Desk a hold');
    const record = mockStore.visitorSession(slug);
    expect((await call('deleteDesk', { params: { desk_id: deskId } })).status).toBe(204);

    // Whatever an owner tab still open on it sends about its chats, a decision or a callback request
    // in them is refused as the kernel refuses a deleted Desk's: 409 `closed`, and nothing changes.
    const closed = { status: 409, body: { error: 'kernel', code: 'closed' } };
    const params = { session_id: session.session_id };
    const at = { params, body: { generation: session.generation } };
    for (const key of ['takeover', 'handback', 'resume', 'ownerTyping'] as const) expect(await call(key, at), key).toEqual(closed);
    for (const kind of ['whisper', 'say']) expect(await call('ownerMessage', { params, body: { text: 'Still there?', kind } }), kind).toEqual(closed);
    expect(await call('conversation', { params })).toEqual(closed);
    expect(await call('decision', { params: { decision_id: held.decision.decision_id } })).toEqual(closed);
    expect(await call('handoffDone', { params: { handoff_id: handoff.handoff.handoff_id } })).toEqual(closed);
    expect(record?.state).toEqual(session);
    expect(record?.items.map((item) => item.kind)).not.toContain('whisper');
    expect(handoff.handoff.status).toBe('open');
    expect(held.decision.state).toBe('held');

    // The copy's other Desk's chats still take them.
    const emergencies = mockStore.world.desk(RIVERA.emergenciesDeskId);
    if (!emergencies) throw new Error('the copy has its other Desk');
    const other = mockStore.world.addSession(emergencies);
    const otherAt = { params: { session_id: other.state.session_id }, body: { generation: other.state.generation } };
    expect((await call('takeover', otherAt)).status).toBe(200);
  });

  it('deleted_desk_holds_are_refused_at_execution', async () => {
    // Dana's refund and the seeded 15% quote are held for Mike when the Desk goes.
    mockStore.reset('rivera_two_desks');
    const refund = mockStore.world.addHeldRefund();
    const quote = [...mockStore.world.decisions.values()].find(
      (record) => record.deskId === deskId && record.decision.state === 'held' && record.decision.decision_id !== refund.decision_id,
    );
    const chat = mockStore.world.sessions.get(refund.session_id);
    if (!quote || !chat) throw new Error('the Desk has two holds, and the refund a chat');
    expect((await call('deleteDesk', { params: { desk_id: deskId } })).status).toBe(204);
    const heard = chat.events.length;

    // Allowed now, the refund doesn't run: the kernel's check at execution refuses a deleted Desk's
    // action. No card is drafted for a Desk that's gone.
    const allowed = await call('answer', { params: { decision_id: refund.decision_id }, body: { answer: 'allow_once' } });
    expect(allowed).toEqual({
      status: 200,
      body: {
        decision: expect.objectContaining({
          decision_id: refund.decision_id,
          state: 'refused_at_execution',
          visitor_plain: VISITOR_PLAIN.en.refused_at_execution,
          inbox: [],
        }) as unknown,
        execution_state: null,
        card_diff: null,
      },
    });
    // Denied, the quote is denied: there is nothing to run.
    const denied = await call('answer', { params: { decision_id: quote.decision.decision_id }, body: { answer: 'deny_once' } });
    expect(denied).toMatchObject({ status: 200, body: { decision: { state: 'denied' }, execution_state: null, card_diff: null } });
    // Each is answered once; another answer is refused as it always is, with the decision as it stands.
    const again = await call('answer', { params: { decision_id: refund.decision_id }, body: { answer: 'allow_once' } });
    expect(again).toMatchObject({ status: 409, body: { error: 'already_resolved', decision: { state: 'refused_at_execution' } } });

    // The closed chat hears nothing more, and no follow-up turn runs.
    await drain();
    expect(chat.events).toHaveLength(heard);
  });

  it('deleted_desk_payment_links_are_cancelled', async () => {
    // The visitor asked for the deposit link on the main Desk, and has it open, when the Desk goes.
    // A link on the copy's other Desk is open too.
    mockStore.reset('rivera_two_desks');
    await openChat();
    await send('Can I pay the deposit?');
    await drain();
    const [token, link] = [...mockStore.world.links].find(([, l]) => l.deskId === deskId) ?? [];
    const emergencies = mockStore.world.desk(RIVERA.emergenciesDeskId);
    if (token === undefined || !link || !emergencies) throw new Error('the main Desk issued a link, and the copy has its other Desk');
    const elsewhere = mockStore.world.issueLink(mockStore.world.addSession(emergencies), { title: 'Call-out', amountCents: 5000, language: 'en' });
    expect(link.view.state).toBe('issued');
    expect((await call('deleteDesk', { params: { desk_id: deskId } })).status).toBe(204);

    // Its open link goes with it, as the kernel cancels a deleted Desk's open links: the checkout
    // reads it cancelled, with no reason to give and no customer's name.
    expect(link.view.state).toBe('cancelled');
    expect(await call('paymentLink', { params: { token } })).toMatchObject({
      status: 200,
      body: { state: 'cancelled', cancel_reason: null, customer_name: null },
    });
    // Paying it now, or cancelling it, is refused with the state it's in, and changes nothing.
    const refused = { status: 409, body: { error: 'kernel', code: 'conflict', state: 'cancelled', cancel_reason: null } };
    expect(await call('completePayment', { params: { token } })).toEqual(refused);
    expect(await call('cancelPayment', { params: { token } })).toEqual(refused);
    expect(link.view.state).toBe('cancelled');

    // The other Desk's link is still open, and can be paid.
    expect(mockStore.world.links.get(elsewhere)?.view.state).toBe('issued');
    expect(await call('completePayment', { params: { token: elsewhere } })).toMatchObject({ status: 200, body: { state: 'paid' } });
  });
});

describe('planted faults', () => {
  const answering = async () => ((await call('me')).body as CopyOut).desks[0]?.answering;

  it('held_answer_waits_for_its_release', async () => {
    // A test holds a request in flight and lets it land when it chooses, with no clock involved.
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStore.inject({ route: 'people', status: 200, until, body: { people: [], leads: [] } });
    let landed = false;
    const answer = call('people', { params: { desk_id: deskId } }).then((a) => {
      landed = true;
      return a;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(landed).toBe(false);
    release();
    expect(await answer).toEqual({ status: 200, body: { people: [], leads: [] } });

    // One held past the end of its epoch changes nothing and is dropped.
    let late = () => {};
    mockStore.inject({ route: 'people', status: 200, until: new Promise<void>((resolve) => (late = resolve)), body: { people: [], leads: [] } });
    const dropped = mockStore.dispatch('people', { params: { desk_id: deskId }, epoch: mockStore.epoch });
    mockStore.nextEpoch();
    late();
    expect(await dropped).toEqual({ network: true });
  });

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

    // `afterCommit`: the message is kept and Claude answers it, but its answer is lost. (Answering
    // is off from above, so Claude's answer is the handoff, with no quote.)
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
    expect(typesOf(events)).toEqual(['writing', 'message', 'turn_end']);

    // Every request is recorded with its body and path, faulted or not.
    expect(mockStore.requests.filter((r) => r.key === 'setAnswering')).toEqual([
      { key: 'setAnswering', body: { on: false }, path: `/api/owner/desks/${deskId}/answering` },
      { key: 'setAnswering', body: { on: false }, path: `/api/owner/desks/${deskId}/answering` },
    ]);
  });
});

describe('epochs', () => {
  it('request_from_an_earlier_epoch_is_dropped', async () => {
    // Sent in the last epoch (the last screen test), it reaches the store after this one began:
    // dropped like a lost connection, unrecorded, and the copy is unchanged.
    const sentIn = mockStore.epoch;
    mockStore.nextEpoch();
    expect(mockStore.admits(sentIn)).toBe(false);
    expect(await mockStore.dispatch('openSession', { params: { slug }, epoch: sentIn })).toEqual({ network: true });
    expect(mockStore.requests).toEqual([]);
    expect(mockStore.visitorSession(slug)).toBeNull();

    // Sent in this epoch, or with none as unit tests and the dev server send them: answered and recorded.
    expect(mockStore.admits(mockStore.epoch)).toBe(true);
    expect(mockStore.admits(undefined)).toBe(true);
    expect((await call('openSession', { params: { slug }, epoch: mockStore.epoch })).status).toBe(200);
    expect((await call('visitorSession', { params: { slug } })).status).toBe(200);
    expect(mockStore.requests.map((r) => r.key)).toEqual(['openSession', 'visitorSession']);
  });

  it('request_still_waiting_when_its_epoch_ends_changes_nothing', async () => {
    // A planted delay holds the answer past the end of its epoch; the route would otherwise apply it
    // to the next test's copy.
    mockStore.inject({ route: 'openSession', status: 200, delayMs: 1_000, afterCommit: true });
    const answer = mockStore.dispatch('openSession', { params: { slug } });
    mockStore.nextEpoch();
    mockStore.reset('rivera');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ network: true });
    expect(mockStore.visitorSession(slug)).toBeNull();
  });
});

describe('Safety triage', () => {
  it('describes_the_seeded_stopped_reply_as_wording', async () => {
    const entries = (await call('safety', { params: { desk_id: deskId } })).body as Attempt[];
    const reply = entries.find((entry) => entry.kind === 'reply_blocked');
    expect(reply?.triage).toEqual({
      category: 'wording',
      summary: 'The visitor asked for a discount. Claude’s draft stated the discount in its own words, so the Desk stopped the reply.',
    });
  });

  it('describes_the_demo_agents_over_limit_request_as_limits', async () => {
    await openChat();
    await call('sendAgent', { params: { slug }, body: { task: 'push_the_limit', idempotency_key: 'safety-limit' } });
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 4);
    const entries = (await call('safety', { params: { desk_id: deskId } })).body as Attempt[];
    expect(entries.find((entry) => entry.kind === 'refused')?.triage).toEqual({
      category: 'limits',
      summary: 'The agent asked to charge more than its signed limit. The Desk refused the charge.',
    });
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
      answers: 0,
      turned_down: 0,
      total: 0,
      newest: { turned_down: null, booking: null, lead_or_answer: null },
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

    // Turner's seed: Alex Kim's assistant, whose deposit Claude quoted and charged within its signed
    // limit; the held visitor, whose drafted reply was stopped; and Dana's chat, where Mike
    // whispered and Claude booked her at the quoted list price. The stopped draft is no request the
    // kernel refused, so the last 7 days count none stopped, and nothing in the briefing turned down:
    // the draft stays on Safety, out of the briefing.
    mockStore.reset('rivera');
    const seeded = await read();
    expect(seeded.this_week).toMatchObject({ bookings: 1, booked_cents: 18_000, conversations: 3, handled: 2, stepped_in: 1, stopped: 0 });
    expect(seeded.this_week.days.at(-1)).toEqual({ date: '2026-10-29', conversations: 3, bookings: 1, stopped: 0 });
    expect(seeded.briefing).toMatchObject({ conversations: 3, bookings: 1, leads: 0, answers: 1, turned_down: 0, total: 2 });
    expect(seeded.briefing.newest.turned_down).toBeNull();
    expect(seeded.briefing.newest.booking).toMatchObject({
      kind: 'booking',
      session_id: 'ses-dana-web',
      line: DECISIONS.book.reasonPlain,
      cause: null,
    });
    expect(seeded.briefing.newest.lead_or_answer).toMatchObject({
      kind: 'answer',
      session_id: 'ses-alex-agent',
      display_name: "Alex Kim's assistant",
      cause: null,
    });
    const blockedReply = mockStore.world.desks[0]?.ledger.find((e) => e.event.kind === 'reply' && e.event.summary.ok === false);
    const attempts = (await call('safety', { params: { desk_id: deskId } })).body as { kind: string; ref_id: string }[];
    expect(attempts.find((a) => a.kind === 'reply_blocked')?.ref_id).toBe(String(blockedReply?.seq));

    // Mike allows the seeded hold: he stepped into that chat, and a quote isn't a booking.
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])[0]?.decision;
    await call('answer', { params: { decision_id: held?.decision_id ?? '' }, body: { answer: 'allow_once' } });
    await drain();
    expect((await read()).this_week).toMatchObject({ bookings: 1, conversations: 3, handled: 1, stepped_in: 2 });

    // A visitor Claude answers, and Mike's own preview that Claude answers too: both count.
    await openChat();
    await send('Hello there');
    await drain();
    await call('openPreview', { params: { desk_id: deskId } });
    await send('Do you work weekends?');
    await drain();
    const both = await read();
    expect(both.this_week).toMatchObject({ conversations: 5, stepped_in: 2, handled: 3 });
    expect(both.briefing).toMatchObject({ conversations: 5, answers: 3, total: 4 });
    expect(both.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', display_name: null });

    // And a visitor who asks for a callback is a lead, not an answer.
    mockStore.reset('rivera');
    await openChat();
    await send('Can you call me back?');
    await drain();
    const withLead = await read();
    expect(withLead.briefing).toMatchObject({ leads: 1, answers: 1, total: 3 });
    expect(withLead.briefing.newest.lead_or_answer).toMatchObject({
      kind: 'lead',
      display_name: 'Dana Whitfield',
      line: '(510) 555-0118 · Leaking water heater',
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
      cause: null,
    });
    expect(answered.this_week).toMatchObject({ conversations: 5, stepped_in: 1, handled: 4 });

    // The full list, newest first, and the short form's rows are its own.
    const full = await list();
    expect(full.items.map((item) => item.kind)).toEqual(['answer', 'lead', 'booking', 'answer']);
    expect(full.items).toHaveLength(answered.briefing.total);
    // The answers counted are the list's own.
    expect(answered.briefing.answers).toBe(full.items.filter((item) => item.kind === 'answer').length);
    expect(full.items).toContainEqual(answered.briefing.newest.booking);
  });

  it('week_counts_refused_requests_only', async () => {
    // Turner's seed keeps one of Claude's drafts the reply check stopped, which nobody tried; then the
    // built-in agent tries to charge over its signed limit, which the kernel refuses. The last 7 days
    // and the briefing count the refusal alone, as the API does, and Safety keeps both.
    mockStore.reset('rivera');
    await openChat();
    const sent = await call('sendAgent', { params: { slug }, body: { task: 'push_the_limit', idempotency_key: 'key-1' } });
    expect(sent.status).toBe(202);
    const runId = (sent.body as { run_id: string }).run_id;
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 4);
    expect(((await call('agentRun', { params: { slug, run_id: runId } })).body as DemoAgentRun).state).toBe('done');

    const today = await read();
    expect(today.this_week.stopped).toBe(1);
    expect(today.this_week.days.map((d) => d.stopped)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(today.briefing.turned_down).toBe(1);
    const turnedDown = (await list()).items.filter((item) => item.kind === 'turned_down');
    expect(turnedDown).toEqual([today.briefing.newest.turned_down]);
    const refusal = [...mockStore.world.decisions.values()].find((d) => d.decision.state === 'refused')?.decision;
    // The kernel's own line, and the refusal's cause: over the agent's signed limit.
    expect(turnedDown[0]).toMatchObject({ ref_id: refusal?.decision_id, line: refusal?.reason_plain, cause: 'agent_limit' });
    const attempts = (await call('safety', { params: { desk_id: deskId } })).body as Attempt[];
    expect(attempts.map((a) => a.kind).sort()).toEqual(['refused', 'reply_blocked']);

    // Each refused entry carries the cause the API would give it, from the same facts: here the
    // baseline's signed-limit policy decided the refusal. A stopped draft has none.
    const refused = [...mockStore.world.decisions.values()].find((d) => d.decision.state === 'refused')?.decision;
    expect(refused?.policy_ids).toEqual(['B.agent_charge_within_mandate']);
    expect(attempts.find((a) => a.kind === 'refused')).toMatchObject({ ref_id: refused?.decision_id, cause: 'agent_limit' });
    expect(attempts.find((a) => a.kind === 'reply_blocked')?.cause).toBeNull();
  });

  /** A chat in the quiet copy, opened an hour ago with `turns` replayed as given, and its session. */
  const chatWith = (turns: ReplayTurn[]) => {
    mockStore.reset('rivera_quiet');
    const desk = mockStore.world.desks[0];
    if (!desk) throw new Error('the copy has its Desk');
    const at = NOW.getTime() - HOUR;
    const session = mockStore.world.at(at, () => mockStore.world.addSession(desk));
    mockStore.world.replay(session, at, turns);
    return session.state.session_id;
  };
  /** Safety's attempts, by kind. */
  const attemptKinds = async () => ((await call('safety', { params: { desk_id: deskId } })).body as { kind: string }[]).map((a) => a.kind);

  it('a_refusal_without_a_cause_and_any_other_outcome_have_none', async () => {
    // A refusal whose policies have no known cause reads as one the API can't place. A booking
    // has no cause even when its policy would identify a refusal's cause.
    chatWith([
      {
        text: 'Book me Tuesday at 2.',
        steps: [
          (ctx) => ctx.status('receipt', ctx.decide({ ...DECISIONS.book, outcome: 'refuse', executed: false, policyIds: ['B.unknown'], reasonPlain: 'That time is taken.' })),
          (ctx) => ctx.status('receipt', ctx.decide({ ...DECISIONS.book, policyIds: ['F.never.test'] })),
        ],
      },
    ]);
    const attempts = (await call('safety', { params: { desk_id: deskId } })).body as Attempt[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.cause).toBeNull();
    const items = (await list()).items;
    expect(items.map((item) => [item.kind, item.cause])).toEqual([
      ['booking', null],
      ['turned_down', null],
    ]);
    expect(items.find((item) => item.kind === 'turned_down')?.line).toBe('That time is taken.');
  });

  it('a_reply_delivered_after_a_stopped_draft_is_an_answer', async () => {
    // Claude's first draft put a price in its own words, so the check stopped it, and the rewrite
    // went out. The draft stays on Safety; in the briefing the chat is one Claude answered.
    const sessionId = chatWith([
      {
        text: 'How much is drain clearing?',
        steps: [
          (ctx) => {
            ctx.reply([proseBlock('It costs $1 today.')], { blocked: true });
            return ctx.reply([proseBlock('Drain clearing is on the price list.')]);
          },
        ],
      },
    ]);
    const today = await read();
    expect(today.briefing).toMatchObject({ conversations: 1, turned_down: 0, total: 1 });
    expect(today.briefing.newest.turned_down).toBeNull();
    expect(today.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', session_id: sessionId, ref_id: sessionId, line: null, cause: null });
    expect((await list()).items).toEqual([today.briefing.newest.lead_or_answer]);
    expect(await attemptKinds()).toEqual(['reply_blocked']);
  });

  it('a_handoff_after_stopped_drafts_makes_no_row', async () => {
    // Both of Claude's drafts were stopped and the visitor got the handoff clause: nobody was turned
    // down and Claude didn't answer, so the briefing has nothing for the chat. Safety keeps both drafts.
    chatWith([
      {
        text: 'How much is drain clearing?',
        steps: [
          (ctx) => {
            ctx.reply([proseBlock('It costs $1 today.')], { blocked: true });
            return ctx.reply([rivera.blocks.handoff[ctx.language]], { blocked: true });
          },
        ],
      },
    ]);
    const today = await read();
    expect(today.briefing).toMatchObject({ conversations: 1, bookings: 0, leads: 0, turned_down: 0, total: 0 });
    expect(today.briefing.newest).toEqual({ turned_down: null, booking: null, lead_or_answer: null });
    expect((await list()).items).toEqual([]);
    expect(await attemptKinds()).toEqual(['reply_blocked', 'reply_blocked']);
  });

  it('a_chat_that_ends_in_a_handoff_is_no_answer', async () => {
    // Claude answered first; a later draft was stopped and the visitor got the handoff clause. The
    // chat isn't one Claude answered alone, as the API counts it, so its earlier reply makes no row.
    chatWith([
      { text: 'Hello there', steps: [(ctx) => ctx.reply([proseBlock('Hi, how can I help?')])] },
      {
        text: 'How much is drain clearing?',
        steps: [
          (ctx) => {
            ctx.reply([proseBlock('It costs $1 today.')], { blocked: true });
            return ctx.reply([rivera.blocks.handoff[ctx.language]], { blocked: true });
          },
        ],
      },
    ]);
    const today = await read();
    expect(today.briefing).toMatchObject({ conversations: 1, turned_down: 0, total: 0 });
    expect((await list()).items).toEqual([]);
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

  it('reports_count_what_the_owner_stepped_into_in_their_days', async () => {
    // As the API counts the reports: over the last `days` local dates, today included (30 unless
    // asked), the conversations the owner stepped into needed her and Claude handled the rest, as
    // Today's last 7 days count them. A request held for her, or a chat the handoff card handed to
    // her, isn't one she stepped into until she answers, takes over, whispers or resumes it.
    mockStore.reset('rivera');
    const reports = async (days?: string) => {
      const answer = await call('reports', { params: { desk_id: deskId }, query: days === undefined ? {} : { days } });
      expect(answer.status, days).toBe(200);
      return answer.body as Reports;
    };
    const split = (r: Reports) => [r.handled_by_claude, r.needed_you];

    // The seeded copy as its last 7 days count it: Mike whispered in Dana's chat, and the held
    // request he hasn't answered is still Claude's.
    const week = (await read()).this_week;
    expect([week.handled, week.stepped_in]).toEqual([2, 1]);
    expect(split(await reports('7'))).toEqual([2, 1]);

    // Three days ago Mike whispered in a chat: it needed him in the last 7 days, but not today.
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the copy has its Desk');
    const at = NOW.getTime() - 3 * 24 * HOUR;
    const earlier = mockStore.world.at(at, () => mockStore.world.addSession(desk));
    mockStore.world.replay(earlier, at, [{ text: 'Is my water heater still covered?', whisper: 'Check the warranty first.', steps: [] }]);
    expect(split(await reports('1'))).toEqual([2, 1]);
    expect(split(await reports('7'))).toEqual([2, 2]);
    expect(split(await reports())).toEqual([2, 2]);

    // Today a visitor asks for him and the handoff card hands him the chat: Claude's, until he takes it over.
    const { session } = await openChat();
    await send('Can I talk to Mike?');
    await drain();
    expect(split(await reports('1'))).toEqual([3, 1]);
    expect((await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation } })).status).toBe(200);
    expect(split(await reports('1'))).toEqual([2, 2]);

    // A span the API refuses.
    for (const days of ['0', '366', 'week']) expect((await call('reports', { params: { desk_id: deskId }, query: { days } })).status, days).toBe(422);
  });
});

describe('idempotency keys', () => {
  it('start_without_a_key_is_refused', async () => {
    // As the API does (plan 02b): send_agent and setup's start each require the client's key, so a
    // body with none (missing or null) is 422 `invalid`, as a malformed key is, and starts nothing.
    const agentBodies = [{ task: 'book_visit' }, { task: 'book_visit', idempotency_key: null }];
    const setup = { description: 'Turner Plumbing. I fix leaks.', timezone: 'America/Los_Angeles' };
    const setupBodies = [setup, { ...setup, idempotency_key: null }];

    // The session comes first, as the API's session dependencies run before it reads the body: with
    // no chat, or signed out, a keyless start is 401, not 422.
    mockStore.reset('rivera', { signedIn: false });
    for (const body of agentBodies) {
      expect(await call('sendAgent', { params: { slug }, body })).toEqual({ status: 401, body: { error: 'no_session' } });
    }
    for (const body of setupBodies) {
      expect(await call('startSetup', { body })).toEqual({ status: 401, body: { error: 'no_owner_session' } });
    }

    mockStore.reset('rivera');
    await openChat();
    const sessions = mockStore.world.sessions.size;
    const desks = mockStore.world.desks.length;
    const refused = { status: 422, body: { error: 'invalid' } };
    for (const body of agentBodies) expect(await call('sendAgent', { params: { slug }, body })).toEqual(refused);
    for (const body of setupBodies) expect(await call('startSetup', { body })).toEqual(refused);
    expect(mockStore.world.sessions.size).toBe(sessions);
    expect(mockStore.world.desks.length).toBe(desks);
  });

  it('send_agent_repeat_answers_the_same_run', async () => {
    // As the API does (plan 02b): a repeat with the same key, task, session and Desk answers the run the
    // first started and starts nothing; the same key with another task is 409 `conflict`.
    await openChat();
    const send = (task: string, key: unknown) => call('sendAgent', { params: { slug }, body: { task, idempotency_key: key } });
    const first = await send('book_visit', 'key-1');
    expect(first.status).toBe(202);
    const sessions = mockStore.world.sessions.size;
    expect(await send('book_visit', 'key-1')).toEqual(first);
    expect(mockStore.world.sessions.size).toBe(sessions);
    expect(await send('quote_and_deposit', 'key-1')).toEqual({ status: 409, body: { error: 'conflict' } });
    // A new key starts a new run.
    const second = await send('book_visit', 'key-2');
    expect(second.status).toBe(202);
    expect(second.body).not.toEqual(first.body);
    // A key the API refuses (empty, over 128 characters, a control character, not a string) is 422,
    // and claims nothing.
    for (const bad of ['', 'k'.repeat(129), 'a\nb', 7]) expect((await send('book_visit', bad)).status).toBe(422);
    expect((await send('book_visit', 'k'.repeat(128))).status).toBe(202);
  });

  it('send_agent_key_is_forgotten_after_its_hour', async () => {
    // As the API does, a send's key is kept for its run's hour and then forgotten: a repeat within
    // the hour answers the same run, and one after it starts a new run.
    await openChat();
    const send = () => call('sendAgent', { params: { slug }, body: { task: 'book_visit', idempotency_key: 'key-1' } });
    const first = await send();
    vi.advanceTimersByTime(60 * 60_000 - 1);
    expect(await send()).toEqual(first);
    vi.advanceTimersByTime(1);
    const later = await send();
    expect(later.status).toBe(202);
    expect(later.body).not.toEqual(first.body);
  });

  it('setup_start_repeat_answers_the_same_interview', async () => {
    // As the API does (plan 02b): a repeat with the same key and body answers the interview the first
    // made (201, as the first) and makes nothing; the same key with another body is 409 `conflict`.
    const body = { description: 'Turner Plumbing. I fix leaks.', timezone: 'America/Los_Angeles' };
    const start = (key: unknown, description = body.description) => call('startSetup', { body: { ...body, description, idempotency_key: key } });
    const first = await start('key-1');
    expect(first.status).toBe(201);
    const desks = mockStore.world.desks.length;
    expect(await start('key-1')).toEqual(first);
    expect(await start('key-1', 'Chen Dental. I fix teeth.')).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(mockStore.world.desks.length).toBe(desks);
    // A key the API refuses is 422; a new key makes a new interview each time.
    for (const bad of ['', 'k'.repeat(129), 'a\u0000b', 7]) expect((await start(bad)).status).toBe(422);
    expect(mockStore.world.desks.length).toBe(desks);
    const ids = [await start('key-2'), await start('key-3'), await start('key-4')].map((r) => (r.body as SetupState).interview_id);
    expect(new Set([...ids, (first.body as SetupState).interview_id]).size).toBe(4);
  });

  it('held_setup_start_answers_in_progress_until_it_ends', async () => {
    // A start that runs long: its own answer is lost (a 504 from the proxy in front), and a repeat
    // with its key meanwhile is 409 `in_progress` with `retry_after` 2 s. Once it has made the Desk,
    // a repeat answers its interview, and only one Desk was made.
    const start = (key: string) => call('startSetup', { body: { description: 'Turner Plumbing. I fix leaks.', timezone: 'UTC', idempotency_key: key } });
    const desks = mockStore.world.desks.length;
    let end = holdNextStart(mockStore.world);
    expect((await start('key-1')).status).toBe(504);
    expect(await start('key-1')).toEqual({ status: 409, body: { error: 'in_progress', retry_after: 2 } });
    end('made');
    const made = await start('key-1');
    expect(made.status).toBe(201);
    expect(await start('key-1')).toEqual(made);
    expect(mockStore.world.desks.length).toBe(desks + 1);

    // One that failed before its Desk was asked for frees its key: the same request starts again.
    end = holdNextStart(mockStore.world);
    expect((await start('key-2')).status).toBe(504);
    end('freed');
    expect((await start('key-2')).status).toBe(201);
    expect(mockStore.world.desks.length).toBe(desks + 2);

    // One whose Desk may or may not exist spends its key for good: 409 `key_spent`, and only a new
    // key starts again.
    end = holdNextStart(mockStore.world);
    expect((await start('key-3')).status).toBe(504);
    end('spent');
    expect(await start('key-3')).toEqual({ status: 409, body: { error: 'key_spent' } });
    expect(mockStore.world.desks.length).toBe(desks + 2);
    expect((await start('key-4')).status).toBe(201);
  });
});
