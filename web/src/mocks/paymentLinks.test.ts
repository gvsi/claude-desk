import { beforeEach, expect, it } from 'vitest';

import { SCRIPT, turnEnd } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => mockStore.reset('rivera'));

it('reads paid and both cancellation paths from the current link record', async () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId);
  const deposit = SCRIPT.find((rule) => rule.name === 'deposit');
  if (!desk || !deposit) throw new Error('Rivera and the deposit script exist');
  const chat = world.addSession(desk);
  const issue = () => {
    const context = world.context(chat, 'en', 'pay the deposit');
    for (const step of [...deposit.steps, turnEnd]) world.emit(chat, step(context));
    const token = [...world.links.keys()].at(-1);
    if (!token) throw new Error('the script issued a link');
    return token;
  };
  const read = (token: string) => mockStore.dispatch('paymentLink', { params: { token } });
  const paid = issue();
  await mockStore.dispatch('completePayment', { params: { token: paid } });
  expect(await read(paid)).toMatchObject({ body: { state: 'paid' } });
  const visitorCancelled = issue();
  await mockStore.dispatch('cancelPayment', { params: { token: visitorCancelled } });
  expect(await read(visitorCancelled)).toMatchObject({ body: { state: 'cancelled' } });
  const ruleCancelled = issue();
  const draft = world.draft(desk, [{ ...desk.policy.cards[0]!, card_id: 'stop-links', applies_to: 'native.payment_link', mode: 'never', who: 'anyone' }]);
  world.confirmDraft(desk, draft.version);
  expect(await read(ruleCancelled)).toMatchObject({ body: { state: 'cancelled', cancel_reason: 'rules_changed' } });
});

it('gives each link its own fact and cancels only that fact', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId);
  const deposit = SCRIPT.find((rule) => rule.name === 'deposit');
  if (!desk || !deposit) throw new Error('Rivera and the deposit script exist');
  const chat = world.addSession(desk);
  for (let i = 0; i < 2; i += 1) {
    const context = world.context(chat, 'en', 'pay the deposit');
    for (const step of [...deposit.steps, turnEnd]) world.emit(chat, step(context));
  }
  const cards = chat.events.flatMap(({ ev }) => ev.type === 'message' ? ev.blocks.filter((b) => b.template === 'payment_link') : []);
  expect(cards[0]?.fact_id).not.toBe(cards[1]?.fact_id);
  const [token, link] = [...world.links][1]!;
  world.cancelLink(token, link, 'rules_changed');
  const cancelled = chat.events.flatMap(({ ev }) => ev.type === 'message' ? ev.blocks.filter((b) => b.template === 'link_cancelled') : []).at(-1);
  expect(cancelled?.fact_id).toBe(cards[1]?.fact_id);
});
