/**
 * The mock API's store, driven the way its handlers drive it: the scripted Desk, held requests and
 * answers, Today, the event log a stream replays, the transcript, a start over and injected faults.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionState, EvMessage, LedgerPage, PublicDesk, SseEvent } from '../api/contracts.ts';
import type { RouteKey } from '../api/routes.ts';
import type {
  ApprovalAnswerOut,
  BriefingList,
  ConversationSummary,
  CopyOut,
  DemoAgentRun,
  NeedsYouItem,
  OwnerTranscript,
  PeopleOut,
  PolicyVersionOut,
  RulesDraft,
  RulesView,
  Today,
  ToolConfirmedOut,
  VisitorSession,
  VisitorTranscript,
} from '../api/views.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { executedLine } from '../ds/fixtures/receipts.ts';
import { chatReducer, initialChatState, type ChatState } from '../public/chatReducer.ts';
import { AGENT_TURN_GAP_MS } from './agents.ts';
import { DECISIONS, DEMO_CODE, EVENT_GAP_MS, HELD_PROSE, VISITOR_PLAIN, askedDiscountBp, matchRule, turnLanguage, type RuleName } from './script.ts';
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

  it('held_discount_says_maria_decides', async () => {
    // A discount past the quote card's limit is held, and Claude's checked reply says Maria decides,
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
      `Your Rivera Plumbing code is ${DEMO_CODE}. It expires in ten minutes. If you didn't ask for it, ignore this message.`,
      `Tu código de Rivera Plumbing es ${DEMO_CODE}. Vence en diez minutos. Si no lo pediste, ignora este mensaje.`,
    ]);
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
    ];
    for (const [text, rule] of cases) expect(matchRule(text).name, text).toBe(rule);

    // So asking about an offer starts no held discount: nothing new for Maria, and a plain answer.
    const before = (await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[];
    const { events } = await openChat();
    await send('Do you offer weekend service?');
    await drain();
    expect(typesOf(events)).toEqual(['writing', 'message', 'turn_end']);
    expect((await call('needsYou', { params: { desk_id: deskId } })).body).toEqual(before);
    expect([...mockStore.world.decisions.values()].filter((d) => d.decision.state === 'held')).toHaveLength(before.length);
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

    expect(typesOf(events)).toEqual(['writing', 'held', 'message', 'turn_end']);
    expect(events.map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    const [, held] = events[1] ?? [];
    expect(held).toMatchObject({ type: 'held', state: 'held', visitor_plain: 'Waiting for Maria Rivera to approve' });
    // Claude says, in checked words, that Maria decides and her answer will show up in the chat.
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

  it('owner_alert_names_the_held_request', async () => {
    // Maria's Demo inbox alert for a hold names that held request; the code sent to a visitor names none.
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

  it('answer_resolves_and_follows_up', async () => {
    const { events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[1] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    const answered = await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      decision: { decision_id: decisionId, state: 'executed', visitor_plain: "Quoted from Maria Rivera's price list" },
      execution_state: 'succeeded',
      card_diff: null,
    });
    // Nothing reaches the chat in the answer itself: the follow-up arrives on the stream.
    expect(typesOf(events)).toEqual(['writing', 'held', 'message', 'turn_end']);

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

  it('held_discount_is_the_one_asked_for', async () => {
    // The held quote carries the percent the visitor named, with its price worked out from the
    // $180.00 list price as the kernel does, and Maria's card says so; once she allows it, the
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
    expect(help).toEqual(['Maria can tell you once she sees it. You can ask for her here anytime.']);
    expect(decided()).toHaveLength(1);
  });

  it('verified_discount_names_the_person_and_drafts_its_percent', async () => {
    // Dana confirms it's her, then asks for 20% off: Maria's card names her, and "Only for Dana
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
      [VISITOR_PLAIN.en.reply_checked, executedLine('native.quote', 'en', 'Maria Rivera')],
      [VISITOR_PLAIN.en.reply_checked, executedLine('native.find_slots', 'en', 'Maria Rivera')],
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
    // handoff, as asking for Maria does, and decides nothing. The owner's preview keeps every tool.
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

    // A callback still goes through, with its receipt and card.
    const handoffs = mockStore.world.handoffs.size;
    const callback = await turn('Can you call me back?');
    expect(callback.map((ev) => ev.type)).toEqual(['writing', 'receipt', 'message', 'turn_end']);
    expect(shown(callback).map(([, template]) => template)).toEqual(['callback_confirmed']);
    expect(toolsDecided(session.session_id)).toEqual(['native.request_callback']);
    expect(mockStore.world.handoffs.size).toBe(handoffs + 1);

    // An agent sent from the chat gets the handoff too, and decides nothing.
    const sent = await call('sendAgent', { params: { slug }, body: { task: 'book_visit' } });
    expect(sent.status).toBe(202);
    const runId = (sent.body as { run_id: string }).run_id;
    await vi.advanceTimersByTimeAsync(AGENT_TURN_GAP_MS * 6);
    const run = (await call('agentRun', { params: { slug, run_id: runId } })).body as DemoAgentRun;
    expect(run.state).toBe('done');
    const desk = run.turns.filter((t) => t.author === 'desk');
    expect(desk.map((t) => [t.blocks.map((b) => [b.kind, b.template, b.text]), t.receipts])).toEqual([[[[handoff.kind, handoff.template, handoff.text]], []]]);
    const agentChat = [...mockStore.world.sessions.values()].filter((s) => s.state.kind === 'agent').at(-1);
    expect(agentChat?.items.filter((item) => item.kind === 'agent_text').map((item) => item.text)).toEqual([
      'Book the earliest visit for a leaking water heater for Alex Kim.',
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
    const sent = await call('sendAgent', { params: { slug }, body: { task: 'quote_and_deposit' } });
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
    // The callback the script files is from Dana Whitfield, the one Dana the copy has on record,
    // with the contact the kernel's seed keeps for her (the fixtures show it masked).
    const seedPy = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend', 'desk', 'kernel_service', 'seed.py'), 'utf8');
    const [, name, contact] = /SeedPerson\(ref="dana", display_name="([^"]+)", contact="([^"]+)"\)/.exec(seedPy) ?? [];
    expect(name).toBe(rivera.people.dana.name);
    expect(rivera.people.dana.maskedContact).toBe(`${contact?.charAt(0)}•••${contact?.slice(contact.indexOf('@'))}`);

    await openChat();
    await send('Can you call me back?');
    await drain();
    const handoff = [...mockStore.world.handoffs.values()].at(-1)?.handoff;
    expect(handoff?.reason).toBe(`${name} · ${contact} · Leaking water heater`);
    const lead = mockStore.world.leads.at(-1);
    expect([lead?.displayName, lead?.note]).toEqual([name, `${contact} · Leaking water heater`]);
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

    // Dana's seeded chat: three actions that ran, and Maria's whisper in it.
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
});

describe('taking over', () => {
  /** What the ledger holds for `sessionId`, by kind, oldest first. */
  const kindsFor = (sessionId: string) =>
    (mockStore.world.desks[0]?.ledger ?? []).filter((e) => e.event.session_id === sessionId).map((e) => e.event.kind);

  it('takeover_fences_the_turn_in_flight', async () => {
    const { session, events } = await openChat();
    // The visitor picks a time, and Maria takes the chat over before Claude's turn has done anything.
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

  it('takeover_still_tells_the_visitor_an_answered_hold_ran', async () => {
    const { session, events } = await openChat();
    await send('Can I get 15% off?');
    await drain();
    const [, held] = events[1] ?? [];
    const decisionId = held?.type === 'held' ? held.decision_id : '';

    // Maria allows the hold, then joins the chat at once. The action ran when she answered, so the
    // visitor still hears that; Claude's follow-up was for the old generation and never comes.
    expect((await call('answer', { params: { decision_id: decisionId }, body: { answer: 'allow_once' } })).status).toBe(200);
    expect((await call('takeover', { params: { session_id: session.session_id }, body: { generation: session.generation } })).status).toBe(200);
    await drain();
    expect(typesOf(events).slice(4)).toEqual(['owner_joined', 'resolved', 'turn_end']);
    expect(events[5]?.[1]).toMatchObject({ type: 'resolved', decision_id: decisionId, state: 'executed' });
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

    // Not before she has taken the chat over.
    expect(await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'Hi, it is Maria.', kind: 'say' } })).toEqual({
      status: 409,
      body: { error: 'take_over_first' },
    });
    expect((await call('takeover', { params: { session_id: sessionId }, body: { generation: session.generation } })).status).toBe(200);
    const said = await call('ownerMessage', { params: { session_id: sessionId }, body: { text: 'Hi, it is Maria.', kind: 'say' } });
    expect(said.status).toBe(200);
    expect(said.body).toMatchObject({ verdict: { ok: true, violations: [] } });

    // The visitor's stream gets her joining, then her words, verbatim, as one owner_said card.
    expect(typesOf(events)).toEqual(['owner_joined', 'message']);
    const [, message] = events[1] ?? [];
    expect(message).toMatchObject({ type: 'message', author: 'owner', generation: session.generation + 1, visitor_plain: VISITOR_PLAIN.en.owner_said });
    expect(message?.type === 'message' && message.blocks.map((b) => [b.template, b.text])).toEqual([['owner_said', 'Hi, it is Maria.']]);
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
    // The active rules: version 7, Rivera's $500 limit, every tool on, from no preset.
    const before = await rules();
    expect(before.active).toMatchObject({ version: 7, status: 'active', auto_money_cap_cents: 50_000 });
    expect(before.preset).toBeNull();
    expect(before.tools.map((row) => row.tool)).toContain('payments.create_refund');
    expect(before.tools.every((row) => row.status === 'enabled')).toBe(true);
    expect(Object.keys(before.tools[0] ?? {}).sort()).toEqual(
      ['cards', 'definition_sha256', 'description_confirmed', 'effects', 'pending_definition_text', 'pending_sha256', 'reversible', 'source', 'status', 'tool'],
    );
    // Each row lists the active cards that cover its tool, in card order, a shared one marked so (plan 02b Task 9).
    const quote = rivera.ruleCards['rv-quote'];
    expect(before.tools.find((row) => row.tool === 'native.quote')?.cards).toEqual([{ card_id: quote.card_id, mode: quote.mode, reason: quote.reason, shared: false }]);

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
    // A $600 limit on an automatic quote rule moves no money, so Rivera's $500 payment limit doesn't hold it back.
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

  it('confirm_tool_takes_the_batch_body', async () => {
    const stripe = ['payments.list_charges', 'payments.create_refund'];
    const entries = async () => Promise.all(stripe.map(async (tool) => ({ tool, definition_sha256: await hashOf(tool) })));

    // The old one-tool body, an empty list or a tool named twice is not a batch.
    expect((await confirmTools({ tool: 'payments.create_refund', enable: false, definition_sha256: await hashOf('payments.create_refund') })).status).toBe(422);
    expect((await confirmTools({ tools: [], enable: false })).status).toBe(422);
    const [charges] = await entries();
    expect((await confirmTools({ tools: [charges, charges], enable: false })).status).toBe(422);
    expect((await confirmTools({ tools: [{ tool: 'calendar.free_busy', definition_sha256: 'x' }], enable: false })).status).toBe(404);

    // Turning a connector off applies at once, with no draft.
    const listed = await entries();
    const off = await confirmTools({ tools: listed, enable: false });
    expect(off.status).toBe(200);
    expect((off.body as ToolConfirmedOut).draft).toBeNull();
    expect((off.body as ToolConfirmedOut).profile).toMatchObject({ tool: 'payments.list_charges', status: 'disabled' });
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
  });

  /** The connector changes `tool`'s definition to one hashed `sha`: it waits for the owner's review. */
  const drift = (tool: string, sha: string) => {
    const desk = mockStore.world.desk(deskId);
    if (!desk) throw new Error('the mock has the main Desk');
    desk.tools = desk.tools.map((row) => (row.tool === tool ? { ...row, status: 'needs_review', pending_definition_text: `Changed ${sha[0]}`, pending_sha256: sha } : row));
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
    expect(await rowOf(refund)).toMatchObject({ status: 'needs_review', definition_sha256: old, pending_sha256: 'e'.repeat(64) });
    expect((await confirm(version)).status).toBe(200);
    expect(await rowOf(refund)).toMatchObject({ status: 'enabled', definition_sha256: 'e'.repeat(64), pending_sha256: null, pending_definition_text: null });
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
    expect(await rowOf(charges)).toMatchObject({ status: 'needs_review', pending_sha256: 'b'.repeat(64) });
  });
});

describe('deleting a Desk', () => {
  it('delete_desk_closes_its_page_and_chats', async () => {
    // Rivera's main Desk, with a chat Claude is writing in when the Desk goes, and the seeded chats idle.
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
    // Dana's refund and the seeded 15% quote are held for Maria when the Desk goes.
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

    // Rivera's seed: Alex Kim's assistant, whose deposit Claude quoted and charged within its signed
    // limit; the held visitor, whose drafted reply was stopped; and Dana's chat, where Maria
    // whispered and Claude booked her at the quoted list price.
    mockStore.reset('rivera');
    const seeded = await read();
    expect(seeded.this_week).toMatchObject({ bookings: 1, booked_cents: 18_000, conversations: 3, handled: 2, stepped_in: 1, stopped: 1 });
    expect(seeded.this_week.days.at(-1)).toEqual({ date: '2026-10-29', conversations: 3, bookings: 1, stopped: 1 });
    expect(seeded.briefing).toMatchObject({ conversations: 3, bookings: 1, leads: 0, blocked: 1, total: 3 });
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
    expect(seeded.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', session_id: 'ses-alex-agent', display_name: "Alex Kim's assistant" });
    // The blocked reply's attempt on Safety has the same ref.
    const attempts = (await call('safety', { params: { desk_id: deskId } })).body as { kind: string; ref_id: string }[];
    expect(attempts.find((a) => a.kind === 'reply_blocked')?.ref_id).toBe(String(blockedReply?.seq));

    // Maria allows the seeded hold: she stepped into that chat, and a quote isn't a booking.
    const held = ((await call('needsYou', { params: { desk_id: deskId } })).body as NeedsYouItem[])[0]?.decision;
    await call('answer', { params: { decision_id: held?.decision_id ?? '' }, body: { answer: 'allow_once' } });
    await drain();
    expect((await read()).this_week).toMatchObject({ bookings: 1, conversations: 3, handled: 1, stepped_in: 2 });

    // A visitor Claude answers, and Maria's own preview that Claude answers too: both count.
    await openChat();
    await send('Hello there');
    await drain();
    await call('openPreview', { params: { desk_id: deskId } });
    await send('Do you work weekends?');
    await drain();
    const both = await read();
    expect(both.this_week).toMatchObject({ conversations: 5, stepped_in: 2, handled: 3 });
    expect(both.briefing).toMatchObject({ conversations: 5, total: 5 });
    expect(both.briefing.newest.lead_or_answer).toMatchObject({ kind: 'answer', display_name: null });

    // And a visitor who asks for a callback is a lead, not an answer.
    mockStore.reset('rivera');
    await openChat();
    await send('Can you call me back?');
    await drain();
    const withLead = await read();
    expect(withLead.briefing).toMatchObject({ leads: 1, total: 4 });
    expect(withLead.briefing.newest.lead_or_answer).toMatchObject({
      kind: 'lead',
      display_name: 'Dana Whitfield',
      line: 'dana@example.com · Leaking water heater',
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
    expect(answered.this_week).toMatchObject({ conversations: 5, stepped_in: 1, handled: 4 });

    // The full list, newest first, and the short form's rows are its own.
    const full = await list();
    expect(full.items.map((item) => item.kind)).toEqual(['answer', 'lead', 'booking', 'blocked', 'answer']);
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
