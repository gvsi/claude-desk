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

it('cancels issued links when a confirmed rule asks the owner first', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const token = world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
  const draft = world.draft(desk, [{ ...desk.policy.cards[0]!, card_id: 'ask-links', applies_to: 'native.payment_link', mode: 'ask', who: 'anyone' }]);
  world.confirmDraft(desk, draft.version);
  expect(world.links.get(token)?.view).toMatchObject({ state: 'cancelled', cancel_reason: 'rules_changed' });
  expect(chat.events.some(({ ev }) => ev.type === 'message' && ev.blocks.some((b) => b.template === 'link_cancelled'))).toBe(true);
});

it('keeps a verified person\'s auto-allowed link when a broader rule asks the owner', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const person = { personId: 'per-dana', name: 'Dana Whitfield' };
  world.verify(chat, person);
  const token = world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
  const base = { ...desk.policy.cards[0]!, applies_to: 'native.payment_link' };
  const draft = world.draftCards(desk, [
    { ...base, card_id: 'ask-anyone', mode: 'ask', who: 'anyone' },
    { ...base, card_id: 'auto-person', mode: 'auto', who: 'person', person_id: person.personId },
  ]);
  world.confirmDraft(desk, draft.version);
  expect(world.links.get(token)?.view.state).toBe('issued');
  expect(chat.events.some(({ ev }) => ev.type === 'message' && ev.blocks.some((b) => b.template === 'link_cancelled'))).toBe(false);
});

it('cancels an ended session link without posting a chat card', () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const token = world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
  chat.ended = true;
  const before = chat.events.length;
  const draft = world.draft(desk, [{ ...desk.policy.cards[0]!, card_id: 'stop-links', applies_to: 'native.payment_link', mode: 'never', who: 'anyone' }]);
  world.confirmDraft(desk, draft.version);
  expect(world.links.get(token)?.view.state).toBe('cancelled');
  expect(chat.events).toHaveLength(before);
});

it('preserves an injected JSON null response body', async () => {
  mockStore.inject({ route: 'paymentLink', status: 200, body: null });
  expect(await mockStore.dispatch('paymentLink', { params: { token: 'unused' } })).toEqual({ status: 200, body: null });
});

it('isolates queued read faults from payment writes and clears them on reset', async () => {
  const { world } = mockStore;
  const desk = world.desk(RIVERA.deskId)!;
  const chat = world.addSession(desk);
  const token = world.issueLink(chat, { title: 'Deposit', amountCents: 2000, language: 'en' });
  for (const status of ['network', 404, 429, 503] as const) mockStore.inject({ route: 'paymentLink', status, times: 1 });
  expect(mockStore.pendingInjections).toHaveLength(4);
  expect(await mockStore.dispatch('completePayment', { params: { token } })).toMatchObject({ status: 200, body: { state: 'paid' } });
  expect(mockStore.pendingInjections).toHaveLength(4);
  for (const status of ['network', 404, 429, 503] as const) {
    expect(await mockStore.dispatch('paymentLink', { params: { token } })).toMatchObject(status === 'network' ? { network: true } : { status });
  }
  expect(mockStore.pendingInjections).toEqual([]);
  mockStore.inject({ route: 'paymentLink', status: 503 });
  mockStore.reset('rivera');
  expect(mockStore.pendingInjections).toEqual([]);
});
