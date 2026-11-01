import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalAnswerOut, OwnerTranscript, RulesDraft, VisitorSession, VisitorTranscript } from '../api/views.ts';
import type { Decision } from '../api/contracts.ts';
import { EVENT_GAP_MS } from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => { vi.useFakeTimers(); mockStore.reset('rivera_quiet'); });
afterEach(() => { vi.useRealTimers(); });

it('a_rule_change_refuses_an_approved_action_and_exposes_the_reason_only_on_owner_reads', async () => {
  const { slug, deskId } = RIVERA;
  const opened = await mockStore.dispatch('openSession', { params: { slug } });
  if ('network' in opened) throw new Error('session opens');
  const sessionId = (opened.body as VisitorSession).state.session_id;
  await mockStore.dispatch('sendMessage', { params: { slug }, body: { text: 'Can I get 15% off?' } });
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  const held = [...mockStore.world.decisions.values()].find((r) => r.decision.session_id === sessionId && r.decision.state === 'held')!;
  const desk = mockStore.world.desk(deskId)!;
  const quoteRule = desk.policy.cards.find((r) => r.applies_to === 'native.quote')!;
  const drafted = await mockStore.dispatch('draftRules', { params: { desk_id: deskId }, body: { add: [{ ...quoteRule, mode: 'never' }] } });
  if ('network' in drafted) throw new Error('rule drafts');
  expect(drafted.status).toBe(200);
  await mockStore.dispatch('confirmRules', { params: { desk_id: deskId }, body: { version: (drafted.body as RulesDraft).version } });
  const answered = await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'allow_once' } });
  if ('network' in answered) throw new Error('approval answers');
  const reason = "Your rules changed before this ran, so it wasn't done.";
  expect(answered.body).toMatchObject({ decision: { state: 'refused_at_execution', owner_plain: reason }, execution_state: null, card_diff: null });
  const read = await mockStore.dispatch('decision', { params: { decision_id: held.decision.decision_id } });
  if ('network' in read) throw new Error('owner reads decision');
  expect((read.body as Decision).owner_plain).toBe(reason);
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  const owner = await mockStore.dispatch('conversation', { params: { session_id: sessionId } });
  const visitor = await mockStore.dispatch('visitorSession', { params: { slug } });
  if ('network' in owner || 'network' in visitor) throw new Error('transcripts read');
  const items = (owner.body as OwnerTranscript).items;
  expect(items.find((i) => i.event?.type === 'resolved')).toMatchObject({ owner_plain: reason });
  expect(items.find((i) => i.event?.type === 'held')).toMatchObject({ owner_plain: null });
  const chat = mockStore.world.sessions.get(sessionId)!;
  for (const value of [(visitor.body as VisitorTranscript).items, chat.items, chat.events]) {
    expect(JSON.stringify(value)).not.toContain('owner_plain');
    expect(JSON.stringify(value)).not.toContain(reason);
  }
  const after = chat.events.filter(({ ev }) => ev.type === 'message').at(-1)?.ev;
  expect(JSON.stringify(after)).not.toContain('quote_total');
  const repeated = await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'allow_once' } });
  expect(repeated).toMatchObject({ status: 409, body: { decision: (answered.body as ApprovalAnswerOut).decision } });
});

it('an_allow_after_the_Desk_was_deleted_has_the_Desk_reason_and_emits_nothing', async () => {
  mockStore.reset('rivera_two_desks');
  const held = mockStore.world.addHeldRefund();
  const chat = mockStore.world.sessions.get(held.session_id)!;
  await mockStore.dispatch('deleteDesk', { params: { desk_id: RIVERA.deskId } });
  const heard = JSON.stringify(chat.events);
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution', owner_plain: "This Desk was deleted before this ran, so it wasn't done." } } });
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  expect(JSON.stringify(chat.events)).toBe(heard);
  expect(JSON.stringify(chat.items)).not.toContain('owner_plain');
});
