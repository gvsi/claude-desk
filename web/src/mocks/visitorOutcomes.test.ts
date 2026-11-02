import { beforeEach, expect, it } from 'vitest';

import { rivera } from '../ds/fixtures/index.ts';
import { conversationSummary } from './readModels.ts';
import { DECISIONS } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => mockStore.reset('rivera'));

it('derives_the_seeded_visitors_booking_from_its_executed_decision', () => {
  const { world } = mockStore;
  const dana = world.sessions.get('ses-dana-web')!;
  expect(conversationSummary(world, dana).latest_outcome).toBe('visit_booked');
  const held = world.sessions.get('ses-visitor-web')!;
  expect(conversationSummary(world, held).latest_outcome).toBeNull();
});

it('uses_executed_tools_and_owner_answers_without_needing_a_shown_card', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const ctx = world.context(chat, 'en', 'A request');
  const latest = () => conversationSummary(world, chat).latest_outcome;
  for (const [spec, outcome] of [
    [DECISIONS.quote, 'quoted'], [DECISIONS.book, 'visit_booked'],
    [{ ...DECISIONS.quote, tool: 'native.capture_lead' }, 'lead_captured'],
    [DECISIONS.releaseInvoice, 'document_sent'],
    [{ ...DECISIONS.quote, outcome: 'refuse', executed: false }, 'turned_down'],
  ] as const) {
    ctx.decide(spec);
    expect(latest()).toBe(outcome);
  }
  const held = ctx.decide(DECISIONS.heldQuote);
  expect(latest()).toBeNull();
  world.answer(world.decisions.get(held.decision_id)!, 'deny_once');
  expect(latest()).toBe('owner_declined');
  ctx.decide(DECISIONS.slots);
  expect(latest()).toBe('owner_declined');
  chat.ownerPreview = true;
  expect(latest()).toBeNull();
});

it('orders_by_ledger_time_then_sequence_and_clears_for_unfinished_requests', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const ctx = world.context(chat, 'en', 'A request');
  const latest = () => conversationSummary(world, chat).latest_outcome;
  const at = Date.parse('2026-10-30T17:00:00Z');
  world.at(at + 1000, () => ctx.decide(DECISIONS.book));
  world.at(at, () => ctx.decide(DECISIONS.quote));
  expect(latest()).toBe('visit_booked');
  world.at(at + 1000, () => ctx.decide(DECISIONS.quote));
  expect(latest()).toBe('quoted');
  for (const state of ['held', 'expired', 'cancelled', 'refused_at_execution'] as const) {
    const decision = world.at(at + 2000, () => ctx.decide(DECISIONS.heldQuote));
    const record = world.decisions.get(decision.decision_id)!;
    record.decision = { ...record.decision, state };
    expect(latest()).toBe(state === 'refused_at_execution' ? 'turned_down' : null);
  }
});

it('counts_a_paid_link_once_and_ignores_a_later_refused_payment_retry', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const ctx = world.context(chat, 'en', 'Pay a deposit');
  const token = world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
  const latest = () => conversationSummary(world, chat).latest_outcome;
  expect(latest()).toBeNull();
  world.payLink(token, world.links.get(token)!);
  expect(latest()).toBe('deposit_paid');
  ctx.decide(DECISIONS.quote);
  world.appendLedger(desk, { kind: 'payment', origin: 'kernel', session_id: chat.state.session_id, ref_id: token,
    summary: { state: 'paid', refused: true } });
  expect(latest()).toBe('quoted');
  world.appendLedger(desk, { kind: 'payment', origin: 'kernel', session_id: chat.state.session_id, ref_id: token,
    summary: { state: 'paid' } });
  expect(latest()).toBe('quoted');
});

it('counts_only_an_owner_completed_callback_and_clears_when_another_handoff_opens', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const ctx = world.context(chat, 'en', 'Call me');
  const latest = () => conversationSummary(world, chat).latest_outcome;
  const open = () => ctx.openHandoff({ reason: 'Call me', callbackWindow: null, lead: 'Marcus Bell' });
  ctx.decide(DECISIONS.quote);
  open();
  expect(latest()).toBeNull();
  const first = [...world.handoffs.values()].at(-1)!;
  open();
  expect(first.handoff.status).toBe('done');
  expect(latest()).toBeNull();
  const second = [...world.handoffs.values()].at(-1)!;
  world.closeHandoff(second);
  expect(latest()).toBe('called_back');
  world.reply(chat, [rivera.blocks.handoff.en], 'en');
  expect(latest()).toBeNull();
  const card = [...world.handoffs.values()].at(-1)!;
  world.closeHandoff(card);
  expect(latest()).toBeNull();
});
