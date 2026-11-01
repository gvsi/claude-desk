import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalAnswerOut, OwnerTranscript, RulesDraft, VisitorSession, VisitorTranscript } from '../api/views.ts';
import type { Decision, RuleCard, StatusEvent } from '../api/contracts.ts';
import { EVENT_GAP_MS } from './script.ts';
import * as script from './script.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => { vi.useFakeTimers(); mockStore.reset('rivera_quiet'); });
afterEach(() => { vi.useRealTimers(); });

async function neverRefund(who: RuleCard['who'], effect = false) {
  const held = mockStore.world.addHeldRefund();
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const rule = desk.policy.cards.find((r) => r.applies_to === held.action?.tool)!;
  const draft = mockStore.world.draft(desk, [{ ...rule, mode: 'never', who,
    person_id: who === 'person' ? mockStore.world.sessions.get(held.session_id)!.person!.personId : null,
    applies_to: effect ? `effect:${held.action!.effects[0]}` : rule.applies_to,
  }]);
  mockStore.world.confirmDraft(desk, draft.version);
  return held;
}

it('a_verified_Never_rule_refuses_Danas_held_refund', async () => {
  const held = await neverRefund('verified');
  const chat = mockStore.world.sessions.get(held.session_id)!;
  const before = chat.events.length;
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution' }, execution_state: null } });
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  expect(chat.events.slice(before).some(({ ev }) => ev.type === 'message')).toBe(false);
});

it('a_person_Never_effect_rule_refuses_Danas_held_refund', async () => {
  const held = await neverRefund('person', true);
  const chat = mockStore.world.sessions.get(held.session_id)!;
  const before = chat.events.length;
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution' }, execution_state: null } });
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  expect(chat.events.slice(before).some(({ ev }) => ev.type === 'message')).toBe(false);
});

it('queues_only_a_visitor_safe_decision_into_afterAnswer', async () => {
  const held = await neverRefund('anyone');
  const boundary = vi.spyOn(script, 'afterAnswer');
  try {
    await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
    const queued = boundary.mock.calls[0]![1];
    expect(queued).not.toHaveProperty('owner_plain');
    expect(JSON.stringify(queued)).not.toContain("Your rules changed before this ran");
  } finally { boundary.mockRestore(); }
});

it('afterAnswer_clears_an_owner_annotation_again_before_its_status_step', async () => {
  const held = await neverRefund('anyone');
  const decision = mockStore.world.answer(mockStore.world.decisions.get(held.decision_id)!, 'allow_once');
  const ctx = mockStore.world.context(mockStore.world.sessions.get(held.session_id)!, 'en', '');
  const status = vi.spyOn(ctx, 'status');
  script.afterAnswer('allow_once', decision, null)[0]!(ctx);
  const received = status.mock.calls[0]![1];
  expect(received).not.toHaveProperty('owner_plain');
  expect(JSON.stringify(received)).not.toContain(decision.owner_plain!);
});

it('an_allow_person_refusal_drafts_no_rule', async () => {
  const held = await neverRefund('anyone');
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_person' } });
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution' }, card_diff: null } });
});

it('a_policy_refusal_writes_one_approval_and_no_execute_entry', async () => {
  const held = await neverRefund('verified');
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const before = desk.ledger.length;
  await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
  expect(desk.ledger.slice(before).map((entry) => entry.event)).toMatchObject([{ kind: 'approval', summary: {
    answer: 'allow_once', state: 'refused_at_execution', reason: 'rules_changed', check: 'policy',
  } }]);
  expect(mockStore.world.decisions.get(held.decision_id)!.decision.ledger_seq).toBe(desk.ledger.at(-1)!.seq);
});

it('the_not_shared_copy_holds_Danas_document_until_after_her_session_ends', async () => {
  await mockStore.dispatch('copies', { body: { passcode: 'not-shared' } });
  const world = mockStore.world;
  const held = [...world.decisions.values()].find((r) => r.decision.state === 'held' && r.decision.action?.tool === 'native.release_document');
  expect(held, 'the mock passcode opens the ended-session document scenario').toBeDefined();
  if (!held) throw new Error('missing document hold');
  const chat = world.sessions.get(held.decision.session_id)!;
  expect(chat.state.verified).toBe(true);
  expect(chat.events.at(-1)?.ev).toEqual({ type: 'error', code: 'session' });
  const before = chat.events.length;
  const desk = world.desk(held.deskId)!;
  const ledgerBefore = desk.ledger.length;
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'allow_once' } });
  const reason = 'Not shared: their session ended before your answer';
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution', owner_plain: reason }, execution_state: null, card_diff: null } });
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  expect(chat.events.slice(before).some(({ ev }) => ev.type === 'message')).toBe(false);
  expect(JSON.stringify(chat.events)).not.toContain(reason);
  expect(desk.ledger.slice(ledgerBefore).map((entry) => entry.event)).toMatchObject([{ kind: 'approval', summary: {
    answer: 'allow_once', state: 'refused_at_execution', reason: 'session_ended', check: 'session_closed',
  } }]);
  const owner = await mockStore.dispatch('conversation', { params: { session_id: chat.state.session_id } });
  expect(owner).toMatchObject({ body: { items: expect.arrayContaining([expect.objectContaining({ owner_plain: reason })]) } });
});

it('refused_status_annotations_require_the_same_session_and_ledger_entry', async () => {
  const held = await neverRefund('verified');
  const world = mockStore.world;
  const decision = world.answer(world.decisions.get(held.decision_id)!, 'allow_once');
  const chat = world.sessions.get(held.session_id)!;
  const other = world.addSession(world.desk(RIVERA.deskId)!);
  const event: StatusEvent = { type: 'resolved', decision_id: decision.decision_id, state: 'refused_at_execution',
    visitor_plain: decision.visitor_plain, signature: decision.signature, ledger_seq: decision.ledger_seq };
  world.emit(chat, { ...event, ledger_seq: event.ledger_seq + 1 });
  world.emit(other, event);
  const annotations = [];
  for (const session of [chat, other]) {
    const result = await mockStore.dispatch('conversation', { params: { session_id: session.state.session_id } });
    if ('network' in result) throw new Error('owner reads transcript');
    annotations.push((result.body as OwnerTranscript).items.at(-1)?.owner_plain);
  }
  expect(annotations).toEqual([null, null]);
});

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
  const chat = mockStore.world.sessions.get(sessionId)!;
  const beforeAnswer = chat.events.length;
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
  for (const value of [(visitor.body as VisitorTranscript).items, chat.items, chat.events]) {
    expect(JSON.stringify(value)).not.toContain('owner_plain');
    expect(JSON.stringify(value)).not.toContain(reason);
  }
  const after = chat.events.slice(beforeAnswer).map(({ ev }) => ev);
  const messages = after.filter((ev) => ev.type === 'message');
  expect(messages.flatMap((ev) => ev.blocks).filter((block) => block.kind === 'card' && block.template === 'quote')).toEqual([]);
  expect(messages).toEqual([]);
  expect(after).toContainEqual(expect.objectContaining({ type: 'resolved', state: 'refused_at_execution' }));
  const repeated = await mockStore.dispatch('answer', { params: { decision_id: held.decision.decision_id }, body: { answer: 'allow_once' } });
  expect(repeated).toMatchObject({ status: 409, body: { decision: (answered.body as ApprovalAnswerOut).decision } });
});

it('an_allow_after_the_Desk_was_deleted_has_the_Desk_reason_and_emits_nothing', async () => {
  mockStore.reset('rivera_two_desks');
  const held = mockStore.world.addHeldRefund();
  const chat = mockStore.world.sessions.get(held.session_id)!;
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  await mockStore.dispatch('deleteDesk', { params: { desk_id: RIVERA.deskId } });
  const before = desk.ledger.length;
  const heard = JSON.stringify(chat.events);
  const result = await mockStore.dispatch('answer', { params: { decision_id: held.decision_id }, body: { answer: 'allow_once' } });
  expect(result).toMatchObject({ status: 200, body: { decision: { state: 'refused_at_execution', owner_plain: "This Desk was deleted before this ran, so it wasn't done." } } });
  expect(desk.ledger.slice(before).map((entry) => entry.event)).toMatchObject([{ kind: 'approval', summary: {
    answer: 'allow_once', state: 'refused_at_execution', reason: 'rules_changed', check: 'desk',
  } }]);
  await vi.advanceTimersByTimeAsync(EVENT_GAP_MS * 12);
  expect(JSON.stringify(chat.events)).toBe(heard);
  expect(JSON.stringify(chat.items)).not.toContain('owner_plain');
});
