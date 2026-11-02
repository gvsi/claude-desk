import { beforeEach, expect, it } from 'vitest';

import { rivera } from '../ds/fixtures/index.ts';
import { DECISIONS } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => mockStore.reset('rivera'));

it.each(['en', 'es'] as const)('a_later_booking_closes_only_its_sessions_held_discount_quotes_on_read_%s', async (language) => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const session = world.addSession(desk);
  session.language = language;
  const other = world.addSession(desk);
  const ctx = world.context(session, language, 'A request');
  const at = world.now();
  const held = ctx.decide(DECISIONS.heldQuote);
  const listPrice = ctx.decide({ ...DECISIONS.heldQuote, discountBp: 0 });
  const refund = ctx.decide(DECISIONS.heldRefund);
  const unrelated = world.context(other, 'en', 'A request').decide(DECISIONS.heldQuote);
  world.at(at + 1000, () => ctx.decide(DECISIONS.book));
  const later = world.at(at + 2000, () => ctx.decide(DECISIONS.heldQuote));

  const read = await mockStore.dispatch('decision', { params: { decision_id: held.decision_id } });
  expect(read).toMatchObject({ status: 200, body: {
    state: 'cancelled', owner_plain: rivera.cancelledByBooking.owner_plain, answers: [],
    visitor_plain: language === 'es' ? 'Cerrada: su reserva sustituyó esta solicitud' : 'Closed: your booking replaced this request',
  } });
  const needs = await mockStore.dispatch('needsYou', { params: { desk_id: RIVERA.deskId } });
  expect(JSON.stringify(needs)).not.toContain(`"decision_id":"${held.decision_id}"`);
  for (const decision of [listPrice, refund, unrelated, later]) {
    expect(world.decisions.get(decision.decision_id)!.decision.state).toBe('held');
  }
  expect(world.inbox.some(({ entry }) => entry.decision_id === held.decision_id)).toBe(true);
  expect(await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } }))
    .toMatchObject({ status: 409 });
});
